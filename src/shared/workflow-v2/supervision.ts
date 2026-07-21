export interface WorkflowV2ExecutionLeasePolicy {
  inactivityTimeoutMs: number;
  softTimeoutMs: number;
  hardTimeoutMs: number;
  progressProbeTimeoutMs: number;
  maxExtensions: number;
  maxExtensionMs: number;
}

export interface WorkflowV2ExecutionLeaseState {
  nodeId: string;
  attempt: number;
  startedAt: number;
  lastActivityAt: number;
  softDeadlineAt: number;
  hardDeadlineAt: number;
  extensionCount: number;
}

export type WorkflowV2ProgressRequestedAction = "continue" | "need_input" | "escalate";

export interface WorkflowV2ProgressReport {
  nodeId: string;
  attempt: number;
  phase: string;
  completedItems: string[];
  remainingItems: string[];
  blockers: string[];
  evidence: string[];
  checkpoint?: string;
  estimatedRemainingMs?: number;
  safeToInterrupt: boolean;
  requestedAction: WorkflowV2ProgressRequestedAction;
  reportedAt: number;
}

export type WorkflowV2SupervisorDecision =
  | { action: "continue"; extensionMs: number; reason: string }
  | { action: "retry"; fromCheckpoint?: string; reason: string }
  | { action: "escalate"; modelProfile: "expert"; reason: string }
  | { action: "pause"; question: string; reason: string }
  | { action: "cancel"; reason: string };

export type WorkflowV2LeaseInspection = "active" | "probe_required" | "hard_timeout";

export type WorkflowV2SupervisorResolution =
  | { action: "continue"; lease: WorkflowV2ExecutionLeaseState; reason: string }
  | { action: "retry"; fromCheckpoint?: string; reason: string }
  | { action: "escalate"; modelProfile: "expert"; reason: string }
  | { action: "pause"; question: string; reason: string }
  | { action: "cancel"; reason: string };

export const DEFAULT_WORKFLOW_V2_EXECUTION_LEASE_POLICY: WorkflowV2ExecutionLeasePolicy = {
  inactivityTimeoutMs: 60_000,
  softTimeoutMs: 10 * 60_000,
  hardTimeoutMs: 30 * 60_000,
  progressProbeTimeoutMs: 30_000,
  maxExtensions: 2,
  maxExtensionMs: 5 * 60_000,
};

export function isWorkflowV2ExecutionLeasePolicy(value: unknown): value is WorkflowV2ExecutionLeasePolicy {
  if (!isRecord(value)) return false;
  if (!isPositiveInteger(value.inactivityTimeoutMs)) return false;
  if (!isPositiveInteger(value.softTimeoutMs)) return false;
  if (!isPositiveInteger(value.hardTimeoutMs)) return false;
  if (!isPositiveInteger(value.progressProbeTimeoutMs)) return false;
  if (!isNonNegativeInteger(value.maxExtensions)) return false;
  if (!isPositiveInteger(value.maxExtensionMs)) return false;
  return value.softTimeoutMs < value.hardTimeoutMs;
}

export function isWorkflowV2ProgressReport(value: unknown): value is WorkflowV2ProgressReport {
  if (!isRecord(value)) return false;
  if (typeof value.nodeId !== "string" || !value.nodeId.trim()) return false;
  if (!isPositiveInteger(value.attempt)) return false;
  if (typeof value.phase !== "string" || !value.phase.trim()) return false;
  if (!isStringArray(value.completedItems)) return false;
  if (!isStringArray(value.remainingItems)) return false;
  if (!isStringArray(value.blockers)) return false;
  if (!isStringArray(value.evidence)) return false;
  if (value.checkpoint !== undefined && (typeof value.checkpoint !== "string" || !value.checkpoint.trim())) {
    return false;
  }
  if (value.estimatedRemainingMs !== undefined && !isNonNegativeFinite(value.estimatedRemainingMs)) {
    return false;
  }
  if (typeof value.safeToInterrupt !== "boolean") return false;
  if (
    value.requestedAction !== "continue"
    && value.requestedAction !== "need_input"
    && value.requestedAction !== "escalate"
  ) {
    return false;
  }
  return isNonNegativeFinite(value.reportedAt);
}

export function isWorkflowV2SupervisorDecision(value: unknown): value is WorkflowV2SupervisorDecision {
  if (!isRecord(value) || typeof value.reason !== "string" || !value.reason.trim()) return false;
  if (value.action === "continue") return isPositiveInteger(value.extensionMs);
  if (value.action === "retry") {
    return value.fromCheckpoint === undefined
      || (typeof value.fromCheckpoint === "string" && value.fromCheckpoint.trim().length > 0);
  }
  if (value.action === "escalate") return value.modelProfile === "expert";
  if (value.action === "pause") return typeof value.question === "string" && value.question.trim().length > 0;
  return value.action === "cancel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
