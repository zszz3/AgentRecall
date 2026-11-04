import { randomUUID } from "node:crypto";
import type { ChatEvent, ChatMessage } from "../../../shared/types";
import {
  asNumber,
  asOptionalString,
  asRecord,
  isAgentId,
  isApprovalDecision,
  isChatEventType,
  isInteractionRequestState,
  isMessageRole,
} from "../persisted/agent-hub-persistence";
import { createAssistantMessage } from "../chat/agent-hub-ui";

export function restoreEvent(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isChatEventType(record.type) || typeof record.content !== "string") return null;
  const event: ChatEvent = {
    id: asOptionalString(record.id) ?? randomUUID(),
    type: record.type,
    content: record.content,
    timestamp: asNumber(record.timestamp, Date.now()),
  };
  if (isAgentId(record.agentId)) event.agentId = record.agentId;
  const name = asOptionalString(record.name);
  if (name) event.name = name;
  if (isAgentId(record.fromAgentId)) event.fromAgentId = record.fromAgentId;
  if (isAgentId(record.toAgentId)) event.toAgentId = record.toAgentId;
  const requestId = asOptionalString(record.requestId);
  if (requestId) event.requestId = requestId;
  if (isInteractionRequestState(record.requestState)) event.requestState = record.requestState;
  if (isApprovalDecision(record.decision)) event.decision = record.decision;
  const metadata = asRecord(record.metadata);
  if (metadata) event.metadata = metadata;
  return event;
}

export function restoreMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isMessageRole(record.role) || typeof record.content !== "string") return null;
  const message: ChatMessage = {
    id: asOptionalString(record.id) ?? randomUUID(),
    role: record.role,
    content: record.content,
    timestamp: asNumber(record.timestamp, Date.now()),
  };
  if (record.local === true) message.local = true;
  if (Array.isArray(record.events)) {
    const events = record.events.map((event) => restoreEvent(event)).filter((event): event is ChatEvent => Boolean(event));
    if (events.length > 0) message.events = events;
  }
  return message;
}

export function normalizeRestoredMessages(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "meta") {
      normalized.push(message);
      continue;
    }

    const event: ChatEvent = {
      id: message.id,
      type: "meta",
      content: message.content,
      timestamp: message.timestamp,
    };
    let target = [...normalized].reverse().find((item) => item.role === "assistant");
    if (!target) {
      target = createAssistantMessage();
      target.timestamp = message.timestamp;
      normalized.push(target);
    }
    target.events = [...(target.events ?? []), event];
  }
  return normalized;
}
