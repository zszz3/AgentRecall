import type {
  AgentId,
  ChatMessage,
  ChatRuntimeSessionState,
  RuntimeExecutionMode,
} from "../../../shared/types";
import type { RuntimeCapabilities } from "../../agents/runtime/runtime-capabilities";
import type { RuntimeSurface } from "../../agents/runtime/runtime-driver";
import type { ChatState } from "../state/agent-hub-state";
import {
  prepareChatPromptExecution,
  type ChatPromptResolvedAgent,
} from "./agent-hub-chat-prompt";

export async function dispatchChatPromptExecution<
  TResolved extends ChatPromptResolvedAgent & { runtimeAgentId: AgentId },
>(input: {
  chat: ChatState;
  prompt: string;
  resolveConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ) => TResolved | undefined;
  selectExecutionMode: (
    runtimeId: AgentId,
    surface: RuntimeSurface,
    preferred: RuntimeExecutionMode,
  ) => RuntimeExecutionMode;
  capabilitiesForRuntime: (runtime: NonNullable<TResolved["runtime"]>) => RuntimeCapabilities;
  hasAgentConversationMessages: (messages: ChatMessage[]) => boolean;
  titleFromPrompt: (prompt: string) => string;
  createUserMessage: (content: string) => ChatMessage;
  createErrorMessage: (content: string) => ChatMessage;
  createRuntimeState: (capabilities: RuntimeCapabilities) => ChatRuntimeSessionState;
  activateChat: (chatId: string) => void;
  emit: () => void;
  dispatchInteractivePrompt: (chat: ChatState, prompt: string, resolved: TResolved) => Promise<void>;
  run: (chat: ChatState, prompt: string, resolved: TResolved) => void;
}): Promise<void> {
  const resolved = input.resolveConfiguredAgent(
    input.chat.configuredAgentId,
    input.chat.modelId,
    input.chat.channelId,
  );
  const supportsInteractiveChat = resolved
    ? input.selectExecutionMode(resolved.runtimeAgentId, "chat", "interactive") === "interactive"
    : false;
  const capabilities =
    resolved?.runtime && supportsInteractiveChat
      ? input.capabilitiesForRuntime(resolved.runtime as NonNullable<TResolved["runtime"]>)
      : undefined;
  const preparedResolved = prepareChatPromptExecution({
    chat: input.chat,
    prompt: input.prompt,
    resolved,
    capabilities,
    hasAgentConversationMessages: input.hasAgentConversationMessages,
    titleFromPrompt: input.titleFromPrompt,
    createUserMessage: input.createUserMessage,
    createErrorMessage: input.createErrorMessage,
    createRuntimeState: input.createRuntimeState,
  });
  if (!preparedResolved) {
    input.emit();
    return;
  }
  input.activateChat(input.chat.id);
  input.emit();

  if (supportsInteractiveChat) {
    await input.dispatchInteractivePrompt(input.chat, input.prompt, preparedResolved);
    return;
  }

  input.run(input.chat, input.prompt, preparedResolved);
}

export async function dispatchSlashChatPrompt(input: {
  chat: ChatState;
  prompt: string;
  createUserMessage: (content: string, hidden?: boolean) => ChatMessage;
  createAssistantMessage: (content: string, hidden?: boolean) => ChatMessage;
  activateChat: (chatId: string) => void;
  emit: () => void;
  runSlashCommand: (chat: ChatState, prompt: string) => Promise<string>;
  now?: number;
}): Promise<void> {
  input.chat.messages.push(input.createUserMessage(input.prompt, true));
  input.chat.lastError = undefined;
  input.chat.updatedAt = input.now ?? Date.now();
  input.activateChat(input.chat.id);
  input.emit();

  const content = await input.runSlashCommand(input.chat, input.prompt);
  input.chat.messages.push(input.createAssistantMessage(content, true));
  input.chat.updatedAt = input.now ?? Date.now();
  input.emit();
}
