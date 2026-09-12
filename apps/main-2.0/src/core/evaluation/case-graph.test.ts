import { describe, expect, it } from "vitest";
import { buildEvaluationGraph } from "./graph/builder";
import {
  AGENT_NODE_ID,
  buildEvaluationCaseGraph,
  isJudgingOnlySpec,
  SESSION_NODE_ID,
  TASK_NODE_ID,
  type EvaluationCasePlan,
} from "./case-graph";
import { createEvaluationValidationRegistry } from "./node-catalog";
import type { EvaluationGraphSpec } from "./graph/builder";

/**
 * The head of a graph is not something a user assembles.
 *
 * Which Runtime, which Skill, which cases — those are how the graph is configured,
 * and the steps that follow from them are derived on every run. A saved graph
 * therefore stores only the judging half, and these tests pin that both halves
 * still meet correctly.
 */
function plan(overrides: Partial<EvaluationCasePlan> = {}): EvaluationCasePlan {
  return {
    source: "run_agent",
    agentId: "agent-1",
    skillName: "review",
    evaluators: [{ id: "exact", kind: "exact_match", threshold: 1 }],
    task: {
      caseId: "case-1",
      datasetItemId: "item-1",
      repetition: 1,
      input: "why does login fail?",
      expectedOutput: "expired token",
      metadata: {},
    },
    linkTrajectory: true,
    ...overrides,
  };
}

/** What the editor saves: the judges, bound to the head the engine will derive. */
function judgingOnly(): EvaluationGraphSpec {
  return {
    name: "judges",
    version: 1,
    nodes: [
      {
        id: "judge-exact",
        type: "deterministic_judge",
        config: { evaluatorId: "exact", threshold: 1, kind: "exact_match" },
        in: { task: `${TASK_NODE_ID}.task`, artifact: `${AGENT_NODE_ID}.artifact` },
      },
      {
        id: "judge-tools",
        type: "tool_failure_judge",
        config: { evaluatorId: "tools", threshold: 1 },
        in: { trajectory: `${SESSION_NODE_ID}.trajectory` },
      },
    ],
  };
}

describe("isJudgingOnlySpec", () => {
  it("recognises a graph that stored only its judges", () => {
    expect(isJudgingOnlySpec(judgingOnly())).toBe(true);
  });

  it("recognises a graph from before that, which stored every step", () => {
    expect(isJudgingOnlySpec({
      name: "authored",
      version: 1,
      nodes: [{ id: "task", type: "task_source", config: {} }],
    })).toBe(false);
  });
});

describe("buildEvaluationCaseGraph", () => {
  const dependencies = {
    runAgent: async () => ({ output: "", durationMs: 0 }),
  };

  it("derives the head and keeps the judges that were saved", () => {
    const { graph } = buildEvaluationCaseGraph(
      plan({
        savedSpec: judgingOnly(),
        evaluators: [
          { id: "exact", kind: "exact_match", threshold: 1 },
          { id: "tools", kind: "tool_failures", threshold: 1 },
        ],
      }),
      dependencies,
    );

    expect([...graph.nodes.keys()]).toEqual([
      "task",
      "skill",
      "agent",
      "session",
      "skill-use",
      "artifact-complete",
      "judge-exact",
      "judge-tools",
    ]);
  });

  it("takes the Runtime, the Skill and the case from how the graph is configured", () => {
    // Not from the saved graph: editing any of the three has to take effect on
    // the next run rather than keeping whatever was stored.
    const { graph } = buildEvaluationCaseGraph(
      plan({ savedSpec: judgingOnly(), agentId: "agent-9", skillName: "other" }),
      dependencies,
    );

    expect(graph.nodes.get("agent")!.config).toMatchObject({ agentId: "agent-9" });
    expect(graph.nodes.get("skill")!.config).toMatchObject({ skillName: "other" });
    expect(graph.nodes.get("task")!.config).toMatchObject({ input: "why does login fail?" });
  });

  it("still runs a graph that stored every step, exactly as stored", () => {
    const authored: EvaluationGraphSpec = {
      name: "authored",
      version: 1,
      nodes: [
        { id: "task", type: "task_source", config: {} },
        { id: "source", type: "session_artifact", in: { task: "task.task" } },
      ],
    };

    const { graph } = buildEvaluationCaseGraph(
      plan({ savedSpec: authored, source: "session", evaluators: [] }),
      dependencies,
    );

    expect([...graph.nodes.keys()]).toEqual(["task", "source"]);
  });

  it("produces a graph the builder accepts", () => {
    const { graph } = buildEvaluationCaseGraph(
      plan({ savedSpec: judgingOnly(), evaluators: [
        { id: "exact", kind: "exact_match", threshold: 1 },
        { id: "tools", kind: "tool_failures", threshold: 1 },
      ] }),
      dependencies,
    );

    expect(() => buildEvaluationGraph(graph.spec, createEvaluationValidationRegistry()))
      .not.toThrow();
  });
});
