import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationStore } from "./evaluation-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("EvaluationStore", () => {
  it("round-trips Judge evidence and failed criteria", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "evaluation-store-"));
    tempDirs.push(dir);
    const store = new EvaluationStore(path.join(dir, "app.db"));
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
    store.close();
  });

  it("pages lightweight run summaries and loads full results only on demand", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "evaluation-store-page-"));
    tempDirs.push(dir);
    const store = new EvaluationStore(path.join(dir, "app.db"));
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
    store.close();
  });
});
