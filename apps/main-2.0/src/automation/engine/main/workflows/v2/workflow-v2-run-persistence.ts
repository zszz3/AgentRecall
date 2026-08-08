import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import {
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
  type WorkflowV2DurableEvent,
  type WorkflowV2DurableNodeControlState,
  type WorkflowV2PersistedRunState,
} from "../../../shared/workflow-v2/storage";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { workflowV2ReviewGateForNode } from "../../../shared/workflow-v2/review-gates";
import { createWorkflowV2NodeCacheFingerprint } from "./workflow-v2-recovery";
import { resolveWorkflowNodeAgent, workflowV2ExecutionEnvironment, workflowV2ReviewerPolicy } from "./workflow-v2-node-policy";
import type { WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";
import {
  resolveWorkflowTransactionPolicy,
  renewWorkflowTransactionRetention,
  sanitizeWorkflowTransactionValue,
  type WorkflowOperationRecord,
  type WorkflowOperationState,
  type WorkflowTransactionState,
} from "../../../shared/workflow-v2/transaction";

export async function persistWorkflowV2PreflightBlocked(input: {
  store: WorkflowV2StorePort | undefined;
  workflow: WorkflowDraftState;
  plan: WorkflowV2Plan;
  runId: string;
  error: string;
  nodeControl: Record<string, WorkflowV2DurableNodeControlState>;
  initialEventCount?: number;
  initialCheckpoint?: ExecuteWorkflowV2Checkpoint;
  initialTransaction?: WorkflowTransactionState;
  now?: number;
}): Promise<void> {
  if (!input.store) return;
  const now = input.now ?? Date.now();
  const policy = resolveWorkflowTransactionPolicy(input.plan.definition.transactionPolicy).policy;
  const transaction = input.initialTransaction
    ? {
        ...structuredClone(input.initialTransaction),
        status: "recovery_required" as const,
        updatedAt: now,
        retentionUntil: now + policy.retentionDays * 24 * 60 * 60 * 1_000,
      }
    : {
        transactionId: `transaction:${input.workflow.workflowId}:${input.runId}`,
        mode: policy.defaultMode,
        status: "rolled_back" as const,
        baselineId: `baseline-pending:${input.runId}`,
        operationCount: 0,
        unknownOperationCount: 0,
        irreversibleOperationCount: 0,
        startedAt: now,
        updatedAt: now,
        retentionUntil: now + policy.retentionDays * 24 * 60 * 60 * 1_000,
      };
  const runState = input.initialCheckpoint
    ? structuredClone(input.initialCheckpoint.runState)
    : createWorkflowV2RunState({ definition: input.plan.definition });
  runState.status = input.initialTransaction ? "paused" : "failed";
  const safeError = String(sanitizeWorkflowTransactionValue(input.error));
  const initialEventCount = input.initialEventCount ?? 0;
  const events: WorkflowV2DurableEvent[] = [
    ...(!input.initialTransaction ? [{
      sequence: initialEventCount,
      workflowId: input.workflow.workflowId,
      runId: input.runId,
      transactionId: transaction.transactionId,
      type: "transaction_started",
      at: now,
      detail: `mode=${transaction.mode}`,
    }] : []),
    {
      sequence: initialEventCount + (input.initialTransaction ? 0 : 1),
      workflowId: input.workflow.workflowId,
      runId: input.runId,
      transactionId: transaction.transactionId,
      type: "preflight_blocked",
      at: now,
      detail: safeError,
    },
  ];
  await input.store.appendEvents({ workflowId: input.workflow.workflowId, runId: input.runId, events });
  await input.store.persistRunState({
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: input.workflow.workflowId,
    runId: input.runId,
    graphVersion: input.plan.graphVersion,
    savedAt: now,
    eventCount: initialEventCount + events.length,
    plan: structuredClone(input.plan),
    runState,
    workerOutputs: input.initialCheckpoint?.workerOutputs.map((output) => structuredClone(output)) ?? [],
    nodeControl: structuredClone(input.nodeControl),
    transaction,
  });
}

export class WorkflowV2RunPersistence {
  private eventCount: number;
  private latest: ExecuteWorkflowV2Checkpoint | undefined;
  private previousRunState: ExecuteWorkflowV2Checkpoint["runState"] | undefined;
  private transaction: WorkflowTransactionState;
  private transactionStartRecorded: boolean;
  private readonly compatibilityWarning: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly cachedNodeIds = new Set<string>();
  private recoveryDecisions: NonNullable<WorkflowV2PersistedRunState["recoveryDecisions"]> = [];
  private finalReport: string | undefined;
  private readonly retentionDays: number;

  constructor(private readonly input: {
    store: WorkflowV2StorePort | undefined;
    workflow: WorkflowDraftState;
    plan: WorkflowV2Plan;
    runId: string;
    initialEventCount: number;
    initialCheckpoint?: ExecuteWorkflowV2Checkpoint;
    nodeControl: Record<string, WorkflowV2DurableNodeControlState>;
    workDir: string;
    configuredAgentId: string;
    modelId: string;
    configuredAgents: Array<{ id: string; modelId: string }>;
    recoveryOverrides?: ReadonlyMap<string, WorkflowV2RecoveryOverride>;
    initialTransaction?: WorkflowTransactionState;
    baselineId?: string;
    onTransactionChanged?: (state: WorkflowTransactionState) => Promise<void> | void;
  }) {
    this.eventCount = input.initialEventCount;
    this.previousRunState = input.initialCheckpoint ? structuredClone(input.initialCheckpoint.runState) : undefined;
    this.transactionStartRecorded = input.initialTransaction !== undefined;
    const now = Date.now();
    const resolvedPolicy = resolveWorkflowTransactionPolicy(input.plan.definition.transactionPolicy);
    const policy = resolvedPolicy.policy;
    this.retentionDays = policy.retentionDays;
    this.compatibilityWarning = resolvedPolicy.compatibilityWarning;
    this.transaction = input.initialTransaction ? structuredClone(input.initialTransaction) : {
      transactionId: `transaction:${input.workflow.workflowId}:${input.runId}`,
      mode: policy.defaultMode,
      status: "active",
      baselineId: input.baselineId ?? `baseline-pending:${input.runId}`,
      operationCount: 0,
      unknownOperationCount: 0,
      irreversibleOperationCount: 0,
      startedAt: now,
      updatedAt: now,
      retentionUntil: now + policy.retentionDays * 24 * 60 * 60 * 1_000,
    };
  }

  get latestCheckpoint(): ExecuteWorkflowV2Checkpoint | undefined {
    return this.latest ? structuredClone(this.latest) : undefined;
  }

  get transactionState(): WorkflowTransactionState {
    return structuredClone(this.transaction);
  }

  appendEvents(events: Array<Omit<WorkflowV2DurableEvent, "sequence" | "workflowId" | "runId">>): Promise<void> {
    return this.enqueueWrite(() => this.appendEventsUnlocked(events));
  }

  initializeWorkspaceTransaction(baselineId: string, scope?: { governedFileCount: number; excludedPaths: string[] }): Promise<void> {
    return this.enqueueWrite(async () => {
      this.transaction.baselineId = baselineId;
      if (scope) {
        this.transaction.governedFileCount = scope.governedFileCount;
        this.transaction.excludedPaths = [...new Set(scope.excludedPaths)].sort();
      }
      await this.ensureTransactionStartedUnlocked();
      const now = Date.now();
      await this.appendEventsUnlocked([
        { type: "baseline_frozen", transactionId: this.transaction.transactionId, at: now, detail: `baselineId=${baselineId}; governedFiles=${scope?.governedFileCount ?? "unknown"}; excludedPaths=${scope?.excludedPaths.join(",") || "none"}` },
        { type: "preflight_passed", transactionId: this.transaction.transactionId, at: now, detail: "Isolated workspace is ready." },
      ]);
      await this.notifyTransactionChanged();
    });
  }

  recordSavepoint(savepointId: string, nodeId: string, attempt: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const operations = await this.input.store?.readOperations?.(this.input.workflow.workflowId, this.input.runId) ?? [];
      this.transaction.currentSavepointId = savepointId;
      this.transaction.currentSavepointOperationIds = [...new Set(operations.map((operation) => operation.operationId))].sort();
      this.transaction.updatedAt = Date.now();
      await this.appendEventsUnlocked([{
        type: "savepoint_created",
        transactionId: this.transaction.transactionId,
        nodeId,
        at: this.transaction.updatedAt,
        detail: `savepointId=${savepointId}; attempt=${attempt}`,
      }]);
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
      await this.notifyTransactionChanged();
    });
  }

  requireCheckpointApproval(checkpointId: string, savepointId: string, planDigest?: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.transaction.currentSavepointId = savepointId;
      this.transaction.pendingCheckpointId = checkpointId;
      this.transaction.approvedCheckpointIds = (this.transaction.approvedCheckpointIds ?? []).filter((approvedId) => approvedId !== checkpointId);
      if (planDigest) this.transaction.pendingCheckpointPlanDigest = planDigest;
      else delete this.transaction.pendingCheckpointPlanDigest;
      this.transaction.status = "waiting_for_user";
      this.transaction.updatedAt = Date.now();
      await this.appendEventsUnlocked([{ type: "checkpoint_approval_required", transactionId: this.transaction.transactionId, at: this.transaction.updatedAt, detail: `checkpointId=${checkpointId}; savepointId=${savepointId}${planDigest ? `; planDigest=${planDigest}` : ""}` }]);
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
      await this.notifyTransactionChanged();
    });
  }

  beginCheckpointCommit(checkpointId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.transaction.committingCheckpointId = checkpointId;
      this.transaction.updatedAt = Date.now();
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
      await this.notifyTransactionChanged();
    });
  }

  completeCheckpoint(checkpointId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const completed = new Set(this.transaction.completedCheckpointIds ?? []);
      completed.add(checkpointId);
      this.transaction.completedCheckpointIds = [...completed];
      if (this.transaction.pendingCheckpointId === checkpointId) delete this.transaction.pendingCheckpointId;
      delete this.transaction.pendingCheckpointPlanDigest;
      if (this.transaction.committingCheckpointId === checkpointId) delete this.transaction.committingCheckpointId;
      this.transaction.status = "active";
      this.transaction.updatedAt = Date.now();
      await this.appendEventsUnlocked([{ type: "checkpoint_completed", transactionId: this.transaction.transactionId, at: this.transaction.updatedAt, detail: `checkpointId=${checkpointId}` }]);
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
      await this.notifyTransactionChanged();
    });
  }

  private async appendEventsUnlocked(events: Array<Omit<WorkflowV2DurableEvent, "sequence" | "workflowId" | "runId">>): Promise<void> {
    if (!this.input.store || events.length === 0) return;
    const sequenced = events.map((event, index): WorkflowV2DurableEvent => ({
      ...event,
      sequence: this.eventCount + index,
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
    }));
    await this.input.store.appendEvents({
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
      events: sequenced,
    });
    this.eventCount += sequenced.length;
  }

  persistCheckpoint(checkpoint: ExecuteWorkflowV2Checkpoint): Promise<void> {
    const snapshot = structuredClone(checkpoint);
    return this.enqueueWrite(() => this.persistCheckpointUnlocked(snapshot));
  }

  persistFinalReport(finalReport: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.finalReport = finalReport;
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
    });
  }

  transitionTransaction(
    status: WorkflowTransactionState["status"],
    event?: { type: string; detail?: string },
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.reloadTransactionState();
      const now = Date.now();
      this.transaction.status = status;
      this.transaction.updatedAt = now;
      if (event) {
        await this.appendEventsUnlocked([{
          type: event.type,
          transactionId: this.transaction.transactionId,
          at: now,
          ...(event.detail ? { detail: event.detail } : {}),
        }]);
      }
      if (this.latest) await this.persistCheckpointUnlocked(this.latest, false);
      await this.notifyTransactionChanged();
    });
  }

  private async persistCheckpointUnlocked(checkpoint: ExecuteWorkflowV2Checkpoint, reloadTransaction = true): Promise<void> {
    this.latest = structuredClone(checkpoint);
    if (!this.input.store) return;
    if (reloadTransaction && this.input.store.readRunState) {
      const durable = await this.input.store.readRunState(this.input.workflow.workflowId, this.input.runId);
      if (durable?.transaction?.transactionId === this.transaction.transactionId) {
        this.transaction = structuredClone(durable.transaction);
        this.eventCount = Math.max(this.eventCount, durable.eventCount);
        this.recoveryDecisions = structuredClone(durable.recoveryDecisions ?? []);
        if (this.finalReport === undefined) this.finalReport = durable.finalReport;
      }
    }
    await this.ensureTransactionStartedUnlocked();
    const transitionEvents = checkpoint.runState.nodeOrder.flatMap((nodeId) => {
      const current = checkpoint.runState.nodes[nodeId];
      const previous = this.previousRunState?.nodes[nodeId];
      if (!current || previous?.status === current.status) return [];
      return [{
        nodeId,
        type: `node_${current.status}`,
        at: Date.now(),
        ...(current.lastError ? { detail: current.lastError } : {}),
      } satisfies Omit<WorkflowV2DurableEvent, "sequence" | "workflowId" | "runId">];
    });
    await this.appendEventsUnlocked(transitionEvents);
    const now = Date.now();
    if (this.transaction.mode === "direct") {
      const previousStatus = this.transaction.status;
      if (previousStatus === "recovery_required" || this.transaction.unknownOperationCount > 0) this.transaction.status = "recovery_required";
      else if (checkpoint.runState.status === "completed") this.transaction.status = "committed";
      else if (checkpoint.runState.status === "failed") this.transaction.status = "recovery_required";
      else if (checkpoint.runState.status === "paused") this.transaction.status = "waiting_for_user";
      else this.transaction.status = "active";
      if (previousStatus !== this.transaction.status && this.transaction.status === "committed") {
        await this.appendEventsUnlocked([
          { type: "commit_started", transactionId: this.transaction.transactionId, at: now, detail: "Direct mode changes were already applied during node execution." },
          { type: "commit_completed", transactionId: this.transaction.transactionId, at: now, detail: "Direct mode run completed without rollback guarantees." },
        ]);
      } else if (previousStatus !== this.transaction.status && this.transaction.status === "recovery_required") {
        await this.appendEventsUnlocked([{ type: "recovery_required", transactionId: this.transaction.transactionId, at: now, detail: "Direct mode run failed or contains unresolved side effects; manual review is required." }]);
      }
    }
    this.transaction.updatedAt = now;
    this.transaction = renewWorkflowTransactionRetention(this.transaction, this.retentionDays, now);
    const persisted: WorkflowV2PersistedRunState = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
      graphVersion: this.input.plan.graphVersion,
      savedAt: Date.now(),
      eventCount: this.eventCount,
      plan: structuredClone(this.input.plan),
      runState: structuredClone(checkpoint.runState),
      workerOutputs: checkpoint.workerOutputs.map((output) => structuredClone(output)),
      nodeControl: structuredClone(this.input.nodeControl),
      transaction: structuredClone(this.transaction),
      recoveryDecisions: structuredClone(this.recoveryDecisions),
      ...(this.finalReport ? { finalReport: this.finalReport } : {}),
    };
    await this.input.store.persistRunState(persisted);
    await this.persistCacheEntries(checkpoint);
    this.previousRunState = structuredClone(checkpoint.runState);
    await this.notifyTransactionChanged();
  }

  persistControlState(nodeId: string, type: string, detail?: string): Promise<void> {
    return this.enqueueWrite(async () => {
      if (!this.latest || !this.input.store) return;
      await this.appendEventsUnlocked([{ nodeId, type, at: Date.now(), ...(detail ? { detail } : {}) }]);
      await this.persistCheckpointUnlocked(this.latest);
    });
  }

  planOperation(record: WorkflowOperationRecord): Promise<WorkflowOperationRecord | undefined> {
    return this.enqueueWrite(async () => {
      if (!this.input.store?.planOperation) return undefined;
      const existing = await this.input.store.readOperations?.(this.input.workflow.workflowId, this.input.runId) ?? [];
      const alreadyPlanned = existing.some((item) => item.operationId === record.operationId || item.idempotencyKey === record.idempotencyKey);
      const planned = await this.input.store.planOperation({ workflowId: this.input.workflow.workflowId, record });
      await this.reloadTransactionState();
      if (!alreadyPlanned) {
        await this.appendEventsUnlocked([{
          type: "operation_planned",
          transactionId: planned.transactionId,
          nodeId: planned.nodeId,
          operationId: planned.operationId,
          at: planned.createdAt,
          detail: `${planned.kind}:${planned.target}`,
        }]);
      }
      await this.notifyTransactionChanged();
      return planned;
    });
  }

  transitionOperation(input: {
    operationId: string;
    state: WorkflowOperationState;
    updatedAt: number;
    receipt?: unknown;
    error?: string;
  }): Promise<WorkflowOperationRecord | undefined> {
    return this.enqueueWrite(async () => {
      if (!this.input.store?.transitionOperation) return undefined;
      const previous = (await this.input.store.readOperations?.(this.input.workflow.workflowId, this.input.runId) ?? [])
        .find((item) => item.operationId === input.operationId);
      const transitioned = await this.input.store.transitionOperation({
        workflowId: this.input.workflow.workflowId,
        runId: this.input.runId,
        ...input,
      });
      await this.reloadTransactionState();
      if (previous?.state !== transitioned.state) {
        const eventType = operationEventType(transitioned.state);
        if (eventType) {
          await this.appendEventsUnlocked([{
            type: eventType,
            transactionId: transitioned.transactionId,
            nodeId: transitioned.nodeId,
            operationId: transitioned.operationId,
            at: transitioned.updatedAt,
            ...(transitioned.error ? { detail: transitioned.error } : {}),
          }]);
        }
      }
      await this.notifyTransactionChanged();
      return transitioned;
    });
  }

  private async persistCacheEntries(checkpoint: ExecuteWorkflowV2Checkpoint): Promise<void> {
    if (!this.input.store?.persistCacheEntry) return;
    const outputByNodeId = new Map(checkpoint.workerOutputs.map((output) => [output.nodeId, output]));
    for (const output of checkpoint.workerOutputs) {
      if (this.cachedNodeIds.has(output.nodeId)) continue;
      const node = this.input.plan.definition.nodes.find((item) => item.id === output.nodeId);
      const planNode = this.input.plan.nodes.find((item) => item.nodeId === output.nodeId);
      const nodeStatus = checkpoint.runState.nodes[output.nodeId]?.status;
      if (!node || !planNode || (nodeStatus !== "completed" && nodeStatus !== "completed_with_override")) continue;
      const recoveryOverride = this.input.recoveryOverrides?.get(output.nodeId);
      const effectivePlanNode = recoveryOverride?.modelProfile ? { ...planNode, modelProfile: recoveryOverride.modelProfile } : planNode;
      const upstreamOutputs = this.input.plan.definition.edges
        .filter((edge) => edge.toNodeId === output.nodeId)
        .map((edge) => outputByNodeId.get(edge.fromNodeId))
        .filter((item): item is WorkflowV2WorkerOutput => Boolean(item));
      const agentRoute = node.execModel === "llm"
        ? resolveWorkflowNodeAgent(node, { configuredAgentId: this.input.configuredAgentId, modelId: this.input.modelId }, this.input.configuredAgents)
        : { configuredAgentId: this.input.configuredAgentId, modelId: this.input.modelId };
      await this.input.store.persistCacheEntry({
        schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
        workflowId: this.input.workflow.workflowId,
        nodeId: output.nodeId,
        graphVersion: this.input.plan.graphVersion,
        fingerprint: createWorkflowV2NodeCacheFingerprint({
          graphVersion: this.input.plan.graphVersion,
          node,
          planNode: effectivePlanNode,
          upstreamOutputs,
          executionEnvironment: workflowV2ExecutionEnvironment({
            node,
            workDir: this.input.workDir,
            configuredAgentId: agentRoute.configuredAgentId,
            modelId: agentRoute.modelId,
          }),
          reviewerPolicy: workflowV2ReviewerPolicy(
            node,
            workflowV2ReviewGateForNode(this.input.plan.definition, node.id)
              ?? this.input.plan.definition.reviewEnabled === true,
            recoveryOverride?.forceIndependentReview === true,
          ),
        }),
        output: structuredClone(output),
        savedAt: Date.now(),
        ...(checkpoint.runState.nodes[output.nodeId]?.reviewVerdict
          ? { reviewVerdict: structuredClone(checkpoint.runState.nodes[output.nodeId]!.reviewVerdict!) }
          : {}),
      });
      this.cachedNodeIds.add(output.nodeId);
    }
  }

  private async reloadTransactionState(): Promise<void> {
    const durable = await this.input.store?.readRunState?.(this.input.workflow.workflowId, this.input.runId);
    if (durable?.transaction?.transactionId === this.transaction.transactionId) {
      this.transaction = structuredClone(durable.transaction);
      this.eventCount = Math.max(this.eventCount, durable.eventCount);
      this.recoveryDecisions = structuredClone(durable.recoveryDecisions ?? []);
      if (this.finalReport === undefined) this.finalReport = durable.finalReport;
    }
  }

  private async ensureTransactionStartedUnlocked(): Promise<void> {
    if (this.transactionStartRecorded) return;
    await this.appendEventsUnlocked([{
      type: "transaction_started",
      transactionId: this.transaction.transactionId,
      at: this.transaction.startedAt,
      detail: [`mode=${this.transaction.mode}`, this.compatibilityWarning].filter(Boolean).join("; "),
    }]);
    this.transactionStartRecorded = true;
  }

  private async notifyTransactionChanged(): Promise<void> {
    await this.input.onTransactionChanged?.(structuredClone(this.transaction));
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function operationEventType(state: WorkflowOperationState): string | undefined {
  if (state === "discarded") return "operation_discarded";
  if (state === "applying") return "operation_started";
  if (state === "applied") return "operation_applied";
  if (state === "unknown") return "operation_unknown";
  if (state === "compensating") return "compensation_started";
  if (state === "compensated") return "compensation_completed";
  return undefined;
}
