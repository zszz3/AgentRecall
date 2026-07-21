import type { WorkflowV2ScriptParameterDef } from "./definition";
import { isWorkflowV2HookJsonValue } from "./hooks";
import type { WorkflowV2WorkerOutput } from "./packets";
import type { WorkflowV2Plan } from "./planning";
import type {
  WorkflowV2InterventionAction,
  WorkflowV2ReviewVerdict,
} from "./review";
import {
  isWorkflowV2InterventionAction,
  isWorkflowV2ReviewVerdict,
} from "./review";
import type { WorkflowV2RunState } from "./state";
import type {
  WorkflowV2ExecutionLeaseState,
  WorkflowV2ProgressReport,
} from "./supervision";
import { isWorkflowV2ProgressReport } from "./supervision";

// Durable storage contract for workflow runs. This lives in shared because main
// persistence, recovery, and future migration code must agree on one wire shape.
export const WORKFLOW_V2_STORAGE_SCHEMA_VERSION = 1;

export interface WorkflowV2StorageLayout {
  workflowDir: string;
  workflowStatePath: string;
  runDir: string;
  runStatePath: string;
  eventLogPath: string;
  cacheDir: string;
}

export interface WorkflowV2NodeCacheFingerprint {
  graphVersion: number;
  nodeDefinitionHash: string;
  upstreamOutputHash: string;
  modelProfile: string;
  role?: string;
  requiredToolsHash?: string;
  executionEnvHash?: string;
  reviewerPolicyHash?: string;
  templateVersion?: string;
}

export interface WorkflowV2CacheEntryMetadata {
  schemaVersion: typeof WORKFLOW_V2_STORAGE_SCHEMA_VERSION;
  workflowId: string;
  nodeId: string;
  graphVersion: number;
  fingerprint: WorkflowV2NodeCacheFingerprint;
  output: WorkflowV2WorkerOutput;
  savedAt: number;
  reviewVerdict?: WorkflowV2ReviewVerdict;
}

export interface WorkflowV2DurableNodeControlState {
  // Mutable per-node control data that is not part of authored definition or
  // final worker outputs, but is required to pause/resume safely.
  lease?: WorkflowV2ExecutionLeaseState;
  progressReport?: WorkflowV2ProgressReport;
  checkpoint?: string;
  extensionCount: number;
  stopReason?: string;
  interventionResolution?: WorkflowV2InterventionResolutionRecord;
  hookVariables?: Record<string, unknown>;
  scriptInput?: {
    requestedParameters: WorkflowV2ScriptParameterDef[];
    submittedValues: Record<string, unknown>;
    auditValues: Record<string, unknown>;
    requestedAt: number;
    submittedAt?: number;
  };
}

export interface WorkflowV2InterventionResolutionRecord {
  action: WorkflowV2InterventionAction;
  reason: string;
  resolvedAt: number;
}

export interface WorkflowV2PersistedRunState {
  schemaVersion: typeof WORKFLOW_V2_STORAGE_SCHEMA_VERSION;
  workflowId: string;
  runId: string;
  graphVersion: number;
  savedAt: number;
  eventCount: number;
  plan: WorkflowV2Plan;
  runState: WorkflowV2RunState;
  workerOutputs: WorkflowV2WorkerOutput[];
  nodeControl: Record<string, WorkflowV2DurableNodeControlState>;
}

export interface WorkflowV2DurableEvent {
  sequence: number;
  workflowId: string;
  runId: string;
  nodeId?: string;
  type: string;
  at: number;
  detail?: string;
}

export type WorkflowV2RecoveryAction = "reuse" | "resume" | "rerun" | "blocked";

export interface WorkflowV2NodeRecoveryDecision {
  nodeId: string;
  action: WorkflowV2RecoveryAction;
  reason: string;
  checkpoint?: string;
  cachedOutput?: WorkflowV2WorkerOutput;
}

export interface WorkflowV2RecoveryPlan {
  workflowId: string;
  runId: string;
  persistedGraphVersion: number;
  targetGraphVersion: number;
  decisions: WorkflowV2NodeRecoveryDecision[];
}

export function isWorkflowV2NodeCacheFingerprint(
  value: unknown,
): value is WorkflowV2NodeCacheFingerprint {
  if (!isRecord(value) || !isPositiveSafeInteger(value.graphVersion)) return false;
  if (!isNonEmptyString(value.nodeDefinitionHash)) return false;
  if (!isNonEmptyString(value.upstreamOutputHash)) return false;
  if (!isNonEmptyString(value.modelProfile)) return false;
  for (const field of [
    "role",
    "requiredToolsHash",
    "executionEnvHash",
    "reviewerPolicyHash",
    "templateVersion",
  ] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) return false;
  }
  return true;
}

export function sameWorkflowV2CacheFingerprint(
  left: WorkflowV2NodeCacheFingerprint,
  right: WorkflowV2NodeCacheFingerprint,
): boolean {
  return (
    left.graphVersion === right.graphVersion
    && left.nodeDefinitionHash === right.nodeDefinitionHash
    && left.upstreamOutputHash === right.upstreamOutputHash
    && left.modelProfile === right.modelProfile
    && left.role === right.role
    && left.requiredToolsHash === right.requiredToolsHash
    && left.executionEnvHash === right.executionEnvHash
    && left.reviewerPolicyHash === right.reviewerPolicyHash
    && left.templateVersion === right.templateVersion
  );
}

export function isWorkflowV2PersistedRunState(
  value: unknown,
): value is WorkflowV2PersistedRunState {
  // Validate a fully materialized persisted snapshot before recovery touches it.
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== WORKFLOW_V2_STORAGE_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value.workflowId) || !isNonEmptyString(value.runId)) return false;
  if (!isPositiveSafeInteger(value.graphVersion)) return false;
  if (!isNonNegativeFinite(value.savedAt) || !isNonNegativeSafeInteger(value.eventCount)) {
    return false;
  }
  if (!isPersistedPlan(value.plan, value.workflowId, value.graphVersion)) return false;
  if (!isPersistedExecutionState(value.runState, value.workflowId, value.graphVersion)) {
    return false;
  }
  if (!Array.isArray(value.workerOutputs) || !value.workerOutputs.every(isWorkerOutput)) return false;
  if (!isRecord(value.nodeControl)) return false;
  const nodeIds = new Set(value.runState.nodeOrder);
  return Object.entries(value.nodeControl).every(
    ([nodeId, control]) => nodeIds.has(nodeId) && isDurableNodeControlState(control),
  );
}

export function isWorkflowV2CacheEntryMetadata(
  value: unknown,
): value is WorkflowV2CacheEntryMetadata {
  if (!isRecord(value) || value.schemaVersion !== WORKFLOW_V2_STORAGE_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value.workflowId) || !isNonEmptyString(value.nodeId)) return false;
  if (!isPositiveSafeInteger(value.graphVersion) || !isNonNegativeFinite(value.savedAt)) {
    return false;
  }
  if (!isWorkflowV2NodeCacheFingerprint(value.fingerprint)) return false;
  if (value.fingerprint.graphVersion !== value.graphVersion) return false;
  if (!isWorkerOutput(value.output) || value.output.nodeId !== value.nodeId) return false;
  return value.reviewVerdict === undefined || isWorkflowV2ReviewVerdict(value.reviewVerdict);
}

function isWorkerOutput(value: unknown): value is WorkflowV2WorkerOutput {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.nodeId) || !isNonEmptyString(value.summary)) return false;
  if (!isRecord(value.outputs) || !Array.isArray(value.proposals)) return false;
  return value.proposals.every((proposal) => {
    if (!isRecord(proposal) || !isNonEmptyString(proposal.kind) || !isNonEmptyString(proposal.reason)) {
      return false;
    }
    return (
      proposal.kind === "continue"
      || proposal.kind === "retry"
      || proposal.kind === "escalate"
      || proposal.kind === "graph-revision"
    );
  });
}

function isPersistedPlan(
  value: unknown,
  workflowId: string,
  graphVersion: number,
): value is WorkflowV2Plan {
  if (!isRecord(value)) return false;
  if (value.workflowId !== workflowId || value.graphVersion !== graphVersion) return false;
  if (!isNonEmptyString(value.objective) || !isNonEmptyString(value.approvedBy)) return false;
  if (!isNonNegativeFinite(value.frozenAt)) return false;
  if (!isRecord(value.definition) || !Array.isArray(value.nodes)) return false;
  if (
    !Array.isArray(value.acceptanceCriteria)
    || !isRecord(value.roleDefaults)
    || !isRecord(value.budget)
  ) {
    return false;
  }
  return (
    value.definition.workflowId === workflowId && value.definition.graphVersion === graphVersion
  );
}

function isPersistedExecutionState(
  value: unknown,
  workflowId: string,
  graphVersion: number,
): value is WorkflowV2RunState {
  // Keep persisted run-state checks shallow-but-strict: enough to reject broken
  // snapshots without re-running full authored-definition validation here.
  if (!isRecord(value)) return false;
  if (value.workflowId !== workflowId || value.graphVersion !== graphVersion) return false;
  if (
    value.status !== "running"
    && value.status !== "paused"
    && value.status !== "completed"
    && value.status !== "failed"
  ) {
    return false;
  }
  if (!isPositiveSafeInteger(value.maxParallelNodes)) return false;
  if (!Array.isArray(value.nodeOrder) || !value.nodeOrder.every(isNonEmptyString)) return false;
  const nodeOrder = value.nodeOrder;
  if (new Set(nodeOrder).size !== nodeOrder.length || !isRecord(value.nodes)) return false;
  const nodes = value.nodes;
  return nodeOrder.every((nodeId) => {
    const node = nodes[nodeId];
    if (!isRecord(node) || node.nodeId !== nodeId || !isNonEmptyString(node.title)) return false;
    if (!isNodeExecutionStatus(node.status) || !isNonNegativeSafeInteger(node.attempt)) return false;
    return [node.dependsOn, node.dependents, node.blockedBy, node.resourceLocks].every(
      (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
    );
  });
}

function isDurableNodeControlState(
  value: unknown,
): value is WorkflowV2DurableNodeControlState {
  // Control state must stay JSON-safe because it is persisted and later reused
  // by resume/recovery code across process restarts.
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.extensionCount)) return false;
  if (value.checkpoint !== undefined && !isNonEmptyString(value.checkpoint)) return false;
  if (value.stopReason !== undefined && !isNonEmptyString(value.stopReason)) return false;
  if (value.progressReport !== undefined && !isWorkflowV2ProgressReport(value.progressReport)) {
    return false;
  }
  if (value.lease !== undefined && !isExecutionLeaseState(value.lease)) return false;
  if (
    value.interventionResolution !== undefined
    && !isInterventionResolutionRecord(value.interventionResolution)
  ) {
    return false;
  }
  if (
    value.hookVariables !== undefined
    && (!isRecord(value.hookVariables) || !isWorkflowV2HookJsonValue(value.hookVariables))
  ) {
    return false;
  }
  if (value.scriptInput !== undefined && !isScriptInputState(value.scriptInput)) return false;
  return true;
}

function isScriptInputState(value: unknown): boolean {
  if (
    !isRecord(value)
    || !Array.isArray(value.requestedParameters)
    || !isRecord(value.submittedValues)
    || !isRecord(value.auditValues)
  ) {
    return false;
  }
  if (!isNonNegativeFinite(value.requestedAt)) return false;
  return value.submittedAt === undefined || isNonNegativeFinite(value.submittedAt);
}

function isInterventionResolutionRecord(
  value: unknown,
): value is WorkflowV2InterventionResolutionRecord {
  if (!isRecord(value) || !isWorkflowV2InterventionAction(value.action)) return false;
  return isNonEmptyString(value.reason) && isNonNegativeFinite(value.resolvedAt);
}

function isExecutionLeaseState(value: unknown): value is WorkflowV2ExecutionLeaseState {
  if (!isRecord(value) || !isNonEmptyString(value.nodeId) || !isPositiveSafeInteger(value.attempt)) {
    return false;
  }
  if (!isNonNegativeFinite(value.startedAt) || !isNonNegativeFinite(value.lastActivityAt)) {
    return false;
  }
  if (!isNonNegativeFinite(value.softDeadlineAt) || !isNonNegativeFinite(value.hardDeadlineAt)) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.extensionCount)) return false;
  return (
    value.startedAt <= value.lastActivityAt
    && value.lastActivityAt <= value.hardDeadlineAt
    && value.softDeadlineAt <= value.hardDeadlineAt
  );
}

function isNodeExecutionStatus(value: unknown): boolean {
  return (
    value === "blocked"
    || value === "ready"
    || value === "running"
    || value === "validating"
    || value === "awaiting_review"
    || value === "paused"
    || value === "skipped"
    || value === "completed"
    || value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
