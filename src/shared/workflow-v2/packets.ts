import type { WorkflowV2ResultPacket } from "./planning";

// Worker output packets deliberately separate user-facing outputs from control
// proposals so runtime recovery/routing can inspect behavior without parsing prose.
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
  return (
    typeof packet.nodeId === "string"
    && typeof packet.summary === "string"
    && Boolean(packet.outputs && typeof packet.outputs === "object" && !Array.isArray(packet.outputs))
  );
}

export function extractWorkflowV2WorkerOutputValue(content: string): unknown {
  return splitWorkflowV2WorkerOutputContent(content)?.value;
}

export function splitWorkflowV2WorkerOutputContent(
  content: string,
): { leadingText: string; value: WorkflowV2ResultPacket } | undefined {
  // Runtime agents may return prose plus a trailing JSON packet. Parse from the
  // end so we preserve any leading explanation while still extracting structure.
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
  return (
    isWorkflowV2ResultPacket(value)
    && Array.isArray((value as WorkflowV2ResultPacket & { proposals?: unknown }).proposals)
  );
}

export function workflowV2ExplicitUserFacingOutput(
  output: WorkflowV2ResultPacket,
): string | undefined {
  // Prefer well-known output keys first so downstream UI/recovery behavior is
  // stable even when nodes emit multiple fields.
  const preferredKeys = [
    "answer_markdown",
    "final_answer",
    "answer",
    "report_markdown",
    "content_markdown",
    "output",
  ];
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

export function cloneWorkflowV2WorkerOutput(
  output: WorkflowV2WorkerOutput,
): WorkflowV2WorkerOutput {
  // Recovery and persistence paths mutate copies; deep-clone nested payloads so
  // cached state never aliases a live in-memory object.
  return {
    ...output,
    outputs: structuredClone(output.outputs),
    ...(output.evidence ? { evidence: [...output.evidence] } : {}),
    ...(output.risks ? { risks: [...output.risks] } : {}),
    ...(output.nextStepSuggestions ? { nextStepSuggestions: [...output.nextStepSuggestions] } : {}),
    proposals: structuredClone(output.proposals),
  };
}
