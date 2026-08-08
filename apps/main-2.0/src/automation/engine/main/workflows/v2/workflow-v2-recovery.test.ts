import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { sanitizeWorkflowTransactionValue } from "../../../shared/workflow-v2/transaction";
import {
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2NodeCacheFingerprint,
  type WorkflowV2PersistedRunState,
} from "../../../shared/workflow-v2/storage";
import { buildWorkflowV2Plan } from "./workflow-v2-planner";
import { transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";
import {
  acceptedWorkflowV2WorkerOutputs,
  buildWorkflowV2FinalReport,
  buildWorkflowV2RecoveryPreview,
  buildWorkflowV2RecoveryPlan,
  createWorkflowV2NodeCacheFingerprint,
  materializeWorkflowV2Recovery,
  parseWorkflowV2RecoveryManagerRecommendation,
} from "./workflow-v2-recovery";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-recovery",
    graphVersion: 1,
    objective: "Recover completed and paused work",
    nodes: [
      { id: "first", kind: "worker", title: "First", execModel: "llm",
        executionMode: "one-shot", prompt: "First", outputFields: [{ key: "value", required: true }] },
      { id: "second", kind: "worker", title: "Second", execModel: "llm",
        executionMode: "one-shot", prompt: "Second", outputFields: [{ key: "value", required: true }] },
    ],
    edges: [{ fromNodeId: "first", toNodeId: "second" }],
  };
}

test("keeps an unreviewed paused candidate out of accepted report outputs", () => {
  const runState = createWorkflowV2RunState({ definition: definition() });
  const paused = transitionWorkflowV2NodeState(runState, { nodeId: "first", status: "paused", now: 2 });

  expect(acceptedWorkflowV2WorkerOutputs(paused, [{ nodeId: "first", summary: "Unreviewed candidate", outputs: { value: "draft" }, proposals: [] }])).toEqual([]);
});

test("redacts quoted secret fields embedded in Review trace text", () => {
  const trace = 'Reviewer input:\n{"token":"secret-token","answer":"safe"}';

  expect(sanitizeWorkflowTransactionValue(trace)).toBe('Reviewer input:\n{"token":"[REDACTED]","answer":"safe"}');
});

async function persisted(): Promise<WorkflowV2PersistedRunState> {
  const workflow = definition();
  const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
  let runState = createWorkflowV2RunState({ definition: workflow });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "first", status: "running", now: 1_100 });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "first", status: "completed", now: 1_200 });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "second", status: "running", now: 1_300 });
  runState = transitionWorkflowV2NodeState(runState, {
    nodeId: "second",
    status: "paused",
    now: 1_400,
    error: "Needs input",
  });
  return {
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: workflow.workflowId,
    runId: "run-1",
    graphVersion: workflow.graphVersion,
    savedAt: 1_500,
    eventCount: 2,
    plan,
    runState,
    workerOutputs: [{ nodeId: "first", summary: "done", outputs: { value: 1 }, proposals: [] }],
    nodeControl: {
      first: { extensionCount: 0 },
      second: { extensionCount: 1, checkpoint: "checkpoint-2", stopReason: "Needs input" },
    },
  };
}

function fingerprint(graphVersion = 1): WorkflowV2NodeCacheFingerprint {
  return {
    graphVersion,
    nodeDefinitionHash: "node",
    upstreamOutputHash: "upstream",
    modelProfile: "fast",
  };
}

describe("workflow-v2 recovery", () => {
  test("builds a recovery preview from uncertain operations and workspace facts", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: {
        transactionId: "transaction-1",
        mode: "strict_atomic",
        status: "recovery_required",
        baselineId: "baseline-1",
        currentSavepointId: "savepoint-1",
        currentSavepointOperationIds: ["operation-1"],
        operationCount: 2,
        unknownOperationCount: 1,
        irreversibleOperationCount: 0,
        startedAt: 1_000,
        updatedAt: 1_500,
        retentionUntil: 2_000,
      },
      operations: [{
        operationId: "operation-1",
        transactionId: "transaction-1",
        runId: "run-1",
        nodeId: "second",
        attempt: 1,
        kind: "http",
        target: "https://example.test/resource",
        idempotencyKey: "key-1",
        state: "unknown",
        reversible: true,
        createdAt: 1_200,
        updatedAt: 1_400,
        error: "request timed out",
      }],
      runState: state.runState,
      workspaceDiff: { created: ["new.txt"], modified: ["changed.txt"], deleted: [], conflicts: ["changed.txt"] },
      canRollbackSavepoint: true,
      now: 1_600,
    });

    expect(preview).toMatchObject({
      status: "recovery_required",
      changedPaths: ["changed.txt", "new.txt"],
      conflicts: ["changed.txt"],
      uncertainNodeIds: ["second"],
      availableActions: ["rollback_savepoint", "keep_state", "abandon"],
    });
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("operation-1: unknown"),
      expect.stringContaining("Workspace conflicts"),
    ]));
    expect(preview.managerRecommendation).toMatchObject({
      recommendedAction: "keep_state",
      rollbackTarget: "savepoint-1",
      manualSteps: [expect.stringContaining("operation-1")],
    });
    expect(preview.managerRecommendation.riskComparison.map((item) => item.action)).toEqual(preview.availableActions);
  });

  test("fails closed when a savepoint rollback would strand later external operations", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: {
        transactionId: "transaction-1", mode: "strict_atomic", status: "recovery_required", baselineId: "baseline-1",
        currentSavepointId: "savepoint-1", currentSavepointOperationIds: [], operationCount: 1, unknownOperationCount: 0,
        irreversibleOperationCount: 0, startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000,
      },
      operations: [{
        operationId: "operation-after-savepoint", transactionId: "transaction-1", runId: "run-1", nodeId: "second", attempt: 1,
        kind: "http", target: "https://example.test/resource", idempotencyKey: "key-after-savepoint", state: "applied",
        reversible: true, createdAt: 1_200, updatedAt: 1_400,
      }],
      runState: state.runState,
      workspaceDiff: { created: [], modified: ["changed.txt"], deleted: [] },
      canRollbackSavepoint: true,
      canCompensate: true,
      compensableOperationIds: ["operation-after-savepoint"],
      now: 1_600,
    });

    expect(preview.availableActions).not.toContain("rollback_savepoint");
    expect(preview.availableActions).toContain("compensate_all");
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.stringContaining("operation-after-savepoint")]));
    expect(preview.managerRecommendation.rollbackTarget).toBeUndefined();
  });

  test("does not offer or recommend continuation when the run has no remaining work", async () => {
    const transaction = {
      transactionId: "transaction-1", mode: "strict_atomic" as const, status: "waiting_for_user" as const, baselineId: "baseline-1",
      operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0,
      startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000,
    };
    const runState = createWorkflowV2RunState({ definition: definition() });
    runState.status = "completed";
    for (const nodeId of runState.nodeOrder) runState.nodes[nodeId]!.status = "completed";
    runState.nodes.first!.status = "completed_with_override";

    const preview = buildWorkflowV2RecoveryPreview({ transaction, operations: [], runState });

    expect(preview.availableActions).not.toContain("continue");
    expect(preview.managerRecommendation.recommendedAction).toBe("keep_state");
  });

  test("blocks continuation when a strict run loses its isolated workspace", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: {
        transactionId: "transaction-1", mode: "strict_atomic", status: "waiting_for_user", baselineId: "baseline-1",
        operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0,
        startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000,
      },
      operations: [],
      runState: state.runState,
      workspaceAvailable: false,
    });

    expect(preview.availableActions).not.toContain("continue");
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.stringContaining("isolated workflow workspace is unavailable")]));
    expect(preview.managerRecommendation.recommendedAction).toBe("keep_state");
  });

  test("blocks continuation when the durable operation ledger cannot be read", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: {
        transactionId: "transaction-1", mode: "strict_atomic", status: "recovery_required", baselineId: "baseline-1",
        operationCount: 1, unknownOperationCount: 1, irreversibleOperationCount: 0,
        startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000,
      },
      operations: [],
      runState: state.runState,
      workspaceAvailable: true,
      operationLedgerAvailable: false,
    });

    expect(preview.availableActions).not.toContain("continue");
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.stringContaining("operation ledger is unavailable")]));
    expect(preview.managerRecommendation.recommendedAction).toBe("keep_state");
  });

  test("creates read-only three-way conflict candidates without applying a merge", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: { transactionId: "transaction-1", mode: "strict_atomic", status: "recovery_required", baselineId: "baseline-1", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000 },
      operations: [],
      runState: state.runState,
      workspaceDiff: { created: [], modified: ["workflow-only.txt", "both.txt"], deleted: [], conflicts: ["workflow-only.txt", "both.txt"] },
      conflictDetails: [
        { path: "workflow-only.txt", baseline: { exists: true, sha256: "baseline" }, isolated: { exists: true, sha256: "isolated" }, current: { exists: true, sha256: "baseline" } },
        { path: "both.txt", baseline: { exists: true, sha256: "baseline" }, isolated: { exists: true, sha256: "isolated" }, current: { exists: true, sha256: "current" } },
      ],
      now: 1_600,
    });

    expect(preview.managerRecommendation.conflictCandidates).toEqual([
      expect.objectContaining({ path: "workflow-only.txt", resolution: "isolated" }),
      expect.objectContaining({ path: "both.txt", resolution: "manual" }),
    ]);
    expect(preview.managerRecommendation.manualSteps).toEqual([expect.stringContaining("both.txt")]);
  });

  test("exposes a required policy checkpoint as an approval blocker while allowing confirmation", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: { transactionId: "transaction-1", mode: "strict_atomic", status: "waiting_for_user", baselineId: "baseline-1", pendingCheckpointId: "publish-draft", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000 },
      operations: [],
      runState: state.runState,
      workspaceDiff: { created: [], modified: ["result.txt"], deleted: [] },
      now: 1_600,
    });

    expect(preview.blockers).toContain("Checkpoint publish-draft requires approval before the frozen run can continue.");
    expect(preview.availableActions).toContain("continue");
  });

  test("uses the terminal node Markdown output as the completed user report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [
      { nodeId: "first", summary: "Prepared", outputs: { value: "context" }, proposals: [] },
      { nodeId: "second", summary: "Answered", outputs: { answer_markdown: "# Final answer\n\nUseful result." }, proposals: [] },
    ], "completed");
    expect(report).toContain("# Final answer\n\nUseful result.");
    expect(report).toContain("## Node timeline");
    expect(report).toContain("## File diff");
    expect(report).not.toContain("Node outputs");
  });

  test("uses a terminal script output field as the completed user report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [
      { nodeId: "first", summary: "Prepared", outputs: { value: "context" }, proposals: [] },
      { nodeId: "second", summary: "Echoed", outputs: { output: "原样内容" }, proposals: [] },
    ], "completed");
    expect(report).toContain("原样内容");
    expect(report).toContain("## Node timeline");
  });

  test("uses the inspected transaction diff for the final file report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [{
      nodeId: "first",
      summary: "Prepared",
      outputs: {},
      proposals: [],
      acceptance: { outcome: "clean", issues: [], changedPaths: ["worker-reported.txt"], operationIds: [] },
    }], "completed", [], [], {
      created: ["hook-created.txt"],
      modified: ["actual-modified.txt"],
      deleted: ["removed.txt"],
      evidenceDigest: "workspace-evidence",
    });

    expect(report).toContain("- created: hook-created.txt");
    expect(report).toContain("- modified: actual-modified.txt");
    expect(report).toContain("- deleted: removed.txt");
    expect(report).not.toContain("- changed: worker-reported.txt");
  });

  test("includes recovery decisions, external operation states, and manual steps in reports", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [], "failed", [{
      decisionId: "decision-1",
      transactionId: "transaction-1",
      action: "keep_state",
      actor: "operator",
      reason: "Waiting for verification with Bearer secret-token.",
      operationIds: ["operation-1"],
      decidedAt: 1_500,
    }], [{
      operationId: "operation-1",
      transactionId: "transaction-1",
      runId: "run-1",
      nodeId: "second",
      attempt: 1,
      kind: "http",
      target: "https://example.test/resource",
      idempotencyKey: "key-1",
      state: "unknown",
      reversible: true,
      requestSummary: { method: "POST", Authorization: "Bearer secret", recipient: "ops@example.test" },
      receipt: { providerId: "remote-1", token: "secret" },
      createdAt: 1_200,
      updatedAt: 1_400,
    }, {
      operationId: "operation-irreversible",
      transactionId: "transaction-1",
      runId: "run-1",
      nodeId: "second",
      attempt: 1,
      kind: "message",
      target: "team-room",
      idempotencyKey: "key-irreversible",
      state: "applied",
      reversible: false,
      receipt: { messageId: "sent-message" },
      createdAt: 1_300,
      updatedAt: 1_500,
    }]);

    expect(report).toContain("## External operations");
    expect(report).toContain("operation-1: http unknown");
    expect(report).toContain('request={"method":"POST","Authorization":"[REDACTED]","recipient":"ops@example.test"}');
    expect(report).toContain('receipt={"providerId":"remote-1","token":"[REDACTED]"}');
    expect(report).toContain("1. operation-1: unknown; updated=1970-01-01T00:00:01.400Z");
    expect(report).not.toContain("Bearer secret");
    expect(report).toContain("## Recovery decisions");
    expect(report).toContain("keep_state by operator");
    expect(report).toContain("Bearer [REDACTED]");
    expect(report).not.toContain("secret-token");
    expect(report).toContain("## Manual steps");
    expect(report).toContain("Verify operation-1 in the external system");
    expect(report).toContain("Manually reconcile operation-irreversible");
  });

  test("accepts only Manager Agent recommendations bound to the current recovery facts", async () => {
    const state = await persisted();
    const preview = buildWorkflowV2RecoveryPreview({
      transaction: { transactionId: "transaction-1", mode: "strict_atomic", status: "recovery_required", baselineId: "baseline-1", currentSavepointId: "savepoint-1", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1_000, updatedAt: 1_500, retentionUntil: 2_000 },
      operations: [], runState: state.runState, workspaceDiff: { created: [], modified: ["both.txt"], deleted: [], conflicts: ["both.txt"] }, conflictDetails: [{ path: "both.txt", baseline: { exists: true, sha256: "baseline" }, isolated: { exists: true, sha256: "isolated" }, current: { exists: true, sha256: "current" } }], canRollbackSavepoint: true,
    });
    const recommendation = parseWorkflowV2RecoveryManagerRecommendation(JSON.stringify({ recommendedAction: "keep_state", rationale: "Preserve evidence.", rollbackTarget: "savepoint-1", compensationOperationIds: [], manualSteps: ["Review both.txt"], riskComparison: preview.availableActions.map((action) => ({ action, risk: action === "keep_state" ? "low" : "medium", detail: `${action} risk.` })), conflictCandidates: [{ path: "both.txt", resolution: "manual", rationale: "Both sides changed." }] }), preview);
    expect(recommendation).toMatchObject({ transactionId: "transaction-1", recommendedAction: "keep_state", conflictCandidates: [{ path: "both.txt", resolution: "manual" }] });
    expect(() => parseWorkflowV2RecoveryManagerRecommendation(JSON.stringify({ recommendedAction: "continue", rationale: "unsafe", compensationOperationIds: [], manualSteps: [], riskComparison: [], conflictCandidates: [] }), preview)).toThrow("unavailable action");
  });

  test("appends transactional acceptance evidence to the completed user report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [
      { nodeId: "first", summary: "Prepared", outputs: { value: "context" }, proposals: [] },
      {
        nodeId: "second",
        summary: "Answered",
        outputs: { answer_markdown: "# Final answer" },
        proposals: [],
        acceptance: {
          outcome: "degraded",
          changedPaths: ["result.md"],
          operationIds: ["operation-1"],
          issues: [{ code: "tool_retry", severity: "warning", detail: "A failed tool call was retried successfully." }],
        },
      },
    ], "completed");

    expect(report).toContain("# Final answer");
    expect(report).toContain("## Transactional node acceptance");
    expect(report).toContain("result.md");
    expect(report).toContain("operation-1");
    expect(report).toContain("tool_retry");
  });

  test("reuses completed work and resumes a checkpoint under the same graph version", async () => {
    const state = await persisted();
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition: definition(),
      targetFingerprints: new Map(),
      cacheEntries: new Map(),
    });

    expect(recovery.decisions).toEqual([
      expect.objectContaining({ nodeId: "first", action: "reuse", cachedOutput: state.workerOutputs[0] }),
      expect.objectContaining({ nodeId: "second", action: "resume", checkpoint: "checkpoint-2" }),
    ]);
  });

  test("reuses a result accepted with human override under the same graph version", async () => {
    const state = await persisted();
    state.runState.nodes.first!.status = "completed_with_override";

    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition: definition(),
      targetFingerprints: new Map(),
      cacheEntries: new Map(),
    });

    expect(recovery.decisions[0]).toMatchObject({
      nodeId: "first",
      action: "reuse",
      cachedOutput: state.workerOutputs[0],
    });
  });

  test("reuses changed-graph work only with an exact target fingerprint", async () => {
    const state = await persisted();
    const target = fingerprint(2);
    const targetDefinition = { ...definition(), graphVersion: 2 };
    const cache: WorkflowV2CacheEntryMetadata = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: state.workflowId,
      nodeId: "first",
      graphVersion: 2,
      fingerprint: target,
      output: { nodeId: "first", summary: "cached", outputs: { value: 2 }, proposals: [] },
      savedAt: 2_000,
    };
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map([["first", target]]),
      cacheEntries: new Map([["first", cache]]),
    });

    expect(recovery.decisions[0]).toMatchObject({ nodeId: "first", action: "reuse", cachedOutput: cache.output });
    expect(recovery.decisions[1]).toMatchObject({ nodeId: "second", action: "rerun" });
  });

  test("invalidates a node and its downstream nodes when a fingerprint changes", async () => {
    const state = await persisted();
    const targetDefinition = { ...definition(), graphVersion: 2 };
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map([["first", fingerprint(2)]]),
      cacheEntries: new Map([["first", {
        schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
        workflowId: state.workflowId,
        nodeId: "first",
        graphVersion: 2,
        fingerprint: { ...fingerprint(2), reviewerPolicyHash: "old" },
        output: { nodeId: "first", summary: "stale", outputs: { value: 1 }, proposals: [] },
        savedAt: 2_000,
      }]]),
    });

    expect(recovery.decisions).toEqual([
      expect.objectContaining({ nodeId: "first", action: "rerun" }),
      expect.objectContaining({ nodeId: "second", action: "rerun", reason: "An upstream node is not reusable." }),
    ]);
  });

  test("builds deterministic fingerprints from canonical object key order", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const node = workflow.nodes[0]!;
    const planNode = plan.nodes[0]!;
    const left = createWorkflowV2NodeCacheFingerprint({
      graphVersion: 1,
      node,
      planNode,
      upstreamOutputs: [],
      executionEnvironment: { b: 2, a: 1 },
    });
    const right = createWorkflowV2NodeCacheFingerprint({
      graphVersion: 1,
      node,
      planNode,
      upstreamOutputs: [],
      executionEnvironment: { a: 1, b: 2 },
    });
    expect(left).toEqual(right);
  });

  test("materializes reusable outputs while leaving checkpoint work runnable", async () => {
    const state = await persisted();
    const targetDefinition = definition();
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map(),
      cacheEntries: new Map(),
    });

    const materialized = materializeWorkflowV2Recovery({ persisted: state, targetDefinition, recovery });

    expect(materialized.checkpoint.runState.nodes.first?.status).toBe("completed");
    expect(materialized.checkpoint.runState.nodes.second?.status).toBe("ready");
    expect(materialized.checkpoint.workerOutputs).toEqual(state.workerOutputs);
    expect(materialized.recoveryCheckpoints.get("second")).toBe("checkpoint-2");
  });
});
