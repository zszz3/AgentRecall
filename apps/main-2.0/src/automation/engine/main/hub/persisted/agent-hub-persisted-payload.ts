import type {
  AgentChannel,
  ConfiguredAgent,
  RuntimeConversation,
} from "../../../shared/types";
import {
  cloneAgentChannel,
} from "../chat/agent-hub-ui";
import type { ChatState } from "../state/agent-hub-state";
import {
  cloneRuntimeState,
  type PersistedAppStateV5,
  type PersistedChatEventRecord,
  type PersistedChatMessageRecord,
  type PersistedChatSessionRecord,
} from "./agent-hub-persistence";

export function buildPersistedPayload(input: {
  activeChatId: string | undefined;
  workDir: string;
  channels: AgentChannel[];
  chats: Iterable<ChatState>;
  configuredAgents: ConfiguredAgent[];
  deletedConfiguredAgentIds: string[];
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
}): PersistedAppStateV5 {
  const sessions: PersistedChatSessionRecord[] = [];
  const messages: PersistedChatMessageRecord[] = [];
  const events: PersistedChatEventRecord[] = [];

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

  return {
    version: 5,
    activeChatId: input.activeChatId ?? null,
    workDir: input.workDir,
    channels: input.channels.map((channel) => cloneAgentChannel(channel)),
    sessions,
    messages,
    events,
    tasks: [],
    taskMessages: [],
    taskEvents: [],
    teams: [],
    teamRuns: [],
    activeTeamId: null,
    activeTeamRunId: null,
    configuredAgents: input.configuredAgents,
    deletedConfiguredAgentIds: input.deletedConfiguredAgentIds,
  };
}
