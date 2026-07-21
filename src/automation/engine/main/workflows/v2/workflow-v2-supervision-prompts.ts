import type { WorkflowV2Node } from "../../../shared/workflow-v2/definition";
import type {
  WorkflowV2ExecutionLeasePolicy,
  WorkflowV2ProgressReport,
  WorkflowV2SupervisorDecision,
} from "../../../shared/workflow-v2/supervision";
import { isWorkflowV2ProgressReport, isWorkflowV2SupervisorDecision } from "./workflow-v2-supervisor";

export function workflowV2ProgressProbePrompt(input: {
  node: WorkflowV2Node;
  attempt: number;
  partialArtifact: string;
  now: number;
}): string {
  return [
    `The Workflow V2 task for node ${input.node.id} was interrupted at its soft execution deadline.`,
    "Report progress only. Do not claim final node completion and do not navigate the workflow graph.",
    `Attempt: ${input.attempt}`,
    `Report timestamp: ${input.now}`,
    "Return one JSON object with exactly this contract:",
    '{"nodeId":"string","attempt":1,"phase":"string","completedItems":["string"],"remainingItems":["string"],"blockers":["string"],"evidence":["string"],"checkpoint":"optional non-empty string","estimatedRemainingMs":0,"safeToInterrupt":true,"requestedAction":"continue|need_input|escalate","reportedAt":0}',
    "Use concrete evidence produced since execution began. A percentage alone is not evidence.",
    "Partial artifact captured before interruption:",
    input.partialArtifact || "(no partial artifact)",
  ].join("\n\n");
}

export function workflowV2SupervisorDecisionPrompt(input: {
  node: WorkflowV2Node;
  report: WorkflowV2ProgressReport;
  policy: WorkflowV2ExecutionLeasePolicy;
  extensionCount: number;
}): string {
  return [
    `Act as the Workflow V2 orchestrator supervising overdue node ${input.node.id}.`,
    "Choose navigation only; this decision cannot mark the node completed.",
    `Lease extensions used: ${input.extensionCount}/${input.policy.maxExtensions}.`,
    `Maximum extension milliseconds: ${input.policy.maxExtensionMs}.`,
    "Return one JSON object matching one of these forms:",
    '{"action":"continue","extensionMs":1000,"reason":"string"}',
    '{"action":"retry","fromCheckpoint":"optional string","reason":"string"}',
    '{"action":"escalate","modelProfile":"expert","reason":"string"}',
    '{"action":"pause","question":"string","reason":"string"}',
    '{"action":"cancel","reason":"string"}',
    "Progress report:",
    JSON.stringify(input.report),
  ].join("\n\n");
}

export function workflowV2ContinueAfterProbePrompt(input: {
  node: WorkflowV2Node;
  report: WorkflowV2ProgressReport;
  decision: Extract<WorkflowV2SupervisorDecision, { action: "continue" }>;
}): string {
  return [
    `Continue the interrupted work for Workflow V2 node ${input.node.id}.`,
    `The orchestrator granted ${input.decision.extensionMs}ms because: ${input.decision.reason}`,
    "Use the existing conversation and checkpoint. Finish the node task, then return the final WorkflowV2WorkerOutput JSON required by the original prompt.",
    "The progress report below is control context only and is not a final result:",
    JSON.stringify(input.report),
  ].join("\n\n");
}

export function parseWorkflowV2ProgressReport(content: string): WorkflowV2ProgressReport {
  const parsed = parseJsonObject(content, "progress report");
  if (!isWorkflowV2ProgressReport(parsed)) throw new Error("Workflow V2 progress report is malformed.");
  return structuredClone(parsed);
}

export function parseWorkflowV2SupervisorDecision(content: string): WorkflowV2SupervisorDecision {
  const parsed = parseJsonObject(content, "supervisor decision");
  if (!isWorkflowV2SupervisorDecision(parsed)) throw new Error("Workflow V2 supervisor decision is malformed.");
  return structuredClone(parsed);
}

function parseJsonObject(content: string, label: string): unknown {
  const normalized = content.trim();
  const fenced = normalized.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced?.[1]?.trim() ?? normalized;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow V2 ${label} is not valid JSON: ${message}`);
  }
}
