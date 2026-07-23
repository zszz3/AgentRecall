import { randomUUID } from "node:crypto";
import type {
  AgentTeamMember,
  AgentTeamMode,
  AgentWorkflowTarget,
  ChatMessage,
  ChatRuntimeSessionState,
  RuntimeConversation,
  RuntimeContinuationPolicy,
  RuntimeUsage,
  TaskProgress,
  TaskRunStatus,
  TeamRunStatus,
  TeamRunStep,
} from "../../../shared/types";
import { titleFromPrompt } from "../chat/agent-hub-ui";
import { cloneTeamMember } from "../team/agent-team-workflow";

export class ChatState {
  readonly kind = "chat";
  id: string = randomUUID();
  title: string;
  channelId: string | undefined = undefined;
  runtimeState: ChatRuntimeSessionState | undefined = undefined;
  runtimeConversation: RuntimeConversation | undefined = undefined;
  developerInstructions: string | undefined = undefined;
  contextDocument: string | undefined = undefined;
  running = false;
  messages: ChatMessage[] = [];
  pendingAssistantMessageId: string | undefined = undefined;
  lastError: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public configuredAgentId: string,
    public modelId: string,
    title = "New Chat",
  ) {
    this.title = title;
  }
}

export class TaskState {
  readonly kind = "task";
  id: string = randomUUID();
  title: string;
  runtimeConversation: RuntimeConversation | undefined = undefined;
  usage: RuntimeUsage | undefined = undefined;
  planningWorkflowId: string | undefined = undefined;
  workflowRunId: string | undefined = undefined;
  workflowNodeId: string | undefined = undefined;
  developerInstructions: string | undefined = undefined;
  contextDocument: string | undefined = undefined;
  continuationPolicy: RuntimeContinuationPolicy = "fresh";
  running = false;
  status: TaskRunStatus = "queued";
  progress: TaskProgress = "todo";
  messages: ChatMessage[] = [];
  pendingAssistantMessageId: string | undefined = undefined;
  lastError: string | undefined = undefined;
  teamRunId: string | undefined = undefined;
  teamStepId: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public prompt: string,
    public configuredAgentId: string,
    public modelId: string,
    public workDir: string,
  ) {
    this.title = titleFromPrompt(prompt);
  }
}

export class AgentTeamState {
  id: string = randomUUID();
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public name: string,
    public mode: AgentTeamMode,
    public sharedContext: string,
    public members: AgentTeamMember[],
  ) {}
}

export class TeamRunState {
  id: string = randomUUID();
  title: string;
  status: TeamRunStatus = "queued";
  currentStepIndex = 0;
  steps: TeamRunStep[];
  membersSnapshot: AgentTeamMember[];
  lastError: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;
  teamId: string;
  teamName: string;
  mode: AgentTeamMode;
  sharedContextSnapshot: string;

  constructor(
    team: AgentTeamState,
    public prompt: string,
    public target: AgentWorkflowTarget | undefined,
    public workDir: string,
  ) {
    this.teamId = team.id;
    this.teamName = team.name;
    this.mode = team.mode;
    this.sharedContextSnapshot = team.sharedContext;
    this.membersSnapshot = team.members.map((member) => cloneTeamMember(member));
    this.title = titleFromPrompt(prompt);
    this.steps = this.createSteps(team);
  }

  private createSteps(team: AgentTeamState): TeamRunStep[] {
    const memberSteps: TeamRunStep[] = team.members.map((member): TeamRunStep => ({
      id: randomUUID(),
      teamMemberId: member.id,
      roleName: member.roleName,
      prompt: member.prompt,
      configuredAgentId: member.configuredAgentId,
      status: "queued",
      taskId: undefined,
      artifact: undefined,
      lastError: undefined,
      startedAt: undefined,
      completedAt: undefined,
    }));
    if (team.mode !== "supervisor" || memberSteps.length <= 1) return memberSteps;

    const supervisor = team.members[0];
    if (!supervisor) return memberSteps;
    return [
      memberSteps[0]!,
      ...memberSteps.slice(1),
      {
        id: randomUUID(),
        teamMemberId: `${supervisor.id}:synthesis`,
        roleName: `${supervisor.roleName} Synthesis`,
        prompt: `${supervisor.prompt}\n\nSynthesize worker artifacts into a final coordinated answer.`,
        configuredAgentId: supervisor.configuredAgentId,
        status: "queued",
        taskId: undefined,
        artifact: undefined,
        lastError: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ];
  }
}
