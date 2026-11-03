import type {
  AgentChannel,
  ChatMessage,
  ChatSession,
  RuntimeConversation,
  TaskRun,
} from "../../../shared/types";
import { cloneAgentChannel } from "../chat/agent-hub-ui";
import type { ChatState, TaskState } from "./agent-hub-state";
import { cloneRuntimeState } from "../persisted/agent-hub-persistence";

export function serializeMessage(message: ChatMessage): ChatMessage {
  const copy: ChatMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  };
  if (message.events && message.events.length > 0) {
    copy.events = message.events.map((event) => ({ ...event }));
  }
  if (message.local) copy.local = true;
  return copy;
}

export function serializeChat(input: {
  chat: ChatState;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
}): ChatSession {
  const { chat, cloneConversation } = input;
  return {
    id: chat.id,
    title: chat.title,
    configuredAgentId: chat.configuredAgentId,
    modelId: chat.modelId,
    ...(chat.channelId ? { channelId: chat.channelId } : {}),
    ...(chat.runtimeState ? { runtimeState: cloneRuntimeState(chat.runtimeState) } : {}),
    ...(chat.runtimeConversation ? { runtimeConversation: cloneConversation(chat.runtimeConversation) } : {}),
    running: chat.running,
    messages: chat.messages.map((message) => serializeMessage(message)),
    pendingAssistantMessageId: chat.pendingAssistantMessageId,
    lastError: chat.lastError,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

export function serializeTask(input: {
  task: TaskState;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
}): TaskRun {
  const { task, cloneConversation } = input;
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    configuredAgentId: task.configuredAgentId,
    modelId: task.modelId,
    workDir: task.workDir,
    status: task.status,
    progress: task.progress,
    running: task.running,
    ...(task.runtimeConversation ? { runtimeConversation: cloneConversation(task.runtimeConversation) } : {}),
    ...(task.usage ? { usage: { ...task.usage } } : {}),
    messages: task.messages.map((message) => serializeMessage(message)),
    pendingAssistantMessageId: task.pendingAssistantMessageId,
    lastError: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function cloneChannels(channels: AgentChannel[]): AgentChannel[] {
  return channels.map((channel) => cloneAgentChannel(channel));
}
