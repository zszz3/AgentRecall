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
      (await store.listRuns("experiment"))[0]?.results[0]?.scores[0],
    ).toMatchObject({
      evidence: ["quoted span"],
      failedCriteria: ["focus"],
    });
    store.close();
  });
});
