import type { ChatState } from "../state/agent-hub-state";

export function resetChatRuntimeSessionState(chat: ChatState, now?: number): void {
  chat.runtimeConversation = undefined;
  if (chat.runtimeState) {
    chat.runtimeState.attachmentState = "detached";
    chat.runtimeState.attachmentGeneration = 0;
    delete chat.runtimeState.activeTurnId;
  }
  chat.updatedAt = now ?? Date.now();
}

export function applyChatConfiguredAgent(input: {
  chat: ChatState;
  configuredAgentId: string;
  configuredAgentLabel: string;
  configuredAgentModelId: string;
  normalizeModelId: (configuredAgentId: string, modelId: string | undefined, channelIdOverride?: string) => string;
  hasAgentConversationMessages: (messages: ChatState["messages"]) => boolean;
  currentRuntimeAgentId: string | undefined;
  nextRuntimeAgentId: string | undefined;
  now?: number;
}): { resetRuntimeSession: boolean } {
  input.chat.configuredAgentId = input.configuredAgentId;
  input.chat.channelId = undefined;
  input.chat.modelId = input.normalizeModelId(input.configuredAgentId, input.configuredAgentModelId, input.chat.channelId);
  if (!input.hasAgentConversationMessages(input.chat.messages)) {
    input.chat.title = input.configuredAgentLabel;
  }
  const resetRuntimeSession =
    input.currentRuntimeAgentId !== input.nextRuntimeAgentId
    && Boolean(input.chat.runtimeConversation || input.chat.runtimeState || input.hasAgentConversationMessages(input.chat.messages));
  input.chat.updatedAt = input.now ?? Date.now();
  return { resetRuntimeSession };
}

export function switchChatConfiguredAgent(input: {
  chat: ChatState;
  configuredAgentId: string;
  configuredAgentLabel: string;
  configuredAgentModelId: string;
  normalizeModelId: (configuredAgentId: string, modelId: string | undefined, channelIdOverride?: string) => string;
  hasAgentConversationMessages: (messages: ChatState["messages"]) => boolean;
  currentRuntimeAgentId: string | undefined;
  nextRuntimeAgentId: string | undefined;
  onResetRuntimeSession: () => void;
  now?: number;
}): void {
  const applied = applyChatConfiguredAgent({
    chat: input.chat,
    configuredAgentId: input.configuredAgentId,
    configuredAgentLabel: input.configuredAgentLabel,
    configuredAgentModelId: input.configuredAgentModelId,
    normalizeModelId: input.normalizeModelId,
    hasAgentConversationMessages: input.hasAgentConversationMessages,
    currentRuntimeAgentId: input.currentRuntimeAgentId,
    nextRuntimeAgentId: input.nextRuntimeAgentId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (applied.resetRuntimeSession) {
    resetChatRuntimeSessionState(input.chat, input.now);
    input.onResetRuntimeSession();
  }
}
