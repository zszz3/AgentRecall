import type { WorkflowV2ResultPacket } from "./planning";

export type WorkflowV2WorkProposal =
  | { kind: "continue"; reason: string; targetNodeIds?: string[] }
  | { kind: "retry"; reason: string; targetNodeId?: string }
  | { kind: "escalate"; reason: string }
  | { kind: "graph-revision"; reason: string };

export interface WorkflowV2WorkerOutput extends WorkflowV2ResultPacket {
  proposals: WorkflowV2WorkProposal[];
}

export function isWorkflowV2ResultPacket(value: unknown): value is WorkflowV2ResultPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Record<string, unknown>;
  return typeof packet.nodeId === "string"
    && typeof packet.summary === "string"
    && Boolean(packet.outputs && typeof packet.outputs === "object" && !Array.isArray(packet.outputs));
}

export function extractWorkflowV2WorkerOutputValue(content: string): unknown {
  return splitWorkflowV2WorkerOutputContent(content)?.value;
}

export function splitWorkflowV2WorkerOutputContent(content: string): { leadingText: string; value: WorkflowV2ResultPacket } | undefined {
  const normalized = content.trim();
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const character = normalized[index];
    if (character !== "{" && character !== "[") continue;
    try {
      const value = JSON.parse(normalized.slice(index)) as unknown;
      if (!isWorkflowV2ResultPacket(value)) continue;
      return { leadingText: normalized.slice(0, index).trimEnd(), value };
    } catch {
      // Keep searching for the outer packet boundary.
    }
  }
  return undefined;
}

export function isWorkflowV2WorkerOutput(value: unknown): value is WorkflowV2WorkerOutput {
  return isWorkflowV2ResultPacket(value)
    && Array.isArray((value as WorkflowV2ResultPacket & { proposals?: unknown }).proposals);
}

export function workflowV2ExplicitUserFacingOutput(output: WorkflowV2ResultPacket): string | undefined {
  const preferredKeys = ["answer_markdown", "final_answer", "answer", "report_markdown", "content_markdown", "output"];
  for (const key of preferredKeys) {
    const value = output.outputs[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function workflowV2UserFacingOutput(output: WorkflowV2ResultPacket): string {
  const explicit = workflowV2ExplicitUserFacingOutput(output);
  if (explicit) return explicit;
  for (const value of Object.values(output.outputs)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return output.summary;
}

export function cloneWorkflowV2WorkerOutput(output: WorkflowV2WorkerOutput): WorkflowV2WorkerOutput {
  return {
    ...output,
    outputs: structuredClone(output.outputs),
    ...(output.evidence ? { evidence: [...output.evidence] } : {}),
    ...(output.risks ? { risks: [...output.risks] } : {}),
    ...(output.nextStepSuggestions ? { nextStepSuggestions: [...output.nextStepSuggestions] } : {}),
    proposals: structuredClone(output.proposals),
  };
}
