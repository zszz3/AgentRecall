import { describe, expect, test } from "vitest";
import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import { PostgresWorkflowRepository } from "./postgres-workflow-repository";

describe("PostgresWorkflowRepository portable metadata", () => {
  test("round trips origin and execution-review fields", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowRepository();
    const origin = {
      importedFrom: { fileName: "fixture.agentrecall-workflow.json", workflowId: "source", title: "Source", revision: 4, importedAt: 10 },
      rootOrigin: { kind: "official", workflowId: "official", title: "Official", revision: 2, clonedAt: 5, trust: "file_claim" },
    };
    await repository.replace(database, {
      activeWorkflowId: "wf-imported",
      workflows: [{
        workflowId: "wf-imported", title: "Imported", status: "draft", revision: 3, confirmedRevision: 3,
        configuredAgentId: "agent", modelId: "model", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model",
        objective: "Objective", reply: "", runContextDocument: "", contextDocument: "", messages: [], runProgress: [], runIds: [],
        definition: { workflowId: "wf-imported", graphVersion: 1, objective: "Objective", nodes: [], edges: [] },
        sourceType: "user", topologyLocked: false, origin, generationReview: { status: "approved", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model", reviewedRevision: 3, updatedAt: 10 },
        createdAt: 1, updatedAt: 2,
      }],
      runs: [],
    });

    const loaded = await repository.load(database, "wf-imported");
    expect((loaded.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({ origin, confirmedRevision: 3, reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model", generationReview: { status: "approved" } });
    await database.close();
  });
});
