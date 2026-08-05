export interface CollaborationMessageMetadata {
  author: string;
  recipient: string;
  direction: "incoming" | "outgoing" | "unknown";
  triggerTurn: boolean | null;
  messageType: "new_task" | "message" | "final_answer" | "unknown";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function collaborationMessageMetadata(
  attributes: Record<string, unknown> | undefined,
): CollaborationMessageMetadata | null {
  const collaboration = record(attributes?.collaboration);
  if (!collaboration) return null;
  const direction = collaboration.direction;
  const messageType = collaboration.messageType;
  return {
    author: typeof collaboration.author === "string" ? collaboration.author : "",
    recipient: typeof collaboration.recipient === "string" ? collaboration.recipient : "",
    direction: direction === "incoming" || direction === "outgoing" ? direction : "unknown",
    triggerTurn: typeof collaboration.triggerTurn === "boolean" ? collaboration.triggerTurn : null,
    messageType: messageType === "new_task" || messageType === "message" || messageType === "final_answer"
      ? messageType
      : "unknown",
  };
}
