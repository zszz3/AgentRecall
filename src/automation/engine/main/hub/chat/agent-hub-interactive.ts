import type {
  AgentId,
  AgentRuntime,
  ChatRuntimeSessionState,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
} from "../../../shared/types";
import { InteractiveSessionManager } from "../../agents/runtime/interactive-session-manager";
import type { RuntimeCapabilities } from "../../agents/runtime/runtime-capabilities";
import type {
  InteractiveSessionContext,
  InteractiveSessionSnapshot,
  RuntimeSurface,
} from "../../agents/runtime/runtime-driver";
import { cloneRuntimeState } from "../persisted/agent-hub-persistence";
import type { ChatState } from "../state/agent-hub-state";

export interface ResolvedConfiguredAgentForInteractive {
  runtimeAgentId: AgentId;
  modelId: string;
  reasoningEffort?: string;
  runtime: AgentRuntime | undefined;
  channel: { id: string };
}

export function runtimeStateFromCapabilities(capabilities: RuntimeCapabilities): ChatRuntimeSessionState {
  return {
    executionStyle: capabilities.chatStyle,
    attachmentState: "detached",
    attachmentGeneration: 0,
    capabilities: {
      ...capabilities.resume,
      supportsInterrupt: capabilities.supportsInterrupt,
      supportsContinue: capabilities.supportsContinue,
      supportsApprovalRequests: capabilities.supportsApprovalRequests,
      supportsUserInputRequests: capabilities.supportsUserInputRequests,
    },
  };
}

export function syncInteractiveChatState(input: {
  chat: ChatState;
  state: InteractiveSessionSnapshot;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  now?: number;
}): void {
  input.chat.runtimeState = cloneRuntimeState(input.state.runtimeState);
  input.chat.runtimeConversation = input.state.runtimeConversation
    ? input.cloneConversation(input.state.runtimeConversation)
    : undefined;
  input.chat.updatedAt = input.now ?? Date.now();
}

export function buildInteractiveChatContext(input: {
  chat: ChatState;
  resolved: ResolvedConfiguredAgentForInteractive;
  workDir: string;
  developerInstructions: string;
  selectExecutionMode: (
    runtimeId: AgentId,
    surface: RuntimeSurface,
    preferred: RuntimeExecutionMode,
  ) => RuntimeExecutionMode;
  defaultContinuationPolicy: (
    runtimeId: AgentId,
    surface: RuntimeSurface,
    executionMode: RuntimeExecutionMode,
  ) => RuntimeContinuationPolicy;
  cloneConversationForPolicy: (
    continuationPolicy: RuntimeContinuationPolicy,
    runtimeConversation: RuntimeConversation | undefined,
  ) => RuntimeConversation | undefined;
  emit: InteractiveSessionContext["emit"];
  syncState: (state: InteractiveSessionSnapshot) => void;
}): InteractiveSessionContext {
  const executionMode = input.selectExecutionMode(input.resolved.runtimeAgentId, "chat", "interactive");
  const continuationPolicy = input.defaultContinuationPolicy(input.resolved.runtimeAgentId, "chat", executionMode);
  const runtimeConversation = input.cloneConversationForPolicy(continuationPolicy, input.chat.runtimeConversation);
  return {
    chatId: input.chat.id,
    configuredAgentId: input.chat.configuredAgentId,
    runtimeId: input.resolved.runtimeAgentId,
    executionMode,
    continuationPolicy,
    runtimeConfig: {
      model: input.resolved.modelId,
      ...(input.resolved.reasoningEffort ? { reasoningEffort: input.resolved.reasoningEffort } : {}),
    },
    ...(runtimeConversation ? { runtimeConversation } : {}),
    runtime: input.resolved.runtime as AgentRuntime,
    channelId: input.resolved.channel.id,
    workDir: input.workDir,
    developerInstructions: input.developerInstructions,
    emit: input.emit,
    syncState: input.syncState,
  };
}

export async function dispatchInteractiveChatPrompt(input: {
  chat: ChatState;
  prompt: string;
  interactiveSessions: Pick<InteractiveSessionManager, "dispatch" | "getOrCreate" | "interrupt">;
  buildContext: () => InteractiveSessionContext;
  syncInteractiveChatState: (chat: ChatState, state: InteractiveSessionSnapshot) => void;
  registerStop: (stop: () => Promise<void>) => void;
  markRunFailed: (chat: ChatState, error: string) => void;
}): Promise<void> {
  let session: ReturnType<InteractiveSessionManager["getOrCreate"]> | undefined;
  try {
    const context = input.buildContext();
    session = input.interactiveSessions.getOrCreate(input.chat.id, context);
    const interactiveSession = session;
    input.syncInteractiveChatState(input.chat, interactiveSession.snapshot());
    input.registerStop(async () => {
      if (!input.chat.running) return;
      await input.interactiveSessions.interrupt(input.chat.id);
      input.syncInteractiveChatState(input.chat, interactiveSession.snapshot());
    });
    await input.interactiveSessions.dispatch(input.chat.id, context, async (managed, lease) => {
      await managed.ensureAttached();
      const attachedState = managed.snapshot();
      lease.syncAttachmentGeneration(attachedState.runtimeState.attachmentGeneration);
      input.syncInteractiveChatState(input.chat, attachedState);
      await managed.sendPrompt(input.prompt);
      input.syncInteractiveChatState(input.chat, managed.snapshot());
    });
  } catch (error) {
    if (session) input.syncInteractiveChatState(input.chat, session.snapshot());
    input.markRunFailed(input.chat, error instanceof Error ? error.message : String(error));
  }
}
