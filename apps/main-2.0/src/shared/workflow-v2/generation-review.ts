import type { WorkflowV2ScriptRiskLevel } from "./definition";
import type { WorkflowV2ReviewTraceEntry } from "./review";

export type WorkflowV2GenerationReviewStatus = "not_reviewed" | "reviewing" | "approved" | "changes_requested" | "failed";
export type WorkflowV2GenerationReviewVerdict = "approve" | "revise";

export interface WorkflowV2GenerationReviewFinding {
  severity: "blocking" | "warning";
  nodeIds: string[];
  summary: string;
  failurePath: string;
  requiredChange: string;
}

export type WorkflowV2GenerationReviewSubmission = Omit<WorkflowV2GenerationReviewResult, "reviewedRevision">;

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
  trace?: WorkflowV2ReviewTraceEntry[];
  updatedAt: number;
}
