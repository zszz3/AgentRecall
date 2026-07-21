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
import { buildWorkflowSnapshot, cloneTeamMember } from "../team/agent-team-workflow";
import type { AgentTeamState, ChatState, TaskState, TeamRunState } from "../state/agent-hub-state";
import type { WorkflowNodeConversation } from "../../../shared/workflow-v2/conversation";
import {
  cloneRuntimeState,
  type PersistedAppStateV5,
  type PersistedAgentTeamRecord,
  type PersistedChatEventRecord,
  type PersistedChatMessageRecord,
  type PersistedChatSessionRecord,
  type PersistedTaskEventRecord,
  type PersistedTaskMessageRecord,
  type PersistedTaskRunRecord,
  type PersistedTeamRunRecord,
} from "./agent-hub-persistence";

export function buildPersistedPayload(input: {
  activeChatId: string | undefined;
  activeTaskId: string | undefined;
  activeTeamId: string | undefined;
  activeTeamRunId: string | undefined;
  workDir: string;
  channels: AgentChannel[];
  chats: Iterable<ChatState>;
  tasks: Iterable<TaskState>;
  teams: Iterable<AgentTeamState>;
  teamRuns: Iterable<TeamRunState>;
  configuredAgents: ConfiguredAgent[];
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
  const teams: PersistedAgentTeamRecord[] = [];
  const teamRuns: PersistedTeamRunRecord[] = [];

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

  for (const team of input.teams) {
    teams.push({
      id: team.id,
      name: team.name,
      mode: team.mode,
      sharedContext: team.sharedContext,
      members: team.members.map((member) => cloneTeamMember(member)),
      workflow: buildWorkflowSnapshot({ mode: team.mode, members: team.members }),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    });
  }

  for (const run of input.teamRuns) {
    teamRuns.push({
      id: run.id,
      teamId: run.teamId,
      teamName: run.teamName,
      title: run.title,
      prompt: run.prompt,
      membersSnapshot: run.membersSnapshot.map((member) => cloneTeamMember(member)),
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
    });
  }

  void input.artifacts;

  return {
    version: 5,
    activeChatId: input.activeChatId ?? null,
    activeTaskId: input.activeTaskId ?? null,
    activeTeamId: input.activeTeamId ?? null,
    activeTeamRunId: input.activeTeamRunId ?? null,
    workDir: input.workDir,
    channels: input.channels.map((channel) => cloneAgentChannel(channel)),
    sessions,
    messages,
    events,
    tasks,
    taskMessages,
    taskEvents,
    teams,
    teamRuns,
    configuredAgents: input.configuredAgents,
    workflowStore: input.workflowStore,
    scheduledWorkflowStore: input.scheduledWorkflowStore,
    workflowNodeConversations: input.workflowNodeConversations.map((conversation) => structuredClone(conversation)),
  };
}
