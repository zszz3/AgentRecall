import { describe, expect, test } from "vitest";
import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import type { WorkflowDefinition, WorkflowRun } from "../../../shared/workflow/model";
import { PostgresWorkflowCoreRepository } from "./postgres-workflow-core-repository";

function definition(): WorkflowDefinition {
  return {
    id: "workflow",
    name: "Workflow",
    description: "Structured Workflow",
    inputs: [],
    nodes: [{
      id: "answer",
      kind: "agent",
      title: "Answer",
      goal: "Answer.",
      agentId: "agent",
      instructions: [],
      constraints: [],
      inputs: [],
      outputs: [{ key: "answer", name: "Answer", description: "Answer", type: "text", required: true }],
      acceptanceCriteria: [],
    }],
    createdAt: 10,
    updatedAt: 20,
  };
}

function run(status: WorkflowRun["status"] = "completed"): WorkflowRun {
  return {
    id: "run",
    workflowId: "workflow",
    definition: definition(),
    inputs: { question: "Why?" },
    status,
    nodeRuns: {
      answer: {
        nodeId: "answer",
        status: status === "running" ? "running" : "completed",
        attempt: 1,
        resolvedInputs: {},
        revisionFeedback: ["Add evidence."],
        outputs: status === "running" ? undefined : { answer: "Because." },
        startedAt: 30,
        finishedAt: status === "running" ? undefined : 40,
      },
    },
    events: [{ sequence: 1, type: "run_started", timestamp: 30 }],
    startedAt: 30,
    finishedAt: status === "running" ? undefined : 40,
  };
}

describe("PostgresWorkflowCoreRepository", () => {
  test("round trips structured definitions and complete node outputs", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database);

    await repository.saveDefinition(definition());
    await repository.saveRun(run());

    await expect(repository.listDefinitions()).resolves.toEqual([definition()]);
    await expect(repository.getRun("run")).resolves.toEqual(run());
    const withPlanning: WorkflowDefinition = { ...definition(), planning: {
      agentId: "agent", messages: [{ role: "user", content: "请总结文档" }, { role: "assistant", content: "面向谁阅读？" }],
      proposal: { name: "Proposal", description: "Pending user confirmation", inputs: [], nodes: definition().nodes },
    } };
    await repository.saveDefinition(withPlanning);
    const reloaded = new PostgresWorkflowCoreRepository(database);
    await expect(reloaded.getDefinition("workflow")).resolves.toEqual(withPlanning);
    // The historical run remains the original definition with no authoring metadata.
    await expect(reloaded.getRun("run")).resolves.toEqual(run());
    await database.close();
  });

  test("strips nested output schema data at the persistence boundary", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database);
    const value = definition();
    Object.assign(value.nodes[0]!.outputs[0]!, {
      fields: [{ key: "nested", name: "Nested", description: "Legacy nested field", type: "text", required: true }],
      item: { key: "item", name: "Item", description: "Legacy item", type: "text", required: true },
    });
    Object.assign(value.nodes[0]!, {
      inputs: [{ key: "workspace", name: "Workspace", description: "Legacy node-local workspace", required: true, source: "workspace", path: "." }],
    });

    await repository.saveDefinition(value);

    await expect(repository.getDefinition(value.id)).resolves.toEqual(definition());
    await database.close();
  });

  test("persists a Workflow-specific directory and an explicit clear as null", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database);
    const selected = { ...definition(), workDir: "/workflow-project" };
    await repository.saveDefinition(selected);
    await expect(repository.getDefinition(selected.id)).resolves.toEqual(selected);

    const cleared = { ...selected, workDir: null };
    await repository.saveDefinition(cleared);
    await expect(repository.getDefinition(cleared.id)).resolves.toEqual(cleared);
    await expect(database.query<{ definition: unknown }>("select definition from agent_recall.workflows where id = $1", [cleared.id]))
      .resolves.toMatchObject({ rows: [{ definition: expect.objectContaining({ workDir: null }) }] });
    await database.close();
  });

  test("marks interrupted runs and active nodes failed on startup", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database, () => 100);
    await repository.saveDefinition(definition());
    await repository.saveRun(run("running"));

    await repository.markInterruptedRunsFailed();

    const interrupted = await repository.getRun("run");
    expect(interrupted).toMatchObject({ status: "failed", finishedAt: 100 });
    expect(interrupted?.nodeRuns.answer).toMatchObject({
      status: "failed",
      finishedAt: 100,
      error: { code: "app_restarted", message: "The application restarted while this node was running." },
    });
    await database.close();
  });
});
