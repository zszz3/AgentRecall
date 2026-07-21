import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { isWorkflowV2HookJsonValue } from "../../../shared/workflow-v2/hooks";
import { extractWorkflowV2WorkerOutputValue, type WorkflowV2WorkerOutput, type WorkflowV2WorkProposal } from "../../../shared/workflow-v2/packets";
import { truncateWorkflowContext } from "../../../shared/workflow-v2/runtime-utils";

export function parseWorkflowV2WorkerArtifact(node: WorkflowV2LLMNode, artifact: string): WorkflowV2WorkerOutput {
  const normalized = artifact.trim();
  if (!normalized) throw new Error(`Workflow V2 LLM node ${node.id} returned an empty artifact.`);
  const jsonCandidate = unwrapJsonFence(normalized);
  try {
    return parseStructuredWorkflowV2WorkerOutput(node.id, JSON.parse(jsonCandidate) as unknown);
  } catch (error) {
    if (jsonCandidate.startsWith("{") || jsonCandidate.startsWith("[")) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workflow V2 LLM node ${node.id} returned an invalid structured worker-output packet: ${message}`);
    }
  }
  const extracted = extractWorkflowV2WorkerOutputValue(normalized);
  if (extracted !== undefined) return parseStructuredWorkflowV2WorkerOutput(node.id, extracted);
  if (node.outputFields.length !== 1) {
    throw new Error(`Workflow V2 LLM node ${node.id} must return structured JSON for multiple output fields.`);
  }
  const outputField = node.outputFields[0]!;
  return { nodeId: node.id, summary: truncateWorkflowContext(normalized, 240), outputs: { [outputField.key]: normalized }, proposals: [] };
}

export function parseWorkflowV2HookLlmValue(content: string): unknown {
  const normalized = content.trim();
  if (!normalized) throw new Error("Workflow V2 llmHook returned an empty response.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(normalized)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow V2 llmHook returned invalid JSON: ${message}`);
  }
  if (!isWorkflowV2HookJsonValue(parsed)) throw new Error("Workflow V2 llmHook returned a non-finite JSON value.");
  return parsed;
}

function unwrapJsonFence(content: string): string {
  const fenced = content.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced?.[1]?.trim() ?? content;
}

function parseStructuredWorkflowV2WorkerOutput(expectedNodeId: string, value: unknown): WorkflowV2WorkerOutput {
  if (!isRecord(value)) throw new Error("the packet must be a JSON object");
  if (typeof value.nodeId !== "string" || !value.nodeId.trim()) throw new Error("nodeId must be a non-empty string");
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("summary must be a non-empty string");
  if (!isRecord(value.outputs)) throw new Error("outputs must be a JSON object");
  if (!Array.isArray(value.proposals) || !value.proposals.every(isWorkflowV2WorkProposal)) {
    throw new Error("proposals must be an array of valid worker proposals");
  }
  if (value.nodeId !== expectedNodeId) throw new Error(`nodeId ${value.nodeId} does not match expected node ${expectedNodeId}`);
  const evidence = parseOptionalStringArray(value.evidence, "evidence");
  const risks = parseOptionalStringArray(value.risks, "risks");
  const nextStepSuggestions = parseOptionalStringArray(value.nextStepSuggestions, "nextStepSuggestions");
  return {
    nodeId: value.nodeId,
    summary: value.summary,
    outputs: value.outputs,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(risks !== undefined ? { risks } : {}),
    ...(nextStepSuggestions !== undefined ? { nextStepSuggestions } : {}),
    proposals: value.proposals as WorkflowV2WorkProposal[],
  };
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be an array of strings`);
  return value;
}

function isWorkflowV2WorkProposal(value: unknown): value is WorkflowV2WorkProposal {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.reason !== "string") return false;
  if (value.kind === "continue") return value.targetNodeIds === undefined || (Array.isArray(value.targetNodeIds) && value.targetNodeIds.every((item) => typeof item === "string"));
  if (value.kind === "retry") return value.targetNodeId === undefined || typeof value.targetNodeId === "string";
  return value.kind === "escalate" || value.kind === "graph-revision";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
