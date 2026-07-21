import type { ChatMessage, ChatRuntimeSessionState } from "../../../shared/types";
import type { RuntimeCapabilities } from "../../agents/runtime/runtime-capabilities";
import type { ChatState } from "../state/agent-hub-state";

export interface ChatPromptResolvedAgent {
  agent: { id: string; name: string };
  runtimeAgentId: string;
  runtime: { available: boolean } | undefined;
}

export function failChatPromptStart(input: {
  chat: ChatState;
  lastError: string;
  message: string;
  createErrorMessage: (content: string) => ChatMessage;
  now?: number;
}): void {
  input.chat.messages.push(input.createErrorMessage(input.message));
  input.chat.lastError = input.lastError;
  input.chat.updatedAt = input.now ?? Date.now();
}

export function beginChatPrompt(input: {
  chat: ChatState;
  prompt: string;
  capabilities: RuntimeCapabilities | undefined;
  hasAgentConversationMessages: (messages: ChatMessage[]) => boolean;
  titleFromPrompt: (prompt: string) => string;
  createUserMessage: (content: string) => ChatMessage;
  createRuntimeState: (capabilities: RuntimeCapabilities) => ChatRuntimeSessionState;
  now?: number;
}): void {
  if (input.capabilities && !input.chat.runtimeState) {
    input.chat.runtimeState = input.createRuntimeState(input.capabilities);
  }
  if (!input.hasAgentConversationMessages(input.chat.messages)) {
    input.chat.title = input.titleFromPrompt(input.prompt);
  }
  input.chat.messages.push(input.createUserMessage(input.prompt));
  input.chat.running = true;
  input.chat.lastError = undefined;
  input.chat.pendingAssistantMessageId = undefined;
  input.chat.updatedAt = input.now ?? Date.now();
}

export function prepareChatPromptExecution<TResolved extends ChatPromptResolvedAgent>(input: {
  chat: ChatState;
  prompt: string;
  resolved: TResolved | undefined;
  capabilities: RuntimeCapabilities | undefined;
  hasAgentConversationMessages: (messages: ChatMessage[]) => boolean;
  titleFromPrompt: (prompt: string) => string;
  createUserMessage: (content: string) => ChatMessage;
  createErrorMessage: (content: string) => ChatMessage;
  createRuntimeState: (capabilities: RuntimeCapabilities) => ChatRuntimeSessionState;
  now?: number;
}): TResolved | undefined {
  if (!input.resolved) {
    failChatPromptStart({
      chat: input.chat,
      lastError: "No configured agent selected",
      message: "No configured agent is selected.",
      createErrorMessage: input.createErrorMessage,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return undefined;
  }
  if (!input.resolved.runtime?.available) {
    failChatPromptStart({
      chat: input.chat,
      lastError: `${input.resolved.runtimeAgentId} unavailable`,
      message: `${input.resolved.agent.name || input.resolved.agent.id} is not available on this machine.`,
      createErrorMessage: input.createErrorMessage,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return undefined;
  }
  beginChatPrompt({
    chat: input.chat,
    prompt: input.prompt,
    capabilities: input.capabilities,
    hasAgentConversationMessages: input.hasAgentConversationMessages,
    titleFromPrompt: input.titleFromPrompt,
    createUserMessage: input.createUserMessage,
    createRuntimeState: input.createRuntimeState,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return input.resolved;
}
