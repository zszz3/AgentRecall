import type {
  AgentChannel,
  ConfiguredAgent,
  RegisteredArtifact,
  RuntimeConversation,
  ScheduledWorkflowStoreState,
  WorkflowStoreState,
} from "../../../shared/types";
import {
  cloneAgentChannel,
} from "../chat/agent-hub-ui";
import type { ChatState, TaskState } from "../state/agent-hub-state";
import type { WorkflowNodeConversation } from "../../../shared/workflow-v2/conversation";
import {
  cloneRuntimeState,
  type PersistedAppStateV5,
  type PersistedChatEventRecord,
  type PersistedChatMessageRecord,
  type PersistedChatSessionRecord,
  type PersistedTaskEventRecord,
  type PersistedTaskMessageRecord,
  type PersistedTaskRunRecord,
} from "./agent-hub-persistence";

export function buildPersistedPayload(input: {
  activeChatId: string | undefined;
  activeTaskId: string | undefined;
  workDir: string;
  channels: AgentChannel[];
  chats: Iterable<ChatState>;
  tasks: Iterable<TaskState>;
  configuredAgents: ConfiguredAgent[];
  deletedConfiguredAgentIds: string[];
  artifacts: RegisteredArtifact[];
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  workflowStore: WorkflowStoreState;
  scheduledWorkflowStore: ScheduledWorkflowStoreState;
  workflowNodeConversations: WorkflowNodeConversation[];
}): PersistedAppStateV5 {
  const sessions: PersistedChatSessionRecord[] = [];
  const messages: PersistedChatMessageRecord[] = [];
  const events: PersistedChatEventRecord[] = [];
  const tasks: PersistedTaskRunRecord[] = [];
  const taskMessages: PersistedTaskMessageRecord[] = [];
  const taskEvents: PersistedTaskEventRecord[] = [];

  for (const chat of input.chats) {
    sessions.push({
      id: chat.id,
      title: chat.title,
      configuredAgentId: chat.configuredAgentId,
      modelId: chat.modelId,
      ...(chat.channelId ? { channelId: chat.channelId } : {}),
      ...(chat.runtimeState ? { runtimeState: cloneRuntimeState(chat.runtimeState) } : {}),
      ...(chat.runtimeConversation ? { runtimeConversation: input.cloneConversation(chat.runtimeConversation) } : {}),
      lastError: chat.lastError,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    });
    for (const message of chat.messages) {
      messages.push({
        id: message.id,
        chatId: chat.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.local ? { local: true } : {}),
      });
      for (const event of message.events ?? []) {
        events.push({
          ...event,
          chatId: chat.id,
          messageId: message.id,
        });
      }
    }
  }

  for (const task of input.tasks) {
    tasks.push({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      ...(task.developerInstructions ? { developerInstructions: task.developerInstructions } : {}),
      ...(task.contextDocument ? { contextDocument: task.contextDocument } : {}),
      configuredAgentId: task.configuredAgentId,
      modelId: task.modelId,
      workDir: task.workDir,
      status: task.status,
      progress: task.progress,
      ...(task.runtimeConversation ? { runtimeConversation: input.cloneConversation(task.runtimeConversation) } : {}),
      lastError: task.lastError,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    for (const message of task.messages) {
      taskMessages.push({
        id: message.id,
        taskId: task.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.local ? { local: true } : {}),
      });
      for (const event of message.events ?? []) {
        taskEvents.push({
          ...event,
          taskId: task.id,
          messageId: message.id,
        });
      }
    }
  }

  void input.artifacts;

  return {
    version: 5,
    activeChatId: input.activeChatId ?? null,
    activeTaskId: input.activeTaskId ?? null,
    workDir: input.workDir,
    channels: input.channels.map((channel) => cloneAgentChannel(channel)),
    sessions,
    messages,
    events,
    tasks,
    taskMessages,
    taskEvents,
    configuredAgents: input.configuredAgents,
    deletedConfiguredAgentIds: input.deletedConfiguredAgentIds,
    workflowStore: input.workflowStore,
    scheduledWorkflowStore: input.scheduledWorkflowStore,
    workflowNodeConversations: input.workflowNodeConversations.map((conversation) => structuredClone(conversation)),
  };
}
