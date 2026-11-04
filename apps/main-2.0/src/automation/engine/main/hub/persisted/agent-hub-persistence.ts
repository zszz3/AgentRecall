import type {
  AgentChannel,
  AgentId,
  ChatEvent,
  ChatMessage,
  ChatRuntimeSessionState,
  ConfiguredAgent,
  RuntimeConversation,
  RuntimeInteractionCapabilities,
  RuntimeResumeCapabilities,
} from "../../../shared/types";
import { isRuntimeId } from "../../../shared/runtime-catalog";

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

export interface PersistedAppStateV5 {
  version: 5;
  activeChatId: string | null;
  workDir: string;
  sessions: PersistedChatSessionRecord[];
  messages: PersistedChatMessageRecord[];
  events: PersistedChatEventRecord[];
  channels?: AgentChannel[];
  configuredAgents?: ConfiguredAgent[];
  deletedConfiguredAgentIds?: string[];
  /**
   * Retired Task fields. Saves keep them empty because earlier builds reject a
   * version-5 payload without these arrays; loading ignores whatever they
   * contain, as it does any retired Workflow or Agent Team keys.
   */
  tasks: [];
  taskMessages: [];
  taskEvents: [];
  /** Retired Agent Team fields, kept empty for the same downgrade reason. */
  teams?: [];
  teamRuns?: [];
  activeTeamId?: null;
  activeTeamRunId?: null;
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

export function isExecutionStyle(value: unknown): value is ChatRuntimeSessionState["executionStyle"] {
  return value === "oneshot" || value === "interactive";
}

export function isRuntimeAttachmentState(value: unknown): value is ChatRuntimeSessionState["attachmentState"] {
  return value === "detached" || value === "idle" || value === "running" || value === "interrupted";
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
