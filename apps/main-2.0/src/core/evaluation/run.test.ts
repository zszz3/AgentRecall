import { describe, expect, it } from "vitest";
import { createJudgeScriptRunner } from "./judge-script-runner";
import { executeEvaluationRun, type EvaluationRunPlan } from "./run";
import type {
  EvaluationNodeDependencies,
  EvaluationTaskValue,
  EvaluationTrajectoryValue,
} from "./nodes/contracts";
import type { EvaluationNodeRecord } from "./graph/node";

function task(id: string, overrides: Partial<EvaluationTaskValue> = {}): EvaluationTaskValue {
  return {
    caseId: id,
    datasetItemId: id,
    repetition: 1,
    input: `input for ${id}`,
    expectedOutput: "4",
    metadata: {},
    ...overrides,
  };
}

function trajectory(
  overrides: Partial<EvaluationTrajectoryValue> = {},
): EvaluationTrajectoryValue {
  return {
    turnCount: 2,
    toolCallCount: 1,
    toolFailureCount: 0,
    failedToolNames: [],
    totalTokens: 500,
    errorCount: 0,
    usedSkillNames: [],
    skillUsageObservable: true,
    ...overrides,
  };
}

function plan(overrides: Partial<EvaluationRunPlan> = {}): EvaluationRunPlan {
  return {
    source: "run_agent",
    agentId: "agent-1",
    skillName: null,
    evaluators: [{ id: "exact", kind: "exact_match", threshold: 1 }],
    cases: [task("case-1")],
    linkTrajectory: false,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<EvaluationNodeDependencies> = {},
): EvaluationNodeDependencies {
  return {
    runAgent: async () => ({ output: "4", durationMs: 10 }),
    wait: async () => undefined,
    ...overrides,
  };
}

function statuses(records: readonly EvaluationNodeRecord[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.nodeId, record.status]));
}

describe("evaluation run", () => {
  it("scores every case and reports the run summary", async () => {
    const outcome = await executeEvaluationRun(
      plan({ cases: [task("case-1"), task("case-2")] }),
      dependencies(),
    );

    expect(outcome.cases.map((item) => item.caseId)).toEqual(["case-1", "case-2"]);
    expect(outcome.cases[0]!.output).toBe("4");
    expect(outcome.score).toMatchObject({
      averageScore: 1,
      passRate: 1,
      scoredCaseCount: 2,
      passedCaseCount: 2,
    });
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toEqual({
      task: "pass",
      skill: "pass",
      agent: "pass",
      "judge-exact": "pass",
    });
  });

  it("reports progress per case and per node while the run is going", async () => {
    const cases: string[] = [];
    const nodes: string[] = [];

    await executeEvaluationRun(plan({ cases: [task("case-1"), task("case-2")] }), dependencies(), {
      onCaseComplete: (outcome) => {
        cases.push(outcome.caseId);
      },
      onNodeRecord: (caseId, record) => {
        nodes.push(`${caseId}/${record.nodeId}`);
      },
    });

    expect(cases).toEqual(["case-1", "case-2"]);
    expect(nodes).toContain("case-1/agent");
    expect(nodes).toContain("case-2/judge-exact");
  });

  it("leaves an agent that never answered unscored instead of scoring it zero", async () => {
    const outcome = await executeEvaluationRun(
      plan(),
      dependencies({
        runAgent: async () => {
          throw new Error("claude runtime is not configured");
        },
      }),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      agent: "excused",
      "judge-exact": "pending",
    });
    expect(result!.score.score).toBeNull();
    expect(result!.score.passed).toBe(false);
    expect(result!.unscoredReason).toBe("claude runtime is not configured");
    // The gate stays open: nothing here was the agent's fault.
    expect(result!.aggregate.gate.passed).toBe(true);
    expect(outcome.score).toMatchObject({ averageScore: null, passRate: null, unscoredCaseCount: 1 });
  });

  it("injects the selected skill as developer instructions and freezes its hash", async () => {
    const seen: Array<{ prompt: string; developerInstructions?: string }> = [];
    const outcome = await executeEvaluationRun(
      plan({ skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# Teach one point\n", hash: "abc123" }),
        runAgent: async (input) => {
          seen.push(input);
          return { output: "4", durationMs: 5 };
        },
      }),
    );

    expect(seen[0]!.developerInstructions).toBe("# Teach one point\n");
    expect(outcome.cases[0]!.skill).toEqual({
      skillName: "one-bite-teaching",
      skillHash: "abc123",
      contentLength: 18,
    });
  });

  it("sends no developer instructions when the experiment injects no skill", async () => {
    const seen: Array<{ developerInstructions?: string }> = [];
    await executeEvaluationRun(
      plan(),
      dependencies({
        runAgent: async (input) => {
          seen.push(input);
          return { output: "4", durationMs: 5 };
        },
      }),
    );

    expect(seen[0]!.developerInstructions).toBeUndefined();
  });

  it("does not run the agent when a requested skill cannot be read", async () => {
    // Running without the skill would evaluate something other than what was
    // configured, so the case reports why it produced nothing instead.
    const outcome = await executeEvaluationRun(
      plan({ skillName: "missing-skill" }),
      dependencies({ readSkill: async () => null }),
    );

    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      skill: "excused",
      agent: "pending",
      "judge-exact": "pending",
    });
    expect(outcome.cases[0]!.unscoredReason).toBe("skill_not_readable");
  });

  it("links the run to the session once indexing catches up", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true, sessionLink: { attempts: 5, delayMs: 250 } }),
      dependencies({
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async (reference) => {
          attempts += 1;
          return attempts < 3
            ? null
            : { sessionKey: `claude:${reference.sessionId}` };
        },
        readTrajectory: async () => trajectory(),
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
    );

    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
    expect(outcome.cases[0]!.sessionKey).toBe("claude:thread-9");
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      session: "pass",
      "skill-use": "pass",
    });
  });

  it("completes a fresh run's artifact with the files its session shows", async () => {
    // The answer is produced before the session that recorded it has been found,
    // so the files can only be attached afterwards — and a judge asking "did it
    // write the file" has nothing to read until they are.
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true }),
      dependencies({
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async (reference) => ({ sessionKey: `claude:${reference.sessionId}` }),
        readTrajectory: async () => trajectory(),
        readArtifactFiles: async () => [{ path: "src/a.ts", status: "added" }],
      }),
    );

    expect(outcome.cases[0]!.artifact).toEqual({
      output: "4",
      durationMs: 5,
      files: [{ path: "src/a.ts", status: "added" }],
      // A linked run does live somewhere, and saying where is what lets anyone
      // verifying a score open the session behind it.
      origin: { kind: "agent_run", reference: "claude:thread-9" },
    });
  });

  it("keeps the answer when the file reader fails", async () => {
    // Files are an observation; losing one must not cost the case its artifact.
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true }),
      dependencies({
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async (reference) => ({ sessionKey: `claude:${reference.sessionId}` }),
        readTrajectory: async () => trajectory(),
        readArtifactFiles: async () => {
          throw new Error("trace unavailable");
        },
      }),
    );

    expect(outcome.cases[0]!.artifact?.output).toBe("4");
    expect(outcome.cases[0]!.artifact?.files).toBeUndefined();
    expect(outcome.cases[0]!.score.score).toBe(1);
  });

  it("leaves an unlinked run's artifact pointing nowhere rather than guessing", async () => {
    const outcome = await executeEvaluationRun(
      plan(),
      dependencies({ readArtifactFiles: async () => [{ path: "src/a.ts", status: "added" }] }),
    );

    expect(outcome.cases[0]!.artifact).toEqual({
      output: "4",
      durationMs: 10,
      origin: { kind: "agent_run" },
    });
  });

  it("keeps the output judge deciding when the session never gets indexed", async () => {
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true, sessionLink: { attempts: 2, delayMs: 0 } }),
      dependencies({
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "thread-9" },
        }),
        resolveSession: async () => null,
        readTrajectory: async () => trajectory(),
      }),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      session: "excused",
      "skill-use": "pending",
      "judge-exact": "pass",
    });
    // A missing session link must not cost the case its score.
    expect(result!.score.score).toBe(1);
    expect(result!.score.passed).toBe(true);
    expect(result!.sessionKey).toBeUndefined();
  });

  it("excuses the link when the runtime reported no session at all", async () => {
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true }),
      dependencies({ readTrajectory: async () => trajectory(), resolveSession: async () => null }),
    );

    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "session"),
    ).toMatchObject({
      status: "excused",
      attribution: { reason: "runtime_reported_no_session" },
    });
  });

  it("records whether the injected skill was actually used", async () => {
    const used = await executeEvaluationRun(
      plan({ linkTrajectory: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async () => ({ sessionKey: "k1" }),
        readTrajectory: async () => trajectory({ usedSkillNames: ["One-Bite-Teaching"] }),
      }),
    );

    expect(
      used.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toEqual({
      injected: true,
      skillName: "one-bite-teaching",
      skillHash: "h1",
      observable: true,
      used: true,
    });

    const unused = await executeEvaluationRun(
      plan({ linkTrajectory: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async () => ({ sessionKey: "k1" }),
        readTrajectory: async () => trajectory({ usedSkillNames: ["something-else"] }),
      }),
    );

    // Skills are offered, not mandated, so going unused is an observation and
    // must not move the score.
    expect(
      unused.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toMatchObject({ used: false });
    expect(unused.cases[0]!.score.passed).toBe(true);
  });

  it("reports skill use as unknown when the session carries no usage data", async () => {
    // An uninstalled usage hook must not be reported as the agent ignoring the
    // skill.
    const outcome = await executeEvaluationRun(
      plan({ linkTrajectory: true, skillName: "one-bite-teaching" }),
      dependencies({
        readSkill: async () => ({ content: "# skill", hash: "h1" }),
        runAgent: async () => ({
          output: "4",
          durationMs: 5,
          executionReference: { sessionId: "t1" },
        }),
        resolveSession: async () => ({ sessionKey: "k1" }),
        readTrajectory: async () => trajectory({ skillUsageObservable: false }),
      }),
    );

    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "skill-use")!.facts,
    ).toMatchObject({ observable: false, used: null });
  });

  it("stops taking new cases once the run is aborted", async () => {
    const controller = new AbortController();
    const outcome = await executeEvaluationRun(
      plan({ cases: [task("case-1"), task("case-2"), task("case-3")] }),
      dependencies({
        runAgent: async () => {
          controller.abort();
          return { output: "4", durationMs: 1 };
        },
      }),
      { signal: controller.signal },
    );

    expect(outcome.cancelled).toBe(true);
    expect(outcome.cases.map((item) => item.caseId)).toEqual(["case-1"]);
    // The abort lands while case-1 is still in its agent node, so its judge
    // never gets a turn and the case cannot be reported as a clean pass.
    expect(statuses(outcome.cases[0]!.aggregate.nodes)).toMatchObject({
      agent: "pass",
      "judge-exact": "pending",
    });
    expect(
      outcome.cases[0]!.aggregate.nodes.find((record) => record.nodeId === "judge-exact")!
        .pendingReason,
    ).toBe("not_decided");
    expect(outcome.cases[0]!.aggregate.gate.passed).toBe(false);
    expect(outcome.cases[0]!.score.passed).toBe(false);
    expect(outcome.cases[0]!.unscoredReason).toBe("case_cancelled");
    expect(outcome.score.passRate).toBeNull();
  });

  it("runs several judges of one case concurrently", async () => {
    let active = 0;
    let peak = 0;
    const outcome = await executeEvaluationRun(
      plan({
        evaluators: [
          { id: "exact", kind: "exact_match", threshold: 1 },
          { id: "judge-a", kind: "llm_judge", threshold: 0.5, runtimeId: "claude", prompt: "" },
          { id: "judge-b", kind: "llm_judge", threshold: 0.5, runtimeId: "claude", prompt: "" },
        ],
      }),
      dependencies({
        executeJudge: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { output: '{"score": 1}', durationMs: 5 };
        },
      }),
    );

    expect(peak).toBeGreaterThan(1);
    expect(outcome.cases[0]!.score.decided).toBe(3);
  });

  it("keeps one judge's failure from hiding another's decision", async () => {
    const outcome = await executeEvaluationRun(
      plan({
        evaluators: [
          { id: "exact", kind: "exact_match", threshold: 1 },
          { id: "broken", kind: "llm_judge", threshold: 0.5, runtimeId: "", prompt: "" },
        ],
      }),
      dependencies(),
    );

    const [result] = outcome.cases;
    expect(statuses(result!.aggregate.nodes)).toMatchObject({
      "judge-exact": "pass",
      "judge-broken": "excused",
    });
    expect(result!.score.score).toBe(1);
    expect(result!.score.decided).toBe(1);
    expect(result!.aggregate.completeness.notDecided).toBe(1);
  });
});

describe("script judges end to end", () => {
  it("scores a run with a judge the user wrote, on the dimension it names", async () => {
    const outcome = await executeEvaluationRun(
      plan({
        cases: [task("case-1", { expectedOutput: "4" })],
        evaluators: [{
          id: "shape",
          kind: "script",
          threshold: 0.5,
          dimension: "格式",
          scriptMode: "inline_js",
          script: `
            const answer = artifact.output.trim();
            return [
              { score: answer === task.expectedOutput ? 1 : 0, dimension: "正确性" },
              { score: answer.length <= 4 ? 1 : 0, dimension: "简洁性" },
            ];
          `,
        }],
      }),
      dependencies({ runJudgeScript: createJudgeScriptRunner() }),
    );

    // One script, two dimensions — which is why a script may return a list.
    expect(outcome.cases[0]!.score.dimensions.map((item) => [item.dimension, item.score]))
      .toEqual([["正确性", 1], ["简洁性", 1]]);
    expect(outcome.score.passRate).toBe(1);
  });

  it("excuses a broken script instead of failing the agent for it", async () => {
    const outcome = await executeEvaluationRun(
      plan({
        evaluators: [{
          id: "broken",
          kind: "script",
          threshold: 0.5,
          scriptMode: "inline_js",
          script: "throw new Error('the rubric has a typo');",
        }],
      }),
      dependencies({ runJudgeScript: createJudgeScriptRunner() }),
    );

    const record = outcome.cases[0]!.aggregate.nodes
      .find((item) => item.nodeType === "script_judge")!;
    expect(record.status).toBe("excused");
    expect(record.attribution).toMatchObject({ type: "judge_failure" });
    // Nothing was learned about the agent, so there is no score — not a zero.
    expect(outcome.cases[0]!.score.score).toBeNull();
    expect(outcome.score.unscoredCaseCount).toBe(1);
  });

  it("judges the trajectory when the script asks for it", async () => {
    const outcome = await executeEvaluationRun(
      plan({
        linkTrajectory: true,
        evaluators: [{
          id: "efficiency",
          kind: "script",
          threshold: 0.5,
          subject: "trajectory",
          scriptMode: "inline_js",
          script: "return { score: trajectory.toolCallCount <= 2 ? 1 : 0, dimension: '效率' };",
        }],
      }),
      dependencies({
        runAgent: async () => ({
          output: "4",
          durationMs: 10,
          executionReference: { sessionId: "raw-1" },
        }),
        resolveSession: async () => ({ sessionKey: "claude:raw-1" }),
        readTrajectory: async () => trajectory({ toolCallCount: 1 }),
        runJudgeScript: createJudgeScriptRunner(),
      }),
    );

    expect(outcome.cases[0]!.score.dimensions.map((item) => [item.dimension, item.score]))
      .toEqual([["效率", 1]]);
  });

  it("leaves a trajectory script out of a folder run and says so", async () => {
    // A folder has no trajectory; the judge must be reported as skipped rather
    // than quietly counting as a pass.
    const outcome = await executeEvaluationRun(
      plan({
        source: "folder",
        cases: [task("case-1", { artifactRef: { path: "/tmp/artifact" } })],
        evaluators: [{
          id: "efficiency",
          kind: "script",
          threshold: 0.5,
          subject: "trajectory",
          scriptMode: "inline_js",
          script: "return 1;",
        }],
      }),
      dependencies({
        readFolderArtifact: async () => ({ output: "4" }),
        runJudgeScript: createJudgeScriptRunner(),
      }),
    );

    expect(outcome.cases[0]!.skippedEvaluatorIds).toEqual(["efficiency"]);
    expect(outcome.cases[0]!.aggregate.nodes
      .some((item) => item.nodeType === "script_trajectory_judge")).toBe(false);
  });
});
