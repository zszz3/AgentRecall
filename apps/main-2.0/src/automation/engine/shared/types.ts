import type { RuntimeId } from "./runtime-catalog";
import type { ResourceSourceType } from "./resource";
import type { RuntimeConversation } from "./runtime/conversation";
import type { RuntimeUsage } from "../../../shared/runtime/usage";
import type { ConfiguredAgent } from "./agent/types";
import type { AgentRecallInvocationSurface } from "../../../shared/runtime-invocation";
export type { ResourceSourceType } from "./resource";
export type { RuntimeConversation } from "./runtime/conversation";
export type { RuntimeUsage } from "../../../shared/runtime/usage";
export type { AgentRecallInvocationSurface } from "../../../shared/runtime-invocation";
export type { AgentRevision, AgentType, ConfiguredAgent } from "./agent/types";
export type {
  AgentMcpBinding,
  McpExternalClientConnection,
  McpExternalClientConnections,
  McpExternalClientId,
  McpExternalClientUpdate,
  McpGatewayCallRequest,
  McpGatewayGetRequest,
  McpGatewaySearchRequest,
  McpGatewaySearchResult,
  McpGatewayToolDetail,
  McpGatewayToolSummary,
  McpServerDefinition,
  McpToolDefinition,
  McpTransport,
} from "./mcp/types";
export type { EvaluationCaseResult, EvaluationDataset, EvaluationDatasetItem, EvaluationEvaluator, EvaluationExperiment, EvaluationRun, EvaluationRunPage, EvaluationRunSummary, EvaluationScore, EvaluatorKind, ListEvaluationRunsRequest } from "./evaluation/types";
export type { EvaluationDimensionScore, EvaluationScoringConfig } from "./evaluation/types";
export type { EvaluationExperimentGraph, EvaluationFailureAttribution, EvaluationFailureType, EvaluationGraphNodeSpec, EvaluationGraphSpec, EvaluationInputBinding, EvaluationNodeRecord, EvaluationPendingReason, EvaluationRecordStatus, EvaluationStageBoundaryKind, EvaluationStageDefinition, EvaluationVerdict, EvaluationVerdictStatus } from "./evaluation/types";

export type AgentId = RuntimeId;

export interface AgentRuntime {
  id: AgentId;
  label: string;
  command: string;
  version: string | null;
  available: boolean;
  error?: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface ModelCatalogRefreshResult {
  channelId: string;
  source: "codex_cli" | "openai_models";
  providerLabel: string;
  discoveredCount: number;
  snapshot: AppSnapshot;
}

export interface RuntimeLocalConfigImportResult {
  runtimeId: AgentId;
  channelId: string;
  source: string;
  snapshot: AppSnapshot;
}

export interface AgentPluginConfig {
  id: string;
  enabled: boolean;
}

export type RuntimeProviderApiFormat = "anthropic" | "openai_chat" | "openai_responses" | "gemini_native";
export type ClaudeApiKeyField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

export interface RuntimeRequestOverrides {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface CodexPluginCatalogItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  enabled: boolean;
  version?: string;
}

export interface AgentChannel {
  id: string;
  agentId: AgentId;
  label: string;
  models: AgentModelOption[];
  profileName?: string;
  presetId?: string;
  modelProvider?: string;
  providerName?: string;
  baseUrl?: string;
  wireApi?: string;
  httpHeaders?: Record<string, string>;
  apiFormat?: RuntimeProviderApiFormat;
  apiKeyField?: ClaudeApiKeyField;
  isFullUrl?: boolean;
  customUserAgent?: string;
  environment?: Record<string, string>;
  dshUseStoredCredentials?: boolean;
  requestOverrides?: RuntimeRequestOverrides;
  plugins?: AgentPluginConfig[];
  modelCatalogJson?: string;
  modelReasoningEffort?: string;
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  sourceLabel?: string;
  sourcePath?: string;
  sourceUrl?: string;
  translationZh?: string;
  sourceType?: ResourceSourceType;
  categoryId?: string;
}

export interface SkillCategory {
  id: string;
  name: string;
  system: boolean;
  sequence: number;
}

export interface AssignSkillCategoryRequest {
  sourceType: ResourceSourceType;
  skillId: string;
  categoryId: string;
}

export type SkillInstallTarget = "codex" | "claude" | "trae";

export interface InstallSkillRequest {
  templateId: string;
  target: SkillInstallTarget;
  sourceType?: ResourceSourceType;
}

export interface ImportOnlineSkillRequest {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  sourceLabel?: string;
  sourcePath?: string;
  sourceUrl?: string;
}

export interface UninstallSkillRequest {
  templateId: string;
  target: SkillInstallTarget;
}

export interface InstalledSkillResult {
  templateId: string;
  target: SkillInstallTarget;
  path: string;
  sourcePath: string;
  existed: boolean;
}

export interface ImportedSkillResult {
  template: SkillTemplate;
  path: string;
  existed: boolean;
}

export interface UninstalledSkillResult {
  templateId: string;
  target: SkillInstallTarget;
  path: string;
  removed: boolean;
}

export interface AgentTestResult {
  agentId: string;
  ok: boolean;
  status: "passed" | "failed";
  message: string;
  output?: string;
  elapsedMs: number;
  testedAt: number;
  runtimeAgentId: AgentId;
  channelId: string;
  modelId: string;
}

export type ProviderBalanceStatus = "success" | "unsupported" | "missing_key" | "error";

export interface ProviderBalanceItem {
  label?: string;
  remaining?: number;
  total?: number;
  used?: number;
  unit?: string;
  isValid?: boolean;
  invalidMessage?: string;
}

export interface ProviderBalanceResult {
  channelId: string;
  providerName?: string;
  supported: boolean;
  status: ProviderBalanceStatus;
  message: string;
  items: ProviderBalanceItem[];
  queriedAt: number;
}

export type AgentTestEvent = (
  | { agentId: string; type: "phase"; content: string; timestamp: number }
  | { agentId: string; type: "user"; content: string; timestamp: number }
  | { agentId: string; type: "assistant_delta"; content: string; timestamp: number }
  | { agentId: string; type: "assistant"; content: string; timestamp: number }
  | { agentId: string; type: "tool"; content: string; timestamp: number }
  | { agentId: string; type: "warning"; content: string; timestamp: number }
  | { agentId: string; type: "stderr"; content: string; timestamp: number }
  | { agentId: string; type: "error"; content: string; timestamp: number }
) & {
  /** Stable Runtime invocation shared by channel-test status and logs. */
  invocationId?: string;
};

export interface GeneratedConfigFile {
  channelId: string;
  modelId: string;
  profileName: string;
  path: string;
}

export interface ImportedCodexConfig {
  sourcePath: string;
  channel: AgentChannel;
}

export interface CodexDefaultConfig {
  modelProvider: string | null;
  providerName: string | null;
  baseUrl: string | null;
  wireApi: string | null;
  httpHeaders: Record<string, string> | null;
  apiKey: string | null;
  modelId: string | null;
  modelCatalogJson: string | null;
  modelReasoningEffort: string | null;
  plugins: AgentPluginConfig[] | null;
}

export interface ClaudeDefaultConfig {
  baseUrl: string | null;
  apiKey: string | null;
  modelId: string | null;
}

export type ExecutionStyle = "oneshot" | "interactive";
export type RuntimeExecutionMode = ExecutionStyle;
export type RuntimeContinuationPolicy = "fresh" | "resume-preferred" | "resume-required";

/** Stable business metadata attached to every Runtime dispatch. */
export interface RuntimeInvocationRequest {
  /** Runtime caller category used for Session grouping and history labels. */
  surface: AgentRecallInvocationSurface;
  /** Optional role within the selected surface, such as node or judge. */
  role?: string;
  /** Exact stable identifiers used to navigate back to the owning record. */
  ownerReference?: Record<string, string>;
}

export interface RuntimeConfig {
  model: string;
  reasoningEffort?: string;
  [key: string]: unknown;
}

export interface RuntimeRequest {
  runtimeId: AgentId;
  executionMode: RuntimeExecutionMode;
  continuationPolicy: RuntimeContinuationPolicy;
  runtimeConfig: RuntimeConfig;
  runtimeConversation?: RuntimeConversation;
  /** Stable identifier shared by the Runtime request, status, and emitted logs. */
  invocationId?: string;
  /**
   * Runtime execution environment used to scope native Session identifiers.
   * Defaults to the reserved `local` environment: Runtime dispatch only spawns
   * CLI subprocesses on the indexing machine. Dispatch outside that machine
   * must pass the owning environment id explicitly or Session attribution is
   * silently dropped.
   */
  environmentId?: string;
  /** Identifies the AgentRecall caller and the exact owner record for this dispatch. */
  invocation: RuntimeInvocationRequest;
}

export interface RuntimeResumeCapabilities {
  supportsInProcessConversationResume: boolean;
  supportsResumeAfterDetach: boolean;
  supportsResumeAfterAppRestart: boolean;
  supportsTurnResume: boolean;
}

export interface RuntimeInteractionCapabilities {
  supportsInterrupt: boolean;
  supportsContinue: boolean;
  supportsApprovalRequests: boolean;
  supportsUserInputRequests: boolean;
}

export type InteractionRequestState = "live" | "resolved" | "expired";
export type ApprovalDecision = "approved" | "rejected";

export interface ChatRuntimeSessionState {
  executionStyle: ExecutionStyle;
  attachmentState: "detached" | "idle" | "running" | "interrupted";
  attachmentGeneration: number;
  activeTurnId?: string;
  lastMeaningfulActivityAt?: number;
  capabilities: RuntimeResumeCapabilities & RuntimeInteractionCapabilities;
}

export type AgentEvent = (
  | { type: "runtime_conversation"; runtimeConversation: RuntimeConversation }
  | { type: "usage"; usage: RuntimeUsage }
  | { type: "delta"; content: string }
  | { type: "meta"; content: string }
  | { type: "system"; content: string; metadata?: Record<string, unknown> }
  | { type: "tool_call"; content: string; name?: string; metadata?: Record<string, unknown> }
  | { type: "tool_result"; content: string; name?: string; metadata?: Record<string, unknown> }
  | { type: "handoff"; content: string; fromAgentId?: AgentId; toAgentId?: AgentId; metadata?: Record<string, unknown> }
  | { type: "approval_request"; requestId: string; content: string; metadata?: Record<string, unknown> }
  | { type: "approval_response"; requestId: string; decision: ApprovalDecision; content?: string; metadata?: Record<string, unknown> }
  | { type: "user_input_request"; requestId: string; content: string; metadata?: Record<string, unknown> }
  | { type: "user_input_response"; requestId: string; content: string; metadata?: Record<string, unknown> }
  | { type: "completed"; content?: string }
  | { type: "error"; error: string }
) & {
  /** Stable identifier for the Runtime invocation that emitted this event. */
  invocationId?: string;
};

export interface SendPromptRequest {
  prompt: string;
  agentIds: AgentId[];
  workDir: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error" | "meta";
  content: string;
  timestamp: number;
  events?: ChatEvent[];
  local?: boolean;
}

export interface ChatEvent {
  id: string;
  type:
    | "meta"
    | "system"
    | "tool_call"
    | "tool_result"
    | "handoff"
    | "approval_request"
    | "approval_response"
    | "user_input_request"
    | "user_input_response"
    | "error";
  content: string;
  timestamp: number;
  agentId?: AgentId;
  name?: string;
  fromAgentId?: AgentId;
  toAgentId?: AgentId;
  requestId?: string;
  requestState?: InteractionRequestState;
  decision?: ApprovalDecision;
  /** Stable Runtime invocation identifier for this persisted event. */
  invocationId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSession {
  id: string;
  title: string;
  configuredAgentId: string;
  modelId: string;
  channelId?: string;
  runtimeState?: ChatRuntimeSessionState;
  runtimeConversation?: RuntimeConversation;
  running: boolean;
  messages: ChatMessage[];
  pendingAssistantMessageId: string | undefined;
  lastError: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface AgentOneShotRequest extends RuntimeRequest {
  requestId?: string;
  prompt: string;
  developerInstructions?: string;
  configuredAgentId: string;
  workDir?: string;
}

export interface AgentOneShotResponse {
  content: string;
  runtimeConversation?: RuntimeConversation;
  executionReference?: RuntimeExecutionReference;
}

export interface RuntimeExecutionReference {
  /** AgentRecall ledger row that owns this native reference. */
  invocationId?: string;
  sessionId?: string;
  turnId?: string;
}

export type AgentOneShotEvent = (
  | { requestId: string; type: "delta"; content: string }
  | { requestId: string; type: "meta" | "system"; content: string; name?: string; metadata?: Record<string, unknown> }
  | { requestId: string; type: "tool_call" | "tool_result"; content: string; name?: string; metadata?: Record<string, unknown> }
  | { requestId: string; type: "approval_request"; approvalRequestId: string; content: string; metadata?: Record<string, unknown> }
  | { requestId: string; type: "approval_response"; approvalRequestId: string; decision: ApprovalDecision; content?: string; metadata?: Record<string, unknown> }
  | { requestId: string; type: "completed"; content: string; runtimeConversation?: RuntimeConversation }
  | { requestId: string; type: "error"; error: string }
) & {
  /** Stable identifier for the Runtime invocation that emitted this event. */
  invocationId?: string;
};

export interface LocalFilePreview {
  path: string;
  title: string;
  content: string;
  truncated: boolean;
}

export interface AppSnapshot {
  detectedAt: number;
  activeChatId: string | undefined;
  workDir: string;
  runtimes: AgentRuntime[];
  channels: AgentChannel[];
  configuredAgents: ConfiguredAgent[];
  chats: ChatSession[];
}

