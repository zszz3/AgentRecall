import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteDatabase } from "../../../core/sqlite/database";
import { SQLITE_MIGRATIONS } from "../../../core/sqlite/schema";
import { SqliteEvaluationStore } from "./sqlite-evaluation-store";
import type { EvaluationRun } from "../shared/evaluation/types";

describe("SQLite evaluation store graph records", () => {
  let database: SqliteDatabase;
  let store: SqliteEvaluationStore;

  beforeEach(async () => {
    database = SqliteDatabase.open(":memory:", {
      migrations: SQLITE_MIGRATIONS,
    });
    await database.initialize();
    store = new SqliteEvaluationStore(database);
    const now = Date.now();
    await store.saveDataset({
      id: "dataset-1",
      name: "cases",
      description: "",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-1",
      name: "graph regression",
      datasetId: "dataset-1",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  function graphRun(): EvaluationRun {
    return {
      id: "run-1",
      experimentId: "experiment-1",
      status: "completed",
      engine: "graph",
      startedAt: 1,
      finishedAt: 2,
      averageScore: 0.75,
      minimumScore: 0.5,
      passRate: 0.5,
      scoredCaseCount: 2,
      unscoredCaseCount: 1,
      coverage: 0.8,
      dimensions: [
        { dimension: "正确性", score: 0.75, weight: 4, scoredCaseCount: 2 },
        { dimension: "格式", score: 1, weight: 1, scoredCaseCount: 2 },
      ],
      totalDurationMs: 100,
      results: [
        {
          id: "run-1:item-1:1",
          runId: "run-1",
          datasetItemId: "item-1",
          repetition: 1,
          input: "question",
          expectedOutput: "4",
          output: "4",
          durationMs: 20,
          gatePassed: true,
          score: 0.9,
          passed: true,
          coverage: 0.5,
          dimensions: [
            {
              dimension: "正确性",
              score: 0.9,
              weight: 4,
              decided: 1,
              undecided: 0,
              met: 1,
              unmet: 0,
            },
          ],
          byLabel: { dimension: { 正确性: 0.9 }, priority: { must: 0.9 } },
          skippedEvaluatorIds: ["tool-failures"],
          artifact: {
            origin: { kind: "agent_run", reference: "claude:thread-9" },
            files: [
              { path: "src/a.ts", status: "added" },
              { path: "src/b.ts", status: "modified" },
            ],
          },
          sessionKey: "claude:thread-9",
          skillInjection: { skillName: "review", skillHash: "hash-1", contentLength: 42 },
          scores: [
            { evaluatorId: "exact", score: 1, passed: true, dimension: "正确性", durationMs: 1 },
            { evaluatorId: "exact", score: 0.8, passed: true, dimension: "格式", durationMs: 1 },
          ],
          nodes: [
            {
              nodeId: "agent",
              nodeType: "agent_execute",
              nodeVersion: 1,
              role: "prepare",
              status: "pass",
              startedAt: 10,
              finishedAt: 20,
              durationMs: 10,
              producedOutputs: ["execution"],
              facts: { outputLength: 1 },
            },
            {
              nodeId: "session",
              nodeType: "session_link",
              nodeVersion: 1,
              role: "prepare",
              status: "excused",
              attribution: {
                type: "infra_failure",
                reason: "session_not_indexed",
                details: ["waited 3s"],
              },
            },
            {
              nodeId: "judge-exact",
              nodeType: "deterministic_judge",
              nodeVersion: 1,
              role: "judge",
              status: "pass",
              durationMs: 1,
              verdicts: [
                {
                  verdictId: "judge-exact:exact",
                  evaluatorId: "exact",
                  labels: { dimension: "output" },
                  status: "met",
                  raw: 1,
                  threshold: 1,
                  reason: "output matched the expected value",
                  evidence: ["says 4"],
                  sourceNodeId: "judge-exact",
                  sourceNodeType: "deterministic_judge",
                  durationMs: 1,
                },
              ],
            },
            {
              nodeId: "skill-use",
              nodeType: "skill_use_observe",
              nodeVersion: 1,
              role: "prepare",
              status: "pending",
              pendingReason: "upstream_not_pass",
              pendingUpstream: ["evidence"],
            },
          ],
        },
      ],
    };
  }

  it("round-trips node records, verdicts and the session link", async () => {
    await store.saveRun(graphRun());

    const loaded = await store.getRun("run-1");

    expect(loaded).toMatchObject({
      engine: "graph",
      scoredCaseCount: 2,
      unscoredCaseCount: 1,
    });
    // The dimension breakdown is the point of the score, so it has to survive a
    // reload rather than only existing in the process that computed it.
    expect(loaded!.coverage).toBeCloseTo(0.8);
    expect(loaded!.dimensions).toEqual(graphRun().dimensions);
    const [result] = loaded!.results;
    expect(result).toMatchObject({
      sessionKey: "claude:thread-9",
      gatePassed: true,
      skillInjection: { skillName: "review", skillHash: "hash-1", contentLength: 42 },
      score: 0.9,
      passed: true,
      coverage: 0.5,
      byLabel: { dimension: { 正确性: 0.9 }, priority: { must: 0.9 } },
      skippedEvaluatorIds: ["tool-failures"],
    });
    // What the run produced, not only what it said: a judge written next week has
    // to be able to read last week's files without running the agent again.
    expect(result!.artifact).toEqual({
      origin: { kind: "agent_run", reference: "claude:thread-9" },
      files: [
        { path: "src/a.ts", status: "added" },
        { path: "src/b.ts", status: "modified" },
      ],
    });
    expect(result!.dimensions).toEqual(graphRun().results[0]!.dimensions);
    expect(result!.scores.map((score) => score.dimension)).toEqual(["格式", "正确性"]);
    expect(result!.nodes?.map((node) => node.nodeId)).toEqual([
      "agent",
      "session",
      "judge-exact",
      "skill-use",
    ]);
    expect(result!.nodes?.[1]).toMatchObject({
      status: "excused",
      attribution: {
        type: "infra_failure",
        reason: "session_not_indexed",
        details: ["waited 3s"],
      },
    });
    expect(result!.nodes?.[2]!.verdicts).toEqual(graphRun().results[0]!.nodes![2]!.verdicts);
    expect(result!.nodes?.[3]).toMatchObject({
      status: "pending",
      pendingReason: "upstream_not_pass",
      pendingUpstream: ["evidence"],
    });
  });

  it("leaves a case without an artifact without one", async () => {
    // An empty file list and an unobserved one are different answers, and only a
    // missing artifact means the source never produced anything to judge.
    const run = graphRun();
    delete run.results[0]!.artifact;
    await store.saveRun(run);

    const loaded = await store.getRun("run-1");

    expect(loaded!.results[0]!.artifact).toBeUndefined();
  });

  it("keeps an artifact that was produced but touched no files", async () => {
    const run = graphRun();
    run.results[0]!.artifact = { origin: { kind: "folder", reference: "/tmp/out" } };
    await store.saveRun(run);

    const loaded = await store.getRun("run-1");

    expect(loaded!.results[0]!.artifact).toEqual({
      origin: { kind: "folder", reference: "/tmp/out" },
    });
    expect(loaded!.results[0]!.artifact!.files).toBeUndefined();
  });

  it("replaces the previous node records when a run snapshot is saved again", async () => {
    // Progress snapshots re-save the whole run, so a case must not accumulate
    // duplicate node rows as it advances.
    await store.saveRun(graphRun());
    await store.saveRun(graphRun());

    const loaded = await store.getRun("run-1");

    expect(loaded!.results[0]!.nodes).toHaveLength(4);
    expect(loaded!.results[0]!.nodes?.[2]!.verdicts).toHaveLength(1);
  });

  it("round-trips an authored graph on the experiment", async () => {
    const experiments = await store.listExperiments();
    const target = experiments.find((item) => item.id === "experiment-1")!;
    await store.saveExperiment({
      ...target,
      graph: {
        version: 1,
        spec: {
          name: "authored",
          version: 1,
          nodes: [
            { id: "task", type: "task_source", config: {} },
            {
              id: "agent",
              type: "agent_execute",
              config: { agentId: "agent-1" },
              in: { task: "task.task" },
            },
          ],
        },
        layout: { task: { x: 10, y: 20 }, agent: { x: 240, y: 20 } },
      },
      updatedAt: Date.now(),
    });

    const reloaded = (await store.listExperiments()).find((item) => item.id === "experiment-1")!;
    expect(reloaded.graph?.spec.nodes.map((node) => node.id)).toEqual(["task", "agent"]);
    expect(reloaded.graph?.layout).toEqual({ task: { x: 10, y: 20 }, agent: { x: 240, y: 20 } });
  });

  it("leaves an experiment without an authored graph on the derived shape", async () => {
    const reloaded = (await store.listExperiments()).find((item) => item.id === "experiment-1")!;

    expect(reloaded.graph).toBeNull();
  });

  it("keeps a run recorded before the graph engine readable", async () => {
    await store.saveRun({
      id: "run-legacy",
      experimentId: "experiment-1",
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      averageScore: 1,
      passRate: 1,
      results: [
        {
          id: "run-legacy:item-1:1",
          runId: "run-legacy",
          datasetItemId: "item-1",
          repetition: 1,
          input: "question",
          output: "4",
          durationMs: 5,
          scores: [{ evaluatorId: "exact", score: 1, passed: true, durationMs: 1 }],
        },
      ],
    });

    const loaded = await store.getRun("run-legacy");

    expect(loaded!.engine).toBeUndefined();
    expect(loaded!.results[0]!.nodes).toBeUndefined();
    expect(loaded!.results[0]!.sessionKey).toBeUndefined();
    expect(loaded!.results[0]!.scores).toHaveLength(1);
  });

  it("round-trips a script evaluator's own settings", async () => {
    // A script judge that lost its code on reload would silently stop judging,
    // and the dimension it scores decides how its verdict is combined.
    const now = Date.now();
    await store.saveEvaluator({
      id: "evaluator-script",
      name: "answer length",
      kind: "script",
      threshold: 0.7,
      enabled: true,
      dimension: "简洁性",
      priority: "should",
      scriptMode: "command",
      command: "/usr/bin/python3",
      commandArgs: ["judge.py", "--strict"],
      subject: "trajectory",
      timeoutMs: 4_000,
      createdAt: now,
      updatedAt: now,
    });

    const reloaded = (await store.listEvaluators()).find((item) => item.id === "evaluator-script");

    expect(reloaded).toMatchObject({
      kind: "script",
      dimension: "简洁性",
      priority: "should",
      scriptMode: "command",
      command: "/usr/bin/python3",
      commandArgs: ["judge.py", "--strict"],
      subject: "trajectory",
      timeoutMs: 4_000,
    });
  });

  it("round-trips the artifact source and scoring config of an experiment", async () => {
    const target = (await store.listExperiments()).find((item) => item.id === "experiment-1")!;
    await store.saveExperiment({
      ...target,
      source: "session",
      scoring: {
        weightByLabels: { dimension: { 正确性: 4 }, priority: { should: 0.5 } },
        resolvedThreshold: 0.8,
        minCoverage: 0.5,
        uncertain: "zero",
      },
      updatedAt: Date.now(),
    });

    const reloaded = (await store.listExperiments()).find((item) => item.id === "experiment-1")!;

    expect(reloaded.source).toBe("session");
    expect(reloaded.scoring).toEqual({
      weightByLabels: { dimension: { 正确性: 4 }, priority: { should: 0.5 } },
      resolvedThreshold: 0.8,
      minCoverage: 0.5,
      uncertain: "zero",
    });
  });

  it("keeps a tool-failure evaluator's budget", async () => {
    const now = Date.now();
    await store.saveEvaluator({
      id: "evaluator-tools",
      name: "tool failures",
      kind: "tool_failures",
      threshold: 1,
      enabled: true,
      maxToolFailures: 3,
      createdAt: now,
      updatedAt: now,
    });

    expect((await store.listEvaluators()).find((item) => item.id === "evaluator-tools"))
      .toMatchObject({ kind: "tool_failures", maxToolFailures: 3 });
  });
});
