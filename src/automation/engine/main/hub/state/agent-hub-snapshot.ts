import type {
  AgentChannel,
  AgentTeam,
  ChatMessage,
  ChatSession,
  RuntimeConversation,
  TaskRun,
  TeamRun,
} from "../../../shared/types";
import { cloneAgentChannel } from "../chat/agent-hub-ui";
import { buildWorkflowSnapshot, cloneTeamMember } from "../team/agent-team-workflow";
import type { AgentTeamState, ChatState, TaskState, TeamRunState } from "./agent-hub-state";
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

export function serializeTeam(team: AgentTeamState): AgentTeam {
  return {
    id: team.id,
    name: team.name,
    mode: team.mode,
    sharedContext: team.sharedContext,
    members: team.members.map((member) => cloneTeamMember(member)),
    workflow: buildWorkflowSnapshot({ mode: team.mode, members: team.members }),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export function serializeTeamRun(run: TeamRunState): TeamRun {
  return {
    id: run.id,
    teamId: run.teamId,
    teamName: run.teamName,
    title: run.title,
    prompt: run.prompt,
    target: run.target ? { ...run.target } : undefined,
    mode: run.mode,
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    workDir: run.workDir,
    sharedContextSnapshot: run.sharedContextSnapshot,
    workflow: buildWorkflowSnapshot({
      mode: run.mode,
      members: run.membersSnapshot,
      steps: run.steps,
      runStatus: run.status,
    }),
    steps: run.steps.map((step) => ({ ...step })),
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function cloneChannels(channels: AgentChannel[]): AgentChannel[] {
  return channels.map((channel) => cloneAgentChannel(channel));
}
