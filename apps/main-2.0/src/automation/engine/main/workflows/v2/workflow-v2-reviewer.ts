import type { WorkflowV2Node, WorkflowV2ReviewGate } from "../../../shared/workflow-v2/definition";
import { cloneWorkflowV2WorkerOutput, type WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2ResultPacket } from "../../../shared/workflow-v2/planning";
import type {
  WorkflowV2ReviewResolution,
  WorkflowV2ReviewGateSubmission,
  WorkflowV2ReviewDimensionResult,
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
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  reviewAttempt: number;
  gate?: WorkflowV2ReviewGate;
}): WorkflowV2ReviewerInput {
  const reviewLevel = input.gate?.reviewLevel ?? input.node.reviewLevel;
  if (!reviewLevel || reviewLevel === "none") throw new Error(`Workflow V2 node ${input.node.id} does not require review.`);
  const { proposals: _executorProposals, ...reviewEvidence } = cloneWorkflowV2WorkerOutput(input.output);
  return {
    ...(input.gate ? {
      gateId: input.gate.id,
      reviewerConfiguredAgentId: input.gate.configuredAgentId,
    } : {}),
    executorNodeId: input.node.id,
    objective: input.objective,
    constraints: input.node.execModel === "llm"
      ? (input.node.constraints ?? []).map((constraint) => ({ ...constraint }))
      : [],
    reviewLevel,
    judgeDimensions: structuredClone(input.gate?.judgeDimensions ?? input.node.judgeDimensions ?? []),
    reviewAttempt: input.reviewAttempt,
    upstreamResults: input.upstreamOutputs.map((output) => structuredClone(output)),
    result: reviewEvidence,
  };
}

export function assertIndependentWorkflowV2Reviewer(
  executorNodeId: string,
  response: WorkflowV2ReviewerResponse,
  contextBoundGate = false,
): void {
  if (!contextBoundGate && response.reviewerNodeId === executorNodeId) {
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
  if (retryPolicy.reviewAttempt <= retryPolicy.maxReviewRetries) {
    return { action: "retry", verdict: cloneVerdict(verdict), reason };
  }
  return { action: "pause", verdict: cloneVerdict(verdict), reason };
}

export function isWorkflowV2ReviewVerdict(value: unknown): value is WorkflowV2ReviewVerdict {
  return isSharedWorkflowV2ReviewVerdict(value);
}

export function workflowV2ReviewerPrompt(input: WorkflowV2ReviewerInput): string {
  return [
    `Act as an independent Workflow V2 reviewer for executor node ${input.executorNodeId}.`,
    "Do not continue the executor's work and do not certify based on its self-assessment.",
    "Operate only as a reviewer: do not modify the Workflow definition or executor result. Use the Review Agent's normal tool bindings; any permission-requiring operation must go through the Approval Broker.",
    "Evaluate the result against the Workflow objective, node constraints, and every configured judge dimension using only concrete evidence in the packet.",
    "Return one result for every judge dimension. Use low, medium, or high. Include at least one concrete, non-empty evidence item for every dimension. The engine derives the overall quality level and pass/fail decision.",
    "Write every human-readable review field in Simplified Chinese, including reasons, requiredFixes, evidence, and each dimension result's reason and evidence. Keep protocol enums, reviewerNodeId, node IDs, and configured dimension keys unchanged.",
    "Submit the result by calling workflow_review_gate_submit (it may be displayed with an MCP namespace) exactly once successfully. Workflow, Run, Gate, node, candidate, and Reviewer identity are already bound by the tool context and must not be supplied.",
    "If that tool is unavailable, return only one JSON object with exactly this fallback contract:",
    '{"reasons":["string"],"requiredFixes":["optional string"],"riskLevel":"low|medium|high","evidence":["optional string"],"confidence":"high|medium|low","dimensionResults":[{"key":"configured-dimension-key","qualityLevel":"low|medium|high","reason":"string","evidence":["string"]}]}',
    "Reviewer input:",
    JSON.stringify(input),
  ].join("\n\n");
}

export function parseWorkflowV2ReviewerResponse(
  content: string,
  input: WorkflowV2ReviewerInput,
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
  if (!isRecord(parsed)) throw new Error("Workflow V2 reviewer response is malformed.");
  if (typeof parsed.reviewerNodeId === "string" && isWorkflowV2ReviewVerdict(parsed.verdict)) {
    return finalizeWorkflowV2ReviewGateSubmission({
      reviewerNodeId: parsed.reviewerNodeId,
      input,
      submission: {
        reasons: parsed.verdict.reasons,
        ...(parsed.verdict.requiredFixes ? { requiredFixes: parsed.verdict.requiredFixes } : {}),
        riskLevel: parsed.verdict.riskLevel,
        ...(parsed.verdict.evidence ? { evidence: parsed.verdict.evidence } : {}),
        confidence: parsed.verdict.confidence,
        dimensionResults: parsed.verdict.dimensionResults,
      },
    });
  }
  return finalizeWorkflowV2ReviewGateSubmission({
    reviewerNodeId: input.reviewerConfiguredAgentId ?? `reviewer:${input.executorNodeId}`,
    input,
    submission: parseWorkflowV2ReviewGateSubmission(parsed, input),
  });
}

export function parseWorkflowV2ReviewGateSubmission(
  value: unknown,
  input: WorkflowV2ReviewerInput,
): WorkflowV2ReviewGateSubmission {
  if (!isRecord(value)) throw new Error("Workflow Review Gate submission must be an object.");
  const allowedKeys = new Set(["reasons", "requiredFixes", "riskLevel", "evidence", "confidence", "dimensionResults"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Workflow Review Gate submission contains unsupported fields.");
  }
  if (!isNonEmptyStringArray(value.reasons)
    || (value.requiredFixes !== undefined && !isNonEmptyStringArray(value.requiredFixes))
    || (value.evidence !== undefined && !isNonEmptyStringArray(value.evidence))
    || (value.riskLevel !== "low" && value.riskLevel !== "medium" && value.riskLevel !== "high")
    || (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low")
    || !Array.isArray(value.dimensionResults)) {
    throw new Error("Workflow Review Gate submission is malformed.");
  }
  const dimensionResults: WorkflowV2ReviewDimensionResult[] = value.dimensionResults.map((dimension) => {
    if (!isRecord(dimension)
      || Object.keys(dimension).some((key) => !["key", "qualityLevel", "reason", "evidence"].includes(key))
      || typeof dimension.key !== "string" || !dimension.key.trim()
      || (dimension.qualityLevel !== "low" && dimension.qualityLevel !== "medium" && dimension.qualityLevel !== "high")
      || typeof dimension.reason !== "string" || !dimension.reason.trim()
      || !isNonEmptyStringArray(dimension.evidence)) {
      throw new Error("Every Workflow Review Gate dimension requires a level, reason, and concrete evidence.");
    }
    return {
      key: dimension.key.trim(),
      qualityLevel: dimension.qualityLevel as WorkflowV2ReviewDimensionResult["qualityLevel"],
      reason: dimension.reason.trim(),
      evidence: dimension.evidence.map((item) => item.trim()),
    };
  });
  const dimensionKeys = new Set(input.judgeDimensions.map((dimension) => dimension.key));
  if (dimensionResults.length !== dimensionKeys.size
    || dimensionResults.some((dimension) => !dimensionKeys.has(dimension.key))
    || new Set(dimensionResults.map((dimension) => dimension.key)).size !== dimensionKeys.size) {
    throw new Error("Workflow V2 reviewer response must assess every configured judge dimension exactly once.");
  }
  return {
    reasons: value.reasons.map((item) => item.trim()),
    ...(value.requiredFixes ? { requiredFixes: value.requiredFixes.map((item) => item.trim()) } : {}),
    riskLevel: value.riskLevel,
    ...(value.evidence ? { evidence: value.evidence.map((item) => item.trim()) } : {}),
    confidence: value.confidence,
    dimensionResults,
  };
}

export function finalizeWorkflowV2ReviewGateSubmission(input: {
  reviewerNodeId: string;
  input: WorkflowV2ReviewerInput;
  submission: WorkflowV2ReviewGateSubmission;
}): WorkflowV2ReviewerResponse {
  const submission = parseWorkflowV2ReviewGateSubmission(input.submission, input.input);
  const qualityLevel = lowestQualityLevel(submission.dimensionResults.map((dimension) => dimension.qualityLevel));
  const decision = qualityRank(qualityLevel) >= qualityRank(input.input.reviewLevel) ? "accept" : "reject";
  const response: WorkflowV2ReviewerResponse = {
    reviewerNodeId: input.reviewerNodeId.trim(),
    verdict: cloneVerdict({ ...submission, decision, qualityLevel }),
  };
  if (!response.reviewerNodeId) throw new Error("Workflow Review Gate reviewer identity is missing.");
  assertIndependentWorkflowV2Reviewer(input.input.executorNodeId, response, input.input.gateId !== undefined);
  return response;
}

function qualityRank(level: "low" | "medium" | "high"): number {
  return level === "low" ? 1 : level === "medium" ? 2 : 3;
}

function lowestQualityLevel(levels: Array<"low" | "medium" | "high">): "low" | "medium" | "high" {
  if (levels.length === 0) throw new Error("Workflow V2 reviewer response has no dimension results.");
  return levels.reduce((lowest, level) => qualityRank(level) < qualityRank(lowest) ? level : lowest);
}

function cloneVerdict(verdict: WorkflowV2ReviewVerdict): WorkflowV2ReviewVerdict {
  return structuredClone(verdict);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}
