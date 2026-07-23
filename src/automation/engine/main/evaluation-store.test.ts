import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresDatabase } from "../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../core/postgres/schema";
import { PGliteTestPool } from "../../../core/postgres/test-pglite";
import { PostgresSessionRepository } from "../../../core/postgres/session-repository";
import { EvaluationStore } from "./evaluation-store";

let database: PostgresDatabase;
let store: EvaluationStore;

beforeEach(async () => {
  database = new PostgresDatabase(new PGliteTestPool(), {
    migrationLock: false,
    migrations: POSTGRES_MIGRATIONS,
  });
  await database.initialize();
  store = new EvaluationStore(database);
});

afterEach(async () => {
  await database.close();
});

describe("EvaluationStore", () => {
  it("round-trips Judge evidence and failed criteria", async () => {
    await store.saveDataset({
      id: "dataset",
      name: "Dataset",
      description: "",
      items: [{ id: "item", input: "Question", metadata: {}, sequence: 0 }],
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveEvaluator({
      id: "judge",
      name: "Judge",
      kind: "llm_judge",
      prompt: "Complete prompt",
      threshold: 0.75,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveExperiment({
      id: "experiment",
      name: "Experiment",
      datasetId: "dataset",
      agentId: "agent",
      evaluatorIds: ["judge"],
      repetitions: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveRun({
      id: "run",
      experimentId: "experiment",
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      results: [
        {
          id: "result",
          runId: "run",
          datasetItemId: "item",
          repetition: 1,
          input: "Question",
          output: "Answer",
          durationMs: 1,
          scores: [
            {
              evaluatorId: "judge",
              score: 0.75,
              passed: true,
              reason: "Minor issue.",
              evidence: ["quoted span"],
              failedCriteria: ["focus"],
              durationMs: 1,
            },
          ],
        },
      ],
    });

    expect(
      (await store.getRun("run"))?.results[0]?.scores[0],
    ).toMatchObject({
      evidence: ["quoted span"],
      failedCriteria: ["focus"],
    });
  });

  it("pages lightweight run summaries and loads full results only on demand", async () => {
    await store.saveDataset({ id: "dataset", name: "Dataset", description: "", items: [], createdAt: 1, updatedAt: 1 });
    await store.saveExperiment({ id: "experiment", name: "Experiment", datasetId: "dataset", agentId: "agent", evaluatorIds: [], repetitions: 1, createdAt: 1, updatedAt: 1 });
    for (let index = 0; index < 3; index += 1) {
      await store.saveRun({
        id: `run-${index}`,
        experimentId: "experiment",
        status: "completed",
        startedAt: index + 1,
        averageScore: index / 2,
        results: [{
          id: `result-${index}`,
          runId: `run-${index}`,
          datasetItemId: `item-${index}`,
          repetition: 1,
          input: `Question ${index}`,
          output: `Answer ${index}`,
          durationMs: 1,
          scores: [{ evaluatorId: "exact", score: index / 2, passed: index > 0, durationMs: 1 }],
        }],
      });
    }

    const page = await store.listRuns({ experimentId: "experiment", limit: 2, offset: 0 });
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(page.items.map((run) => run.id)).toEqual(["run-2", "run-1"]);
    expect(page.items[0]).toMatchObject({ resultCount: 1, failedResultCount: 0 });
    expect(page.items[0]).not.toHaveProperty("results");
    expect((await store.getRun("run-0"))?.results[0]?.output).toBe("Answer 0");
  });

  it("attaches trajectory evaluations to a Session, Turn, or Span", async () => {
    const sessions = new PostgresSessionRepository(database);
    await sessions.upsertIndexedSession(
      {
        sessionKey: "codex:evaluation",
        rawId: "evaluation",
        source: "codex-cli",
        projectPath: "/repo",
        filePath: "/fixture/evaluation.jsonl",
        originalTitle: "Evaluate trajectory",
        firstQuestion: "Evaluate this",
        timestamp: 1_000,
        fileMtimeMs: 1_000,
        fileSize: 10,
        prUrl: null,
        prNumber: null,
      },
      [{
        role: "user",
        content: "Run the test",
        timestamp: new Date(1_000).toISOString(),
        index: 0,
      }],
      [],
      [{
        index: 0,
        kind: "tool_call",
        source: "codex",
        title: "shell",
        detail: "{}",
        timestamp: new Date(1_100).toISOString(),
        callId: "call-1",
        status: "success",
      }],
    );
    const identifiers = (await database.query<{ turn_id: string; span_id: string }>(`
      select t.id as turn_id, s.id as span_id
        from agent_recall.session_turns t
        join agent_recall.trace_spans s on s.turn_id = t.id
       where t.session_key = 'codex:evaluation'
    `)).rows[0];
    const subjects = [
      { type: "session" as const, sessionKey: "codex:evaluation" },
      { type: "turn" as const, turnId: identifiers.turn_id },
      { type: "span" as const, spanId: identifiers.span_id },
    ];
    for (const [index, subject] of subjects.entries()) {
      await store.saveTrajectoryResult({
        id: `trajectory-${index}`,
        subject,
        metric: "quality",
        score: 0.9,
        passed: true,
        evidence: { observed: true },
        createdAt: 2_000 + index,
      });
      expect(await store.listTrajectoryResults(subject)).toEqual([
        expect.objectContaining({
          id: `trajectory-${index}`,
          score: 0.9,
          evidence: { observed: true },
        }),
      ]);
    }

    await sessions.deleteSessionRecord("codex:evaluation");
    const remaining = await database.query<{ count: number }>(
      "select count(*)::integer as count from agent_recall.evaluation_results",
    );
    expect(remaining.rows[0].count).toBe(0);
  });
});
