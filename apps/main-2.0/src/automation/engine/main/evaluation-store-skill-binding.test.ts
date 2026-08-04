import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../core/postgres/schema";
import { PGliteTestPool } from "../../../core/postgres/test-pglite";
import { EvaluationStore } from "./evaluation-store";

describe("PostgreSQL evaluation store skill binding (phase four)", () => {
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

  it("round-trips skill_name and skill_hash on experiments", async () => {
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
      name: "basic regression",
      datasetId: "dataset-1",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 2,
      skillName: "review",
      skillHash: "abc123",
      createdAt: now,
      updatedAt: now,
    });

    const experiments = await store.listExperiments();
    expect(experiments).toHaveLength(1);
    expect(experiments[0].skillName).toBe("review");
    expect(experiments[0].skillHash).toBe("abc123");
  });

  it("keeps legacy experiments without skill columns readable", async () => {
    const now = Date.now();
    await store.saveDataset({
      id: "dataset-2",
      name: "legacy",
      description: "",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-legacy",
      name: "legacy experiment",
      datasetId: "dataset-2",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });

    const experiments = await store.listExperiments();
    expect(experiments).toHaveLength(1);
    expect(experiments[0].skillName).toBeNull();
    expect(experiments[0].skillHash).toBeNull();
  });

  it("updates skill_hash in place on re-save", async () => {
    const now = Date.now();
    await store.saveDataset({
      id: "dataset-3",
      name: "cases",
      description: "",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-3",
      name: "suite",
      datasetId: "dataset-3",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      skillName: "review",
      skillHash: "old-hash",
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-3",
      name: "suite",
      datasetId: "dataset-3",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      skillName: "review",
      skillHash: "new-hash",
      createdAt: now,
      updatedAt: now + 1,
    });

    const experiments = await store.listExperiments();
    expect(experiments).toHaveLength(1);
    expect(experiments[0].skillHash).toBe("new-hash");
  });

  it("attributes runs to the executing skill version and keeps the first attribution", async () => {
    const now = Date.now();
    await store.saveDataset({
      id: "dataset-4",
      name: "cases",
      description: "",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-4",
      name: "suite",
      datasetId: "dataset-4",
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      skillName: "review",
      skillHash: "hash-a",
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRun({
      id: "run-1",
      experimentId: "experiment-4",
      status: "running",
      skillHash: "hash-a",
      startedAt: now,
      results: [],
    });
    // Later snapshots of the same run carry no hash; the original attribution
    // must survive the upsert.
    await store.saveRun({
      id: "run-1",
      experimentId: "experiment-4",
      status: "completed",
      startedAt: now,
      finishedAt: now + 100,
      results: [],
    });

    const run = await store.getRun("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.skillHash).toBe("hash-a");

    const page = await store.listRuns({ experimentId: "experiment-4" });
    expect(page.items[0].skillHash).toBe("hash-a");
  });
});
