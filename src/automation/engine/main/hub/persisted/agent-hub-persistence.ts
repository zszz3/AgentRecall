import {
  DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY,
  type AgentChannel,
  type AgentId,
  type AgentTeamMember,
  type AgentTeamMode,
  type AgentWorkflowSnapshot,
  type AgentWorkflowTarget,
  type ChatEvent,
  type ChatMessage,
  type ChatRuntimeSessionState,
  type ConfiguredAgent,
  type RuntimeConversation,
  type RuntimeInteractionCapabilities,
  type RuntimeResumeCapabilities,
  type ScheduledWorkflowFrequency,
  type ScheduledWorkflowRunStatus,
  type ScheduledWorkflowStoreState,
  type TaskProgress,
  type TaskRunStatus,
  type TeamRunStatus,
  type TeamRunStep,
  type TeamRunStepStatus,
  type WorkflowDraftState,
  type WorkflowRunNodeStatus,
  type WorkflowStoreState,
} from "../../../shared/types";
import { isRuntimeId } from "../../../shared/runtime-catalog";
import type { WorkflowNodeConversation } from "../../../shared/workflow-v2/conversation";

export interface PersistedChatSessionRecord {
  id: string;
  title: string;
  configuredAgentId: string;
  modelId?: string;
  channelId?: string;
  runtimeState?: ChatRuntimeSessionState;
  runtimeConversation?: RuntimeConversation;
  lastError: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedChatMessageRecord {
  id: string;
  chatId: string;
  role: ChatMessage["role"];
  content: string;
  timestamp: number;
  local?: boolean;
}

export interface PersistedChatEventRecord extends ChatEvent {
  chatId: string;
  messageId: string;
}

export interface PersistedTaskRunRecord {
  id: string;
  title: string;
  prompt: string;
  developerInstructions?: string;
  contextDocument?: string;
  configuredAgentId: string;
  modelId?: string;
  workDir: string;
  status: TaskRunStatus;
  progress?: TaskProgress;
  runtimeConversation?: RuntimeConversation;
  lastError: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedTaskMessageRecord {
  id: string;
  taskId: string;
  role: ChatMessage["role"];
  content: string;
  timestamp: number;
  local?: boolean;
}

export interface PersistedTaskEventRecord extends ChatEvent {
  taskId: string;
  messageId: string;
}

export interface PersistedAgentTeamRecord {
  id: string;
  name: string;
  mode: AgentTeamMode;
  sharedContext: string;
  members: AgentTeamMember[];
  workflow?: AgentWorkflowSnapshot;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedTeamRunRecord {
  id: string;
  teamId: string;
  teamName: string;
  title: string;
  prompt: string;
  membersSnapshot?: AgentTeamMember[];
  target: AgentWorkflowTarget | undefined;
  mode: AgentTeamMode;
  status: TeamRunStatus;
  currentStepIndex: number;
  workDir: string;
  sharedContextSnapshot: string;
  workflow?: AgentWorkflowSnapshot;
  steps: TeamRunStep[];
  lastError: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedAppStateV5 {
  version: 5;
  activeChatId: string | null;
  activeTaskId?: string | null;
  activeTeamId?: string | null;
  activeTeamRunId?: string | null;
  workDir: string;
  sessions: PersistedChatSessionRecord[];
  messages: PersistedChatMessageRecord[];
  events: PersistedChatEventRecord[];
  tasks?: PersistedTaskRunRecord[];
  taskMessages?: PersistedTaskMessageRecord[];
  taskEvents?: PersistedTaskEventRecord[];
  teams?: PersistedAgentTeamRecord[];
  teamRuns?: PersistedTeamRunRecord[];
  workflowStore?: WorkflowStoreState;
  workflowDraft?: WorkflowDraftState;
  scheduledWorkflowStore?: ScheduledWorkflowStoreState;
  channels?: AgentChannel[];
  configuredAgents?: ConfiguredAgent[];
  workflowNodeConversations?: WorkflowNodeConversation[];
}

export type PersistedAppState = PersistedAppStateV5;

export function isAgentId(value: unknown): value is AgentId {
  return isRuntimeId(value);
}

export function isMessageRole(value: unknown): value is ChatMessage["role"] {
  return value === "user" || value === "assistant" || value === "error" || value === "meta";
}

export function isChatEventType(value: unknown): value is ChatEvent["type"] {
  return (
    value === "meta" ||
    value === "system" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "handoff" ||
    value === "approval_request" ||
    value === "approval_response" ||
    value === "user_input_request" ||
    value === "user_input_response" ||
    value === "error"
  );
}

export function isInteractionRequestState(value: unknown): value is "live" | "resolved" | "expired" {
  return value === "live" || value === "resolved" || value === "expired";
}

export function isApprovalDecision(value: unknown): value is "approved" | "rejected" {
  return value === "approved" || value === "rejected";
}

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped";
}

export function isTaskProgress(value: unknown): value is TaskProgress {
  return value === "backlog" || value === "todo" || value === "in_progress" || value === "in_review" || value === "done";
}

export function isExecutionStyle(value: unknown): value is ChatRuntimeSessionState["executionStyle"] {
  return value === "oneshot" || value === "interactive";
}

export function isRuntimeAttachmentState(value: unknown): value is ChatRuntimeSessionState["attachmentState"] {
  return value === "detached" || value === "idle" || value === "running" || value === "interrupted";
}

export function isAgentTeamMode(value: unknown): value is AgentTeamMode {
  return value === "pipeline" || value === "parallel" || value === "supervisor";
}

export function isWorkflowDraftMessageRole(value: unknown): value is WorkflowDraftState["messages"][number]["role"] {
  return value === "assistant" || value === "user";
}

export function isWorkflowRunNodeStatus(value: unknown): value is WorkflowRunNodeStatus {
  return value === "queued" || value === "running" || value === "paused" || value === "awaiting_input" || value === "completed" || value === "failed";
}

export function isScheduledWorkflowRunStatus(value: unknown): value is ScheduledWorkflowRunStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "skipped";
}

export function normalizeScheduledWorkflowFrequency(value: unknown): ScheduledWorkflowFrequency {
  return value === "weekly" || value === "monthly" ? value : "daily";
}

export function normalizeScheduledWorkflowTimeOfDay(value: unknown): string {
  const raw = asOptionalString(value)?.trim();
  return raw && /^\d{2}:\d{2}$/.test(raw) ? raw : DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY;
}

export function normalizeScheduledWorkflowWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = [...new Set(value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))];
  return days.length > 0 ? days : undefined;
}

export function normalizeScheduledWorkflowDayOfMonth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(31, Math.max(1, value)) : undefined;
}

export function isAgentWorkflowTarget(value: unknown): value is AgentWorkflowTarget {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentWorkflowTarget>;
  return (
    (record.kind === "workspace" || record.kind === "task" || record.kind === "custom") &&
    typeof record.label === "string" &&
    typeof record.value === "string"
  );
}

export function isTeamRunStatus(value: unknown): value is TeamRunStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped";
}

export function isTeamRunStepStatus(value: unknown): value is TeamRunStepStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped";
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function defaultRuntimeSessionCapabilities(): RuntimeResumeCapabilities & RuntimeInteractionCapabilities {
  return {
    supportsInProcessConversationResume: true,
    supportsResumeAfterDetach: false,
    supportsResumeAfterAppRestart: false,
    supportsTurnResume: false,
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
  };
}

export function cloneRuntimeState(runtimeSession: ChatRuntimeSessionState): ChatRuntimeSessionState {
  return {
    executionStyle: runtimeSession.executionStyle,
    attachmentState: runtimeSession.attachmentState,
    attachmentGeneration: runtimeSession.attachmentGeneration,
    ...(runtimeSession.activeTurnId !== undefined ? { activeTurnId: runtimeSession.activeTurnId } : {}),
    ...(runtimeSession.lastMeaningfulActivityAt !== undefined
      ? { lastMeaningfulActivityAt: runtimeSession.lastMeaningfulActivityAt }
      : {}),
    capabilities: { ...runtimeSession.capabilities },
  };
}
