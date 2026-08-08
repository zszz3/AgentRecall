import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { WORKFLOW_V2_STORAGE_SCHEMA_VERSION, type WorkflowV2PersistedRunState } from "../../../shared/workflow-v2/storage";
import { buildWorkflowV2Plan } from "./workflow-v2-planner";
import { WorkflowV2FileStore } from "./workflow-v2-store";
import { WorkflowV2RunPersistence } from "./workflow-v2-run-persistence";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowCommitPlan } from "../../../shared/workflow-v2/transaction";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function persistedState(): Promise<WorkflowV2PersistedRunState> {
  const definition = {
    workflowId: "workflow-1",
    graphVersion: 1,
    objective: "Persist the run",
    nodes: [{
      id: "node-1",
      kind: "worker",
      title: "Worker",
      execModel: "llm" as const,
      executionMode: "one-shot" as const,
      prompt: "Work",
      outputFields: [{ key: "result", required: true }],
    }],
    edges: [],
  };
  const plan = await buildWorkflowV2Plan({ definition, approvedBy: "tester", now: 1_000 });
  return {
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: definition.workflowId,
    runId: "run-1",
    graphVersion: definition.graphVersion,
    savedAt: 2_000,
    eventCount: 0,
    plan,
    runState: createWorkflowV2RunState({ definition }),
    workerOutputs: [],
    nodeControl: { "node-1": { extensionCount: 0 } },
  };
}

describe("workflow-v2 file store", () => {
  test("atomically writes and reloads authoritative run state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-store-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.nodeControl["node-1"]!.interventionResolution = {
      action: "continue",
      reason: "Approved by the operator.",
      resolvedAt: 1_900,
    };

    await store.persistRunState(state);

    expect(await store.readRunState("workflow-1", "run-1")).toEqual(state);
    expect(state.runState.maxParallelNodes).toBe(Number.MAX_SAFE_INTEGER);
    const layout = store.layout("workflow-1", "run-1");
    expect((await readdir(layout.runDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("serializes concurrent event appends from independent stores", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-events-"));
    temporaryDirectories.push(root);
    const firstStore = new WorkflowV2FileStore(root);
    const secondStore = new WorkflowV2FileStore(root);

    await Promise.all([
      firstStore.appendEvents({
        workflowId: "workflow-1",
        runId: "run-1",
        events: [{ sequence: 0, workflowId: "workflow-1", runId: "run-1", type: "started", at: 1 }],
      }),
      secondStore.appendEvents({
        workflowId: "workflow-1",
        runId: "run-1",
        events: [{ sequence: 1, workflowId: "workflow-1", runId: "run-1", type: "paused", at: 2 }],
      }),
    ]);

    expect(await firstStore.readEvents("workflow-1", "run-1")).toEqual([
      { sequence: 0, workflowId: "workflow-1", runId: "run-1", type: "started", at: 1 },
      { sequence: 1, workflowId: "workflow-1", runId: "run-1", type: "paused", at: 2 },
    ]);
  });

  test("cleans only expired committed materials and preserves recovery evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-retention-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const committed = await persistedState();
    committed.transaction = {
      transactionId: "transaction-committed",
      mode: "strict_atomic",
      status: "committed",
      baselineId: "baseline-committed",
      operationCount: 0,
      unknownOperationCount: 0,
      irreversibleOperationCount: 0,
      startedAt: 1_000,
      updatedAt: 2_000,
      retentionUntil: 2_000,
    };
    const recovery = structuredClone(committed);
    recovery.runId = "run-recovery";
    recovery.transaction = { ...committed.transaction, transactionId: "transaction-recovery", status: "recovery_required" };
    await store.persistRunState(committed);
    await store.persistRunState(recovery);

    await expect(store.cleanupExpiredRuns(3_000)).resolves.toEqual([{ workflowId: "workflow-1", runId: "run-1" }]);
    await expect(store.readRunState("workflow-1", "run-1")).resolves.toBeUndefined();
    await expect(store.readRunState("workflow-1", "run-recovery")).resolves.toMatchObject({ transaction: { status: "recovery_required" } });
  });

  test("allows explicit cleanup only for committed or fully rolled back runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-manual-cleanup-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const committed = await persistedState();
    committed.transaction = { transactionId: "transaction-committed", mode: "strict_atomic", status: "committed", baselineId: "baseline", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1_000, updatedAt: 2_000, retentionUntil: 99_000 };
    const recovery = structuredClone(committed);
    recovery.runId = "run-recovery";
    recovery.transaction = { ...committed.transaction, transactionId: "transaction-recovery", status: "recovery_required" };
    await store.persistRunState(committed);
    await store.persistRunState(recovery);

    await expect(store.cleanupRunMaterials("workflow-1", "run-recovery")).rejects.toThrow("Only committed or fully rolled back");
    await expect(store.cleanupRunMaterials("workflow-1", "run-1")).resolves.toBeUndefined();

    await expect(store.readRunState("workflow-1", "run-1")).resolves.toBeUndefined();
    await expect(store.readRunState("workflow-1", "run-recovery")).resolves.toBeDefined();
  });

  test("deduplicates exact event retries and rejects conflicting or non-monotonic history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-event-contract-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const started = { sequence: 0, workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", type: "transaction_started", at: 1 };

    await store.appendEvents({ workflowId: "workflow-1", runId: "run-1", events: [started] });
    await store.appendEvents({ workflowId: "workflow-1", runId: "run-1", events: [started] });
    expect(await store.readEvents("workflow-1", "run-1")).toHaveLength(1);
    await expect(store.appendEvents({ workflowId: "workflow-1", runId: "run-1", events: [{ ...started, at: 2 }] })).rejects.toThrow("conflicts");
    await expect(store.appendEvents({ workflowId: "workflow-1", runId: "run-1", events: [{ ...started, sequence: 2, type: "commit_started" }] })).rejects.toThrow("monotonic");
    const state = await persistedState();
    state.eventCount = 0;
    await store.persistRunState(state);
    expect((await store.readRunState("workflow-1", "run-1"))?.eventCount).toBe(1);

  });

  test("serializes concurrent persistence events before assigning sequences", async () => {
    const sequences: number[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persistence = new WorkflowV2RunPersistence({
      store: {
        appendEvents: async ({ events }) => {
          sequences.push(events[0]!.sequence);
          if (sequences.length === 1) await firstWrite;
        },
        persistRunState: async () => undefined,
      },
      workflow: { workflowId: "workflow-1", workDir: "C:/workspace" } as WorkflowDraftState,
      plan: (await persistedState()).plan,
      runId: "run-1",
      initialEventCount: 0,
      nodeControl: {},
      workDir: "C:/workspace",
      configuredAgentId: "agent-1",
      modelId: "model-1",
      configuredAgents: [],
    });

    const first = persistence.appendEvents([{ type: "lease_started", nodeId: "node-1", at: 1 }]);
    const second = persistence.appendEvents([{ type: "lease_started", nodeId: "node-2", at: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await Promise.all([first, second]);

    expect(sequences).toEqual([0, 1]);
  });

  test("persists a redacted idempotent operation ledger and enforces legal transitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-operation-ledger-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.transaction = {
      transactionId: "transaction-1",
      mode: "controlled",
      status: "active",
      baselineId: "baseline-1",
      operationCount: 0,
      unknownOperationCount: 0,
      irreversibleOperationCount: 0,
      startedAt: 1,
      updatedAt: 1,
      retentionUntil: 10_000,
    };
    await store.persistRunState(state);
    const operation = {
      operationId: "operation-1",
      transactionId: "transaction-1",
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      kind: "http" as const,
      target: "https://example.test/resource?token=visible",
      idempotencyKey: "stable-key",
      state: "planned" as const,
      reversible: false,
      adapterId: "http",
      prepared: { plan: { headers: { Authorization: "Bearer visible" } }, value: { token: "visible" } },
      requestSummary: { Authorization: "Bearer visible" },
      createdAt: 2,
      updatedAt: 2,
    };

    await expect(store.planOperation({ workflowId: "workflow-1", record: { ...operation, transactionId: "wrong-transaction" } })).rejects.toThrow("identity does not match");
    expect(await store.readOperations("workflow-1", "run-1")).toEqual([]);

    const planned = await store.planOperation({ workflowId: "workflow-1", record: operation });
    const duplicate = await store.planOperation({ workflowId: "workflow-1", record: { ...operation, operationId: "operation-retry", updatedAt: 3 } });
    expect(duplicate.operationId).toBe(planned.operationId);
    await expect(store.planOperation({ workflowId: "workflow-1", record: { ...operation, operationId: "operation-conflict", target: "https://example.test/different", updatedAt: 3 } })).rejects.toThrow("semantic identity");
    await expect(store.planOperation({ workflowId: "workflow-1", record: { ...operation, operationId: "operation-secret-conflict", requestSummary: { Authorization: "Bearer different-secret" }, updatedAt: 3 } })).rejects.toThrow("semantic identity");
    expect(JSON.stringify(await store.readOperations("workflow-1", "run-1"))).not.toContain("visible");
    await expect(store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", state: "applied", updatedAt: 3 })).rejects.toMatchObject({
      code: "WORKFLOW_OPERATION_INVALID_TRANSITION",
      operationId: "operation-1",
      from: "planned",
      to: "applied",
    });
    await expect(store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", state: "applying", updatedAt: 1 })).rejects.toThrow("must not move backwards");
    await store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", state: "applying", updatedAt: 3 });
    await store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", state: "unknown", updatedAt: 4, error: "Bearer visible" });
    await expect(store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", state: "applied", updatedAt: 5 })).rejects.toThrow("cannot transition");
    expect((await store.readRunState("workflow-1", "run-1"))?.transaction).toMatchObject({ status: "recovery_required", operationCount: 1, unknownOperationCount: 1, irreversibleOperationCount: 1 });
    await expect(store.resolveUnknownOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", verifiedState: "applied", actor: "a".repeat(257), reason: "Verified by remote receipt", updatedAt: 6 })).rejects.toThrow("bounded actor and reason");
    await expect(store.resolveUnknownOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", verifiedState: "applied", actor: "operator", reason: "r".repeat(2_001), updatedAt: 6 })).rejects.toThrow("bounded actor and reason");
    const resolved = await store.resolveUnknownOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-1", verifiedState: "applied", actor: `${" ".repeat(300)}operator`, reason: `Verified by remote receipt${" ".repeat(2_100)}`, evidence: { "X-Api-Key": "must-not-persist" }, updatedAt: 6 });
    expect(resolved).toMatchObject({ state: "applied", receipt: { recoveryResolution: { actor: "operator", reason: "Verified by remote receipt" } } });
    expect(JSON.stringify(resolved)).not.toContain("must-not-persist");
    expect((await store.readRunState("workflow-1", "run-1"))?.transaction).toMatchObject({ status: "waiting_for_user", unknownOperationCount: 0 });
    expect(await store.readEvents("workflow-1", "run-1")).toContainEqual(expect.objectContaining({
      sequence: 0,
      type: "operation_applied",
      operationId: "operation-1",
      nodeId: "node-1",
    }));
    expect((await store.readRunState("workflow-1", "run-1"))?.eventCount).toBe(1);
    await store.planOperation({ workflowId: "workflow-1", record: {
      ...operation,
      operationId: "operation-2",
      idempotencyKey: "discarded-key",
      createdAt: 7,
      updatedAt: 7,
    } });
    await expect(store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-2", state: "discarded", updatedAt: 8 }))
      .resolves.toMatchObject({ state: "discarded" });
    await expect(store.transitionOperation({ workflowId: "workflow-1", runId: "run-1", operationId: "operation-2", state: "applying", updatedAt: 9 }))
      .rejects.toThrow("cannot transition");
    expect((await store.readRunState("workflow-1", "run-1"))?.transaction).toMatchObject({ operationCount: 2, irreversibleOperationCount: 1 });
  });

  test("persists an immutable commit plan and rejects later mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-commit-plan-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.transaction = { transactionId: "transaction-1", mode: "controlled", status: "active", baselineId: "baseline-1", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1, updatedAt: 1, retentionUntil: 10_000 };
    await store.persistRunState(state);
    const plan: WorkflowCommitPlan = {
      schemaVersion: 1,
      commitPlanId: "commit-plan-1",
      transactionId: "transaction-1",
      workflowId: "workflow-1",
      runId: "run-1",
      planDigest: "digest-1",
      createdAt: 2,
      steps: [{ stepId: "workspace", order: 0, kind: "workspace", prerequisites: [], evidenceDigest: "workspace-digest" }],
    };

    await expect(store.persistCommitPlan(plan)).resolves.toEqual(plan);
    await expect(store.persistCommitPlan(structuredClone(plan))).resolves.toEqual(plan);
    await expect(store.persistCommitPlan({ ...plan, planDigest: "mutated" })).rejects.toThrow("immutable");
    await expect(store.readCommitPlan("workflow-1", "run-1")).resolves.toEqual(plan);

    const nextPlan: WorkflowCommitPlan = {
      ...plan,
      commitPlanId: "commit-plan-2",
      planDigest: "digest-2",
      createdAt: 3,
      steps: [{ stepId: "workspace-2", order: 0, kind: "workspace", prerequisites: [], evidenceDigest: "workspace-digest-2" }],
    };
    await expect(store.persistCommitPlan(nextPlan)).resolves.toEqual(nextPlan);
    await expect(store.readCommitPlan("workflow-1", "run-1")).resolves.toEqual(nextPlan);
    await expect(store.persistCommitPlan({ ...plan, planDigest: "mutated-again" })).rejects.toThrow("immutable");
  });

  test("reloads authoritative transaction counters before persisting a later checkpoint", async () => {
    const durable = await persistedState();
    durable.eventCount = 3;
    durable.transaction = {
      transactionId: "transaction-1",
      mode: "direct",
      status: "active",
      baselineId: "baseline-1",
      operationCount: 2,
      unknownOperationCount: 0,
      irreversibleOperationCount: 1,
      startedAt: 1,
      updatedAt: 3,
      retentionUntil: 10_000,
    };
    const writes: WorkflowV2PersistedRunState[] = [];
    const events: string[] = [];
    const persistence = new WorkflowV2RunPersistence({
      store: {
        readRunState: async () => structuredClone(durable),
        appendEvents: async (input) => { events.push(...input.events.map((event) => event.type)); },
        persistRunState: async (state) => { writes.push(structuredClone(state)); },
      },
      workflow: { workflowId: "workflow-1", workDir: "C:/workspace" } as WorkflowDraftState,
      plan: durable.plan,
      runId: "run-1",
      initialEventCount: 0,
      initialTransaction: { ...durable.transaction, operationCount: 0, irreversibleOperationCount: 0 },
      nodeControl: durable.nodeControl,
      workDir: "C:/workspace",
      configuredAgentId: "agent-1",
      modelId: "model-1",
      configuredAgents: [],
    });

    await persistence.persistCheckpoint({ runState: durable.runState, workerOutputs: [] });

    expect(writes.at(-1)?.transaction).toMatchObject({ operationCount: 2, irreversibleOperationCount: 1 });
    expect(writes.at(-1)?.eventCount).toBe(4);
    const failedRunState = structuredClone(durable.runState);
    failedRunState.status = "failed";
    await persistence.persistCheckpoint({ runState: failedRunState, workerOutputs: [] });
    expect(writes.at(-1)?.transaction?.status).toBe("recovery_required");
    expect(events).toContain("recovery_required");
  });

  test("does not commit a completed run while an operation remains unknown", async () => {
    const durable = await persistedState();
    durable.transaction = {
      transactionId: "transaction-1",
      mode: "direct",
      status: "recovery_required",
      baselineId: "baseline-1",
      operationCount: 1,
      unknownOperationCount: 1,
      irreversibleOperationCount: 0,
      startedAt: 1,
      updatedAt: 2,
      retentionUntil: 10_000,
    };
    let written!: WorkflowV2PersistedRunState;
    const events: string[] = [];
    const persistence = new WorkflowV2RunPersistence({
      store: {
        readRunState: async () => structuredClone(durable),
        appendEvents: async ({ events: appended }) => { events.push(...appended.map((event) => event.type)); },
        persistRunState: async (state) => { written = structuredClone(state); },
      },
      workflow: { workflowId: "workflow-1", workDir: "C:/workspace" } as WorkflowDraftState,
      plan: durable.plan,
      runId: "run-1",
      initialEventCount: 0,
      initialTransaction: durable.transaction,
      nodeControl: durable.nodeControl,
      workDir: "C:/workspace",
      configuredAgentId: "agent-1",
      modelId: "model-1",
      configuredAgents: [],
    });
    const completed = structuredClone(durable.runState);
    completed.status = "completed";

    await persistence.persistCheckpoint({ runState: completed, workerOutputs: [] });

    expect(written.transaction).toMatchObject({ status: "recovery_required", unknownOperationCount: 1 });
    expect(events).not.toContain("commit_completed");
  });

  test("persists idempotent node completion submissions outside message history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-completion-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const identity = { workflowId: "workflow-1", runId: "run-1", nodeId: "node-1", executionId: "execution-1" };
    await store.beginNodeCompletionExecution({ ...identity, attempt: 2, startedAt: 10 });

    const first = await store.submitNodeCompletion({
      ...identity,
      output: { nodeId: "node-1", summary: "Done", outputs: { b: 2, a: 1 }, proposals: [] },
      submittedAt: 20,
    });
    const duplicate = await store.submitNodeCompletion({
      ...identity,
      output: { nodeId: "node-1", summary: "Done", outputs: { a: 1, b: 2 }, proposals: [] },
      submittedAt: 21,
    });

    expect(duplicate.submissionId).toBe(first.submissionId);
    expect(await store.readLatestNodeCompletionSubmission(identity)).toMatchObject({ submissionId: first.submissionId, status: "submitted" });
    await store.resolveNodeCompletionSubmission({ ...identity, submissionId: first.submissionId, status: "consumed", resolvedAt: 30 });
    await store.resolveNodeCompletionSubmission({ ...identity, submissionId: first.submissionId, status: "accepted", resolvedAt: 31 });
    expect(await store.readLatestNodeCompletionSubmission(identity)).toBeUndefined();
    await expect(store.submitNodeCompletion({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "stale-execution",
      output: { nodeId: "node-1", summary: "Late", outputs: { value: true }, proposals: [] },
      submittedAt: 40,
    })).rejects.toThrow("not active");
  });

  test("rejects traversal identifiers before touching the filesystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-safe-path-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    expect(() => store.layout("../escape", "run-1")).toThrow("safe path segment");
    expect(() => store.layout("workflow-1", "../../escape")).toThrow("safe path segment");
  });

  test("fails closed on malformed state JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-invalid-state-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const layout = store.layout("workflow-1", "run-1");
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.runStatePath, "{broken", "utf8");

    await expect(store.readRunState("workflow-1", "run-1")).rejects.toThrow("not valid JSON");
  });

  test("rejects non-finite durable numbers instead of silently writing null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-non-finite-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.plan.frozenAt = Number.POSITIVE_INFINITY;

    await expect(store.persistRunState(state)).rejects.toThrow("malformed");
  });

  test("writes cache entries outside run control state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-cache-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    await store.persistCacheEntry({
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: "workflow-1",
      nodeId: "node-1",
      graphVersion: 1,
      fingerprint: {
        graphVersion: 1,
        nodeDefinitionHash: "node",
        upstreamOutputHash: "upstream",
        modelProfile: "fast",
      },
      output: { nodeId: "node-1", summary: "done", outputs: { result: true }, proposals: [] },
      savedAt: 3_000,
    });

    const cachePath = path.join(root, "workflows", "workflow-1", "cache", "graph-1", "node-1.json");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ nodeId: "node-1", graphVersion: 1 });
    expect(await store.readCacheEntry("workflow-1", 1, "node-1")).toMatchObject({
      nodeId: "node-1",
      graphVersion: 1,
      output: { nodeId: "node-1" },
    });
  });
});
