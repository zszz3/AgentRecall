import type { ChatEvent, ChatMessage } from "../../../shared/types";
import type { AgentTeamState, ChatState, TaskState, TeamRunState } from "../state/agent-hub-state";
import {
  asOptionalString,
  asRecord,
  type PersistedAppStateV5,
} from "./agent-hub-persistence";
import { restoreEvent, restoreMessage } from "../state/agent-hub-restore";

export interface RestoredPersistedCollections {
  chats: ChatState[];
  tasks: TaskState[];
  teams: AgentTeamState[];
  teamRuns: TeamRunState[];
}

export function selectRestoredActiveId<T extends { id: string }>(
  items: Iterable<T>,
  preferredId: string | undefined,
): string | undefined {
  const list = [...items];
  if (preferredId && list.some((item) => item.id === preferredId)) return preferredId;
  return list[0]?.id;
}

export function installRestoredMapItems<T extends { id: string }>(
  target: Map<string, T>,
  items: Iterable<T>,
): void {
  target.clear();
  for (const item of items) target.set(item.id, item);
}

export function installRestoredChats(input: {
  target: Map<string, ChatState>;
  chats: ChatState[];
  activeChatId: string | undefined;
  workDir: string | undefined;
  createDefaultChat: () => ChatState;
}): { activeChatId: string | undefined; workDir: string | undefined } {
  installRestoredMapItems(input.target, input.chats);
  if (input.target.size === 0) {
    const chat = input.createDefaultChat();
    input.target.set(chat.id, chat);
    return {
      activeChatId: chat.id,
      workDir: input.workDir,
    };
  }
  return {
    activeChatId: selectRestoredActiveId(input.target.values(), input.activeChatId),
    workDir: input.workDir,
  };
}

export function installRestoredTasks(input: {
  target: Map<string, TaskState>;
  tasks: TaskState[];
  activeTaskId: string | undefined;
}): string | undefined {
  installRestoredMapItems(input.target, input.tasks);
  return selectRestoredActiveId(input.target.values(), input.activeTaskId);
}

export function installRestoredTeams(input: {
  teamsTarget: Map<string, AgentTeamState>;
  teams: AgentTeamState[];
  activeTeamId: string | undefined;
  teamRunsTarget: Map<string, TeamRunState>;
  teamRuns: TeamRunState[];
  activeTeamRunId: string | undefined;
}): { activeTeamId: string | undefined; activeTeamRunId: string | undefined } {
  installRestoredMapItems(input.teamsTarget, input.teams);
  installRestoredMapItems(input.teamRunsTarget, input.teamRuns);
  return {
    activeTeamId: selectRestoredActiveId(input.teamsTarget.values(), input.activeTeamId),
    activeTeamRunId: selectRestoredActiveId(input.teamRunsTarget.values(), input.activeTeamRunId),
  };
}

export function restorePersistedMessageMap(input: {
  items: unknown[];
  ownerKey: "chatId" | "taskId";
  events: unknown[];
}): Map<string, ChatMessage[]> | undefined {
  const messagesByOwner = new Map<string, ChatMessage[]>();
  for (const item of input.items) {
    const messageRecord = asRecord(item);
    const ownerId = asOptionalString(messageRecord?.[input.ownerKey]);
    const message = messageRecord ? restoreMessage(messageRecord) : undefined;
    if (!ownerId || !message) continue;
    const messages = messagesByOwner.get(ownerId) ?? [];
    messages.push(message);
    messagesByOwner.set(ownerId, messages);
  }

  const eventsByMessage = new Map<string, ChatEvent[]>();
  for (const item of input.events) {
    const eventRecord = asRecord(item);
    const messageId = asOptionalString(eventRecord?.messageId);
    const event = eventRecord ? restoreEvent(eventRecord) : undefined;
    if (!messageId || !event) continue;
    const events = eventsByMessage.get(messageId) ?? [];
    events.push(event);
    eventsByMessage.set(messageId, events);
  }

  for (const messages of messagesByOwner.values()) {
    for (const message of messages) {
      const events = eventsByMessage.get(message.id);
      if (events && events.length > 0) message.events = events;
    }
  }
  return messagesByOwner;
}

export function restorePersistedCollections(
  record: PersistedAppStateV5 & Record<string, unknown>,
  deps: {
    restoreChatState: (raw: unknown) => ChatState | null;
    restoreTaskState: (raw: unknown) => TaskState | null;
    restoreTeamState: (raw: unknown) => AgentTeamState | null;
    restoreTeamRunState: (raw: unknown) => TeamRunState | null;
  },
): RestoredPersistedCollections | undefined {
  const messagesByChat = restorePersistedMessageMap({
    items: record.messages,
    ownerKey: "chatId",
    events: record.events,
  });
  if (!messagesByChat) return undefined;

  const messagesByTask = restorePersistedMessageMap({
    items: record.taskMessages ?? [],
    ownerKey: "taskId",
    events: record.taskEvents ?? [],
  });
  if (!messagesByTask) return undefined;

  const chats: ChatState[] = [];
  for (const item of record.sessions) {
    const sessionRecord = asRecord(item);
    const chatId = asOptionalString(sessionRecord?.id);
    if (!sessionRecord || !chatId) continue;
    const chat = deps.restoreChatState({
      ...sessionRecord,
      messages: messagesByChat.get(chatId) ?? [],
    });
    if (!chat) continue;
    chats.push(chat);
  }

  const tasks: TaskState[] = [];
  for (const item of record.tasks ?? []) {
    const taskRecord = asRecord(item);
    const taskId = asOptionalString(taskRecord?.id);
    if (!taskRecord || !taskId) continue;
    const task = deps.restoreTaskState({
      ...taskRecord,
      messages: messagesByTask.get(taskId) ?? [],
    });
    if (!task) continue;
    tasks.push(task);
  }

  const teams = (record.teams ?? []).map((item) => deps.restoreTeamState(item));
  const validTeams = teams.filter((item): item is AgentTeamState => Boolean(item));
  const teamRuns = (record.teamRuns ?? []).map((item) => deps.restoreTeamRunState(item));
  const validTeamRuns = teamRuns.filter((item): item is TeamRunState => Boolean(item));

  return {
    chats,
    tasks,
    teams: validTeams,
    teamRuns: validTeamRuns,
  };
}
