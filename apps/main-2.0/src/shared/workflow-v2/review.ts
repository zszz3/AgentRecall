import type { WorkflowV2ConstraintDef, WorkflowV2JudgeDimensionDef, WorkflowV2ReviewLevel, WorkflowV2ScriptCapability, WorkflowV2ScriptRiskLevel } from "./definition";
import { isWorkflowV2WorkerOutput, type WorkflowV2WorkerOutput } from "./packets";
import type { WorkflowV2ResultPacket } from "./planning";
import type { WorkflowV2ProgressReport, WorkflowV2SupervisorDecision } from "./supervision";
import { isWorkflowV2ProgressReport, isWorkflowV2SupervisorDecision } from "./supervision";

export type WorkflowV2ReviewDecision = "accept" | "reject" | "escalate";
export type WorkflowV2ReviewRiskLevel = "low" | "medium" | "high";
export type WorkflowV2ReviewConfidence = "high" | "medium" | "low";
export type WorkflowV2QualityLevel = Exclude<WorkflowV2ReviewLevel, "none">;

export type WorkflowV2ReviewTraceKind =
  | "request"
  | "response"
  | "tool_call"
  | "tool_result"
  | "system"
  | "handoff"
  | "approval_request"
  | "approval_response"
  | "user_input_request"
  | "user_input_response"
  | "error";

export interface WorkflowV2ReviewTraceEntry {
  id: string;
  kind: WorkflowV2ReviewTraceKind;
  at: number;
  content: string;
  name?: string;
  metadata?: Record<string, unknown>;
  infrastructureAttempt?: number;
}

export interface WorkflowV2ReviewDimensionResult {
  key: string;
  qualityLevel: WorkflowV2QualityLevel;
  reason: string;
  evidence: string[];
}

export interface WorkflowV2ReviewVerdict {
  decision: WorkflowV2ReviewDecision;
  reasons: string[];
  requiredFixes?: string[];
  riskLevel: WorkflowV2ReviewRiskLevel;
  evidence?: string[];
  confidence: WorkflowV2ReviewConfidence;
  qualityLevel: WorkflowV2QualityLevel;
  dimensionResults: WorkflowV2ReviewDimensionResult[];
}

export interface WorkflowV2ReviewGateSubmission {
  reasons: string[];
  requiredFixes?: string[];
  riskLevel: WorkflowV2ReviewRiskLevel;
  evidence?: string[];
  confidence: WorkflowV2ReviewConfidence;
  dimensionResults: WorkflowV2ReviewDimensionResult[];
}

export interface WorkflowV2ReviewerInput {
  gateId?: string;
  executorNodeId: string;
  reviewerConfiguredAgentId?: string;
  objective: string;
  constraints: WorkflowV2ConstraintDef[];
  reviewLevel: WorkflowV2QualityLevel;
  judgeDimensions: WorkflowV2JudgeDimensionDef[];
  reviewAttempt: number;
  upstreamResults: WorkflowV2ResultPacket[];
  result: Omit<WorkflowV2WorkerOutput, "proposals">;
}

export interface WorkflowV2ReviewerResponse {
  reviewerNodeId: string;
  verdict: WorkflowV2ReviewVerdict;
  trace?: WorkflowV2ReviewTraceEntry[];
}

export type WorkflowV2ReviewAction = "accept" | "retry" | "fail" | "skip" | "pause" | "escalate";

export interface WorkflowV2ReviewResolution {
  action: WorkflowV2ReviewAction;
  verdict: WorkflowV2ReviewVerdict;
  reason: string;
}

export interface WorkflowV2ReviewRetryPolicy {
  reviewAttempt: number;
  maxReviewRetries: number;
}

export interface WorkflowV2ReviewAttemptRecord {
  gateId?: string;
  reviewerConfiguredAgentId?: string;
  reviewAttempt: number;
  candidate: WorkflowV2WorkerOutput;
  verdict: WorkflowV2ReviewVerdict;
  requiredLevel: WorkflowV2QualityLevel;
  passed: boolean;
  reviewedAt: number;
  trace?: WorkflowV2ReviewTraceEntry[];
}

export type WorkflowV2InterventionAction = "continue" | "skip" | "escalate" | "replan" | "increase_review_strength" | "approve_once" | "reject" | "rerun_all" | "accept_last_result";

export interface WorkflowV2ScriptApprovalRequest {
  requestId: string;
  risk: WorkflowV2ScriptRiskLevel;
  capabilities: WorkflowV2ScriptCapability[];
  capabilityDigest: string;
  operationDigest: string;
  executableSummary: string;
  workDir: string;
}

export interface WorkflowV2HumanIntervention {
  nodeId: string;
  source:
    | "validation"
    | "review_rejection"
    | "review_escalation"
    | "supervision_pause"
    | "supervision_escalation"
    | "hook_pause"
    | "script_permission";
  reason: string;
  allowedActions: WorkflowV2InterventionAction[];
  requestedAt: number;
  reviewVerdict?: WorkflowV2ReviewVerdict;
  reviewTrace?: WorkflowV2ReviewTraceEntry[];
  lastCandidate?: WorkflowV2WorkerOutput;
  progressReport?: WorkflowV2ProgressReport;
  supervisorDecision?: WorkflowV2SupervisorDecision;
  scriptApproval?: WorkflowV2ScriptApprovalRequest;
  resumeConversation?: {
    runtimeId: string;
    codecVersion: string;
    payload: unknown;
  };
}

export function isWorkflowV2ReviewVerdict(value: unknown): value is WorkflowV2ReviewVerdict {
  if (!isRecord(value)) return false;
  if (value.decision !== "accept" && value.decision !== "reject" && value.decision !== "escalate") {
    return false;
  }
  if (!isStringArray(value.reasons)) return false;
  if (value.requiredFixes !== undefined && !isStringArray(value.requiredFixes)) return false;
  if (value.riskLevel !== "low" && value.riskLevel !== "medium" && value.riskLevel !== "high") {
    return false;
  }
  if (value.evidence !== undefined && !isStringArray(value.evidence)) return false;
  if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") return false;
  if (!isQualityLevel(value.qualityLevel) || !Array.isArray(value.dimensionResults)) return false;
  return value.dimensionResults.every((item) => isRecord(item)
    && typeof item.key === "string" && item.key.trim().length > 0
    && isQualityLevel(item.qualityLevel)
    && typeof item.reason === "string" && item.reason.trim().length > 0
    && isStringArray(item.evidence));
}

export function isWorkflowV2HumanIntervention(value: unknown): value is WorkflowV2HumanIntervention {
  if (!isRecord(value)) return false;
  if (typeof value.nodeId !== "string" || !value.nodeId.trim()) return false;
  if (!isInterventionSource(value.source)) return false;
  if (typeof value.reason !== "string" || !value.reason.trim()) return false;
  if (!Array.isArray(value.allowedActions) || !value.allowedActions.every(isWorkflowV2InterventionAction)) {
    return false;
  }
  if (typeof value.requestedAt !== "number" || !Number.isFinite(value.requestedAt) || value.requestedAt < 0) {
    return false;
  }
  if (value.reviewVerdict !== undefined && !isWorkflowV2ReviewVerdict(value.reviewVerdict)) return false;
  if (value.reviewTrace !== undefined && (!Array.isArray(value.reviewTrace) || !value.reviewTrace.every(isWorkflowV2ReviewTraceEntry))) return false;
  if (value.lastCandidate !== undefined && !isWorkflowV2WorkerOutput(value.lastCandidate)) return false;
  if (value.progressReport !== undefined && !isWorkflowV2ProgressReport(value.progressReport)) return false;
  if (value.supervisorDecision !== undefined && !isWorkflowV2SupervisorDecision(value.supervisorDecision)) {
    return false;
  }
  if (value.scriptApproval !== undefined && !isWorkflowV2ScriptApprovalRequest(value.scriptApproval)) {
    return false;
  }
  if (value.source === "script_permission") {
    if (value.scriptApproval === undefined) return false;
    if (
      value.allowedActions.length !== 2
      || !value.allowedActions.includes("approve_once")
      || !value.allowedActions.includes("reject")
    ) {
      return false;
    }
  } else if (value.scriptApproval !== undefined) {
    return false;
  }
  return value.resumeConversation === undefined || isResumeConversation(value.resumeConversation);
}

function isInterventionSource(value: unknown): value is WorkflowV2HumanIntervention["source"] {
  return (
    value === "validation"
    || value === "review_rejection"
    || value === "review_escalation"
    || value === "supervision_pause"
    || value === "supervision_escalation"
    || value === "hook_pause"
    || value === "script_permission"
  );
}

export function isWorkflowV2InterventionAction(value: unknown): value is WorkflowV2InterventionAction {
  return (
    value === "continue"
    || value === "skip"
    || value === "escalate"
    || value === "replan"
    || value === "increase_review_strength"
    || value === "approve_once"
    || value === "reject"
    || value === "rerun_all"
    || value === "accept_last_result"
  );
}

export function isWorkflowV2ReviewTraceEntry(value: unknown): value is WorkflowV2ReviewTraceEntry {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return false;
  if (!isReviewTraceKind(value.kind)) return false;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0) return false;
  if (typeof value.content !== "string") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false;
  return value.infrastructureAttempt === undefined
    || (Number.isSafeInteger(value.infrastructureAttempt) && Number(value.infrastructureAttempt) > 0);
}

function isReviewTraceKind(value: unknown): value is WorkflowV2ReviewTraceKind {
  return value === "request"
    || value === "response"
    || value === "tool_call"
    || value === "tool_result"
    || value === "system"
    || value === "handoff"
    || value === "approval_request"
    || value === "approval_response"
    || value === "user_input_request"
    || value === "user_input_response"
    || value === "error";
}

function isQualityLevel(value: unknown): value is WorkflowV2QualityLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isWorkflowV2ScriptApprovalRequest(value: unknown): value is WorkflowV2ScriptApprovalRequest {
  if (!isRecord(value)) return false;
  if (typeof value.requestId !== "string" || !value.requestId.trim()) return false;
  if (
    value.risk !== "safe"
    && value.risk !== "read"
    && value.risk !== "write"
    && value.risk !== "dangerous"
  ) {
    return false;
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === "string")) {
    return false;
  }
  return [value.capabilityDigest, value.operationDigest, value.executableSummary, value.workDir].every(
    (item) => typeof item === "string" && item.trim().length > 0,
  );
}

function isResumeConversation(
  value: unknown,
): value is NonNullable<WorkflowV2HumanIntervention["resumeConversation"]> {
  return (
    isRecord(value)
    && typeof value.runtimeId === "string"
    && value.runtimeId.trim().length > 0
    && typeof value.codecVersion === "string"
    && value.codecVersion.trim().length > 0
    && Object.hasOwn(value, "payload")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
