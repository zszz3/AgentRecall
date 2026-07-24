import { isWorkflowV2WorkerOutput, type WorkflowV2WorkerOutput } from "./packets";

export const WORKFLOW_V2_COMPLETION_LEDGER_SCHEMA_VERSION = 1 as const;

export type WorkflowV2NodeCompletionSubmissionStatus =
  | "submitted"
  | "consumed"
  | "accepted"
  | "rejected"
  | "superseded";

export interface WorkflowV2NodeCompletionSubmission {
  submissionId: string;
  digest: string;
  status: WorkflowV2NodeCompletionSubmissionStatus;
  output: WorkflowV2WorkerOutput;
  submittedAt: number;
  resolvedAt?: number;
  reason?: string;
}

export interface WorkflowV2NodeCompletionLedger {
  schemaVersion: typeof WORKFLOW_V2_COMPLETION_LEDGER_SCHEMA_VERSION;
  workflowId: string;
  runId: string;
  nodeId: string;
  executionId: string;
  attempt: number;
  startedAt: number;
  updatedAt: number;
  submissions: WorkflowV2NodeCompletionSubmission[];
}

export function isWorkflowV2NodeCompletionLedger(value: unknown): value is WorkflowV2NodeCompletionLedger {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== WORKFLOW_V2_COMPLETION_LEDGER_SCHEMA_VERSION) return false;
  if (![value.workflowId, value.runId, value.nodeId, value.executionId].every(nonEmptyString)) return false;
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) <= 0) return false;
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.updatedAt)) return false;
  return Array.isArray(value.submissions)
    && value.submissions.every((submission) => isSubmission(submission) && submission.output.nodeId === value.nodeId);
}

function isSubmission(value: unknown): value is WorkflowV2NodeCompletionSubmission {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.submissionId) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) return false;
  if (!completionStatuses.has(value.status as WorkflowV2NodeCompletionSubmissionStatus)) return false;
  if (!isWorkflowV2WorkerOutput(value.output) || !validTimestamp(value.submittedAt)) return false;
  if (value.resolvedAt !== undefined && !validTimestamp(value.resolvedAt)) return false;
  return value.reason === undefined || typeof value.reason === "string";
}

const completionStatuses = new Set<WorkflowV2NodeCompletionSubmissionStatus>([
  "submitted", "consumed", "accepted", "rejected", "superseded",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
