import { createHash } from "node:crypto";
import type {
  WorkflowOperationKind,
  WorkflowOperationRecord,
  WorkflowOperationState,
} from "../../../shared/workflow-v2/transaction";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";

export type WorkflowOperationInspection = "applied" | "not_applied" | "unknown";

export interface WorkflowPreparedOperation<TPlan = unknown> {
  adapterId: string;
  plan: TPlan;
  prepared: unknown;
  preparedAt: number;
}

export interface WorkflowTransactionalOperationAdapter<TPlan = unknown, TReceipt = unknown> {
  readonly adapterId: string;
  prepare(input: {
    transactionId: string;
    runId: string;
    nodeId: string;
    attempt: number;
    idempotencyKey: string;
    plan: TPlan;
    signal: AbortSignal;
  }): Promise<WorkflowPreparedOperation<TPlan>>;
  apply(input: { prepared: WorkflowPreparedOperation<TPlan>; signal: AbortSignal }): Promise<TReceipt>;
  inspect(input: { prepared: WorkflowPreparedOperation<TPlan>; receipt?: TReceipt; signal: AbortSignal }): Promise<WorkflowOperationInspection>;
  compensate(input: { prepared: WorkflowPreparedOperation<TPlan>; receipt: TReceipt; signal: AbortSignal }): Promise<void>;
}

export interface WorkflowOperationBrokerApplyInput<TPlan> {
  workflowId: string;
  transactionId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  kind: WorkflowOperationKind;
  target: string;
  plan: TPlan;
  adapterId: string;
  reversible: boolean;
  compensationAdapter?: string;
  requestSummary?: unknown;
  signal?: AbortSignal;
}

export interface WorkflowOperationCompensationResult {
  compensated: string[];
  skipped: string[];
  failed?: { operationId: string; error: string };
}

export class WorkflowV2OperationBroker {
  private readonly adapters = new Map<string, WorkflowTransactionalOperationAdapter>();
  private readonly volatilePrepared = new Map<string, WorkflowPreparedOperation>();

  constructor(private readonly store: WorkflowV2StorePort) {}

  register<TPlan, TReceipt>(adapter: WorkflowTransactionalOperationAdapter<TPlan, TReceipt>): void {
    if (!adapter.adapterId.trim()) throw new Error("Workflow operation adapter id must not be empty.");
    if (this.adapters.has(adapter.adapterId)) throw new Error(`Workflow operation adapter ${adapter.adapterId} is already registered.`);
    this.adapters.set(adapter.adapterId, adapter as WorkflowTransactionalOperationAdapter);
  }

  canInspectOperation(operation: WorkflowOperationRecord): boolean {
    return Boolean(operation.adapterId && operation.prepared && this.adapters.has(operation.adapterId));
  }

  canCompensateOperation(operation: WorkflowOperationRecord): boolean {
    return operation.state === "applied"
      && operation.reversible
      && operation.receipt !== undefined
      && Boolean(operation.prepared && !containsRedactedValue(operation.prepared) && operation.compensationAdapter && this.adapters.has(operation.compensationAdapter));
  }

  async apply<TPlan, TReceipt>(input: WorkflowOperationBrokerApplyInput<TPlan>): Promise<TReceipt> {
    const operation = await this.prepare(input);
    if (operation.state === "applied") return operation.receipt as TReceipt;
    if (operation.state === "discarded") throw new Error(`Workflow operation ${operation.operationId} was discarded after a rejected attempt and cannot be applied.`);
    return this.applyPrepared<TReceipt>({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, signal: input.signal });
  }

  async prepare<TPlan>(input: WorkflowOperationBrokerApplyInput<TPlan>): Promise<WorkflowOperationRecord> {
    this.assertDurableLedger();
    const adapter = this.adapter<TPlan, unknown>(input.adapterId);
    const digest = semanticDigest(input.plan);
    const idempotencyKey = `${input.transactionId}:${input.nodeId}:${input.attempt}:${input.adapterId}:${digest}`;
    const existing = (await this.store.readOperations?.(input.workflowId, input.runId) ?? [])
      .find((operation) => operation.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.state === "compensated") throw new Error(`Workflow operation ${existing.operationId} was already compensated and cannot be prepared again.`);
      return existing;
    }

    const controller = new AbortController();
    const signal = input.signal ?? controller.signal;
    const prepared = await adapter.prepare({
      transactionId: input.transactionId,
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      idempotencyKey,
      plan: input.plan,
      signal,
    });
    if (prepared.adapterId !== input.adapterId) throw new Error("Workflow operation adapter returned a mismatched adapter id.");
    const now = Date.now();
    const operation: WorkflowOperationRecord = {
      operationId: `operation:${input.runId}:${input.nodeId}:${input.attempt}:${input.adapterId}:${digest.slice(0, 16)}`,
      transactionId: input.transactionId,
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      kind: input.kind,
      target: input.target,
      idempotencyKey,
      semanticDigest: digest,
      adapterId: input.adapterId,
      prepared: { plan: prepared.plan, value: prepared.prepared },
      state: "planned",
      reversible: input.reversible,
      ...(input.compensationAdapter ? { compensationAdapter: input.compensationAdapter } : {}),
      ...(input.requestSummary !== undefined ? { requestSummary: input.requestSummary } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const planned = await this.store.planOperation?.({ workflowId: input.workflowId, record: operation });
    if (!planned) throw new Error("Workflow operation broker requires a durable operation ledger.");
    this.volatilePrepared.set(planned.operationId, prepared as WorkflowPreparedOperation);
    return planned;
  }

  async applyPrepared<TReceipt>(input: { workflowId: string; runId: string; operationId: string; signal?: AbortSignal }): Promise<TReceipt> {
    this.assertDurableLedger();
    const operation = (await this.store.readOperations?.(input.workflowId, input.runId) ?? []).find((item) => item.operationId === input.operationId);
    if (!operation) throw new Error(`Workflow operation ${input.operationId} was not found.`);
    if (operation.state === "applied") return operation.receipt as TReceipt;
    if (operation.state !== "planned") return this.resolveExisting<TReceipt>(operation);
    if (!operation.adapterId || !operation.prepared) throw new Error(`Workflow operation ${operation.operationId} has no prepared adapter state.`);
    const adapter = this.adapter<unknown, TReceipt>(operation.adapterId);
    const persistedPrepared = operation.prepared as { plan?: unknown; value?: unknown };
    const prepared = this.volatilePrepared.get(operation.operationId) ?? {
      adapterId: operation.adapterId,
      plan: persistedPrepared.plan,
      prepared: persistedPrepared.value,
      preparedAt: operation.createdAt,
    };
    const signal = input.signal ?? new AbortController().signal;
    await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "applying", updatedAt: Date.now() });
    let receipt: TReceipt;
    try {
      receipt = await adapter.apply({ prepared, signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "unknown", updatedAt: Date.now(), error: message });
      throw error;
    }
    await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "applied", updatedAt: Date.now(), receipt });
    this.volatilePrepared.delete(operation.operationId);
    return receipt;
  }

  async inspect(input: { workflowId: string; runId: string; operationId: string; signal?: AbortSignal }): Promise<WorkflowOperationInspection> {
    this.assertDurableLedger();
    const operations = await this.store.readOperations?.(input.workflowId, input.runId) ?? [];
    const operation = operations.find((item) => item.operationId === input.operationId);
    if (!operation) throw new Error(`Workflow operation ${input.operationId} was not found.`);
    if (operation.state !== "applying" && operation.state !== "unknown" && operation.state !== "compensating") return operation.state === "applied" ? "applied" : "not_applied";
    if (!operation.prepared || !operation.adapterId) {
      await this.markUnknown(input, operation, "Prepared operation data is unavailable for inspection.");
      return "unknown";
    }
    const adapter = this.adapter(operation.adapterId);
    const persistedPrepared = operation.prepared as { plan?: unknown; value?: unknown };
    const prepared = { adapterId: operation.adapterId, plan: persistedPrepared.plan, prepared: persistedPrepared.value, preparedAt: operation.createdAt } as WorkflowPreparedOperation;
    let result: WorkflowOperationInspection;
    try {
      result = await adapter.inspect({ prepared, ...(operation.receipt !== undefined ? { receipt: operation.receipt } : {}), signal: input.signal ?? new AbortController().signal });
    } catch (error) {
      await this.markUnknown(input, operation, error instanceof Error ? error.message : String(error));
      return "unknown";
    }
    if (result === "applied") {
      const receipt = { ...(operation.receipt !== undefined ? { originalReceipt: operation.receipt } : {}), inspection: "applied" };
      if (operation.state === "unknown" && this.store.resolveUnknownOperation) {
        await this.store.resolveUnknownOperation({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, verifiedState: "applied", actor: "operation-broker", reason: "Adapter inspection verified the remote operation was applied.", updatedAt: Date.now(), evidence: receipt });
      } else if (operation.state === "applying" || operation.state === "compensating") {
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "applied", updatedAt: Date.now(), receipt });
      } else if (operation.state === "unknown") {
        throw new Error(`Workflow operation ${operation.operationId} inspection proved applied but no durable unknown-state resolver is available.`);
      }
    } else if (result === "not_applied") {
      const receipt = { inspection: "not_applied" };
      if (operation.state === "unknown" && this.store.resolveUnknownOperation) {
        await this.store.resolveUnknownOperation({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, verifiedState: "compensated", actor: "operation-broker", reason: "Adapter inspection verified the remote operation was not applied.", updatedAt: Date.now(), evidence: receipt });
      } else if (operation.state === "applying") {
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "compensating", updatedAt: Date.now(), receipt });
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "compensated", updatedAt: Date.now(), receipt });
      } else if (operation.state === "compensating") {
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "compensated", updatedAt: Date.now(), receipt });
      } else if (operation.state === "unknown") {
        throw new Error(`Workflow operation ${operation.operationId} inspection proved not applied but no durable unknown-state resolver is available.`);
      }
    } else {
      await this.markUnknown(input, operation, "Operation inspection returned unknown.");
    }
    return result;
  }

  async compensateRun(input: { workflowId: string; runId: string; operationIds?: readonly string[]; signal?: AbortSignal }): Promise<WorkflowOperationCompensationResult> {
    this.assertDurableLedger();
    const operations = (await this.store.readOperations?.(input.workflowId, input.runId) ?? [])
      .filter((operation) => operation.state === "applied" && (!input.operationIds || input.operationIds.includes(operation.operationId)));
    const result: WorkflowOperationCompensationResult = { compensated: [], skipped: [] };
    for (const { operation, index } of operations.map((operation, index) => ({ operation, index })).sort((left, right) => right.operation.updatedAt - left.operation.updatedAt || right.operation.createdAt - left.operation.createdAt || right.index - left.index)) {
      const compensationAdapterId = operation.compensationAdapter;
      if (!operation.reversible || !compensationAdapterId || !operation.prepared) {
        result.skipped.push(operation.operationId);
        continue;
      }
      const adapter = this.adapter(compensationAdapterId);
      const persistedPrepared = operation.prepared as { plan?: unknown; value?: unknown };
      const prepared = { adapterId: operation.adapterId ?? operation.compensationAdapter, plan: persistedPrepared.plan, prepared: persistedPrepared.value, preparedAt: operation.createdAt } as WorkflowPreparedOperation;
      try {
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "compensating", updatedAt: Date.now() });
        await adapter.compensate({ prepared, receipt: operation.receipt, signal: input.signal ?? new AbortController().signal });
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "compensated", updatedAt: Date.now() });
        result.compensated.push(operation.operationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "unknown", updatedAt: Date.now(), error: message });
        result.failed = { operationId: operation.operationId, error: message };
        break;
      }
    }
    return result;
  }

  private adapter<TPlan, TReceipt>(adapterId: string): WorkflowTransactionalOperationAdapter<TPlan, TReceipt> {
    const adapter = this.adapters.get(adapterId) as WorkflowTransactionalOperationAdapter<TPlan, TReceipt> | undefined;
    if (!adapter) throw new Error(`Workflow operation adapter ${adapterId} is not registered.`);
    return adapter;
  }

  private assertDurableLedger(): void {
    if (!this.store.planOperation || !this.store.transitionOperation || !this.store.readOperations) {
      throw new Error("Workflow operation broker requires a durable operation ledger with plan, transition, and read support.");
    }
  }

  private async markUnknown(input: { workflowId: string; runId: string; operationId: string }, operation: WorkflowOperationRecord, error: string): Promise<void> {
    await this.store.transitionOperation?.({ workflowId: input.workflowId, runId: input.runId, operationId: operation.operationId, state: "unknown", updatedAt: Date.now(), error });
  }

  private resolveExisting<TReceipt>(operation: WorkflowOperationRecord): TReceipt {
    if (operation.state === "applied") return operation.receipt as TReceipt;
    if (operation.state === "compensated") throw new Error(`Workflow operation ${operation.operationId} was already compensated and cannot be applied again.`);
    if (operation.state === "unknown") throw new Error(`Workflow operation ${operation.operationId} has unknown remote state and must be inspected before retry.`);
    throw new Error(`Workflow operation ${operation.operationId} is already ${operation.state}; duplicate apply is blocked.`);
  }
}

function containsRedactedValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes("[REDACTED");
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.some((item) => containsRedactedValue(item, seen));
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
