import type {
  CleanupWorkflowV2RunRequest,
  AnswerWorkflowGateRequest,
  PauseWorkflowNodeRequest,
  ResolveWorkflowV2InterventionRequest,
  RefreshWorkflowV2RecoveryRequest,
  ResolveWorkflowV2ConflictRequest,
  ResolveWorkflowV2UnknownOperationRequest,
  ResolveWorkflowV2RecoveryRequest,
  RunWorkflowRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  WorkflowOperationResult,
} from "../../shared/workflow/commands";
import type { WorkflowV2InterventionAction } from "../../shared/workflow-v2/review";
import type { RuntimeConversation } from "../../shared/runtime/conversation";
import type { WorkflowDraftState } from "../../shared/workflow/draft";
import { isWorkflowRunTerminalStatus, type WorkflowRunState } from "../../shared/workflow/run";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import type {
  WorkflowV2NodeCompletionLedger,
  WorkflowV2NodeCompletionSubmission,
} from "../../shared/workflow-v2/completion";
import type { WorkflowV2Plan } from "../../shared/workflow-v2/planning";
import { createHash } from "node:crypto";
import path from "node:path";
import { workflowStoragePlanDocument, workflowStoragePlanFor } from "../../shared/workflow-v2/runtime-utils";
import { WorkflowRunRegistry, type ActiveWorkflowRun } from "./workflow-run-registry";
import { WorkflowV2RunExecutor } from "./v2/workflow-v2-run-executor";
import { materializeWorkflowV2OutputArtifacts } from "./v2/workflow-v2-output-artifacts";
import type { WorkflowV2RecoveryOverride } from "./v2/workflow-v2-execution-contract";
import type {
  ExecuteWorkflowV2ScriptRequest,
  WorkflowRuntimeDependencies,
  WorkflowRunStateUpdate,
  WorkflowV2StorePort,
} from "./workflow-runtime-ports";
export type {
  ExecuteWorkflowV2ScriptRequest,
  WorkflowRunStateUpdate,
  WorkflowV2StorePort,
} from "./workflow-runtime-ports";
import { isWorkflowV2InterventionAction } from "../../shared/workflow-v2/review";
import { startWorkflowRun } from "./workflow-run-starter";
import { resolveWorkflowV2ScriptInput } from "./v2/workflow-v2-script-input";
import { WorkflowV2CommitCoordinator } from "./v2/workflow-v2-commit-coordinator";
import { canRollbackWorkflowV2CurrentSavepoint, inspectWorkflowV2RecoveryWorkspace } from "./v2/workflow-v2-recovery-capabilities";
import {
  configuredAgentModelId,
  resolveWorkflowNodeAgent,
  workflowV2ExecutionEnvironment,
  workflowV2InterventionResolutionReason,
  workflowV2LlmNodePrompt,
  workflowV2ReviewerPolicy,
} from "./v2/workflow-v2-node-policy";
export {
  resolveWorkflowNodeAgent,
  workflowV2LlmNodePrompt,
  type WorkflowV2LlmNodeMessages,
} from "./v2/workflow-v2-node-policy";
export { parseWorkflowV2WorkerArtifact } from "./v2/workflow-v2-output-parser";
import {
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2DurableEvent,
  type WorkflowV2NodeCacheFingerprint,
  type WorkflowV2PersistedRunState,
} from "../../shared/workflow-v2/storage";
import {
  buildWorkflowV2FinalReport,
  buildWorkflowV2RecoveryPlan,
  buildWorkflowV2RecoveryPreview,
  createWorkflowV2NodeCacheFingerprint,
  materializeWorkflowV2Recovery,
  workflowV2ReportValue,
} from "./v2/workflow-v2-recovery";
import { transitionWorkflowV2NodeState } from "./v2/workflow-v2-scheduler";
import { createWorkflowV2ScriptApprovalOverride, rejectWorkflowV2ScriptApproval, WorkflowV2ScriptApprovalCoordinator } from "./v2/workflow-v2-script-approval";
import { renewWorkflowTransactionRetention, resolveWorkflowTransactionPolicy, sanitizeWorkflowOperationRecord, sanitizeWorkflowTransactionValue, workflowTransactionPreflightError, type WorkflowTransactionCapabilities, type WorkflowTransactionState } from "../../shared/workflow-v2/transaction";
function workflowAuditText(value: string): string {
  const sanitized = sanitizeWorkflowTransactionValue(value.trim());
  return typeof sanitized === "string" ? sanitized : "[REDACTED]";
}
function withoutWorkflowReportSection(report: string, title: string): string {
  const marker = `\n\n## ${title}\n`;
  const start = report.indexOf(marker);
  if (start < 0) return report;
  const next = report.indexOf("\n\n## ", start + marker.length);
  return next < 0 ? report.slice(0, start) : `${report.slice(0, start)}${report.slice(next)}`;
}
function runtimeTransactionCapabilities(store: WorkflowV2StorePort | undefined): WorkflowTransactionCapabilities {
  return {
    workspaceIsolation: Boolean(store?.prepareWorkspaceTransaction),
    externalOperationBroker: Boolean(store?.planOperation && store.transitionOperation && store.readOperations),
    durableLedger: Boolean(store),
    recoveryApproval: true,
  };
}

class WorkflowV2RecoveryActionCoordinator {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(input: { workflowId: string; runId: string }, action: () => Promise<T>): Promise<T> {
    const key = `${input.workflowId}:${input.runId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.chains.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }
}

export class WorkflowRuntime {
  private readonly runRegistry = new WorkflowRunRegistry();
  private readonly runExecutor: WorkflowV2RunExecutor;
  private readonly scriptApprovalCoordinator = new WorkflowV2ScriptApprovalCoordinator();
  private readonly recoveryActionCoordinator = new WorkflowV2RecoveryActionCoordinator();
  private readonly completionStore: WorkflowV2StorePort | undefined;

  constructor(private readonly deps: WorkflowRuntimeDependencies) {
    this.completionStore = deps.createWorkflowV2Store?.();
    this.runExecutor = new WorkflowV2RunExecutor(deps, this.runRegistry);
  }

  private async awaitRunLeaseRelease(runId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 100 && this.runRegistry.has(runId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !this.runRegistry.has(runId);
  }

  private async workflowV2RecoveryAvailabilityError(run: WorkflowRunState): Promise<string | undefined> {
    if (run.status !== "waiting_for_user" && run.status !== "stopped" && run.status !== "failed") {
      return "Workflow run is not awaiting recovery.";
    }
    return await this.awaitRunLeaseRelease(run.runId)
      ? undefined
      : "Workflow run is still active; wait for the current execution to stop before changing recovery state.";
  }

  async beginNodeCompletionExecution(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    attempt: number;
    startedAt?: number;
  }): Promise<WorkflowV2NodeCompletionLedger | undefined> {
    const store = this.completionStore;
    if (!store?.beginNodeCompletionExecution) return undefined;
    return store.beginNodeCompletionExecution({ ...input, startedAt: input.startedAt ?? Date.now() });
  }

  async submitNodeCompletion(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    output: WorkflowV2WorkerOutput;
  }): Promise<WorkflowV2NodeCompletionSubmission> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    const node = run?.progress.find((item) => item.nodeId === input.nodeId);
    if (!run || !node) throw new Error("Workflow node completion target was not found.");
    if (node.status !== "running" && node.status !== "paused" && node.status !== "awaiting_input") {
      throw new Error(`Workflow node ${input.nodeId} is not accepting completion submissions.`);
    }
    const store = this.completionStore;
    if (!store?.submitNodeCompletion) throw new Error("Workflow node completion storage is unavailable.");
    return store.submitNodeCompletion({ ...input, submittedAt: Date.now() });
  }

  async readLatestNodeCompletionSubmission(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
  }): Promise<WorkflowV2NodeCompletionSubmission | undefined> {
    return this.completionStore?.readLatestNodeCompletionSubmission?.(input);
  }

  async resolveNodeCompletionSubmission(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    submissionId: string;
    status: "consumed" | "accepted" | "rejected";
    reason?: string;
  }): Promise<WorkflowV2NodeCompletionSubmission | undefined> {
    const store = this.completionStore;
    if (!store?.resolveNodeCompletionSubmission) return undefined;
    return store.resolveNodeCompletionSubmission({ ...input, resolvedAt: Date.now() });
  }

  runWorkflow(input: RunWorkflowRequest): WorkflowOperationResult {
    return startWorkflowRun({ request: input, deps: this.deps, registry: this.runRegistry, executor: this.runExecutor });
  }

  async stopWorkflowRun(input: StopWorkflowRunRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    if (isWorkflowRunTerminalStatus(run.status)) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Only an active workflow can be stopped." };

    const activeRun = this.runRegistry.requestStop(input.runId);
    for (const controller of activeRun?.abortControllerByNodeId?.values() ?? []) controller.abort(new Error("Workflow stopped by user."));
    const activeProgress = run.progress.filter((item) => item.status === "running" || item.status === "awaiting_input");
    const activeNodeIds = new Set(activeProgress.map((item) => item.nodeId));
    const taskIds = new Set<string>([
      ...[...(activeRun?.taskIdByNodeId.entries() ?? [])]
        .filter(([nodeId]) => activeNodeIds.has(nodeId))
        .map(([, taskId]) => taskId),
      ...activeProgress.map((item) => item.taskId).filter((taskId): taskId is string => Boolean(taskId)),
    ]);
    await Promise.all([...taskIds].map((taskId) => this.deps.stopTask(taskId).catch(() => undefined)));
    await this.deps.stopWorkflowNodeConversations(input.workflowId, input.runId);
    const progress = run.progress.map((item) => activeNodeIds.has(item.nodeId)
      ? { ...item, status: "paused" as const, detail: "Workflow stopped by user" }
      : item);
    this.deps.finishWorkflowRun({
      workflowId: input.workflowId,
      runId: input.runId,
      status: "stopped",
      progress,
      appendEvents: progress.filter((item) => activeNodeIds.has(item.nodeId)).map((item) => ({ type: "node_paused" as const, nodeId: item.nodeId, at: Date.now(), detail: "Workflow stopped by user" })),
      contextDocument: run.contextDocument,
      ...(run.finalReport ? { finalReport: run.finalReport } : {}),
    });
    this.runRegistry.release(input.runId);
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  isRunning(runId: string): boolean {
    return this.runRegistry.has(runId);
  }

  async pauseWorkflowNode(input: PauseWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!run) return { ok: false, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      return this.pauseWorkflowV2Node({ run, nodeId: input.nodeId });
    }
    if (run.status !== "running") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is not running." };
    const progressItem = run.progress.find((item) => item.nodeId === input.nodeId);
    if (!progressItem) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow node ${input.nodeId} was not found in this run.` };
    if (progressItem.status !== "running") {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow node ${progressItem.title} is not running.` };
    }

    const activeRun = this.runRegistry.get(input.runId) ?? {
      workflowId: input.workflowId,
      runId: input.runId,
      pausedNodeIds: new Set<string>(),
      pausedTaskIds: new Set<string>(),
      gatedNodeIds: new Set<string>(),
      taskIdByNodeId: new Map<string, string>(),
    };
    this.runRegistry.register(activeRun);
    activeRun.pausedNodeIds.add(input.nodeId);

    const taskId = activeRun.taskIdByNodeId.get(input.nodeId) ?? progressItem.taskId;
    if (taskId) activeRun.pausedTaskIds.add(taskId);
    const nextProgress = run.progress.map((item) =>
      item.nodeId === input.nodeId
        ? {
            ...item,
            status: "paused" as const,
            detail: "Paused",
            ...(taskId ? { taskId } : {}),
          }
        : item,
    );
    this.deps.updateWorkflowRunState({
      workflowId: input.workflowId,
      runId: input.runId,
      status: "running",
      progress: nextProgress,
      appendEvents: [{ type: "node_paused", nodeId: input.nodeId, at: Date.now(), ...(taskId ? { taskId } : {}) }],
      contextDocument: run.contextDocument,
      ...(run.finalReport ? { finalReport: run.finalReport } : {}),
    });

    if (taskId) await this.deps.stopTask(taskId);

    // A paused node remains part of the same non-terminal run until the user resumes or stops it.
    const stillRunning = nextProgress.some((item) => item.status === "running");
    if (!stillRunning) {
      this.deps.updateWorkflowRunState({
        workflowId: input.workflowId,
        runId: input.runId,
        status: "waiting_for_user",
        progress: nextProgress,
        contextDocument: run.contextDocument,
        ...(run.finalReport ? { finalReport: run.finalReport } : {}),
      });
    }
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  private async pauseWorkflowV2Node(input: {
    run: WorkflowRunState;
    nodeId: string;
  }): Promise<WorkflowOperationResult> {
    if (input.run.status !== "running") {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: "Workflow run is not running.",
      };
    }
    const progressItem = input.run.progress.find((item) => item.nodeId === input.nodeId);
    if (!progressItem) {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} was not found in this run.`,
      };
    }
    if (progressItem.status !== "running") {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${progressItem.title} is not running.`,
      };
    }
    const activeRun = this.runRegistry.get(input.run.runId);
    if (!activeRun) {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 run is not active in this process.",
      };
    }

    const reason = "Paused by user through the unified Workflow V2 intervention boundary.";
    activeRun.manualPauseReasonByNodeId ??= new Map();
    activeRun.manualPauseReasonByNodeId.set(input.nodeId, reason);
    const taskId = activeRun.taskIdByNodeId.get(input.nodeId) ?? progressItem.taskId;
    const nextProgress = input.run.progress.map((item) => item.nodeId === input.nodeId
      ? { ...item, status: "paused" as const, detail: "Paused by user", ...(taskId ? { taskId } : {}) }
      : item);
    const stillRunning = nextProgress.some((item) => item.status === "running");
    const update = {
      workflowId: input.run.workflowId,
      runId: input.run.runId,
      progress: nextProgress,
      contextDocument: input.run.contextDocument,
      appendEvents: [{ type: "node_paused" as const, nodeId: input.nodeId, at: Date.now(), detail: reason, ...(taskId ? { taskId } : {}) }],
      ...(input.run.finalReport ? { finalReport: input.run.finalReport } : {}),
    };
    this.deps.updateWorkflowRunState({ ...update, status: stillRunning ? "running" : "waiting_for_user" });
    if (taskId) await this.deps.stopTask(taskId);
    activeRun.abortControllerByNodeId?.get(input.nodeId)?.abort(new Error(reason));
    const store = this.deps.createWorkflowV2Store?.();
    if (store?.readRunState) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await store.readRunState(input.run.workflowId, input.run.runId))?.runState.nodes[input.nodeId]?.status === "paused") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    // The durable paused state is written just before the executor unwinds. Do
    // not report the pause as resumable until that executor releases the run
    // lease, otherwise an immediate Resume races with the old execution.
    await this.awaitRunLeaseRelease(input.run.runId);
    return { ok: true, workflowId: input.run.workflowId, runId: input.run.runId };
  }

  async startWorkflowNode(input: StartWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      return this.resumeWorkflowV2Node({ workflow, run, nodeId: input.nodeId, action: "continue" });
    }
    return {
      ok: false,
      workflowId: input.workflowId,
      runId: input.runId,
      error: "Workflow V2 plan is required. Legacy workflow execution is no longer supported.",
    };
  }

  async resolveWorkflowV2Intervention(
    input: ResolveWorkflowV2InterventionRequest,
  ): Promise<WorkflowOperationResult> {
    if (!isWorkflowV2InterventionAction(input.action)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 intervention action is invalid." };
    }
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.trim().length > 2_000)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 intervention reason is invalid." };
    }
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (!run.workflowV2Plan) {
      return {
        ok: false,
        workflowId: input.workflowId,
        runId: input.runId,
        error: "Unified intervention actions are available only for Workflow V2 runs.",
      };
    }
    return this.resumeWorkflowV2Node({
      workflow,
      run,
      nodeId: input.nodeId,
      action: input.action,
      ...(input.reason?.trim() ? { reason: workflowAuditText(input.reason) } : {}),
    });
  }

  async resolveWorkflowV2Recovery(input: ResolveWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    return this.recoveryActionCoordinator.run(input, () => this.resolveWorkflowV2RecoveryUnlocked(input));
  }

  private async resolveWorkflowV2RecoveryUnlocked(input: ResolveWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    const actorText = input.actor.trim();
    const reasonText = input.reason.trim();
    if (!actorText || actorText.length > 256 || !reasonText || reasonText.length > 2_000) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow recovery actor and reason are required." };
    }
    const actor = workflowAuditText(actorText);
    const reason = workflowAuditText(reasonText);
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    const availabilityError = await this.workflowV2RecoveryAvailabilityError(run);
    if (availabilityError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: availabilityError };
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.readRunState || !store.readOperations) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow recovery storage is unavailable." };
    }
    let persisted = await store.readRunState(input.workflowId, input.runId);
    if (!persisted?.transaction) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow transaction recovery state was not found." };
    }
    const initialTransaction = persisted.transaction;
    const operationBroker = this.deps.createWorkflowV2RecoveryOperationBroker?.(store);
    let rawOperations = await store.readOperations(input.workflowId, input.runId);
    if (operationBroker) {
      for (const operation of rawOperations.filter((item) => item.state === "applying" || item.state === "unknown" || item.state === "compensating")) {
        if (!operationBroker.canInspectOperation(operation)) continue;
        await operationBroker.inspect({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
      persisted = await store.readRunState(input.workflowId, input.runId) ?? persisted;
      rawOperations = await store.readOperations(input.workflowId, input.runId);
    }
    const persistedTransaction = persisted.transaction ?? initialTransaction;
    let operations = rawOperations.map(sanitizeWorkflowOperationRecord);
    const workspaceInspection = await inspectWorkflowV2RecoveryWorkspace({
      store,
      workflowId: input.workflowId,
      runId: input.runId,
      fallbackConflictPaths: run.recovery?.conflicts ?? [],
    });
    const recoveryWorkspaceDiff = workspaceInspection.workspaceDiff
      ? { ...workspaceInspection.workspaceDiff, conflicts: workspaceInspection.conflictPaths }
      : workspaceInspection.conflictPaths.length ? { created: [], modified: [], deleted: [], conflicts: workspaceInspection.conflictPaths } : undefined;
    const workspaceDiff = workspaceInspection.workspaceDiff;
    const canCompensate = Boolean(operationBroker && rawOperations.some((operation) => operationBroker.canCompensateOperation(operation)));
    const compensableOperationIds = operationBroker ? rawOperations.filter((operation) => operationBroker.canCompensateOperation(operation)).map((operation) => operation.operationId) : [];
    const canRollbackSavepoint = await canRollbackWorkflowV2CurrentSavepoint({ store, workflowId: input.workflowId, runId: input.runId, transaction: persistedTransaction });
    const preview = buildWorkflowV2RecoveryPreview({ transaction: persistedTransaction, operations, runState: persisted.runState, nodeControl: persisted.nodeControl, ...(recoveryWorkspaceDiff ? { workspaceDiff: recoveryWorkspaceDiff } : {}), workspaceAvailable: workspaceInspection.workspaceAvailable, conflictDetails: workspaceInspection.conflictDetails, canRollbackSavepoint, canRollbackWorkspace: Boolean(store.rollbackWorkspaceTransaction), canCompensate, compensableOperationIds });
    if (!preview.availableActions.includes(input.action)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow recovery action ${input.action} is not safe for the current transaction facts.` };
    }
    if (input.action === "rollback_savepoint" && (!persistedTransaction.currentSavepointId || !store.restoreWorkspaceSavepoint)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow savepoint rollback is unavailable." };
    }
    if (input.action === "compensate_all" && !operationBroker && !store.rollbackWorkspaceTransaction) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow compensation and workspace rollback are unavailable." };
    }
    const continuationTargetNodeId = input.action === "continue"
      ? persisted.runState.nodeOrder.find((nodeId) => {
          const status = persisted.runState.nodes[nodeId]?.status;
          return status !== "completed" && status !== "skipped";
        })
      : undefined;
    const pendingCheckpointId = persistedTransaction.pendingCheckpointId;
    if (input.action === "continue" && !continuationTargetNodeId && !pendingCheckpointId) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow recovery has no pending node to continue." };
    }
    if (input.action === "continue" && pendingCheckpointId && !workflow?.workflowV2Plan) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 plan was not found for checkpoint continuation." };
    }
    if (input.action === "continue" && pendingCheckpointId && this.runRegistry.has(input.runId)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is already active." };
    }
    const now = Date.now();
    if (input.action === "continue" && pendingCheckpointId && persistedTransaction.pendingCheckpointPlanDigest) {
      if (!store.readCommitPlan || !store.persistCommitPlan) {
        return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow checkpoint approval cannot bind to its immutable commit plan." };
      }
      const commitPlan = await store.readCommitPlan(input.workflowId, input.runId);
      if (!commitPlan || commitPlan.planDigest !== persistedTransaction.pendingCheckpointPlanDigest) {
        return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow checkpoint commit plan changed after preview; refresh and approve the current plan." };
      }
      const approvalHash = createHash("sha256")
        .update(`${actor}\0${now}\0${commitPlan.planDigest}`)
        .digest("hex")
        .slice(0, 16);
      await store.persistCommitPlan({
        ...commitPlan,
        commitPlanId: `commit-plan:${commitPlan.transactionId}:${commitPlan.planDigest.slice(0, 16)}:approval:${approvalHash}`,
        approval: { actor, approvedAt: now, evidenceDigest: commitPlan.planDigest },
      });
    }
    const operationIds = input.action === "compensate_all" && operationBroker
      ? rawOperations.filter((operation) => operationBroker.canCompensateOperation(operation)).map((operation) => operation.operationId)
      : operations.map((operation) => operation.operationId);
    const decision = {
      decisionId: `${persistedTransaction.transactionId}:recovery:${persisted.eventCount}`,
      transactionId: persistedTransaction.transactionId,
      action: input.action,
      actor,
      reason,
      operationIds,
      decidedAt: now,
    };
    const recoveryDecisions = [...(persisted.recoveryDecisions ?? []), decision];
    const decisionEvents: WorkflowV2DurableEvent[] = [{
      sequence: persisted.eventCount,
      workflowId: input.workflowId,
      runId: input.runId,
      transactionId: persistedTransaction.transactionId,
      type: "recovery_decision",
      at: now,
      detail: `action=${input.action}; actor=${actor}; reason=${reason}; operationIds=${operationIds.join(",") || "none"}`,
    }];
    if (input.action === "continue" && pendingCheckpointId) {
      decisionEvents.push({
        sequence: persisted.eventCount + 1,
        workflowId: input.workflowId,
        runId: input.runId,
        transactionId: persistedTransaction.transactionId,
        type: "checkpoint_approved",
        at: now,
        detail: `checkpointId=${pendingCheckpointId}; actor=${actor}`,
      });
    }
    await store.appendEvents({
      workflowId: input.workflowId,
      runId: input.runId,
      events: decisionEvents,
    });
    await store.persistRunState({ ...persisted, eventCount: persisted.eventCount + decisionEvents.length, savedAt: now, recoveryDecisions });
    let transaction = structuredClone(persistedTransaction);
    let finalPersisted = persisted;
    let finalEventCount = persisted.eventCount + decisionEvents.length;
    transaction.updatedAt = now;
    if (input.action === "rollback_savepoint") {
      await store.restoreWorkspaceSavepoint!({ workflowId: input.workflowId, runId: input.runId, savepointId: transaction.currentSavepointId! });
      transaction.status = "waiting_for_user";
    } else if (input.action === "compensate_all") {
      transaction.status = "rolling_back";
      await store.persistRunState({ ...persisted, eventCount: persisted.eventCount + 1, savedAt: now, transaction, recoveryDecisions });
      const compensation = operationBroker
        ? await operationBroker.compensateRun({ workflowId: input.workflowId, runId: input.runId, operationIds, signal: AbortSignal.timeout(60_000) })
        : { compensated: [], skipped: [] };
      let workspaceRollbackFailed = false;
      const workspaceHasChanges = Boolean(workspaceDiff && (workspaceDiff.created.length > 0 || workspaceDiff.modified.length > 0 || workspaceDiff.deleted.length > 0));
      const workspaceRollbackUnavailable = workspaceHasChanges && !store.rollbackWorkspaceTransaction;
      if (store.rollbackWorkspaceTransaction) {
        try {
          const rollback = await store.rollbackWorkspaceTransaction({ workflowId: input.workflowId, runId: input.runId });
          workspaceRollbackFailed = rollback.conflicts.length > 0;
        } catch {
          workspaceRollbackFailed = true;
        }
      }
      const latest = await store.readRunState(input.workflowId, input.runId);
      finalPersisted = latest ?? finalPersisted;
      finalEventCount = finalPersisted.eventCount;
      rawOperations = await store.readOperations(input.workflowId, input.runId);
      operations = rawOperations.map(sanitizeWorkflowOperationRecord);
      transaction = structuredClone(latest?.transaction ?? transaction);
      transaction.updatedAt = Date.now();
      transaction.status = compensation.failed || workspaceRollbackFailed
        ? "recovery_required"
        : workspaceRollbackUnavailable || compensation.skipped.length > 0 || rawOperations.some((operation) => operation.state === "unknown" || operation.state === "compensating" || operation.state === "applied")
          ? "partially_rolled_back"
          : "rolled_back";
    } else if (input.action === "continue") {
      transaction.status = "active";
      if (pendingCheckpointId) {
        transaction.approvedCheckpointIds = [...new Set([...(transaction.approvedCheckpointIds ?? []), pendingCheckpointId])];
        delete transaction.pendingCheckpointId;
        delete transaction.pendingCheckpointPlanDigest;
      }
    }
    const nextCompensableOperationIds = operationBroker ? rawOperations.filter((operation) => operationBroker.canCompensateOperation(operation)).map((operation) => operation.operationId) : [];
    const nextWorkspaceInspection = await inspectWorkflowV2RecoveryWorkspace({
      store,
      workflowId: input.workflowId,
      runId: input.runId,
      fallbackConflictPaths: workspaceInspection.conflictPaths,
    });
    const nextRecoveryWorkspaceDiff = nextWorkspaceInspection.workspaceDiff
      ? { ...nextWorkspaceInspection.workspaceDiff, conflicts: nextWorkspaceInspection.conflictPaths }
      : nextWorkspaceInspection.conflictPaths.length ? { created: [], modified: [], deleted: [], conflicts: nextWorkspaceInspection.conflictPaths } : undefined;
    transaction = renewWorkflowTransactionRetention(transaction, resolveWorkflowTransactionPolicy(finalPersisted.plan.definition.transactionPolicy).policy.retentionDays);
    const canRollbackNextSavepoint = await canRollbackWorkflowV2CurrentSavepoint({ store, workflowId: input.workflowId, runId: input.runId, transaction });
    const nextPreview = buildWorkflowV2RecoveryPreview({ transaction, operations, runState: persisted.runState, nodeControl: persisted.nodeControl, ...(nextRecoveryWorkspaceDiff ? { workspaceDiff: nextRecoveryWorkspaceDiff } : {}), workspaceAvailable: nextWorkspaceInspection.workspaceAvailable, conflictDetails: nextWorkspaceInspection.conflictDetails, canRollbackSavepoint: canRollbackNextSavepoint, canRollbackWorkspace: Boolean(store.rollbackWorkspaceTransaction), canCompensate: nextCompensableOperationIds.length > 0, compensableOperationIds: nextCompensableOperationIds });
    const resumedRunState = input.action === "continue" && pendingCheckpointId
      ? { ...finalPersisted.runState, status: "running" as const }
      : finalPersisted.runState;
    const finalReport = buildWorkflowV2FinalReport(
      finalPersisted.plan,
      finalPersisted.workerOutputs,
      resumedRunState.status,
      recoveryDecisions,
      operations,
      workspaceDiff,
    );
    const nextPersisted = { ...finalPersisted, eventCount: finalEventCount, savedAt: Date.now(), runState: resumedRunState, transaction, recoveryDecisions, recovery: input.action === "continue" ? undefined : nextPreview, finalReport };
    await store.persistRunState(nextPersisted);
    this.deps.updateWorkflowRunState({
      workflowId: input.workflowId,
      runId: input.runId,
      transaction,
      operations,
      recovery: input.action === "continue" ? null : nextPreview,
      recoveryDecisions,
      finalReport,
    });
    if (input.action === "continue") {
      if (pendingCheckpointId) {
        return this.resumeWorkflowV2Checkpoint(workflow!, run, nextPersisted);
      }
      return this.startWorkflowNode({ workflowId: input.workflowId, runId: input.runId, nodeId: continuationTargetNodeId! });
    }
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  async refreshWorkflowV2Recovery(input: RefreshWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    return this.recoveryActionCoordinator.run(input, () => this.refreshWorkflowV2RecoveryUnlocked(input));
  }

  private async refreshWorkflowV2RecoveryUnlocked(input: RefreshWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    const availabilityError = await this.workflowV2RecoveryAvailabilityError(run);
    if (availabilityError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: availabilityError };
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.readRunState || !store.readOperations) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow recovery storage is unavailable." };
    let persisted = await store.readRunState(input.workflowId, input.runId);
    if (!persisted?.transaction) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow transaction recovery state was not found." };
    const operationBroker = this.deps.createWorkflowV2RecoveryOperationBroker?.(store);
    let rawOperations = await store.readOperations(input.workflowId, input.runId);
    if (operationBroker) {
      for (const operation of rawOperations.filter((item) => item.state === "applying" || item.state === "unknown" || item.state === "compensating")) {
        if (!operationBroker.canInspectOperation(operation)) continue;
        await operationBroker.inspect({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
      rawOperations = await store.readOperations(input.workflowId, input.runId);
      persisted = await store.readRunState(input.workflowId, input.runId) ?? persisted;
    }
    if (!persisted.transaction) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow transaction recovery state was not found after operation inspection." };
    const transaction = renewWorkflowTransactionRetention(persisted.transaction, resolveWorkflowTransactionPolicy(persisted.plan.definition.transactionPolicy).policy.retentionDays);
    persisted = {
      ...persisted,
      transaction,
    };
    const operations = rawOperations.map(sanitizeWorkflowOperationRecord);
    const workspaceInspection = await inspectWorkflowV2RecoveryWorkspace({
      store,
      workflowId: input.workflowId,
      runId: input.runId,
      fallbackConflictPaths: run.recovery?.conflicts ?? persisted.recovery?.conflicts ?? [],
    });
    const recoveryWorkspaceDiff = workspaceInspection.workspaceDiff
      ? { ...workspaceInspection.workspaceDiff, conflicts: workspaceInspection.conflictPaths }
      : workspaceInspection.conflictPaths.length ? { created: [], modified: [], deleted: [], conflicts: workspaceInspection.conflictPaths } : undefined;
    const compensableOperationIds = operationBroker ? rawOperations.filter((operation) => operationBroker.canCompensateOperation(operation)).map((operation) => operation.operationId) : [];
    const canRollbackSavepoint = await canRollbackWorkflowV2CurrentSavepoint({ store, workflowId: input.workflowId, runId: input.runId, transaction });
    let recovery = buildWorkflowV2RecoveryPreview({ transaction, operations, runState: persisted.runState, nodeControl: persisted.nodeControl, ...(recoveryWorkspaceDiff ? { workspaceDiff: recoveryWorkspaceDiff } : {}), workspaceAvailable: workspaceInspection.workspaceAvailable, conflictDetails: workspaceInspection.conflictDetails, canRollbackSavepoint, canRollbackWorkspace: Boolean(store.rollbackWorkspaceTransaction), canCompensate: compensableOperationIds.length > 0, compensableOperationIds });
    if (this.deps.generateWorkflowV2RecoveryRecommendation) {
      const generated = await this.deps.generateWorkflowV2RecoveryRecommendation({
        workflowId: input.workflowId,
        runId: input.runId,
        recovery,
        evidence: { plan: persisted.plan, runState: persisted.runState, nodeControl: persisted.nodeControl, workerOutputs: persisted.workerOutputs, operations, recoveryDecisions: persisted.recoveryDecisions ?? [], workspaceDiff: recoveryWorkspaceDiff, conflictDetails: workspaceInspection.conflictDetails, events: run.events, progress: run.progress },
      }).catch(() => undefined);
      if (generated) recovery = { ...recovery, managerRecommendation: generated };
    }
    recovery = sanitizeWorkflowTransactionValue(recovery) as typeof recovery;
    const managerReport = [
      "## Manager recovery recommendation",
      `- Source: ${recovery.managerRecommendation.source}`,
      `- Recommended action: ${recovery.managerRecommendation.recommendedAction}`,
      `- Rationale: ${recovery.managerRecommendation.rationale}`,
      ...(recovery.managerRecommendation.rollbackTarget ? [`- Rollback target: ${recovery.managerRecommendation.rollbackTarget}`] : []),
      ...recovery.managerRecommendation.compensationOperationIds.map((operationId) => `- Compensation: ${operationId}`),
      ...recovery.managerRecommendation.conflictCandidates.map((candidate) => `- Conflict ${candidate.path}: ${candidate.resolution}; ${candidate.rationale}`),
      ...recovery.managerRecommendation.manualSteps.map((step) => `- Manual step: ${step}`),
    ].join("\n");
    const evidenceReport = [
      "## Recovery evidence refresh",
      `- Transaction: ${transaction.status}; operations=${operations.length}; unknown=${transaction.unknownOperationCount}`,
      ...operations.map((operation) => `- Operation ${operation.operationId}: ${operation.state}; request=${workflowV2ReportValue(operation.requestSummary)}; receipt=${workflowV2ReportValue(operation.receipt)}`),
      ...(persisted.recoveryDecisions ?? []).map((decision) => `- Decision ${decision.action} by ${workflowAuditText(decision.actor)}: ${workflowAuditText(decision.reason)}`),
    ].join("\n");
    const currentReport = run.finalReport ?? persisted.finalReport ?? "# Workflow V2 Recovery Report";
    const baseReport = withoutWorkflowReportSection(withoutWorkflowReportSection(currentReport, "Manager recovery recommendation"), "Recovery evidence refresh");
    const finalReport = `${baseReport}\n\n${evidenceReport}\n\n${managerReport}`;
    await store.persistRunState({ ...persisted, recovery: structuredClone(recovery), finalReport, savedAt: Date.now() });
    this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, transaction, operations, recovery, finalReport });
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  async resolveWorkflowV2Conflict(input: ResolveWorkflowV2ConflictRequest): Promise<WorkflowOperationResult> {
    return this.recoveryActionCoordinator.run(input, () => this.resolveWorkflowV2ConflictUnlocked(input));
  }

  private async resolveWorkflowV2ConflictUnlocked(input: ResolveWorkflowV2ConflictRequest): Promise<WorkflowOperationResult> {
    const actorText = input.actor.trim();
    const reasonText = input.reason.trim();
    if (!actorText || actorText.length > 256 || !reasonText || reasonText.length > 2_000) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow conflict actor and reason are required." };
    const actor = workflowAuditText(actorText);
    const reason = workflowAuditText(reasonText);
    const run = this.deps.snapshot().workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    const availabilityError = await this.workflowV2RecoveryAvailabilityError(run);
    if (availabilityError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: availabilityError };
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.resolveWorkspaceConflict || !store.readRunState) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow conflict resolution storage is unavailable." };
    const persisted = await store.readRunState(input.workflowId, input.runId);
    if (!persisted?.transaction) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow transaction recovery state was not found." };
    try {
      const finalPreview = await store.resolveWorkspaceConflict({ workflowId: input.workflowId, runId: input.runId, path: input.path, resolution: input.resolution, ...(input.expectedCurrentSha256 ? { expectedCurrentSha256: input.expectedCurrentSha256 } : {}), ...(input.content !== undefined ? { content: input.content } : {}) });
      await store.appendEvents({ workflowId: input.workflowId, runId: input.runId, events: [{ sequence: persisted.eventCount, workflowId: input.workflowId, runId: input.runId, transactionId: persisted.transaction.transactionId, type: "recovery_decision", at: Date.now(), detail: `conflict=${input.path}; resolution=${input.resolution}; actor=${actor}; reason=${reason}; finalSha256=${finalPreview.current.sha256 ?? "deleted"}` }] });
      await store.persistRunState({ ...persisted, eventCount: persisted.eventCount + 1, savedAt: Date.now() });
      const refreshed = await this.refreshWorkflowV2RecoveryUnlocked({ workflowId: input.workflowId, runId: input.runId });
      if (refreshed.ok) {
        const run = this.deps.snapshot().workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
        const conflictReport = ["## Conflict decision", `- Path: ${input.path}`, `- Resolution: ${input.resolution}`, `- Actor: ${actor}`, `- Reason: ${reason}`, `- Final digest: ${finalPreview.current.sha256 ?? "deleted"}`].join("\n");
        const finalReport = `${run?.finalReport ?? "# Workflow V2 Recovery Report"}\n\n${conflictReport}`;
        const latest = await store.readRunState(input.workflowId, input.runId);
        if ((latest?.recovery?.conflicts.length ?? 0) === 0) {
          const broker = this.deps.createWorkflowV2RecoveryOperationBroker?.(store);
          if (!latest?.transaction || !broker || !store.readCommitPlan) throw new Error("Workflow conflict resolution cannot resume the durable commit plan.");
          const coordinator = new WorkflowV2CommitCoordinator(store, broker);
          const existingPlan = await store.readCommitPlan(input.workflowId, input.runId);
          if (!existingPlan) throw new Error("Workflow conflict resolution cannot find the durable commit plan.");
          const operationIds = existingPlan.steps.flatMap((step) => step.operationId ? [step.operationId] : []);
          const includeWorkspace = existingPlan.steps.some((step) => step.kind === "workspace");
          const preview = await coordinator.previewPlan({
            workflowId: input.workflowId,
            runId: input.runId,
            transactionId: latest.transaction.transactionId,
            operationIds,
            includeWorkspace,
          });
          if (preview.planDigest !== existingPlan.planDigest) {
            const existingExternalSteps = existingPlan.steps.filter((step) => step.kind !== "workspace");
            const previewExternalSteps = preview.steps.filter((step) => step.kind !== "workspace");
            const conflictChangedIsolatedContent = input.resolution === "current" || input.resolution === "manual";
            if (!conflictChangedIsolatedContent || JSON.stringify(existingExternalSteps) !== JSON.stringify(previewExternalSteps)) {
              throw new Error("Workflow commit plan changed beyond the confirmed workspace conflict; refresh the plan and approval.");
            }
            const approvedAt = Date.now();
            await coordinator.createPlan({
              workflowId: input.workflowId,
              runId: input.runId,
              transactionId: latest.transaction.transactionId,
              operationIds,
              includeWorkspace,
              ...(existingPlan.approval ? { approval: { actor, approvedAt, evidenceDigest: preview.planDigest } } : {}),
              now: approvedAt,
            });
          }
          const result = await coordinator.commit({ workflowId: input.workflowId, runId: input.runId });
          if (result.status !== "committed") throw new Error(result.error ?? `Workflow commit remained ${result.status} after conflict resolution.`);
          const committedAt = Date.now();
          const checkpointId = latest.transaction.committingCheckpointId;
          let transaction: WorkflowTransactionState = { ...latest.transaction, status: checkpointId ? "active" : "committed", updatedAt: committedAt };
          transaction = renewWorkflowTransactionRetention(transaction, resolveWorkflowTransactionPolicy(latest.plan.definition.transactionPolicy).policy.retentionDays, committedAt);
          if (checkpointId) {
            transaction.completedCheckpointIds = [...new Set([...(transaction.completedCheckpointIds ?? []), checkpointId])];
            delete transaction.committingCheckpointId;
          }
          const eventType = checkpointId ? "checkpoint_completed" : "commit_completed";
          await store.appendEvents({ workflowId: input.workflowId, runId: input.runId, events: [{ sequence: latest.eventCount, workflowId: input.workflowId, runId: input.runId, transactionId: transaction.transactionId, type: eventType, at: committedAt, detail: `Conflict resolution completed ${checkpointId ? `checkpoint ${checkpointId}` : "the final commit"}; workspace files=${result.workspaceApplied.length}; external operations=${result.appliedOperationIds.length}.` }] });
          const runState = checkpointId ? { ...latest.runState, status: "running" as const } : latest.runState;
          const resolvedPersisted = { ...latest, eventCount: latest.eventCount + 1, savedAt: committedAt, runState, transaction, recovery: undefined, finalReport };
          await store.persistRunState(resolvedPersisted);
          this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, transaction, recovery: null, finalReport });
          if (checkpointId) {
            const snapshot = this.deps.snapshot();
            const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
            const activeRun = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
            if (!workflow?.workflowV2Plan || !activeRun) throw new Error("Workflow checkpoint conflict resolution cannot resume the frozen run.");
            return this.resumeWorkflowV2Checkpoint(workflow, activeRun, resolvedPersisted);
          }
          this.deps.finishWorkflowRun({ workflowId: input.workflowId, runId: input.runId, status: "completed", finalReport });
        } else {
          if (latest) await store.persistRunState({ ...latest, finalReport, savedAt: Date.now() });
          this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, finalReport });
        }
      }
      return refreshed;
    } catch (error) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async resolveWorkflowV2UnknownOperation(input: ResolveWorkflowV2UnknownOperationRequest): Promise<WorkflowOperationResult> {
    return this.recoveryActionCoordinator.run(input, () => this.resolveWorkflowV2UnknownOperationUnlocked(input));
  }

  private async resolveWorkflowV2UnknownOperationUnlocked(input: ResolveWorkflowV2UnknownOperationRequest): Promise<WorkflowOperationResult> {
    const actorText = input.actor.trim();
    const reasonText = input.reason.trim();
    if (!actorText || actorText.length > 256 || !reasonText || reasonText.length > 2_000) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow operation verification actor and reason are required." };
    }
    const actor = workflowAuditText(actorText);
    const reason = workflowAuditText(reasonText);
    const run = this.deps.snapshot().workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    const availabilityError = await this.workflowV2RecoveryAvailabilityError(run);
    if (availabilityError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: availabilityError };
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.resolveUnknownOperation || !store.readRunState || !store.readOperations) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow unknown-operation verification storage is unavailable." };
    }
    const persisted = await store.readRunState(input.workflowId, input.runId);
    const operation = (await store.readOperations(input.workflowId, input.runId)).find((item) => item.operationId === input.operationId);
    if (!persisted?.transaction || !operation || operation.transactionId !== persisted.transaction.transactionId) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow operation ${input.operationId} was not found in this transaction.` };
    }
    if (operation.state !== "unknown") {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow operation ${input.operationId} is not awaiting verification.` };
    }
    try {
      await store.resolveUnknownOperation({
        workflowId: input.workflowId,
        runId: input.runId,
        operationId: input.operationId,
        verifiedState: input.verifiedState === "applied" ? "applied" : "compensated",
        actor,
        reason,
        updatedAt: Date.now(),
        evidence: { source: "user_verification", observedState: input.verifiedState },
      });
      return this.refreshWorkflowV2RecoveryUnlocked({ workflowId: input.workflowId, runId: input.runId });
    } catch (error) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resumeWorkflowV2Checkpoint(workflow: WorkflowDraftState, run: WorkflowRunState, persisted: WorkflowV2PersistedRunState): WorkflowOperationResult {
    if (!workflow.workflowV2Plan || !persisted.transaction) return { ok: false, workflowId: workflow.workflowId, runId: run.runId, error: "Workflow checkpoint continuation state is incomplete." };
    if (this.runRegistry.has(run.runId)) return { ok: false, workflowId: workflow.workflowId, runId: run.runId, error: "Workflow run is already active." };
    this.runRegistry.register({
      workflowId: workflow.workflowId,
      runId: run.runId,
      pausedNodeIds: new Set(),
      pausedTaskIds: new Set(),
      gatedNodeIds: new Set(),
      taskIdByNodeId: new Map(),
      manualPauseReasonByNodeId: new Map(),
      abortControllerByNodeId: new Map(),
    });
    this.deps.updateWorkflowRunState({ workflowId: workflow.workflowId, runId: run.runId, status: "running", contextDocument: run.contextDocument });
    const storagePlan = workflowStoragePlanFor(workflow.workflowId, run.runId);
    void this.runExecutor.execute({
      workflow,
      plan: workflow.workflowV2Plan,
      runId: run.runId,
      baseWorkflowContextDocument: run.contextDocument,
      storagePlanDocument: workflowStoragePlanDocument(storagePlan),
      initialCheckpoint: { runState: persisted.runState, workerOutputs: persisted.workerOutputs },
      initialNodeControl: persisted.nodeControl,
      initialDurableEventCount: persisted.eventCount,
      initialTransaction: persisted.transaction,
    }).finally(() => this.runRegistry.release(run.runId));
    return { ok: true, workflowId: workflow.workflowId, runId: run.runId };
  }

  async cleanupWorkflowV2RunMaterials(input: CleanupWorkflowV2RunRequest): Promise<WorkflowOperationResult> {
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.cleanupRunMaterials) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 material cleanup is unavailable." };
    try {
      await store.cleanupRunMaterials(input.workflowId, input.runId);
      this.deps.updateWorkflowRunState({
        workflowId: input.workflowId,
        runId: input.runId,
        operations: null,
        recovery: null,
      });
      return { ok: true, workflowId: input.workflowId, runId: input.runId };
    } catch (error) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async completeInteractiveNode(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    output: WorkflowV2WorkerOutput;
    executionId: string;
    submissionId?: string;
  }): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    const store = this.deps.createWorkflowV2Store?.();
    if (!workflow?.workflowV2Plan || !run || !store?.readRunState) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 interactive run state is unavailable." };
    }
    const transactionError = workflowTransactionPreflightError(workflow.workflowV2Plan.definition.transactionPolicy, runtimeTransactionCapabilities(store));
    if (transactionError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: transactionError };
    const persisted = await store.readRunState(input.workflowId, input.runId);
    if (!persisted) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 durable run state was not found." };
    const nodeState = persisted.runState.nodes[input.nodeId];
    if (nodeState?.status !== "paused") {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not awaiting interactive confirmation.` };
    }
    const node = workflow.workflowV2Plan.definition.nodes.find((item) => item.id === input.nodeId);
    if (!node) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is unavailable.` };
    }
    await materializeWorkflowV2OutputArtifacts({
      workflowId: input.workflowId,
      runId: input.runId,
      workDir: workflow.workDir || snapshot.workDir,
      node,
      output: input.output,
    });
    const runState = transitionWorkflowV2NodeState(persisted.runState, { nodeId: input.nodeId, status: "completed", now: Date.now() });
    const workerOutputs = [...persisted.workerOutputs.filter((output) => output.nodeId !== input.nodeId), structuredClone(input.output)];
    const checkpoint = { runState, workerOutputs };
    await store.persistRunState({ ...persisted, runState, workerOutputs });
    if (input.submissionId) {
      await this.resolveNodeCompletionSubmission({
        workflowId: input.workflowId,
        runId: input.runId,
        nodeId: input.nodeId,
        executionId: input.executionId,
        submissionId: input.submissionId,
        status: "accepted",
      });
    }
    this.runRegistry.register({
      workflowId: input.workflowId,
      runId: input.runId,
      pausedNodeIds: new Set(),
      pausedTaskIds: new Set(),
      gatedNodeIds: new Set(),
      taskIdByNodeId: new Map(),
      manualPauseReasonByNodeId: new Map(),
      abortControllerByNodeId: new Map(),
    });
    this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, status: "running", contextDocument: run.contextDocument });
    const storagePlan = workflowStoragePlanFor(input.workflowId, input.runId);
    void this.runExecutor.execute({
      workflow,
      plan: workflow.workflowV2Plan,
      runId: input.runId,
      baseWorkflowContextDocument: run.contextDocument,
      storagePlanDocument: workflowStoragePlanDocument(storagePlan),
      initialCheckpoint: checkpoint,
      initialNodeControl: persisted.nodeControl,
      initialDurableEventCount: persisted.eventCount,
      ...(persisted.transaction ? { initialTransaction: persisted.transaction } : {}),
    }).finally(() => this.runRegistry.release(input.runId));
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  private async resumeWorkflowV2Node(input: {
    workflow: WorkflowDraftState;
    run: WorkflowRunState;
    nodeId: string;
    action: WorkflowV2InterventionAction;
    reason?: string;
  }): Promise<WorkflowOperationResult> {
    return this.scriptApprovalCoordinator.run({ workflowId: input.workflow.workflowId, runId: input.run.runId, nodeId: input.nodeId, action: input.action }, () => this.resumeWorkflowV2NodeUnlocked(input));
  }

  private async resumeWorkflowV2NodeUnlocked(input: {
    workflow: WorkflowDraftState;
    run: WorkflowRunState;
    nodeId: string;
    action: WorkflowV2InterventionAction;
    reason?: string;
  }): Promise<WorkflowOperationResult> {
    if (input.run.status !== "waiting_for_user" && input.run.status !== "stopped" && input.run.status !== "failed") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow run is not resumable.",
      };
    }
    if (this.runRegistry.has(input.run.runId)) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow run is already active.",
      };
    }
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.readRunState) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable state is unavailable.",
      };
    }
    const persisted = await store.readRunState(input.workflow.workflowId, input.run.runId);
    if (!persisted) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable run state was not found.",
      };
    }
    if (persisted.workflowId !== input.workflow.workflowId || persisted.runId !== input.run.runId) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable run state identity does not match the requested run.",
      };
    }
    const plan = input.workflow.workflowV2Plan;
    if (!plan) {
      return { ok: false, workflowId: input.workflow.workflowId, runId: input.run.runId, error: "Workflow V2 plan was not found." };
    }
    const transactionError = workflowTransactionPreflightError(plan.definition.transactionPolicy, runtimeTransactionCapabilities(store));
    if (transactionError) return { ok: false, workflowId: input.workflow.workflowId, runId: input.run.runId, error: transactionError };
    const targetNode = plan.definition.nodes.find((node) => node.id === input.nodeId);
    if (!targetNode) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} was not found.`,
      };
    }
    const persistedNode = persisted.runState.nodes[input.nodeId];
    const intervention = persistedNode?.intervention;
    if (input.action !== "continue" && !intervention) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} has no pending human intervention.`,
      };
    }
    if (intervention && !intervention.allowedActions.includes(input.action)) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 intervention does not allow action ${input.action}.`,
      };
    }
    if ((input.action === "approve_once" || input.action === "reject") && intervention?.source !== "script_permission") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 action ${input.action} requires a pending script permission request.`,
      };
    }
    if ((input.action === "escalate" || input.action === "increase_review_strength") && targetNode.execModel !== "llm") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 action ${input.action} requires an llm node.`,
      };
    }
    const resolvedAt = Date.now();
    const resolutionReason = workflowV2InterventionResolutionReason(input.action, targetNode.title, input.reason);
    const initialNodeControl = structuredClone(persisted.nodeControl);
    initialNodeControl[input.nodeId] = {
      ...(initialNodeControl[input.nodeId] ?? { extensionCount: 0 }),
      interventionResolution: {
        action: input.action,
        reason: resolutionReason,
        resolvedAt,
      },
    };
    const resolutionEvent: WorkflowV2DurableEvent = {
      sequence: persisted.eventCount,
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      nodeId: input.nodeId,
      type: `intervention_${input.action}`,
      at: resolvedAt,
      detail: resolutionReason,
    };
    const initialDurableEventCount = persisted.eventCount + 1;

    if (input.action === "reject") {
      return rejectWorkflowV2ScriptApproval({ deps: this.deps, store, persisted, run: input.run, nodeId: input.nodeId, nodeTitle: targetNode.title, resolvedAt, ...(input.reason ? { reason: input.reason } : {}), nodeControl: initialNodeControl, resolutionEvent, eventCount: initialDurableEventCount });
    }

    if (input.action === "replan") {
      await store.appendEvents({
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        events: [resolutionEvent],
      });
      await store.persistRunState({
        ...structuredClone(persisted),
        savedAt: resolvedAt,
        eventCount: initialDurableEventCount,
        nodeControl: initialNodeControl,
      });
      const progress = input.run.progress.map((item) => item.nodeId === input.nodeId
        ? { ...item, status: "paused" as const, detail: resolutionReason }
        : item);
      this.deps.finishWorkflowRun({
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        status: "stopped",
        progress,
        appendEvents: [{
          type: "node_paused",
          nodeId: input.nodeId,
          at: resolvedAt,
          detail: resolutionReason,
          ...(intervention ? { intervention: structuredClone(intervention) } : {}),
        }],
        contextDocument: input.run.contextDocument,
      });
      return { ok: true, workflowId: input.workflow.workflowId, runId: input.run.runId };
    }

    const snapshot = this.deps.snapshot();
    const workDir = input.workflow.workDir || snapshot.workDir;
    const configuredAgentId = input.workflow.configuredAgentId;
    const modelId = configuredAgentModelId(input.workflow, snapshot);
    const cacheEntries = new Map<string, WorkflowV2CacheEntryMetadata>();
    const targetFingerprints = new Map<string, WorkflowV2NodeCacheFingerprint>();
    const knownOutputs = new Map(persisted.workerOutputs.map((output) => [output.nodeId, output]));

    for (const node of plan.definition.nodes) {
      const planNode = plan.nodes.find((item) => item.nodeId === node.id);
      if (!planNode) {
        return {
          ok: false,
          workflowId: input.workflow.workflowId,
          runId: input.run.runId,
          error: `Workflow V2 plan node ${node.id} was not found.`,
        };
      }
      const cacheEntry = await store.readCacheEntry?.(input.workflow.workflowId, plan.graphVersion, node.id);
      if (cacheEntry) cacheEntries.set(node.id, cacheEntry);
      const upstreamOutputs = plan.definition.edges
        .filter((edge) => edge.toNodeId === node.id)
        .map((edge) => knownOutputs.get(edge.fromNodeId))
        .filter((output): output is WorkflowV2WorkerOutput => Boolean(output));
      const agentRoute = node.execModel === "llm" ? resolveWorkflowNodeAgent(node, { configuredAgentId, modelId }, snapshot.configuredAgents) : { configuredAgentId, modelId };
      const fingerprint = createWorkflowV2NodeCacheFingerprint({
        graphVersion: plan.graphVersion,
        node,
        planNode,
        upstreamOutputs,
        executionEnvironment: workflowV2ExecutionEnvironment({ node, workDir, configuredAgentId: agentRoute.configuredAgentId, modelId: agentRoute.modelId }),
        reviewerPolicy: workflowV2ReviewerPolicy(node),
      });
      targetFingerprints.set(node.id, fingerprint);
      if (cacheEntry) knownOutputs.set(node.id, cacheEntry.output);
    }

    const recovery = buildWorkflowV2RecoveryPlan({
      persisted,
      targetDefinition: plan.definition,
      targetFingerprints,
      cacheEntries,
    });
    const targetDecision = recovery.decisions.find((decision) => decision.nodeId === input.nodeId);
    if (!targetDecision || targetDecision.action === "reuse") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} does not require recovery.`,
      };
    }
    await store.appendEvents({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      events: [resolutionEvent],
    });
    const materialized = materializeWorkflowV2Recovery({
      persisted,
      targetDefinition: plan.definition,
      recovery,
    });
    if (input.action === "skip") {
      materialized.checkpoint.runState = transitionWorkflowV2NodeState(materialized.checkpoint.runState, {
        nodeId: input.nodeId,
        status: "skipped",
        now: resolvedAt,
      });
      materialized.checkpoint.workerOutputs.push({
        nodeId: input.nodeId,
        summary: `Skipped by human intervention: ${resolutionReason}`,
        outputs: {},
        risks: [resolutionReason],
        proposals: [],
      });
      materialized.recoveryCheckpoints.delete(input.nodeId);
      materialized.resumeConversations.delete(input.nodeId);
    }
    const recoveryOverrides = new Map<string, WorkflowV2RecoveryOverride>();
    if (input.action === "approve_once") {
      const approval = createWorkflowV2ScriptApprovalOverride({ node: targetNode, planNode: plan.nodes.find((item) => item.nodeId === input.nodeId), intervention, resolutionReason });
      if (!approval.override) return { ok: false, workflowId: input.workflow.workflowId, runId: input.run.runId, error: approval.error ?? "Workflow V2 script approval is invalid." };
      recoveryOverrides.set(input.nodeId, approval.override);
    } else if (input.action === "continue") {
      recoveryOverrides.set(input.nodeId, {
        forceIndependentReview: false,
        instruction: resolutionReason,
        ...(input.reason?.trim() ? { userInput: input.reason.trim() } : {}),
      });
    } else if (input.action === "escalate") {
      recoveryOverrides.set(input.nodeId, {
        modelProfile: "expert",
        forceIndependentReview: true,
        instruction: resolutionReason,
      });
    } else if (input.action === "increase_review_strength") {
      recoveryOverrides.set(input.nodeId, {
        forceIndependentReview: true,
        instruction: resolutionReason,
      });
    }

    this.runRegistry.register({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      pausedNodeIds: new Set(),
      pausedTaskIds: new Set(),
      gatedNodeIds: new Set(),
      taskIdByNodeId: new Map(),
      manualPauseReasonByNodeId: new Map(),
      abortControllerByNodeId: new Map(),
    });
    this.deps.updateWorkflowRunState({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      status: "running",
      contextDocument: input.run.contextDocument,
    });
    const storagePlan = workflowStoragePlanFor(input.workflow.workflowId, input.run.runId);
    void this.runExecutor.execute({
      workflow: input.workflow,
      plan,
      runId: input.run.runId,
      baseWorkflowContextDocument: input.run.contextDocument,
      storagePlanDocument: workflowStoragePlanDocument(storagePlan),
      initialCheckpoint: materialized.checkpoint,
      initialNodeControl,
      initialDurableEventCount,
      ...(persisted.transaction ? { initialTransaction: persisted.transaction } : {}),
      recoveryCheckpoints: materialized.recoveryCheckpoints,
      resumeConversations: materialized.resumeConversations,
      recoveryOverrides,
    }).finally(() => {
      this.runRegistry.release(input.run.runId);
    });
    return { ok: true, workflowId: input.workflow.workflowId, runId: input.run.runId };
  }

  async answerWorkflowGate(input: AnswerWorkflowGateRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      const answer = input.answer.trim();
      if (!answer) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "A gate answer is required." };
      return this.resolveWorkflowV2Intervention({
        workflowId: input.workflowId,
        runId: input.runId,
        nodeId: input.nodeId,
        action: "continue",
        reason: answer,
      });
    }
    return {
      ok: false,
      workflowId: input.workflowId,
      runId: input.runId,
      error: "Workflow V2 plan is required. Legacy workflow execution is no longer supported.",
    };
  }

  async submitWorkflowScriptInput(input: SubmitWorkflowScriptInputRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    const store = this.deps.createWorkflowV2Store?.();
    if (!workflow?.workflowV2Plan || !run || !store?.readRunState) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 script input state is unavailable." };
    const transactionError = workflowTransactionPreflightError(workflow.workflowV2Plan.definition.transactionPolicy, runtimeTransactionCapabilities(store));
    if (transactionError) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: transactionError };
    if (run.status !== "waiting_for_user") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is not waiting for script input." };
    if (this.runRegistry.has(input.runId)) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is already active." };
    const persisted = await store.readRunState(input.workflowId, input.runId);
    const node = workflow.workflowV2Plan.definition.nodes.find((item) => item.id === input.nodeId);
    const request = persisted?.nodeControl[input.nodeId]?.scriptInput;
    if (!persisted || node?.execModel !== "script" || !request || request.submittedAt !== undefined) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not awaiting script input.` };
    const resolved = resolveWorkflowV2ScriptInput({ parameters: node.script.parameters, workflowContext: { objective: workflow.objective, contextDocument: run.contextDocument }, upstreamOutputs: persisted.workerOutputs, submittedValues: input.values });
    if (!resolved.complete) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Missing required script inputs: ${resolved.missing.map((item) => item.key).join(", ")}.` };
    const submittedAt = Date.now();
    const nodeControl = structuredClone(persisted.nodeControl);
    nodeControl[input.nodeId] = { ...nodeControl[input.nodeId]!, scriptInput: { ...request, submittedValues: structuredClone(input.values), auditValues: resolved.auditValues, submittedAt } };
    let runState = structuredClone(persisted.runState);
    if (runState.nodes[input.nodeId]?.status !== "paused") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not paused for script input.` };
    runState = transitionWorkflowV2NodeState(runState, { nodeId: input.nodeId, status: "ready", now: submittedAt });
    runState = { ...runState, status: "running" };
    await store.persistRunState({ ...persisted, savedAt: submittedAt, runState, nodeControl });
    this.runRegistry.register({ workflowId: input.workflowId, runId: input.runId, pausedNodeIds: new Set(), pausedTaskIds: new Set(), gatedNodeIds: new Set(), taskIdByNodeId: new Map(), manualPauseReasonByNodeId: new Map(), abortControllerByNodeId: new Map() });
    this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, status: "running", progress: run.progress.map((item) => {
      if (item.nodeId !== input.nodeId) return item;
      const next = { ...item, status: "running" as const, detail: "Script input submitted", inputSummary: structuredClone(resolved.auditValues) };
      delete next.inputRequest;
      return next;
    }), appendEvents: [{ type: "gate_answered", nodeId: input.nodeId, at: submittedAt, answer: JSON.stringify(resolved.auditValues) }], contextDocument: run.contextDocument });
    const storagePlan = workflowStoragePlanFor(input.workflowId, input.runId);
    void this.runExecutor.execute({ workflow, plan: workflow.workflowV2Plan, runId: input.runId, baseWorkflowContextDocument: run.contextDocument, storagePlanDocument: workflowStoragePlanDocument(storagePlan), initialCheckpoint: { runState, workerOutputs: persisted.workerOutputs }, initialNodeControl: nodeControl, initialDurableEventCount: persisted.eventCount, ...(persisted.transaction ? { initialTransaction: persisted.transaction } : {}) }).finally(() => this.runRegistry.release(input.runId));
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }


}
