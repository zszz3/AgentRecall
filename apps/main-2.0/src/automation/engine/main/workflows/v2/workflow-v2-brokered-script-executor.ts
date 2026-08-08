import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { WorkflowV2ScriptWorkerOutput } from "../../../shared/workflow-v2/packets";
import type { ExecuteWorkflowV2ScriptRequest, WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { WorkflowHttpOperationPlan, WorkflowMessagePlan } from "./workflow-v2-external-adapters";
import { WorkflowV2OperationBroker } from "./workflow-v2-operation-broker";
import { assertWorkflowV2ScriptAuthorized, validateWorkflowV2ScriptOutput, WorkflowV2ScriptExecutionError } from "./workflow-v2-script-executor";

interface BrokeredHttpOperation {
  kind: "http";
  plan: WorkflowHttpOperationPlan;
  reversible: boolean;
}
interface BrokeredMessageOperation {
  kind: "message";
  plan: WorkflowMessagePlan;
  reversible: boolean;
}
type BrokeredOperation = BrokeredHttpOperation | BrokeredMessageOperation;

export async function executeWorkflowV2BrokeredScript(input: ExecuteWorkflowV2ScriptRequest, store: WorkflowV2StorePort, broker: WorkflowV2OperationBroker): Promise<WorkflowV2ScriptWorkerOutput> {
  assertWorkflowV2ScriptAuthorized(input);
  if (input.node.script.effectMode !== "brokered_external") throw new Error("Brokered script executor only accepts brokered_external nodes.");
  if (input.node.script.executable.kind !== "inline" || input.node.script.executable.language !== "typescript") throw new Error("Brokered external scripts must be inline TypeScript that returns declarative operations.");
  if (!store.readOperations) throw new Error("Brokered script execution requires a durable operation ledger.");
  const startedAt = Date.now();
  const transactionMode = input.transactionMode ?? "direct";
  let outputs: Record<string, unknown>;
  let operations: BrokeredOperation[];
  try {
    const value = runInNewContext(`"use strict"; (function(inputs) { ${input.node.script.executable.code}\n})(inputs)`, { inputs: structuredClone(input.inputs) }, { timeout: Math.max(1, Math.min(input.timeoutMs, 30_000)), contextCodeGeneration: { strings: false, wasm: false } }) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Brokered script must return an object.");
    const rawOutputs = structuredClone(value as Record<string, unknown>);
    operations = parseOperations(rawOutputs.operations);
    delete rawOutputs.operations;
    outputs = rawOutputs;
    validateWorkflowV2ScriptOutput(input, outputs);
  } catch (error) {
    throw new WorkflowV2ScriptExecutionError(error instanceof Error ? error.message : String(error), receipt(input, "unknown", startedAt));
  }
  const operationIds: string[] = [];
  try {
    for (const [index, operation] of operations.entries()) {
      if (operation.plan.mode !== transactionMode) throw new Error("Brokered operation mode does not match the frozen workflow transaction mode.");
      if (input.requireReversibleOperations && !operation.reversible) throw new Error("Review-gated brokered operations must be reversible so rejected attempts can be compensated safely.");
      if (transactionMode === "strict_atomic" && !operation.reversible) throw new Error("Strict atomic brokered operations must be reversible.");
      if (operation.reversible && input.node.script.compensationAdapter !== operation.kind) throw new Error(`Reversible ${operation.kind} brokered operations require the ${operation.kind} compensation adapter.`);
      const prepared = await broker.prepare({
        workflowId: input.authorization.workflowId,
        transactionId: `transaction:${input.authorization.workflowId}:${input.authorization.runId}`,
        runId: input.authorization.runId,
        nodeId: input.node.id,
        attempt: input.authorization.attempt ?? 1,
        kind: operation.kind,
        target: operation.kind === "http" ? operation.plan.request.url : `${operation.plan.draft.channel}:${operation.plan.draft.recipients.join(",")}`,
        plan: operation.plan,
        adapterId: operation.kind,
        reversible: operation.reversible,
        ...(operation.reversible ? { compensationAdapter: operation.kind } : {}),
        requestSummary: operation.kind === "http"
          ? { index, method: operation.plan.request.method, url: operation.plan.request.url, reversible: operation.reversible }
          : { index, channel: operation.plan.draft.channel, recipients: operation.plan.draft.recipients, title: operation.plan.draft.title, attachmentCount: operation.plan.draft.attachments.length, reversible: operation.reversible },
        signal: input.signal,
      });
      operationIds.push(prepared.operationId);
      if (transactionMode !== "strict_atomic") {
        await broker.applyPrepared({ workflowId: input.authorization.workflowId, runId: input.authorization.runId, operationId: prepared.operationId, signal: input.signal });
      }
    }
  } catch (error) {
    throw new WorkflowV2ScriptExecutionError(error instanceof Error ? error.message : String(error), receipt(input, "unknown", startedAt));
  }
  return {
    nodeId: input.node.id,
    summary: `${input.node.title} completed ${operationIds.length} brokered operation${operationIds.length === 1 ? "" : "s"}.`,
    outputs,
    evidence: [],
    proposals: [],
    scriptReceipt: receipt(input, "brokered", startedAt),
    acceptance: { outcome: "clean", issues: [], changedPaths: [], operationIds },
  };
}

function parseOperations(value: unknown): BrokeredOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Brokered script output requires a non-empty operations array.");
  return value.map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Brokered operation is malformed.");
    const item = operation as Record<string, unknown>;
    if ((item.kind !== "http" && item.kind !== "message") || !item.plan || typeof item.plan !== "object" || Array.isArray(item.plan)) throw new Error("Only declarative HTTP and message brokered operations are supported.");
    if (typeof item.reversible !== "boolean") throw new Error("Brokered operation must declare reversibility.");
    return item.kind === "http"
      ? { kind: "http", plan: structuredClone(item.plan as unknown as WorkflowHttpOperationPlan), reversible: item.reversible }
      : { kind: "message", plan: structuredClone(item.plan as unknown as WorkflowMessagePlan), reversible: item.reversible };
  });
}

function receipt(input: ExecuteWorkflowV2ScriptRequest, effectState: "brokered" | "unknown", startedAt: number) {
  return {
    exitCode: effectState === "brokered" ? 0 : 1,
    signal: null,
    timedOut: input.signal.aborted || Date.now() - startedAt >= input.timeoutMs,
    stderrSummary: "",
    stdoutDigest: createHash("sha256").update(effectState).digest("hex"),
    operationDigest: input.authorization.operationDigest,
    effectState,
  } as const;
}
