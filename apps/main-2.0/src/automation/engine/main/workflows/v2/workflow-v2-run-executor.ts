import type { RunTaskRequest, TaskRun } from "../../../shared/types";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeConversation } from "../../../shared/runtime/conversation";
import { mergeRuntimeUsage } from "../../../../../shared/runtime/usage";
import type { WorkflowEvent, WorkflowRunNodeTelemetry, WorkflowRunProgressItem } from "../../../shared/workflow/run";
import type { WorkflowV2LLMNode, WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowNodeMessage } from "../../../shared/workflow-v2/conversation";
import type { WorkflowV2ScriptExecutionReceipt, WorkflowV2ScriptWorkerOutput, WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type {
  WorkflowV2Plan,
  WorkflowV2ResultPacket,
  WorkflowV2TaskPacket,
} from "../../../shared/workflow-v2/planning";
import { resolveWorkflowTransactionPolicy, sanitizeWorkflowOperationRecord, sanitizeWorkflowTransactionValue, type WorkflowCommitPlan, type WorkflowOperationRecord, type WorkflowTransactionState } from "../../../shared/workflow-v2/transaction";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKFLOW_TASK_POLL_MS,
  WORKFLOW_TASK_TIMEOUT_MS,
  taskAssistantArtifact,
  taskArtifact,
  truncateWorkflowContext,
  workflowProgressAfterFailure,
} from "../../../shared/workflow-v2/runtime-utils";
import { executeWorkflowV2Plan } from "./workflow-v2-executor";
import type { WorkflowRunRegistry } from "../workflow-run-registry";
import { persistWorkflowV2PreflightBlocked, WorkflowV2RunPersistence } from "./workflow-v2-run-persistence";
import type { ExecuteWorkflowV2RunInput, WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";
export type { WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";

function addNodeUsage(telemetry: WorkflowRunNodeTelemetry, usage: TaskRun["usage"]): WorkflowRunNodeTelemetry {
  if (!usage) return telemetry;
  return { ...telemetry, ...mergeRuntimeUsage(telemetry, usage) };
}

function startNodeAttempt(previous: WorkflowRunNodeTelemetry | undefined, next: WorkflowRunNodeTelemetry): WorkflowRunNodeTelemetry {
  if (!previous) return next;
  const merged = addNodeUsage(next, previous);
  return {
    ...merged,
    attempt: next.attempt,
    startedAt: previous.startedAt,
  };
}
import type { WorkflowRuntimeDependencies } from "../workflow-runtime-ports";
import type {
  WorkflowV2ExecutionLeaseState,
  WorkflowV2ProgressReport,
} from "../../../shared/workflow-v2/supervision";
import type { WorkflowV2ReviewerInput, WorkflowV2ReviewerResponse } from "../../../shared/workflow-v2/review";
import { isWorkflowV2InterventionAction } from "../../../shared/workflow-v2/review";
import {
  createWorkflowV2ExecutionLease,
  inspectWorkflowV2ExecutionLease,
  recordWorkflowV2LeaseActivity,
  resolveWorkflowV2SupervisorDecision,
} from "./workflow-v2-supervisor";
import {
  parseWorkflowV2ProgressReport,
  parseWorkflowV2SupervisorDecision,
  workflowV2ContinueAfterProbePrompt,
  workflowV2ProgressProbePrompt,
  workflowV2SupervisorDecisionPrompt,
} from "./workflow-v2-supervision-prompts";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";
import {
  configuredAgentModelId,
  resolveWorkflowNodeAgent,
  workflowV2ExecutionEnvironment,
  workflowV2LlmNodePrompt,
  workflowV2ReviewerPolicy,
} from "./workflow-v2-node-policy";
import {
  parseWorkflowV2HookLlmValue,
  parseWorkflowV2WorkerArtifact,
} from "./workflow-v2-output-parser";
import { materializeWorkflowV2OutputArtifacts } from "./workflow-v2-output-artifacts";
import {
  parseWorkflowV2ReviewerResponse,
  workflowV2ReviewerPrompt,
} from "./workflow-v2-reviewer";
import {
  type WorkflowV2DurableEvent,
  type WorkflowV2DurableNodeControlState,
} from "../../../shared/workflow-v2/storage";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import { recordWorkflowV2ScriptInputRequest, resolveWorkflowV2ScriptInput, workflowV2ScriptInputSignal } from "./workflow-v2-script-input";
import { projectWorkflowV2PausedNodeInteraction } from "./workflow-v2-node-interaction";
import { executeAuthorizedWorkflowV2Script } from "./workflow-v2-script-execution";
import { authorizeWorkflowV2ScriptOperation } from "./workflow-v2-script-approval";
import { buildWorkflowV2FinalReport, buildWorkflowV2RecoveryPreview } from "./workflow-v2-recovery";
import {
  createWorkflowV2HookRegistry,
  runWorkflowV2HookChain,
  WorkflowV2HookSignal,
  type WorkflowV2HookChainResult,
} from "./workflow-v2-hooks";
import { runWorkflowV2TaskWithOutputPolicy } from "./workflow-v2-output-approval";
import { workflowV2WorkspaceIsolationPlanError } from "./workflow-v2-workspace-transaction";
import { inspectWorkflowV2AgentCompletion } from "./workflow-v2-node-acceptance";
import { WorkflowV2ScriptExecutionError } from "./workflow-v2-script-executor";
import { WorkflowV2CommitCoordinator } from "./workflow-v2-commit-coordinator";
import { canRollbackWorkflowV2CurrentSavepoint } from "./workflow-v2-recovery-capabilities";

const WORKFLOW_V2_MAX_PARALLEL_NODES = 4;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
function workflowV2NodeSavepointId(nodeId: string, attempt: number): string {
  return `node-${createHash("sha256").update(nodeId).digest("hex").slice(0, 20)}-attempt-${attempt}`;
}
function workflowV2PolicySavepointId(checkpointId: string): string {
  return `policy-${createHash("sha256").update(checkpointId).digest("hex").slice(0, 20)}`;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowNodeAuditMessages(tasks: readonly TaskRun[]): TaskRun["messages"] {
  const messagesById = new Map<string, TaskRun["messages"][number]>();
  for (const task of tasks) {
    for (const [messageIndex, message] of task.messages.entries()) {
      const messageId = message.id?.trim() ? message.id : `${task.id}:message:${messageIndex}`;
      const existing = messagesById.get(messageId);
      if (!existing) {
        messagesById.set(messageId, {
          ...structuredClone(message),
          id: messageId,
          ...(message.events ? {
            events: message.events.map((event, eventIndex) => ({
              ...structuredClone(event),
              id: event.id?.trim() ? event.id : `${messageId}:event:${eventIndex}`,
            })),
          } : {}),
        });
        continue;
      }
      const eventsById = new Map((existing.events ?? []).map((event, eventIndex) => [event.id?.trim() ? event.id : `${messageId}:existing-event:${eventIndex}`, event]));
      for (const [eventIndex, event] of (message.events ?? []).entries()) {
        const eventId = event.id?.trim() ? event.id : `${messageId}:event:${eventIndex}`;
        eventsById.set(eventId, { ...structuredClone(event), id: eventId });
      }
      messagesById.set(messageId, {
        ...structuredClone(message),
        id: messageId,
        events: [...eventsById.values()],
      });
    }
  }
  return [...messagesById.values()];
}

function workflowNodeHistoryMessages(taskOrTasks: TaskRun | readonly TaskRun[]): WorkflowNodeMessage[] {
  const tasks = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
  return workflowNodeAuditMessages(tasks).flatMap((message, messageIndex) => {
    const messages: WorkflowNodeMessage[] = [];
    if (message.content.trim()) {
      messages.push({
        id: `${message.id || `workflow-message:${messageIndex}`}:content`,
        role: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
        content: message.content,
        at: message.timestamp,
      });
    }
    for (const event of message.events ?? []) {
      messages.push({
        id: event.id,
        role: event.type === "tool_call" || event.type === "tool_result" ? "tool" : "system",
        content: event.content || event.type.replaceAll("_", " "),
        at: event.timestamp,
        eventType: event.type,
        ...(event.name ? { name: event.name } : {}),
        event: structuredClone(event),
      });
    }
    return messages;
  });
}

class WorkflowV2OneShotInputRequestSignal extends Error {
  constructor(readonly task: TaskRun, readonly question: string) {
    super("One-shot workflow node requested user input.");
  }
}
export class WorkflowV2RunExecutor {
  constructor(
    private readonly deps: WorkflowRuntimeDependencies,
    private readonly runRegistry: WorkflowRunRegistry,
  ) {}

  async execute(input: ExecuteWorkflowV2RunInput): Promise<void> {
    const { workflow, plan, runId, baseWorkflowContextDocument, storagePlanDocument } = input;
    const executionStartedAt = Date.now();
    const maxWallClockMs = plan.budget.cost?.maxWallClockMs;
    const maxModelCalls = plan.budget.cost?.maxModelCalls;
    let startedModelCalls = 0;
    const durableStore = this.deps.createWorkflowV2Store?.();
    const durableNodeControl: Record<string, WorkflowV2DurableNodeControlState> = input.initialNodeControl
      ? structuredClone(input.initialNodeControl)
      : Object.fromEntries(plan.definition.nodes.map((node) => [node.id, { extensionCount: 0 }]));
    const hookVariablesByNodeId = new Map<string, Record<string, unknown>>(
      Object.entries(durableNodeControl).map(([nodeId, control]) => [nodeId, structuredClone(control.hookVariables ?? {})]),
    );
    const hookInjectedContextByNodeId = new Map<string, string[]>();
    let latestSnapshot = this.deps.snapshot();
    let latestProgress = plan.definition.nodes.map((node): WorkflowRunProgressItem => {
      const recovered = input.initialCheckpoint?.runState.nodes[node.id];
      if (recovered?.status === "completed" || recovered?.status === "skipped") {
        return { nodeId: node.id, title: node.title, status: "completed", detail: "Recovered" };
      }
      if (recovered?.status === "failed") {
        return { nodeId: node.id, title: node.title, status: "failed", detail: recovered.lastError ?? "Recovery failed" };
      }
      return { nodeId: node.id, title: node.title, status: "queued", detail: "Queued" };
    });
    const sourceWorkDir = workflow.workDir || latestSnapshot.workDir;
    const transactionMode = resolveWorkflowTransactionPolicy(plan.definition.transactionPolicy).policy.defaultMode;
    const workspaceIsolated = transactionMode === "strict_atomic";
    let workflowWorkDir = sourceWorkDir;
    let baselineId: string | undefined;
    let workspaceScope: { governedFileCount: number; excludedPaths: string[] } | undefined;
    if (workspaceIsolated) {
      try {
        const planError = workflowV2WorkspaceIsolationPlanError(plan, { brokeredScriptExecution: Boolean(this.deps.executeWorkflowV2BrokeredScript), brokeredAdapters: this.deps.workflowV2BrokeredAdapters });
        if (planError) throw new Error(planError);
        if (!durableStore?.prepareWorkspaceTransaction) throw new Error("Workflow strict_atomic mode requires durable workspace isolation.");
        const preparation = await durableStore.prepareWorkspaceTransaction({
          workflowId: workflow.workflowId,
          runId,
          sourceDir: sourceWorkDir,
          baselineId: `baseline:${workflow.workflowId}:${runId}`,
        });
        workflowWorkDir = preparation.workspaceDir;
        baselineId = preparation.baselineId;
        workspaceScope = {
          governedFileCount: preparation.manifest.files.length,
          excludedPaths: preparation.manifest.excluded.map((entry) => entry.relativePath),
        };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = String(sanitizeWorkflowTransactionValue(rawMessage));
        try {
          await persistWorkflowV2PreflightBlocked({
            store: durableStore,
            workflow,
            plan,
            runId,
            error: message,
            nodeControl: durableNodeControl,
            initialEventCount: input.initialDurableEventCount,
            initialCheckpoint: input.initialCheckpoint,
            initialTransaction: input.initialTransaction,
          });
        } catch (persistenceError) {
          console.warn("[workflow-v2] Failed to persist strict transaction preflight failure", persistenceError);
        }
        this.deps.finishWorkflowRun({
          workflowId: workflow.workflowId,
          runId,
          status: "failed",
          progress: workflowProgressAfterFailure(latestProgress, message),
          contextDocument: baseWorkflowContextDocument,
          lastError: message,
        });
        return;
      }
    }
    const configuredAgentId = workflow.configuredAgentId;
    const modelId = configuredAgentModelId(workflow, latestSnapshot);
    const publishTransactionProjection = async (transaction: WorkflowTransactionState): Promise<void> => {
      const operations = (await durableStore?.readOperations?.(workflow.workflowId, runId) ?? [])
        .map(sanitizeWorkflowOperationRecord);
      const persisted = await durableStore?.readRunState?.(workflow.workflowId, runId);
      const workspaceDiff = workspaceIsolated
        ? await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId })
        : undefined;
      const recoveryVisible = transaction.status === "waiting_for_user"
        || transaction.status === "recovery_required"
        || transaction.status === "partially_rolled_back";
      this.deps.updateWorkflowRunState({
        workflowId: workflow.workflowId,
        runId,
        transaction: structuredClone(transaction),
        operations,
        recoveryDecisions: structuredClone(persisted?.recoveryDecisions ?? []),
        recovery: recoveryVisible && persisted
          ? buildWorkflowV2RecoveryPreview({ transaction, operations, runState: persisted.runState, nodeControl: persisted.nodeControl, ...(workspaceDiff ? { workspaceDiff } : {}), workspaceAvailable: workspaceDiff !== undefined, canRollbackSavepoint: await canRollbackWorkflowV2CurrentSavepoint({ store: durableStore, workflowId: workflow.workflowId, runId, transaction }), canRollbackWorkspace: Boolean(durableStore?.rollbackWorkspaceTransaction) })
          : null,
      });
    };
    const persistence = new WorkflowV2RunPersistence({
      store: durableStore,
      workflow,
      plan,
      runId,
      initialEventCount: input.initialDurableEventCount ?? 0,
      ...(input.initialCheckpoint ? { initialCheckpoint: input.initialCheckpoint } : {}),
      ...(input.initialTransaction ? { initialTransaction: input.initialTransaction } : {}),
      ...(baselineId ? { baselineId } : {}),
      nodeControl: durableNodeControl,
      workDir: workflowWorkDir,
      configuredAgentId,
      modelId, configuredAgents: latestSnapshot.configuredAgents,
      ...(input.recoveryOverrides ? { recoveryOverrides: input.recoveryOverrides } : {}),
      onTransactionChanged: publishTransactionProjection,
    });
    if (workspaceIsolated && baselineId && !input.initialTransaction) {
      await persistence.initializeWorkspaceTransaction(baselineId, workspaceScope);
    }
    const createCommitCoordinator = (): WorkflowV2CommitCoordinator => {
      if (!durableStore?.commitWorkspaceTransaction || !durableStore.readOperations) {
        throw new Error("Workflow strict_atomic mode cannot commit its governed transaction.");
      }
      const commitBroker = this.deps.createWorkflowV2RecoveryOperationBroker?.(durableStore);
      if (!commitBroker) throw new Error("Workflow strict_atomic mode cannot create its external operation commit broker.");
      return new WorkflowV2CommitCoordinator(durableStore, commitBroker);
    };
    const prepareGovernedCommitPlan = async (): Promise<WorkflowCommitPlan> => {
      const coordinator = createCommitCoordinator();
      const existingPlan = await durableStore!.readCommitPlan?.(workflow.workflowId, runId);
      const operationIds = (await durableStore!.readOperations!(workflow.workflowId, runId))
        .filter((operation) => operation.adapterId && operation.state === "planned")
        .map((operation) => operation.operationId);
      const preview = await coordinator.previewPlan({
        workflowId: workflow.workflowId,
        runId,
        transactionId: persistence.transactionState.transactionId,
        operationIds,
        includeWorkspace: true,
      });
      if (existingPlan?.planDigest === preview.planDigest) return existingPlan;
      return durableStore!.persistCommitPlan!(preview);
    };
    const commitGovernedChanges = async (): Promise<Awaited<ReturnType<WorkflowV2CommitCoordinator["commit"]>>> => {
      const coordinator = createCommitCoordinator();
      const existingPlan = await durableStore!.readCommitPlan?.(workflow.workflowId, runId);
      if (persistence.transactionState.status !== "committing" || !existingPlan) {
        await prepareGovernedCommitPlan();
      }
      await persistence.transitionTransaction("committing", { type: "commit_started", detail: "Applying governed checkpoint changes." });
      return coordinator.commit({ workflowId: workflow.workflowId, runId });
    };
    const processTransactionCheckpoints = async (checkpoint: ExecuteWorkflowV2Checkpoint): Promise<{ pauseReason?: string }> => {
      if (!workspaceIsolated) return {};
      const completedIds = new Set(persistence.transactionState.completedCheckpointIds ?? []);
      const approvedIds = new Set(persistence.transactionState.approvedCheckpointIds ?? []);
      for (const policyCheckpoint of resolveWorkflowTransactionPolicy(plan.definition.transactionPolicy).policy.checkpoints) {
        if (completedIds.has(policyCheckpoint.id)) continue;
        const reached = policyCheckpoint.afterNodeIds.every((nodeId) => {
          const status = checkpoint.runState.nodes[nodeId]?.status;
          return status === "completed" || status === "skipped";
        });
        if (!reached) continue;
        const savepointId = workflowV2PolicySavepointId(policyCheckpoint.id);
        if (persistence.transactionState.currentSavepointId !== savepointId) {
          if (!durableStore?.createWorkspaceSavepoint) throw new Error("Workflow strict_atomic mode cannot create a policy savepoint.");
          await durableStore.createWorkspaceSavepoint({
            workflowId: workflow.workflowId,
            runId,
            savepointId,
            nodeId: policyCheckpoint.afterNodeIds.at(-1) ?? policyCheckpoint.id,
            attempt: 1,
          });
          await persistence.recordSavepoint(savepointId, policyCheckpoint.afterNodeIds.at(-1) ?? policyCheckpoint.id, 1);
        }
        const pendingPlan = policyCheckpoint.kind === "commit" ? await prepareGovernedCommitPlan() : undefined;
        const approvalMatchesCurrentPlan = approvedIds.has(policyCheckpoint.id)
          && (!pendingPlan || pendingPlan.approval?.evidenceDigest === pendingPlan.planDigest);
        if (policyCheckpoint.approval === "required" && !approvalMatchesCurrentPlan) {
          await persistence.requireCheckpointApproval(policyCheckpoint.id, savepointId, pendingPlan?.planDigest);
          approvedIds.delete(policyCheckpoint.id);
          const persisted = await durableStore?.readRunState?.(workflow.workflowId, runId);
          const workspaceDiff = await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId });
          if (persisted) {
            const operations = (await durableStore?.readOperations?.(workflow.workflowId, runId) ?? []).map(sanitizeWorkflowOperationRecord);
            this.deps.updateWorkflowRunState({
              workflowId: workflow.workflowId,
              runId,
              status: "waiting_for_user",
              recovery: buildWorkflowV2RecoveryPreview({
                transaction: persistence.transactionState,
                operations,
                runState: persisted.runState,
                nodeControl: persisted.nodeControl,
                workspaceDiff: {
                  created: workspaceDiff?.created ?? [],
                  modified: workspaceDiff?.modified ?? [],
                  deleted: workspaceDiff?.deleted ?? [],
                },
                workspaceAvailable: workspaceDiff !== undefined,
                canRollbackSavepoint: await canRollbackWorkflowV2CurrentSavepoint({ store: durableStore, workflowId: workflow.workflowId, runId, transaction: persistence.transactionState }),
                canRollbackWorkspace: Boolean(durableStore?.rollbackWorkspaceTransaction),
              }),
            });
          }
          return { pauseReason: `Checkpoint ${policyCheckpoint.title} requires approval.` };
        }
        if (policyCheckpoint.kind === "commit") {
          await persistence.beginCheckpointCommit(policyCheckpoint.id);
          const commit = await commitGovernedChanges();
          if (commit.conflicts.length > 0) {
            await persistence.transitionTransaction("waiting_for_user", { type: "conflict_detected", detail: `Checkpoint conflicts require review: ${commit.conflicts.join(", ")}` });
            const persisted = await durableStore?.readRunState?.(workflow.workflowId, runId);
            const workspaceDiff = await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId });
            const conflictDetails = await durableStore?.inspectWorkspaceConflicts?.({ workflowId: workflow.workflowId, runId, paths: commit.conflicts }) ?? [];
            if (persisted) {
              const operations = (await durableStore?.readOperations?.(workflow.workflowId, runId) ?? []).map(sanitizeWorkflowOperationRecord);
              this.deps.updateWorkflowRunState({
                workflowId: workflow.workflowId,
                runId,
                status: "waiting_for_user",
                recovery: buildWorkflowV2RecoveryPreview({
                  transaction: persistence.transactionState,
                  operations,
                  runState: persisted.runState,
                  nodeControl: persisted.nodeControl,
                  workspaceDiff: { created: workspaceDiff?.created ?? [], modified: workspaceDiff?.modified ?? [], deleted: workspaceDiff?.deleted ?? [], conflicts: commit.conflicts },
                  workspaceAvailable: workspaceDiff !== undefined,
                  canRollbackSavepoint: await canRollbackWorkflowV2CurrentSavepoint({ store: durableStore, workflowId: workflow.workflowId, runId, transaction: persistence.transactionState }),
                  canRollbackWorkspace: Boolean(durableStore?.rollbackWorkspaceTransaction),
                  conflictDetails,
                }),
              });
            }
            return { pauseReason: `Checkpoint ${policyCheckpoint.title} has workspace conflicts.` };
          }
          if (commit.status !== "committed") {
            await persistence.transitionTransaction(commit.status, {
              type: commit.status === "recovery_required" ? "recovery_required" : "compensation_completed",
              detail: commit.error ?? `Checkpoint commit completed with ${commit.status}.`,
            });
            throw new Error(commit.error ?? `Checkpoint commit completed with ${commit.status}.`);
          }
        }
        await persistence.completeCheckpoint(policyCheckpoint.id);
        completedIds.add(policyCheckpoint.id);
      }
      return {};
    };
    const operationLedgerEnabled = Boolean(durableStore?.planOperation && durableStore.transitionOperation && durableStore.readOperations);
    const planNodeOperation = async (operation: WorkflowOperationRecord): Promise<void> => {
      await persistence.planOperation(operation);
      await persistence.transitionOperation({ operationId: operation.operationId, state: "applying", updatedAt: Date.now() });
    };
    const completeNodeOperation = async (operationId: string, receipt: unknown): Promise<void> => {
      await persistence.transitionOperation({ operationId, state: "applied", updatedAt: Date.now(), receipt });
    };
    const markNodeOperationUnknown = async (operationId: string, error: unknown, receipt?: unknown): Promise<void> => {
      const message = error instanceof Error ? error.message : String(error);
      await persistence.transitionOperation({ operationId, state: "unknown", updatedAt: Date.now(), error: message, ...(receipt !== undefined ? { receipt } : {}) });
    };
    const inspectNodeWorkspaceDiff = async (nodeId: string, attempt: number) => {
      if (!workspaceIsolated) return undefined;
      if (durableStore?.inspectWorkspaceSavepointDiff) {
        return durableStore.inspectWorkspaceSavepointDiff({ workflowId: workflow.workflowId, runId, savepointId: workflowV2NodeSavepointId(nodeId, attempt) });
      }
      return durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId });
    };

    const remainingWallClockMs = (): number => maxWallClockMs === undefined
      ? Number.POSITIVE_INFINITY
      : maxWallClockMs - (Date.now() - executionStartedAt);
    const assertWallClockBudget = (nodeId: string): number => {
      const remainingMs = remainingWallClockMs();
      if (remainingMs <= 0) {
        throw new Error(`Workflow V2 wall-clock budget exhausted before node ${nodeId}.`);
      }
      return remainingMs;
    };
    const consumeModelCallBudget = (nodeId: string): void => {
      if (maxModelCalls !== undefined && startedModelCalls >= maxModelCalls) {
        throw new Error(`Workflow V2 model-call budget exhausted before node ${nodeId}.`);
      }
      startedModelCalls += 1;
    };

    const updateNode = (
      nodeId: string,
      update: Partial<WorkflowRunProgressItem>,
      event?: Omit<WorkflowEvent, "at">,
      clearTaskId = false,
    ): void => {
      latestProgress = latestProgress.map((item) => {
        if (item.nodeId !== nodeId) return item;
        const next = { ...item, ...update };
        if (next.status !== "awaiting_input") delete next.inputRequest;
        if (next.status !== "paused" && next.status !== "awaiting_input") delete next.intervention;
        if (clearTaskId) delete next.taskId;
        return next;
      });
      this.deps.updateWorkflowRunState({
        workflowId: workflow.workflowId,
        runId,
        status: "running",
        progress: latestProgress,
        ...(event ? { appendEvents: [{ ...event, at: Date.now() }] } : {}),
        contextDocument: baseWorkflowContextDocument,
      });
    };

    const startWorkflowTask = async (request: RunTaskRequest, allowOutputWrite = false): Promise<TaskRun> => {
      const existingTaskIds = new Set(latestSnapshot.tasks.map((task) => task.id));
      latestSnapshot = await runWorkflowV2TaskWithOutputPolicy({
        workflowId: workflow.workflowId,
        runId,
        workDir: workflowWorkDir,
        request,
        allowOutputWrite,
        workspaceOnly: workspaceIsolated,
        ...(workspaceIsolated && allowOutputWrite ? { allowedFileWriteRoot: workflowWorkDir } : {}),
        runTask: this.deps.runTask,
      });
      const task = latestSnapshot.tasks
        .filter((item) => !existingTaskIds.has(item.id))
        .sort((left, right) => right.createdAt - left.createdAt)
        .find((item) => item.prompt === request.prompt && item.configuredAgentId === request.configuredAgentId);
      if (task) return task;
      const fallbackTask = latestSnapshot.tasks
        .filter((item) => !existingTaskIds.has(item.id))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!fallbackTask) throw new Error("Workflow V2 task creation did not return a new task.");
      return fallbackTask;
    };
    const throwIfWorkflowV2ManuallyPaused = async (nodeId: string, task?: TaskRun): Promise<void> => {
      const activeRun = this.runRegistry.get(runId);
      const reason = activeRun?.manualPauseReasonByNodeId?.get(nodeId);
      if (!reason) return;
      activeRun?.manualPauseReasonByNodeId?.delete(nodeId);
      const node = plan.definition.nodes.find((item) => item.id === nodeId);
      const attempt = persistence.latestCheckpoint?.runState.nodes[nodeId]?.attempt ?? 1;
      const checkpoint = durableNodeControl[nodeId]?.checkpoint;
      const partialArtifact = task ? truncateWorkflowContext(taskArtifact(task), 500) : "";
      const report: WorkflowV2ProgressReport = {
        nodeId,
        attempt: Math.max(1, attempt),
        phase: "manual intervention",
        completedItems: [],
        remainingItems: [node?.title ?? nodeId],
        blockers: [reason],
        evidence: partialArtifact ? [partialArtifact] : [],
        ...(checkpoint ? { checkpoint } : {}),
        safeToInterrupt: true,
        requestedAction: "need_input",
        reportedAt: Date.now(),
      };
      durableNodeControl[nodeId] = {
        ...(durableNodeControl[nodeId] ?? { extensionCount: 0 }),
        progressReport: structuredClone(report),
        stopReason: reason,
      };
      await persistence.persistControlState(nodeId, "manual_pause", reason);
      throw new WorkflowV2SupervisionSignal({
        report,
        resolution: {
          action: "pause",
          question: `Choose how to continue Workflow V2 node ${node?.title ?? nodeId}.`,
          reason,
        },
        ...(task?.runtimeConversation ? { resumeConversation: task.runtimeConversation } : {}),
      });
    };

    const waitForTask = async (
      taskId: string,
      nodeId: string,
      timeoutMs = WORKFLOW_TASK_TIMEOUT_MS,
      detectUserInputRequest = false,
    ): Promise<TaskRun> => {
      const startedAt = Date.now();
      while (true) {
        assertWallClockBudget(nodeId);
        const remainingTaskMs = timeoutMs - (Date.now() - startedAt);
        if (remainingTaskMs <= 0) throw new Error(`Workflow V2 task ${taskId} timed out.`);
        latestSnapshot = this.deps.snapshot();
        const task = latestSnapshot.tasks.find((item) => item.id === taskId);
        if (!task) throw new Error(`Workflow V2 task ${taskId} was deleted before completion.`);
        await throwIfWorkflowV2ManuallyPaused(nodeId, task);
        if (detectUserInputRequest) {
          const requestEvent = task.messages
            .flatMap((message) => message.events ?? [])
            .find((event) => event.type === "user_input_request" && event.requestState !== "resolved");
          if (requestEvent?.content.trim()) throw new WorkflowV2OneShotInputRequestSignal(task, requestEvent.content.trim());
        }
        const approvalRequest = task.messages
          .flatMap((message) => message.events ?? [])
          .find((event) => event.type === "approval_request" && event.requestState === "live");
        if (approvalRequest) {
          const prompt = approvalRequest.content.trim() || "This workflow node is waiting for command approval.";
          updateNode(nodeId, {
            status: "awaiting_input",
            detail: prompt,
            taskId,
            inputRequest: { kind: "agent_message", prompt },
            messages: workflowNodeHistoryMessages(task),
          });
          await delay(Math.min(WORKFLOW_TASK_POLL_MS, remainingTaskMs, remainingWallClockMs()));
          continue;
        }
        if (task.status === "completed") return task;
        if (task.status === "failed" || task.status === "stopped") {
          throw new Error(task.lastError || `Workflow V2 task ${task.title} ${task.status}.`);
        }
        updateNode(nodeId, { status: "running", detail: taskArtifact(task), taskId });
        await delay(Math.min(WORKFLOW_TASK_POLL_MS, remainingTaskMs, remainingWallClockMs()));
      }
    };

    const runtimeAttemptByNodeId = new Map<string, number>();
    const consumedRecoveryNodeIds = new Set<string>();

    const startModelTask = async (nodeId: string, request: RunTaskRequest, allowOutputWrite = false): Promise<TaskRun> => {
      consumeModelCallBudget(nodeId);
      const task = await startWorkflowTask({
        ...request,
        planningWorkflowId: workflow.workflowId,
        workflowRunId: runId,
        workflowNodeId: nodeId,
      }, allowOutputWrite);
      this.runRegistry.get(runId)?.taskIdByNodeId.set(nodeId, task.id);
      return task;
    };

    const cleanupSupervisedTasks = async (
      taskIds: readonly string[],
      archiveTaskIds: ReadonlySet<string>,
    ): Promise<void> => {
      for (const taskId of taskIds) {
        latestSnapshot = await this.deps.deleteTask(taskId, {
          preserveRuntimeConversation: !archiveTaskIds.has(taskId),
        });
      }
    };

    const stoppedTaskSnapshot = (task: TaskRun): TaskRun => {
      latestSnapshot = this.deps.snapshot();
      return latestSnapshot.tasks.find((item) => item.id === task.id) ?? task;
    };

    const unavailableProgressReport = (
      node: WorkflowV2LLMNode,
      attempt: number,
      partialArtifact: string,
      lease: WorkflowV2ExecutionLeaseState,
    ): WorkflowV2ProgressReport => ({
      nodeId: node.id,
      attempt,
      phase: "progress probe unavailable",
      completedItems: [],
      remainingItems: [node.title],
      blockers: ["The runtime did not expose a resumable conversation after interruption."],
      evidence: partialArtifact.trim() ? [truncateWorkflowContext(partialArtifact, 500)] : [],
      safeToInterrupt: true,
      requestedAction: "need_input",
      reportedAt: Math.min(Date.now(), lease.hardDeadlineAt),
    });

    const waitForLeasedLlmTask = async (input: {
      node: WorkflowV2LLMNode;
      initialTask: TaskRun;
      attempt: number;
      configuredAgentId: string;
      modelId: string;
      workDir: string;
      taskIds: string[];
      auditTaskIds: string[];
      supervisorTaskIds: string[];
      completionExecutionId?: string;
    }): Promise<TaskRun> => {
      const policy = input.node.executionLease;
      if (!policy) {
        return waitForTask(input.initialTask.id, input.node.id, WORKFLOW_TASK_TIMEOUT_MS, true);
      }

      let currentTask = input.initialTask;
      let lease = createWorkflowV2ExecutionLease({
        nodeId: input.node.id,
        attempt: input.attempt,
        startedAt: Date.now(),
        policy,
      });
      durableNodeControl[input.node.id] = {
        ...durableNodeControl[input.node.id],
        lease: structuredClone(lease),
        extensionCount: lease.extensionCount,
      };
      await persistence.persistControlState(input.node.id, "lease_started");
      let previousReport: WorkflowV2ProgressReport | undefined;
      const boundedProbeTimeoutMs = (): number => {
        const remainingLeaseMs = lease.hardDeadlineAt - Date.now();
        const remainingRunMs = remainingWallClockMs();
        const timeoutMs = Math.min(policy.progressProbeTimeoutMs, remainingLeaseMs, remainingRunMs);
        if (timeoutMs <= 0) throw new Error(`Workflow V2 node ${input.node.id} reached its hard execution timeout.`);
        return timeoutMs;
      };

      while (true) {
        assertWallClockBudget(input.node.id);
        latestSnapshot = this.deps.snapshot();
        const task = latestSnapshot.tasks.find((item) => item.id === currentTask.id);
        if (!task) throw new Error(`Workflow V2 task ${currentTask.id} was deleted before completion.`);
        currentTask = task;
        await throwIfWorkflowV2ManuallyPaused(input.node.id, task);
        const requestEvent = task.messages
          .flatMap((message) => message.events ?? [])
          .find((event) => event.type === "user_input_request" && event.requestState !== "resolved");
        if (requestEvent?.content.trim()) throw new WorkflowV2OneShotInputRequestSignal(task, requestEvent.content.trim());
        if (task.status === "completed") return task;
        if (task.status === "failed" || task.status === "stopped") {
          throw new Error(task.lastError || `Workflow V2 task ${task.title} ${task.status}.`);
        }

        if (task.updatedAt > lease.lastActivityAt) {
          lease = recordWorkflowV2LeaseActivity(lease, Math.min(task.updatedAt, lease.hardDeadlineAt));
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            extensionCount: lease.extensionCount,
          };
        }
        updateNode(input.node.id, { status: "running", detail: taskArtifact(task), taskId: task.id });
        const now = Date.now();
        const inspection = inspectWorkflowV2ExecutionLease({ lease, policy, now });
        if (inspection === "active") {
          const untilInactivity = policy.inactivityTimeoutMs - (now - lease.lastActivityAt);
          const waitMs = Math.max(1, Math.min(
            WORKFLOW_TASK_POLL_MS,
            lease.softDeadlineAt - now,
            lease.hardDeadlineAt - now,
            untilInactivity,
            remainingWallClockMs(),
          ));
          await delay(waitMs);
          continue;
        }
        if (inspection === "hard_timeout") {
          await this.deps.stopTask(task.id);
          const report: WorkflowV2ProgressReport = {
            ...unavailableProgressReport(input.node, input.attempt, taskArtifact(task), lease),
            phase: "hard execution timeout",
            blockers: ["The node reached its absolute hard execution timeout."],
            ...(durableNodeControl[input.node.id]?.checkpoint
              ? { checkpoint: durableNodeControl[input.node.id]!.checkpoint }
              : {}),
          };
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: "Hard execution timeout reached.",
          };
          await persistence.persistControlState(input.node.id, "lease_hard_timeout", "Hard execution timeout reached.");
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `Node ${input.node.title} reached its hard timeout. Choose whether to retry, skip, escalate, or replan.`,
              reason: "Hard execution timeout reached.",
            },
            ...(task.runtimeConversation ? { resumeConversation: task.runtimeConversation } : {}),
          });
        }

        await this.deps.stopTask(task.id);
        const stoppedTask = stoppedTaskSnapshot(task);
        const partialArtifact = truncateWorkflowContext(taskArtifact(stoppedTask), 4_000);
        if (!stoppedTask.runtimeConversation) {
          const report = unavailableProgressReport(input.node, input.attempt, partialArtifact, lease);
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: "Progress probe requires a resumable runtime conversation.",
          };
          await persistence.persistControlState(
            input.node.id,
            "progress_probe_unavailable",
            "Progress probe requires a resumable runtime conversation.",
          );
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `Node ${input.node.title} exceeded its soft timeout but its runtime cannot resume for a progress probe.`,
              reason: "Progress probe requires a resumable runtime conversation.",
            },
          });
        }

        const progressTask = await startModelTask(input.node.id, {
          prompt: workflowV2ProgressProbePrompt({
            node: input.node,
            attempt: input.attempt,
            partialArtifact,
            now: Date.now(),
          }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
          continuationPolicy: "resume-required",
          runtimeConversation: stoppedTask.runtimeConversation,
        });
        input.taskIds.push(progressTask.id);

        let completedProgressTask: TaskRun;
        try {
          completedProgressTask = await waitForTask(progressTask.id, input.node.id, boundedProbeTimeoutMs());
        } catch (error) {
          await this.deps.stopTask(progressTask.id);
          const reason = error instanceof Error ? error.message : String(error);
          const report = unavailableProgressReport(input.node, input.attempt, partialArtifact, lease);
          report.phase = "progress probe failed";
          report.blockers = [reason];
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: reason,
          };
          await persistence.persistControlState(input.node.id, "progress_probe_failed", reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `The progress probe for ${input.node.title} did not complete. Choose the next recovery action.`,
              reason,
            },
            ...(stoppedTask.runtimeConversation ? { resumeConversation: stoppedTask.runtimeConversation } : {}),
          });
        }
        const report = parseWorkflowV2ProgressReport(taskArtifact(completedProgressTask));
        durableNodeControl[input.node.id] = {
          ...durableNodeControl[input.node.id],
          lease: structuredClone(lease),
          progressReport: structuredClone(report),
          ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
          extensionCount: lease.extensionCount,
        };
        await persistence.persistControlState(input.node.id, "progress_reported", report.phase);

        const supervisorTask = await startModelTask(input.node.id, {
          prompt: workflowV2SupervisorDecisionPrompt({
            node: input.node,
            report,
            policy,
            extensionCount: lease.extensionCount,
          }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
        });
        input.taskIds.push(supervisorTask.id);
        input.supervisorTaskIds.push(supervisorTask.id);

        let completedSupervisorTask: TaskRun;
        try {
          completedSupervisorTask = await waitForTask(supervisorTask.id, input.node.id, boundedProbeTimeoutMs());
        } catch (error) {
          await this.deps.stopTask(supervisorTask.id);
          const reason = error instanceof Error ? error.message : String(error);
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
            extensionCount: lease.extensionCount,
            stopReason: reason,
          };
          await persistence.persistControlState(input.node.id, "supervisor_response_failed", reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `The supervisor decision for ${input.node.title} did not complete. Choose the next recovery action.`,
              reason,
            },
            ...(completedProgressTask.runtimeConversation
              ? { resumeConversation: completedProgressTask.runtimeConversation }
              : {}),
          });
        }
        const decision = parseWorkflowV2SupervisorDecision(taskArtifact(completedSupervisorTask));
        const resolution = resolveWorkflowV2SupervisorDecision({
          lease,
          policy,
          report,
          ...(previousReport ? { previousReport } : {}),
          decision,
          now: Date.now(),
        });
        if (resolution.action !== "continue") {
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
            extensionCount: lease.extensionCount,
            stopReason: resolution.reason,
          };
          await persistence.persistControlState(input.node.id, `supervisor_${resolution.action}`, resolution.reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution,
            ...(completedProgressTask.runtimeConversation
              ? { resumeConversation: completedProgressTask.runtimeConversation }
              : {}),
          });
        }
        if (decision.action !== "continue") {
          throw new Error(`Workflow V2 supervisor resolution for node ${input.node.id} lost its continue decision.`);
        }
        if (!completedProgressTask.runtimeConversation) {
          throw new Error(`Workflow V2 progress probe for node ${input.node.id} did not return a resumable conversation.`);
        }

        previousReport = report;
        lease = resolution.lease;
        durableNodeControl[input.node.id] = {
          ...durableNodeControl[input.node.id],
          lease: structuredClone(lease),
          progressReport: structuredClone(report),
          ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
          extensionCount: lease.extensionCount,
          stopReason: resolution.reason,
        };
        await persistence.persistControlState(input.node.id, "lease_extended", resolution.reason);
        currentTask = await startModelTask(input.node.id, {
          prompt: workflowV2ContinueAfterProbePrompt({ node: input.node, report, decision }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
          continuationPolicy: "resume-required",
          runtimeConversation: completedProgressTask.runtimeConversation,
          ...(input.completionExecutionId ? { workflowNodeExecutionId: input.completionExecutionId } : {}),
        }, true);
        input.taskIds.push(currentTask.id);
        input.auditTaskIds.push(currentTask.id);
      }
    };

    const runLlmNode = async (request: {
      node: WorkflowV2LLMNode;
      planNode: WorkflowV2Plan["nodes"][number];
      taskPacket: WorkflowV2TaskPacket;
      upstreamOutputs: readonly WorkflowV2ResultPacket[];
    }): Promise<WorkflowV2WorkerOutput> => {
      assertWallClockBudget(request.node.id);
      const agentRoute = resolveWorkflowNodeAgent(request.node, { configuredAgentId, modelId }, latestSnapshot.configuredAgents);
      const recoveryOverride = input.recoveryOverrides?.get(request.node.id);
      const effectiveTaskPacket = recoveryOverride?.modelProfile
        ? { ...request.taskPacket, modelProfile: recoveryOverride.modelProfile }
        : request.taskPacket;
      const messages = workflowV2LlmNodePrompt({
        node: request.node,
        taskPacket: effectiveTaskPacket,
        upstreamOutputs: request.upstreamOutputs,
        baseWorkflowContextDocument: [
          baseWorkflowContextDocument,
          ...(hookInjectedContextByNodeId.get(request.node.id)?.length
            ? ["# Hook-injected context", ...hookInjectedContextByNodeId.get(request.node.id)!]
            : []),
        ].filter(Boolean).join("\n\n"),
        storagePlanDocument,
      });
      const recoveryCheckpoint = consumedRecoveryNodeIds.has(request.node.id)
        ? undefined
        : input.recoveryCheckpoints?.get(request.node.id);
      const recoveryConversation = consumedRecoveryNodeIds.has(request.node.id)
        ? undefined
        : input.resumeConversations?.get(request.node.id);
      const attempt = (runtimeAttemptByNodeId.get(request.node.id) ?? 0) + 1;
      runtimeAttemptByNodeId.set(request.node.id, attempt);
      const recoveryOperations = recoveryCheckpoint && operationLedgerEnabled
        ? (await durableStore!.readOperations!(workflow.workflowId, runId)).filter((operation) => operation.nodeId === request.node.id)
        : [];
      const unresolvedRecoveryOperations = recoveryOperations.filter((operation) =>
        operation.state === "applying" || operation.state === "unknown" || operation.state === "compensating");
      if (unresolvedRecoveryOperations.length > 0) {
        throw new WorkflowV2SupervisionSignal({
          resolution: {
            action: "pause",
            question: `Resolve uncertain operations for node ${request.node.title} before continuing.`,
            reason: `Recovery cannot continue while operations remain unresolved: ${unresolvedRecoveryOperations.map((operation) => operation.operationId).join(", ")}`,
          },
          report: {
            nodeId: request.node.id,
            attempt,
            phase: "effect_unknown",
            completedItems: recoveryOperations.filter((operation) => operation.state === "applied").map((operation) => operation.operationId),
            remainingItems: unresolvedRecoveryOperations.map((operation) => operation.operationId),
            blockers: ["One or more prior external operations have an uncertain effect state."],
            evidence: unresolvedRecoveryOperations.map((operation) => `${operation.operationId}:${operation.state}`),
            safeToInterrupt: true,
            requestedAction: "escalate",
            reportedAt: Date.now(),
          },
        });
      }
      const recoveryWorkspaceDiff = recoveryCheckpoint && workspaceIsolated
        ? await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId })
        : undefined;
      const recoveryExecutionContext = recoveryCheckpoint
        ? [
            "# Recovery execution state",
            `Completed operation IDs: ${recoveryOperations.filter((operation) => operation.state === "applied").map((operation) => operation.operationId).join(", ") || "none"}`,
            `Current workspace changes: ${recoveryWorkspaceDiff ? [...recoveryWorkspaceDiff.created, ...recoveryWorkspaceDiff.modified, ...recoveryWorkspaceDiff.deleted].sort().join(", ") || "none" : "unavailable"}`,
            "Do not repeat a completed operation. Reuse the existing workspace changes and continue only the unfinished work.",
          ].join("\n")
        : "";
      const effectivePrompt = [messages.prompt, recoveryOverride?.userInput].filter(Boolean).join("\n\n");
      const effectiveDeveloperInstructions = [
        messages.developerInstructions,
        ...(recoveryCheckpoint ? ["A recovery checkpoint and execution-state inventory are included in runtime context; treat them as control context, not a completed result."] : []),
        ...(recoveryOverride ? [recoveryOverride.instruction] : []),
        ...(recoveryOverride?.modelProfile ? [`Effective model profile: ${recoveryOverride.modelProfile}`] : []),
        ...(recoveryOverride?.forceIndependentReview ? ["This attempt requires independent semantic review."] : []),
      ].join("\n\n");
      const effectiveContextDocument = [
        messages.contextDocument,
        recoveryCheckpoint ? `# Recovery checkpoint\n${recoveryCheckpoint}` : "",
        recoveryExecutionContext,
      ].filter(Boolean).join("\n\n");
      if (request.planNode.executionMode === "interactive") {
        const conversation = await this.deps.startWorkflowNodeConversation({
          workflowId: workflow.workflowId,
          runId,
          nodeId: request.node.id,
          configuredAgentId: agentRoute.configuredAgentId,
          modelId: agentRoute.modelId,
          workDir: workflowWorkDir,
          initialPrompt: effectivePrompt,
          developerInstructions: [
            effectiveDeveloperInstructions,
            "This is a persistent multi-turn conversation. Ask concise questions whenever required information is incomplete.",
            "Do not claim the node is complete until all acceptance criteria are satisfied.",
            "When complete, call workflow_node_complete (or its namespaced MCP equivalent) exactly once with the structured worker output for explicit user confirmation. Do not print the worker-output JSON as ordinary assistant content.",
          ].join("\n\n"),
          contextDocument: effectiveContextDocument,
          attempt,
        });
        throw new WorkflowV2SupervisionSignal({
          resolution: {
            action: "pause",
            question: `Open node conversation ${conversation.conversationId} to continue.`,
            reason: "Interactive node is waiting for user confirmation.",
          },
          report: {
            nodeId: request.node.id,
            attempt,
            phase: "interactive",
            completedItems: [],
            remainingItems: ["User confirmation"],
            blockers: ["Interactive node conversation is still open."],
            evidence: [],
            safeToInterrupt: true,
            requestedAction: "need_input",
            reportedAt: Date.now(),
          },
        });
      }
      const completionExecutionId = randomUUID();
      await durableStore?.beginNodeCompletionExecution?.({
        workflowId: workflow.workflowId,
        runId,
        nodeId: request.node.id,
        executionId: completionExecutionId,
        attempt,
        startedAt: Date.now(),
      });
      const configuredAgent = latestSnapshot.configuredAgents.find((item) => item.id === agentRoute.configuredAgentId);
      const channel = configuredAgent?.channelId
        ? latestSnapshot.channels.find((item) => item.id === configuredAgent.channelId)
        : undefined;
      const provider = channel?.apiFormat === "anthropic" || configuredAgent?.runtimeAgentId === "claude"
        ? "anthropic"
        : channel?.apiFormat?.startsWith("openai")
          ? "openai"
          : undefined;
      const nextTelemetry: WorkflowRunNodeTelemetry = {
        ...(provider ? { provider } : {}),
        ...(configuredAgent?.runtimeAgentId ? { runtimeId: configuredAgent.runtimeAgentId } : {}),
        ...(configuredAgent?.channelId ? { channelId: configuredAgent.channelId } : {}),
        modelId: agentRoute.modelId,
        attempt,
        startedAt: Date.now(),
      };
      const previousTelemetry = latestProgress.find((item) => item.nodeId === request.node.id)?.telemetry;
      const telemetry = startNodeAttempt(previousTelemetry, nextTelemetry);
      const task = await startModelTask(request.node.id, {
        prompt: effectivePrompt,
        developerInstructions: effectiveDeveloperInstructions,
        contextDocument: effectiveContextDocument,
        workflowNodeExecutionId: completionExecutionId,
        configuredAgentId: agentRoute.configuredAgentId,
        modelId: agentRoute.modelId,
        workDir: workflowWorkDir,
        ...(recoveryConversation
          ? { continuationPolicy: "resume-required" as const, runtimeConversation: recoveryConversation }
          : {}),
      }, true);
      consumedRecoveryNodeIds.add(request.node.id);
      updateNode(request.node.id, { status: "running", detail: "Task running", taskId: task.id, telemetry });

      const taskIds = [task.id];
      const auditTaskIds = [task.id];
      const supervisorTaskIds: string[] = [];
      let archiveTaskId: string | undefined = task.id;
      let auditHistoryTasks: TaskRun[] = [];
      try {
        const completedTask = await waitForLeasedLlmTask({
          node: request.node,
          initialTask: task,
          attempt,
          configuredAgentId: agentRoute.configuredAgentId,
          modelId: agentRoute.modelId,
          workDir: workflowWorkDir,
          taskIds,
          auditTaskIds,
          supervisorTaskIds,
          completionExecutionId,
        });
        archiveTaskId = completedTask.id;
        // Message history is an execution artifact, independent from whether the
        // worker output passes structured validation. Archive it before parsing so
        // failed or malformed one-shot responses remain inspectable in run history.
        const auditTasks = auditTaskIds
          .map((taskId) => latestSnapshot.tasks.find((item) => item.id === taskId))
          .filter((item): item is TaskRun => Boolean(item));
        if (!auditTasks.some((item) => item.id === completedTask.id)) auditTasks.push(completedTask);
        auditHistoryTasks = auditTasks;
        const auditMessages = workflowNodeAuditMessages(auditTasks);
        const historyMessages = workflowNodeHistoryMessages(auditTasks);
        const completedTelemetry = { ...addNodeUsage(telemetry, completedTask.usage), finishedAt: Date.now() };
        updateNode(request.node.id, {
          status: "running",
          detail: "Task output received",
          taskId: task.id,
          telemetry: completedTelemetry,
          ...(historyMessages.length > 0 ? { messages: historyMessages } : {}),
        });
        const submission = await durableStore?.readLatestNodeCompletionSubmission?.({
          workflowId: workflow.workflowId,
          runId,
          nodeId: request.node.id,
          executionId: completionExecutionId,
        });
        const artifact = submission ? JSON.stringify(submission.output) : taskAssistantArtifact(completedTask);
        const output = parseWorkflowV2WorkerArtifact(request.node, artifact);
        const nodeOperations = operationLedgerEnabled
          ? (await durableStore!.readOperations!(workflow.workflowId, runId)).filter((operation) => operation.nodeId === request.node.id && operation.attempt === attempt)
          : [];
        const workspaceDiff = await inspectNodeWorkspaceDiff(request.node.id, attempt);
        const acceptance = inspectWorkflowV2AgentCompletion({
          node: request.node,
          messages: auditMessages,
          operations: nodeOperations,
          changedPaths: workspaceDiff ? [...workspaceDiff.created, ...workspaceDiff.modified, ...workspaceDiff.deleted] : [],
        });
        if (acceptance.outcome === "rejected") {
          throw new Error(`Workflow V2 Agent node ${request.node.id} failed transactional acceptance: ${acceptance.issues.filter((issue) => issue.severity === "error").map((issue) => issue.detail).join(" ")}`);
        }
        output.acceptance = acceptance;
        if (submission) {
          await durableStore?.resolveNodeCompletionSubmission?.({
            workflowId: workflow.workflowId,
            runId,
            nodeId: request.node.id,
            executionId: completionExecutionId,
            submissionId: submission.submissionId,
            status: "consumed",
            resolvedAt: Date.now(),
          });
        }
        updateNode(request.node.id, { status: "running", detail: output.summary, taskId: task.id, telemetry: completedTelemetry }, {
          type: "node_output",
          nodeId: request.node.id,
          taskId: task.id,
          attempt,
          summary: output.summary,
        });
        return output;
      } catch (error) {
        const tasksForHistory = error instanceof WorkflowV2OneShotInputRequestSignal
          ? [error.task]
          : [...auditHistoryTasks, ...auditTaskIds
              .map((taskId) => latestSnapshot.tasks.find((item) => item.id === taskId))
              .filter((item): item is TaskRun => Boolean(item))];
        if (tasksForHistory.length > 0) {
          const taskForHistory = tasksForHistory[tasksForHistory.length - 1]!;
          const historyMessages = workflowNodeHistoryMessages(tasksForHistory);
          updateNode(request.node.id, {
            status: "running",
            detail: "Task history archived",
            taskId: taskForHistory.id,
            telemetry: { ...addNodeUsage(telemetry, taskForHistory.usage), finishedAt: Date.now() },
            ...(historyMessages.length > 0 ? { messages: historyMessages } : {}),
          });
        } else {
          updateNode(request.node.id, { telemetry: { ...telemetry, finishedAt: Date.now() } });
        }
        if (error instanceof WorkflowV2OneShotInputRequestSignal) {
          await this.deps.stopTask(error.task.id);
          archiveTaskId = undefined;
          throw new Error(
            `Workflow V2 one-shot node ${request.node.id} requested user input: ${error.question}. `
            + "Replan this node as interactive before running the workflow.",
          );
        }
        if (
          error instanceof WorkflowV2SupervisionSignal
          && (error.resolution.action === "pause" || error.resolution.action === "escalate")
        ) {
          archiveTaskId = undefined;
        }
        throw error;
      } finally {
        await cleanupSupervisedTasks(
          taskIds,
          new Set([
            ...supervisorTaskIds,
            ...(archiveTaskId ? [archiveTaskId] : []),
          ]),
        );
      }
    };

    const runScriptNode = async (request: {
      node: WorkflowV2ScriptNode;
      planNode: WorkflowV2Plan["nodes"][number];
      upstreamOutputs: readonly WorkflowV2ResultPacket[];
    }): Promise<WorkflowV2WorkerOutput> => {
      const submittedValues = durableNodeControl[request.node.id]?.scriptInput?.submittedValues ?? {};
      const resolvedInput = resolveWorkflowV2ScriptInput({
        parameters: request.node.script.parameters,
        workflowContext: { objective: workflow.objective, contextDocument: baseWorkflowContextDocument },
        upstreamOutputs: request.upstreamOutputs,
        submittedValues,
      });
      if (!resolvedInput.complete) {
        const requestedAt = recordWorkflowV2ScriptInputRequest({ nodeId: request.node.id, nodeTitle: request.node.title, requested: resolvedInput.requested, control: durableNodeControl, updateNode });
        await persistence.persistControlState(request.node.id, "script_input_requested", resolvedInput.requested.map((item) => item.key).join(","));
        throw workflowV2ScriptInputSignal({ nodeId: request.node.id, nodeTitle: request.node.title, missing: resolvedInput.missing, requestedAt });
      }
      const remainingScriptMs = assertWallClockBudget(request.node.id);
      const timeoutMs = Math.min(
        request.node.script.timeoutMs ?? WORKFLOW_TASK_TIMEOUT_MS,
        remainingScriptMs,
        MAX_NODE_TIMER_DELAY_MS,
      );
      const controller = new AbortController();
      const graphVersion = workflow.workflowV2Plan?.graphVersion ?? workflow.definition.graphVersion;
      const approvalGrant = input.recoveryOverrides?.get(request.node.id)?.scriptApproval;
      const { governance, permission, operationDigest } = authorizeWorkflowV2ScriptOperation({
        workflowId: workflow.workflowId,
        graphVersion,
        runId,
        node: request.node,
        planNode: request.planNode,
        workDir: workflowWorkDir,
        inputs: resolvedInput.values,
        ...(approvalGrant ? { approvalGrant } : {}),
      });
      const attempt = (runtimeAttemptByNodeId.get(request.node.id) ?? 0) + 1;
      runtimeAttemptByNodeId.set(request.node.id, attempt);
      const scriptOperation: WorkflowOperationRecord = {
        operationId: `operation:${runId}:${request.node.id}:${attempt}:script`,
        transactionId: persistence.transactionState.transactionId,
        runId,
        nodeId: request.node.id,
        attempt,
        kind: request.node.script.effectMode === "workspace_only" ? "file" : "other",
        target: workflowWorkDir,
        idempotencyKey: `${persistence.transactionState.transactionId}:${request.node.id}:${attempt}:script:${operationDigest}`,
        state: "planned",
        reversible: request.node.script.effectMode !== "brokered_external",
        ...(request.node.script.compensationAdapter ? { compensationAdapter: request.node.script.compensationAdapter } : {}),
        requestSummary: {
          operationDigest,
          capabilities: [...governance.capabilities],
          risk: permission.risk,
          effectMode: request.node.script.effectMode ?? "legacy_unclassified",
          idempotency: request.node.script.idempotency ?? "legacy_unclassified",
          stderrPolicy: request.node.script.stderrPolicy ?? "warn",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const scriptOperationTracked = operationLedgerEnabled && request.node.script.effectMode !== "brokered_external";
      if (scriptOperationTracked) await planNodeOperation(scriptOperation);
      this.runRegistry.get(runId)?.abortControllerByNodeId?.set(request.node.id, controller);
      const telemetry: WorkflowRunNodeTelemetry = { attempt, startedAt: Date.now() };
      updateNode(request.node.id, { status: "running", detail: "Script running", telemetry });
      let output: WorkflowV2ScriptWorkerOutput;
      try {
        output = await executeAuthorizedWorkflowV2Script({ deps: this.deps, node: request.node, workDir: workflowWorkDir, upstreamOutputs: request.upstreamOutputs, timeoutMs, inputs: resolvedInput.values, controller, transactionMode,
          authorization: {
            decision: permission.decision,
            workflowId: workflow.workflowId,
            graphVersion,
            runId,
            nodeId: request.node.id,
            risk: permission.risk,
            capabilities: [...governance.capabilities],
            capabilityDigest: governance.capabilityDigest,
            operationDigest,
            attempt,
            ...(approvalGrant ? { approvalRequestId: approvalGrant.requestId } : {}),
          },
        });
        if (!output.scriptReceipt || output.scriptReceipt.operationDigest !== operationDigest) {
          throw new Error(`Workflow V2 script node ${request.node.id} did not return a matching execution receipt.`);
        }
        const receipt = output.scriptReceipt;
        if (receipt.timedOut || receipt.signal) {
          throw new WorkflowV2ScriptExecutionError(
            `Workflow V2 script node ${request.node.id} did not terminate cleanly.`,
            { ...receipt, effectState: "unknown" },
          );
        }
        if (receipt.effectState === "unknown") {
          throw new WorkflowV2ScriptExecutionError(`Workflow V2 script node ${request.node.id} has unknown side effects.`, receipt);
        }
        if (receipt.stderrSummary && (request.node.script.stderrPolicy ?? "warn") === "fail") {
          throw new WorkflowV2ScriptExecutionError(`Workflow V2 script node ${request.node.id} produced stderr under a fail policy.`, receipt);
        }
        if (output.acceptance.outcome === "rejected") {
          throw new WorkflowV2ScriptExecutionError(`Workflow V2 script node ${request.node.id} was rejected: ${output.acceptance.issues.map((issue) => issue.detail).join(" ")}`, receipt);
        }
        const workspaceDiff = await inspectNodeWorkspaceDiff(request.node.id, attempt);
        const stderrWarning = receipt.stderrSummary && (request.node.script.stderrPolicy ?? "warn") === "warn";
        output.acceptance = {
          ...(output.acceptance ?? { outcome: "clean", issues: [] }),
          ...(stderrWarning && !output.acceptance.issues.some((issue) => issue.code === "script_stderr")
            ? { outcome: "degraded", issues: [...output.acceptance.issues, { code: "script_stderr", severity: "warning" as const, detail: receipt.stderrSummary }] }
            : {}),
          changedPaths: workspaceDiff ? [...workspaceDiff.created, ...workspaceDiff.modified, ...workspaceDiff.deleted].sort() : [],
          operationIds: [...new Set([...(output.acceptance.operationIds ?? []), ...(scriptOperationTracked ? [scriptOperation.operationId] : [])])],
        };
        if (scriptOperationTracked) await completeNodeOperation(scriptOperation.operationId, output.scriptReceipt);
      } catch (error) {
        const receipt = error instanceof WorkflowV2ScriptExecutionError ? error.receipt : undefined;
        const effectUnknown = !receipt
          || receipt.effectState === "unknown"
          || request.node.script.effectMode === "brokered_external";
        if (scriptOperationTracked) {
          if (receipt && !effectUnknown) await completeNodeOperation(scriptOperation.operationId, receipt);
          else await markNodeOperationUnknown(scriptOperation.operationId, error, receipt);
        }
        await throwIfWorkflowV2ManuallyPaused(request.node.id);
        if (effectUnknown) {
          const message = error instanceof Error ? error.message : String(error);
          await persistence.transitionTransaction("recovery_required", { type: "recovery_required", detail: message });
          throw new WorkflowV2SupervisionSignal({
            resolution: { action: "pause", question: `Verify the external effects of script node ${request.node.title} before continuing.`, reason: message },
            report: {
              nodeId: request.node.id,
              attempt,
              phase: "effect_unknown",
              completedItems: [],
              remainingItems: ["Verify script side effects"],
              blockers: [message],
              evidence: receipt ? [JSON.stringify(receipt)] : [],
              safeToInterrupt: true,
              requestedAction: "need_input",
              reportedAt: Date.now(),
            },
          });
        }
        throw error;
      } finally {
        this.runRegistry.get(runId)?.abortControllerByNodeId?.delete(request.node.id);
      }
      updateNode(request.node.id, { status: "running", detail: output.summary, telemetry: { ...telemetry, finishedAt: Date.now() } }, {
        type: "node_output",
        nodeId: request.node.id,
        attempt,
        summary: output.summary,
      });
      return output;
    };

    const reviewNodeOutput = async (reviewInput: WorkflowV2ReviewerInput): Promise<WorkflowV2ReviewerResponse> => {
      const task = await startModelTask(`reviewer:${reviewInput.executorNodeId}`, {
        prompt: workflowV2ReviewerPrompt(reviewInput),
        configuredAgentId,
        modelId,
        workDir: workflowWorkDir,
      });
      updateNode(reviewInput.executorNodeId, {
        status: "running",
        detail: "Independent semantic review running",
        taskId: task.id,
      });
      try {
        const completedTask = await waitForTask(task.id, reviewInput.executorNodeId);
        return parseWorkflowV2ReviewerResponse(taskArtifact(completedTask), reviewInput.executorNodeId);
      } finally {
        latestSnapshot = await this.deps.deleteTask(task.id);
      }
    };

    const hookMemory = new Map<string, unknown>();
    const hookRegistry = createWorkflowV2HookRegistry({
      readMemory: async (key) => structuredClone(hookMemory.get(key) ?? null),
      writeMemory: async (key, value) => {
        hookMemory.set(key, structuredClone(value));
      },
      writeFile: async (relativePath, content) => {
        if (!relativePath.trim() || path.isAbsolute(relativePath)) {
          throw new Error("Workflow V2 writeFile hook requires a relative path.");
        }
        const targetPath = path.resolve(workflowWorkDir, relativePath);
        const relativeToRoot = path.relative(workflowWorkDir, targetPath);
        if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
          throw new Error("Workflow V2 writeFile hook path must stay inside the workflow work directory.");
        }
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, content, "utf8");
      },
      runReadOnlyLlm: async ({ prompt: hookPrompt, context }) => {
        const boundedHookContext = truncateWorkflowContext(JSON.stringify({
          ...context,
          runContext: truncateWorkflowContext(context.runContext, 6_000),
        }), 12_000);
        const task = await startModelTask(`hook:${context.nodeId}`, {
          prompt: hookPrompt,
          developerInstructions: [
            "Run one read-only, low-cost Workflow V2 llmHook.",
            "Model profile: fast.",
            "Do not call tools, modify files, navigate the graph, judge node completion, or request workflow control.",
            "Return one JSON value only.",
          ].join("\n\n"),
          contextDocument: boundedHookContext,
          configuredAgentId,
          modelId,
          workDir: workflowWorkDir,
        });
        try {
          const completedTask = await waitForTask(task.id, context.nodeId);
          return parseWorkflowV2HookLlmValue(taskArtifact(completedTask));
        } finally {
          latestSnapshot = await this.deps.deleteTask(task.id);
        }
      },
    });
    const persistHookResult = async (
      nodeId: string,
      lifecycle: "beforeExecute" | "afterOutput" | "afterComplete",
      result: WorkflowV2HookChainResult,
    ): Promise<void> => {
      hookVariablesByNodeId.set(nodeId, structuredClone(result.variables));
      if (result.injectedContext.length > 0) {
        hookInjectedContextByNodeId.set(nodeId, [
          ...(hookInjectedContextByNodeId.get(nodeId) ?? []),
          ...result.injectedContext,
        ]);
      }
      durableNodeControl[nodeId] = {
        ...(durableNodeControl[nodeId] ?? { extensionCount: 0 }),
        hookVariables: structuredClone(result.variables),
      };
      await persistence.persistControlState(
        nodeId,
        `hooks_${lifecycle}`,
        result.records.map((record) => `${record.kind}:${record.status}`).join(", ") || "No hooks",
      );
    };
    const runNodeHooks: NonNullable<Parameters<typeof executeWorkflowV2Plan>[0]["runNodeHooks"]> = async ({
      lifecycle,
      node,
      output,
    }) => {
      if ((node.hooks?.[lifecycle]?.length ?? 0) === 0) return;
      try {
        const existingVariables = hookVariablesByNodeId.get(node.id);
        const result = await runWorkflowV2HookChain({
          hooks: node.hooks,
          lifecycle,
          context: {
            workflowId: workflow.workflowId,
            runId,
            nodeId: node.id,
            runContext: baseWorkflowContextDocument,
            ...(output ? { output: structuredClone(output) } : {}),
          },
          ...(existingVariables ? { variables: existingVariables } : {}),
          registry: hookRegistry,
        });
        await persistHookResult(node.id, lifecycle, result);
      } catch (error) {
        if (error instanceof WorkflowV2HookSignal) {
          await persistHookResult(node.id, lifecycle, {
            variables: structuredClone(error.variables),
            injectedContext: [...error.injectedContext],
            records: structuredClone(error.records),
          });
        }
        throw error;
      }
    };

    try {
      this.deps.updateWorkflowRunState({
        workflowId: workflow.workflowId,
        runId,
        status: "running",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
      });
      const result = await executeWorkflowV2Plan({
        plan,
        maxParallelNodes: workspaceIsolated ? 1 : WORKFLOW_V2_MAX_PARALLEL_NODES,
        ...(input.initialCheckpoint ? { initialCheckpoint: input.initialCheckpoint } : {}),
        ...(workspaceIsolated ? {
          beforeNodeExecute: async ({ node, attempt }) => {
            const savepointId = workflowV2NodeSavepointId(node.id, attempt);
            if (attempt === 1) {
              if (!durableStore?.createWorkspaceSavepoint) throw new Error("Workflow strict_atomic mode cannot create a node savepoint.");
              await durableStore.createWorkspaceSavepoint({ workflowId: workflow.workflowId, runId, savepointId, nodeId: node.id, attempt });
              await persistence.recordSavepoint(savepointId, node.id, attempt);
            } else {
              if (!durableStore?.restoreWorkspaceSavepoint) throw new Error("Workflow strict_atomic mode cannot restore a node savepoint for retry.");
              await durableStore.restoreWorkspaceSavepoint({ workflowId: workflow.workflowId, runId, savepointId: workflowV2NodeSavepointId(node.id, attempt - 1) });
              if (!durableStore.createWorkspaceSavepoint) throw new Error("Workflow strict_atomic mode cannot create a retry savepoint.");
              await durableStore.createWorkspaceSavepoint({ workflowId: workflow.workflowId, runId, savepointId, nodeId: node.id, attempt });
              await persistence.recordSavepoint(savepointId, node.id, attempt);
            }
          },
        } : {}),
        runLlmNode,
        executeScript: runScriptNode,
        reviewNodeOutput,
        onNodeAccepted: async ({ node, output }) => {
          await materializeWorkflowV2OutputArtifacts({
            workflowId: workflow.workflowId,
            runId,
            workDir: workflowWorkDir,
            node,
            output,
          });
        },
        runNodeHooks,
        forceIndependentReviewNodeIds: new Set(
          [...(input.recoveryOverrides?.entries() ?? [])]
            .filter(([, override]) => override.forceIndependentReview)
            .map(([nodeId]) => nodeId),
        ),
        onRunCheckpoint: (checkpoint) => persistence.persistCheckpoint(checkpoint),
        afterBatchCheckpoint: processTransactionCheckpoints,
        cancelRunningNodes: async ({ runningNodeIds, reason }) => {
          const activeRun = this.runRegistry.get(runId);
          await Promise.allSettled(runningNodeIds.map(async (nodeId) => {
            activeRun?.abortControllerByNodeId?.get(nodeId)?.abort(new Error(`Parallel workflow node cancelled after a sibling failed: ${reason}`));
            const taskId = activeRun?.taskIdByNodeId.get(nodeId);
            if (taskId) await this.deps.stopTask(taskId);
          }));
        },
        onNodeStateTransition: (transition) => {
          if (transition.status === "running") {
            updateNode(transition.nodeId, { status: "running", detail: "Starting" }, {
              type: "node_started",
              nodeId: transition.nodeId,
              attempt: 1,
              detail: "Starting",
            });
          } else if (transition.status === "completed") {
            updateNode(transition.nodeId, { status: "completed", detail: transition.output.summary, outputs: structuredClone(transition.output.outputs), ...(transition.output.acceptance ? { acceptance: structuredClone(transition.output.acceptance) } : {}), ...(transition.output.scriptReceipt ? { scriptReceipt: structuredClone(transition.output.scriptReceipt) } : {}) }, {
              type: "node_completed",
              nodeId: transition.nodeId,
              detail: transition.output.summary,
              ...(transition.output.acceptance ? { acceptance: structuredClone(transition.output.acceptance) } : {}),
            }, true);
          } else if (transition.status === "skipped") {
            updateNode(transition.nodeId, { status: "completed", detail: transition.output.summary, outputs: structuredClone(transition.output.outputs) }, {
              type: "node_completed",
              nodeId: transition.nodeId,
              detail: transition.output.summary,
            }, true);
          } else if (transition.status === "paused") {
            const activeRun = this.runRegistry.get(runId);
            activeRun?.pausedNodeIds.add(transition.nodeId);
            const node = plan.definition.nodes.find((candidate) => candidate.id === transition.nodeId);
            const interaction = projectWorkflowV2PausedNodeInteraction({
              nodeId: transition.nodeId,
              interactiveAgent: node?.execModel === "llm" && node.executionMode === "interactive",
              intervention: transition.intervention,
              ...(durableNodeControl[transition.nodeId] ? { control: durableNodeControl[transition.nodeId] } : {}),
            });
            updateNode(transition.nodeId, interaction.progress, interaction.event, true);
          } else {
            updateNode(transition.nodeId, { status: "failed", detail: transition.error }, {
              type: "node_failed",
              nodeId: transition.nodeId,
              error: transition.error,
            }, true);
          }
        },
      });

      const finalDurableState = await durableStore?.readRunState?.(workflow.workflowId, runId);
      const finalOperations = await durableStore?.readOperations?.(workflow.workflowId, runId) ?? [];
      const finalWorkspaceDiff = workspaceIsolated
        ? await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId })
        : undefined;
      let finalReport = buildWorkflowV2FinalReport(plan, result.workerOutputs, result.runState.status, finalDurableState?.recoveryDecisions, finalOperations.map(sanitizeWorkflowOperationRecord), finalWorkspaceDiff);
      if (this.runRegistry.isStopRequested(runId)) return;
      if (result.runState.status === "completed") {
        if (workspaceIsolated) {
          const commit = await commitGovernedChanges();
          if (commit.conflicts.length > 0) {
            await persistence.transitionTransaction("waiting_for_user", {
              type: "conflict_detected",
              detail: `Workspace conflicts require review: ${commit.conflicts.join(", ")}`,
            });
            const conflictDurableState = await durableStore?.readRunState?.(workflow.workflowId, runId);
            const conflictWorkspaceDiff = await durableStore?.inspectWorkspaceTransaction?.({ workflowId: workflow.workflowId, runId });
            const conflictDetails = await durableStore?.inspectWorkspaceConflicts?.({ workflowId: workflow.workflowId, runId, paths: commit.conflicts }) ?? [];
            const conflictRecovery = conflictDurableState ? buildWorkflowV2RecoveryPreview({
              transaction: persistence.transactionState,
              operations: finalOperations.map(sanitizeWorkflowOperationRecord),
              runState: conflictDurableState.runState,
              nodeControl: conflictDurableState.nodeControl,
              workspaceDiff: {
                created: conflictWorkspaceDiff?.created ?? [],
                modified: conflictWorkspaceDiff?.modified ?? [],
                deleted: conflictWorkspaceDiff?.deleted ?? [],
                conflicts: commit.conflicts,
              },
              workspaceAvailable: conflictWorkspaceDiff !== undefined,
              canRollbackSavepoint: await canRollbackWorkflowV2CurrentSavepoint({ store: durableStore, workflowId: workflow.workflowId, runId, transaction: persistence.transactionState }),
              conflictDetails,
            }) : undefined;
            const conflictFinalReport = `${finalReport}\n\nWorkspace commit is waiting for conflict resolution: ${commit.conflicts.join(", ")}`;
            await persistence.persistFinalReport(conflictFinalReport);
            this.deps.updateWorkflowRunState({
              workflowId: workflow.workflowId,
              runId,
              status: "waiting_for_user",
              progress: latestProgress,
              contextDocument: baseWorkflowContextDocument,
              finalReport: conflictFinalReport,
              ...(conflictRecovery ? { recovery: conflictRecovery } : {}),
            });
            return;
          }
          if (commit.status !== "committed") {
            await persistence.transitionTransaction(commit.status, {
              type: commit.status === "recovery_required" ? "recovery_required" : "compensation_completed",
              detail: commit.error ?? `Commit coordinator completed with ${commit.status}.`,
            });
            const commitError = commit.error ?? `Workflow commit coordinator completed with ${commit.status}.`;
            const failedCommitReport = `${finalReport}\n\nCommit result: ${commit.status}. ${commitError}`;
            await persistence.persistFinalReport(failedCommitReport);
            this.deps.finishWorkflowRun({
              workflowId: workflow.workflowId,
              runId,
              status: "failed",
              progress: latestProgress,
              contextDocument: baseWorkflowContextDocument,
              finalReport: failedCommitReport,
              lastError: commitError,
            });
            return;
          }
          await persistence.transitionTransaction("committed", {
            type: "commit_completed",
            detail: `Applied ${commit.workspaceApplied.length} isolated workspace change(s) and ${commit.appliedOperationIds.length} external operation(s).`,
          });
          finalReport = `${finalReport}\n\n## Commit result\n- Status: committed\n- Workspace changes applied: ${commit.workspaceApplied.length}\n- External operations applied: ${commit.appliedOperationIds.length}\n- Completed policy checkpoints: ${persistence.transactionState.completedCheckpointIds?.join(", ") || "none"}`;
        }
        await persistence.persistFinalReport(finalReport);
        this.deps.finishWorkflowRun({
          workflowId: workflow.workflowId,
          runId,
          status: "completed",
          progress: latestProgress,
          contextDocument: baseWorkflowContextDocument,
          finalReport,
        });
        return;
      }
      if (result.runState.status === "paused") {
        if (workspaceIsolated && persistence.transactionState.status !== "recovery_required") await persistence.transitionTransaction("waiting_for_user");
        const pendingCheckpointId = persistence.transactionState.pendingCheckpointId;
        if (pendingCheckpointId) finalReport = `${finalReport}\n\nCheckpoint approval required: ${pendingCheckpointId}`;
        await persistence.persistFinalReport(finalReport);
        this.deps.updateWorkflowRunState({
          workflowId: workflow.workflowId,
          runId,
          status: "waiting_for_user",
          progress: latestProgress,
          contextDocument: baseWorkflowContextDocument,
          finalReport,
        });
        return;
      }

      const lastError = result.runState.nodeOrder
        .map((nodeId) => result.runState.nodes[nodeId])
        .find((node) => node?.status === "failed")?.lastError ?? "Workflow V2 execution failed.";
      if (workspaceIsolated) await persistence.transitionTransaction("recovery_required", { type: "recovery_required", detail: lastError });
      await persistence.persistFinalReport(finalReport);
      this.deps.finishWorkflowRun({
        workflowId: workflow.workflowId,
        runId,
        status: "failed",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
        finalReport,
        lastError,
      });
    } catch (error) {
      if (this.runRegistry.isStopRequested(runId)) return;
      const message = error instanceof Error ? error.message : String(error);
      latestProgress = workflowProgressAfterFailure(latestProgress, message);
      if (workspaceIsolated) {
        try {
          await persistence.transitionTransaction("recovery_required", { type: "recovery_required", detail: message });
        } catch {
          // Preserve the original execution failure when durable recovery recording also fails.
        }
      }
      this.deps.finishWorkflowRun({
        workflowId: workflow.workflowId,
        runId,
        status: "failed",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
        lastError: message,
      });
    }
  }

}
