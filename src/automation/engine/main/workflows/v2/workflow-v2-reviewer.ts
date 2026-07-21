import type { WorkflowV2Node } from "../../../shared/workflow-v2/definition";
import { cloneWorkflowV2WorkerOutput, type WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2ResultPacket } from "../../../shared/workflow-v2/planning";
import type {
  WorkflowV2ReviewResolution,
  WorkflowV2ReviewerInput,
  WorkflowV2ReviewerResponse,
  WorkflowV2ReviewRetryPolicy,
  WorkflowV2ReviewVerdict,
} from "../../../shared/workflow-v2/review";
import { isWorkflowV2ReviewVerdict as isSharedWorkflowV2ReviewVerdict } from "../../../shared/workflow-v2/review";

export function createWorkflowV2ReviewerInput(input: {
  node: WorkflowV2Node;
  objective: string;
  output: WorkflowV2WorkerOutput;
}): WorkflowV2ReviewerInput {
  const clonedOutput = cloneWorkflowV2WorkerOutput(input.output);
  return {
    executorNodeId: input.node.id,
    objective: input.objective,
    constraints: input.node.execModel === "llm"
      ? (input.node.constraints ?? []).map((constraint) => ({ ...constraint }))
      : [],
    result: toResultPacket(clonedOutput),
  };
}

export function assertIndependentWorkflowV2Reviewer(
  executorNodeId: string,
  response: WorkflowV2ReviewerResponse,
): void {
  if (response.reviewerNodeId === executorNodeId) {
    throw new Error(`Workflow V2 node ${executorNodeId} cannot certify its own output.`);
  }
  if (!isWorkflowV2ReviewVerdict(response.verdict)) {
    throw new Error(`Workflow V2 reviewer ${response.reviewerNodeId} returned a malformed verdict.`);
  }
}

export function resolveWorkflowV2ReviewVerdict(
  verdict: WorkflowV2ReviewVerdict,
  retryPolicy: WorkflowV2ReviewRetryPolicy,
): WorkflowV2ReviewResolution {
  const reason = verdict.reasons.join(" ").trim() || `Reviewer returned ${verdict.decision}.`;
  if (verdict.decision === "accept") return { action: "accept", verdict: cloneVerdict(verdict), reason };
  if (verdict.decision === "escalate") return { action: "escalate", verdict: cloneVerdict(verdict), reason };
  if (retryPolicy.attempt <= retryPolicy.maxRetry) {
    return { action: "retry", verdict: cloneVerdict(verdict), reason };
  }
  if (retryPolicy.onExhausted === "skip") return { action: "skip", verdict: cloneVerdict(verdict), reason };
  if (retryPolicy.onExhausted === "ask_human") return { action: "pause", verdict: cloneVerdict(verdict), reason };
  return { action: "fail", verdict: cloneVerdict(verdict), reason };
}

export function isWorkflowV2ReviewVerdict(value: unknown): value is WorkflowV2ReviewVerdict {
  return isSharedWorkflowV2ReviewVerdict(value);
}

export function workflowV2ReviewerPrompt(input: WorkflowV2ReviewerInput): string {
  return [
    `Act as an independent Workflow V2 reviewer for executor node ${input.executorNodeId}.`,
    "Do not continue the executor's work and do not certify based on its self-assessment.",
    "Evaluate the result against the objective and constraints using only concrete evidence in the packet.",
    "Return one JSON object with exactly this contract:",
    '{"reviewerNodeId":"independent-reviewer","verdict":{"decision":"accept|reject|escalate","reasons":["string"],"requiredFixes":["optional string"],"riskLevel":"low|medium|high","evidence":["optional string"],"confidence":"high|medium|low"}}',
    "Reviewer input:",
    JSON.stringify(input),
  ].join("\n\n");
}

export function parseWorkflowV2ReviewerResponse(
  content: string,
  executorNodeId: string,
): WorkflowV2ReviewerResponse {
  const normalized = content.trim();
  const fenced = normalized.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced?.[1]?.trim() ?? normalized;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow V2 reviewer response is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)
    || typeof parsed.reviewerNodeId !== "string"
    || !parsed.reviewerNodeId.trim()
    || !isWorkflowV2ReviewVerdict(parsed.verdict)) {
    throw new Error("Workflow V2 reviewer response is malformed.");
  }
  const response: WorkflowV2ReviewerResponse = {
    reviewerNodeId: parsed.reviewerNodeId.trim(),
    verdict: cloneVerdict(parsed.verdict),
  };
  assertIndependentWorkflowV2Reviewer(executorNodeId, response);
  return response;
}

function toResultPacket(output: WorkflowV2WorkerOutput): WorkflowV2ResultPacket {
  return {
    nodeId: output.nodeId,
    summary: output.summary,
    outputs: output.outputs,
    ...(output.evidence ? { evidence: output.evidence } : {}),
    ...(output.risks ? { risks: output.risks } : {}),
    ...(output.nextStepSuggestions ? { nextStepSuggestions: output.nextStepSuggestions } : {}),
  };
}

function cloneVerdict(verdict: WorkflowV2ReviewVerdict): WorkflowV2ReviewVerdict {
  return structuredClone(verdict);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
