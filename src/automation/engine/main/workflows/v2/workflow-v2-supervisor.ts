import type {
  WorkflowV2ExecutionLeasePolicy,
  WorkflowV2ExecutionLeaseState,
  WorkflowV2LeaseInspection,
  WorkflowV2ProgressReport,
  WorkflowV2SupervisorDecision,
  WorkflowV2SupervisorResolution,
} from "../../../shared/workflow-v2/supervision";
import {
  isWorkflowV2ExecutionLeasePolicy,
  isWorkflowV2ProgressReport as isSharedWorkflowV2ProgressReport,
  isWorkflowV2SupervisorDecision as isSharedWorkflowV2SupervisorDecision,
} from "../../../shared/workflow-v2/supervision";

export function validateWorkflowV2ExecutionLeasePolicy(
  value: unknown,
): value is WorkflowV2ExecutionLeasePolicy {
  return isWorkflowV2ExecutionLeasePolicy(value);
}

export function createWorkflowV2ExecutionLease(input: {
  nodeId: string;
  attempt: number;
  startedAt: number;
  policy: WorkflowV2ExecutionLeasePolicy;
}): WorkflowV2ExecutionLeaseState {
  assertLeasePolicy(input.policy);
  if (!input.nodeId.trim()) throw new Error("Workflow V2 execution lease requires a node id.");
  if (!isPositiveInteger(input.attempt)) throw new Error("Workflow V2 execution lease attempt must be a positive integer.");
  if (!isNonNegativeFinite(input.startedAt)) throw new Error("Workflow V2 execution lease start time is invalid.");
  return {
    nodeId: input.nodeId,
    attempt: input.attempt,
    startedAt: input.startedAt,
    lastActivityAt: input.startedAt,
    softDeadlineAt: input.startedAt + input.policy.softTimeoutMs,
    hardDeadlineAt: input.startedAt + input.policy.hardTimeoutMs,
    extensionCount: 0,
  };
}

export function recordWorkflowV2LeaseActivity(
  lease: WorkflowV2ExecutionLeaseState,
  activityAt: number,
): WorkflowV2ExecutionLeaseState {
  if (!isNonNegativeFinite(activityAt) || activityAt < lease.lastActivityAt) {
    throw new Error(`Workflow V2 node ${lease.nodeId} activity time must be monotonic.`);
  }
  return { ...lease, lastActivityAt: Math.min(activityAt, lease.hardDeadlineAt) };
}

export function inspectWorkflowV2ExecutionLease(input: {
  lease: WorkflowV2ExecutionLeaseState;
  policy: WorkflowV2ExecutionLeasePolicy;
  now: number;
}): WorkflowV2LeaseInspection {
  assertLeasePolicy(input.policy);
  if (!isNonNegativeFinite(input.now)) throw new Error("Workflow V2 lease inspection time is invalid.");
  if (input.now >= input.lease.hardDeadlineAt) return "hard_timeout";
  if (input.now >= input.lease.softDeadlineAt) return "probe_required";
  if (input.now - input.lease.lastActivityAt >= input.policy.inactivityTimeoutMs) return "probe_required";
  return "active";
}

export function isWorkflowV2ProgressReport(value: unknown): value is WorkflowV2ProgressReport {
  return isSharedWorkflowV2ProgressReport(value);
}

export function isWorkflowV2SupervisorDecision(value: unknown): value is WorkflowV2SupervisorDecision {
  return isSharedWorkflowV2SupervisorDecision(value);
}

export function assertWorkflowV2ProgressReportIdentity(
  lease: WorkflowV2ExecutionLeaseState,
  report: WorkflowV2ProgressReport,
): void {
  if (!isWorkflowV2ProgressReport(report)) throw new Error("Workflow V2 progress report is malformed.");
  if (report.nodeId !== lease.nodeId || report.attempt !== lease.attempt) {
    throw new Error(`Workflow V2 progress report identity does not match lease ${lease.nodeId} attempt ${lease.attempt}.`);
  }
  if (report.reportedAt < lease.startedAt || report.reportedAt > lease.hardDeadlineAt) {
    throw new Error(`Workflow V2 progress report time is outside lease ${lease.nodeId} attempt ${lease.attempt}.`);
  }
}

export function resolveWorkflowV2SupervisorDecision(input: {
  lease: WorkflowV2ExecutionLeaseState;
  policy: WorkflowV2ExecutionLeasePolicy;
  report: WorkflowV2ProgressReport;
  previousReport?: WorkflowV2ProgressReport;
  decision: WorkflowV2SupervisorDecision;
  now: number;
}): WorkflowV2SupervisorResolution {
  assertLeasePolicy(input.policy);
  assertWorkflowV2ProgressReportIdentity(input.lease, input.report);
  assertSupervisorDecision(input.decision);
  if (!isNonNegativeFinite(input.now) || input.now >= input.lease.hardDeadlineAt) {
    return { action: "cancel", reason: `Workflow V2 node ${input.lease.nodeId} reached its hard timeout.` };
  }

  if (input.decision.action !== "continue") return cloneTerminalDecision(input.decision);
  if (input.report.requestedAction !== "continue") {
    throw new Error(`Workflow V2 node ${input.lease.nodeId} did not request continuation.`);
  }
  if (!hasMeaningfulProgress(input.report, input.previousReport)) {
    throw new Error(`Workflow V2 node ${input.lease.nodeId} cannot renew its lease without new evidence or completed work.`);
  }
  if (input.lease.extensionCount >= input.policy.maxExtensions) {
    throw new Error(`Workflow V2 node ${input.lease.nodeId} exhausted its lease extensions.`);
  }
  if (input.decision.extensionMs > input.policy.maxExtensionMs) {
    throw new Error(`Workflow V2 node ${input.lease.nodeId} requested an extension beyond the configured maximum.`);
  }

  const softDeadlineAt = Math.min(input.now + input.decision.extensionMs, input.lease.hardDeadlineAt);
  if (softDeadlineAt <= input.now) {
    throw new Error(`Workflow V2 node ${input.lease.nodeId} cannot renew beyond its hard timeout.`);
  }
  return {
    action: "continue",
    reason: input.decision.reason,
    lease: {
      ...input.lease,
      lastActivityAt: Math.max(input.lease.lastActivityAt, input.report.reportedAt),
      softDeadlineAt,
      extensionCount: input.lease.extensionCount + 1,
    },
  };
}

function hasMeaningfulProgress(
  report: WorkflowV2ProgressReport,
  previousReport?: WorkflowV2ProgressReport,
): boolean {
  if (!previousReport) return report.completedItems.length > 0 || report.evidence.length > 0;
  const previousCompleted = new Set(previousReport.completedItems);
  const previousEvidence = new Set(previousReport.evidence);
  return report.completedItems.some((item) => !previousCompleted.has(item))
    || report.evidence.some((item) => !previousEvidence.has(item));
}

function cloneTerminalDecision(
  decision: Exclude<WorkflowV2SupervisorDecision, { action: "continue" }>,
): Exclude<WorkflowV2SupervisorResolution, { action: "continue" }> {
  return structuredClone(decision);
}

function assertLeasePolicy(policy: WorkflowV2ExecutionLeasePolicy): void {
  if (!validateWorkflowV2ExecutionLeasePolicy(policy)) {
    throw new Error("Workflow V2 execution lease policy is invalid.");
  }
}

function assertSupervisorDecision(decision: WorkflowV2SupervisorDecision): void {
  if (!isWorkflowV2SupervisorDecision(decision)) throw new Error("Workflow V2 supervisor decision is malformed.");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
