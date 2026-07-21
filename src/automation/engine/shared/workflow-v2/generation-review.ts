import type { WorkflowV2ScriptRiskLevel } from "./definition";

export type WorkflowV2GenerationReviewStatus = "not_reviewed" | "reviewing" | "approved" | "changes_requested" | "failed";
export type WorkflowV2GenerationReviewVerdict = "approve" | "revise";

export interface WorkflowV2GenerationReviewFinding {
  severity: "blocking" | "warning";
  nodeId?: string;
  summary: string;
  failurePath: string;
}

export interface WorkflowV2GenerationReviewResult {
  verdict: WorkflowV2GenerationReviewVerdict;
  reviewedRevision: number;
  summary: string;
  findings: WorkflowV2GenerationReviewFinding[];
  scriptRisks: Record<string, { level: WorkflowV2ScriptRiskLevel; rationale: string }>;
  suggestions: string[];
}

export interface WorkflowV2GenerationReviewState {
  status: WorkflowV2GenerationReviewStatus;
  reviewerConfiguredAgentId: string;
  reviewerModelId: string;
  reviewedRevision?: number;
  result?: WorkflowV2GenerationReviewResult;
  error?: string;
  updatedAt: number;
}

export function isCurrentWorkflowV2GenerationReviewApproved(state: WorkflowV2GenerationReviewState | undefined, revision: number): boolean {
  return state?.status === "approved" && state.reviewedRevision === revision && state.result?.verdict === "approve" && state.result.reviewedRevision === revision;
}

export function isWorkflowV2GenerationReviewValidForRoute(state: WorkflowV2GenerationReviewState | undefined, input: { revision: number; reviewerConfiguredAgentId: string; reviewerModelId: string }): boolean {
  return isCurrentWorkflowV2GenerationReviewApproved(state, input.revision)
    && state?.reviewerConfiguredAgentId === input.reviewerConfiguredAgentId
    && state.reviewerModelId === input.reviewerModelId;
}
