import { randomUUID } from "node:crypto";
import type { AgentEvent, ChatEvent, ChatMessage, ChatRuntimeSessionState, RuntimeConversation } from "../../../shared/types";
import type { ChatState } from "../state/agent-hub-state";
import { createAssistantMessage, createErrorMessage } from "./agent-hub-ui";

export function appendEventToAssistant(run: ChatState, event: ChatEvent): void {
  let message = run.pendingAssistantMessageId
    ? run.messages.find((item) => item.id === run.pendingAssistantMessageId && item.role === "assistant")
    : undefined;

  if (!message) {
    message = [...run.messages].reverse().find((item) => item.role === "assistant");
  }

  if (!message) {
    message = createAssistantMessage();
    run.pendingAssistantMessageId = message.id;
    run.messages.push(message);
  }

  message.events = [...(message.events ?? []), event];
}

export function resolvePendingRequest(
  run: ChatState,
  requestId: string,
  type: "approval_request" | "user_input_request",
): void {
  for (const message of [...run.messages].reverse()) {
    const existing = [...(message.events ?? [])]
      .reverse()
      .find((item) => item.type === type && item.requestId === requestId && item.requestState === "live");
    if (existing) {
      existing.requestState = "resolved";
      return;
    }
  }
}

export function expirePendingInteractionEvents(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.events
      ? {
          events: message.events.map((event) =>
            event.type === "approval_request" || event.type === "user_input_request"
              ? event.requestState === "live"
                ? { ...event, requestState: "expired" as const }
                : event
              : event,
          ),
        }
      : {}),
  }));
}

export function handleAgentEvent(input: {
  run: ChatState;
  event: AgentEvent;
  cloneConversation: (runtimeConversation: RuntimeConversation) => RuntimeConversation;
  takeStop: (runId: string) => (() => Promise<void> | void) | undefined;
  emit: () => void;
}): void {
  const { run, event } = input;
  const runtimeState = run.runtimeState;
  const touchRuntimeState = (attachmentState: ChatRuntimeSessionState["attachmentState"], clearTurn = false): void => {
    if (!runtimeState) return;
    runtimeState.attachmentState = attachmentState;
    runtimeState.lastMeaningfulActivityAt = Date.now();
    if (clearTurn) delete runtimeState.activeTurnId;
  };

  if (event.type === "runtime_conversation") {
    run.runtimeConversation = input.cloneConversation(event.runtimeConversation);
    if (runtimeState) {
      runtimeState.lastMeaningfulActivityAt = Date.now();
    }
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "usage") {
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "delta") {
    touchRuntimeState("running");
    if (!run.pendingAssistantMessageId) {
      const message = createAssistantMessage(event.content);
      run.pendingAssistantMessageId = message.id;
      run.messages.push(message);
    } else {
      const message = run.messages.find((item) => item.id === run.pendingAssistantMessageId);
      if (message) message.content += event.content;
    }
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "meta" || event.type === "system" || event.type === "tool_call" || event.type === "tool_result" || event.type === "handoff") {
    touchRuntimeState("running");
    appendEventToAssistant(run, {
      id: randomUUID(),
      type: event.type,
      content: event.content,
      timestamp: Date.now(),
      ...("name" in event && event.name ? { name: event.name } : {}),
      ...("fromAgentId" in event && event.fromAgentId ? { fromAgentId: event.fromAgentId } : {}),
      ...("toAgentId" in event && event.toAgentId ? { toAgentId: event.toAgentId } : {}),
      ...(event.invocationId ? { invocationId: event.invocationId } : {}),
      ...("metadata" in event && event.metadata ? { metadata: event.metadata } : {}),
    });
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "approval_request" || event.type === "user_input_request") {
    touchRuntimeState("running");
    appendEventToAssistant(run, {
      id: randomUUID(),
      type: event.type,
      content: event.content,
      requestId: event.requestId,
      requestState: "live",
      timestamp: Date.now(),
      ...(event.invocationId ? { invocationId: event.invocationId } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "approval_response" || event.type === "user_input_response") {
    touchRuntimeState("running");
    resolvePendingRequest(run, event.requestId, event.type === "approval_response" ? "approval_request" : "user_input_request");
    appendEventToAssistant(run, {
      id: randomUUID(),
      type: event.type,
      content: event.content ?? "",
      requestId: event.requestId,
      timestamp: Date.now(),
      ...(event.type === "approval_response" ? { decision: event.decision } : {}),
      ...(event.invocationId ? { invocationId: event.invocationId } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
    run.updatedAt = Date.now();
    input.emit();
    return;
  }

  if (event.type === "completed") {
    touchRuntimeState("idle", true);
    if (event.content && !run.pendingAssistantMessageId) {
      run.messages.push(createAssistantMessage(event.content));
    }
    run.pendingAssistantMessageId = undefined;
    run.running = false;
    run.updatedAt = Date.now();
    const stop = input.takeStop(run.id);
    void stop?.();
    input.emit();
    return;
  }

  if (event.type === "error") {
    touchRuntimeState("interrupted", true);
    run.lastError = event.error;
    run.messages.push(createErrorMessage(event.error));
    run.pendingAssistantMessageId = undefined;
    run.running = false;
    run.updatedAt = Date.now();
    const stop = input.takeStop(run.id);
    void stop?.();
    input.emit();
  }
}

export function markRunExited(run: ChatState): void {
  run.running = false;
}

export function markRunFailed(input: {
  run: ChatState;
  error: string;
  takeStop: (runId: string) => (() => Promise<void> | void) | undefined;
  emit: () => void;
}): void {
  input.run.running = false;
  input.run.lastError = input.error;
  input.run.messages.push(createErrorMessage(input.error));
  input.run.updatedAt = Date.now();
  const stop = input.takeStop(input.run.id);
  void stop?.();
  input.emit();
}
