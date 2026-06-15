export type SessionSource =
  | "claude-cli"
  | "claude-app"
  | "claude-internal"
  | "codex-cli"
  | "codex-app"
  | "codex-internal"
  | "codebuddy-cli"
  | "openclaw"
  | "hermes"
  | "opencode-cli"
  | "cursor-agent"
  | "trae";
export type SessionFormat = "claude" | "codex" | "codebuddy" | "openclaw" | "hermes" | "opencode" | "cursor" | "trae";
export type SessionSortBy = "activity" | "created";
export type EnvironmentKind = "local" | "ssh";
export type EnvironmentSyncState = "idle" | "syncing" | "watching" | "disconnected" | "error";
export type SshAuthMode = "none" | "identityFile";

export interface SessionEnvironment {
  id: string;
  kind: EnvironmentKind;
  label: string;
  hostAlias: string | null;
  host: string | null;
  user: string | null;
  port: number | null;
  authMode: SshAuthMode;
  identityFile: string | null;
  enabled: boolean;
  syncState: EnvironmentSyncState;
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentUpsertInput {
  id?: string;
  kind: EnvironmentKind;
  label: string;
  hostAlias?: string | null;
  host?: string | null;
  user?: string | null;
  port?: number | null;
  authMode?: SshAuthMode;
  identityFile?: string | null;
  enabled?: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  index: number;
}

export type SessionTraceKind = "tool_call" | "tool_result" | "event";

export interface SessionTraceEvent {
  index: number;
  kind: SessionTraceKind;
  source: SessionFormat;
  title: string;
  detail: string;
  timestamp: string;
  callId?: string | null;
  eventType?: string | null;
  status?: "success" | "failure" | "unknown" | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TokenUsageEvent extends TokenUsage {
  timestamp: number;
  dedupeKey: string;
}

export interface IndexedSession {
  sessionKey: string;
  rawId: string;
  source: SessionSource;
  projectPath: string;
  filePath: string;
  originalTitle: string;
  firstQuestion: string;
  timestamp: number;
  fileMtimeMs: number;
  fileSize: number;
  prUrl: string | null;
  prNumber: number | null;
  gitBranch?: string | null;
  tokenUsage?: TokenUsage;
  environmentId?: string;
  environmentKind?: EnvironmentKind;
  environmentLabel?: string;
}

export interface LoadedSession {
  session: IndexedSession;
  messages: SessionMessage[];
  tokenEvents?: TokenUsageEvent[];
  traceEvents?: SessionTraceEvent[];
}

export type SessionSourceFilter = SessionSource | "claude" | "codex" | "all";

export interface SearchOptions {
  query?: string;
  tag?: string;
  projectPath?: string;
  environmentId?: string | "all";
  source?: SessionSourceFilter;
  liveStatus?: "open" | "closed";
  liveSessionKeys?: string[];
  visibility?: "default" | "favorites" | "hidden" | "pinned";
  sortBy?: SessionSortBy;
  limit?: number;
}

export interface ProjectSummary {
  path: string;
  label: string;
  sessionCount: number;
  environmentId: string;
  environmentLabel: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface SessionSearchResult extends IndexedSession {
  environmentId: string;
  environmentKind: EnvironmentKind;
  environmentLabel: string;
  tokenUsage: TokenUsage;
  customTitle: string | null;
  displayTitle: string;
  favorited: boolean;
  pinned: boolean;
  hidden: boolean;
  tags: string[];
  matchSnippet: string | null;
  lastOpenedAt: number | null;
  lastResumedAt: number | null;
  lastActivityAt: number;
  messageCount: number;
  aiSummary: string | null;
  aiSummaryStale: boolean;
}

export interface SessionSearchPage {
  sessions: SessionSearchResult[];
  totalCount: number;
  hasMore: boolean;
}

export interface SessionStatsSummary extends TokenUsage {
  sessionCount: number;
  messageCount: number;
}

export interface SessionSourceStats extends SessionStatsSummary {
  source: SessionSource;
}

export type SessionStatsPeriod = "today" | "sevenDay" | "thirtyDay" | "allTime";

export interface SessionStatsOptions {
  period?: SessionStatsPeriod;
}

export interface SessionStats {
  total: SessionStatsSummary;
  bySource: SessionSourceStats[];
  range: {
    period: SessionStatsPeriod;
    since: number | null;
    until: number;
  };
}

export type UsageQuotaProvider = "codex" | "claude-code";
export type UsageQuotaStatus = "supported" | "unsupported_api_key" | "not_configured" | "error";

export interface UsageQuota {
  key: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  usedDisplay: string;
  remainingDisplay: string;
  resetsAt?: string;
  stale?: boolean;
}

export interface UsageQuotaCard {
  provider: UsageQuotaProvider;
  displayName: string;
  status: UsageQuotaStatus;
  source?: string;
  plan?: string;
  quotas: UsageQuota[];
  detail?: string;
}

export interface UsageQuotaSnapshot {
  generatedAt: string;
  providers: UsageQuotaCard[];
}

export type LiveSessionFamily = "claude" | "codex" | "codebuddy" | "trae";

export interface LiveSession {
  family: LiveSessionFamily;
  rawId: string;
  pid: number;
}

export interface LiveSessionSnapshot {
  generatedAt: string;
  sessions: LiveSession[];
  error?: string;
}

export interface ClaudeSessionIndexFile {
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export interface ClaudeAppSessionFile {
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  originCwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
  title?: string;
  prNumber?: number;
  prUrl?: string;
}

export interface ClaudeConversationLine {
  type: "user" | "assistant" | string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role: "user" | "assistant";
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
        }>;
  };
}

export interface CodexConversationLine {
  type?: string;
  timestamp?: string;
  id?: string;
  instructions?: string | null;
  git?: { cwd?: string };
  role?: "user" | "assistant" | string;
  content?: Array<{ type?: string; text?: string }>;
  payload?: {
    type?: string;
    role?: "user" | "assistant" | "developer" | "system" | string;
    content?: Array<{ type?: string; text?: string }>;
    id?: string;
    cwd?: string;
    git?: {
      branch?: string;
      commit_hash?: string;
      repository_url?: string;
    };
    originator?: string;
    name?: string;
    arguments?: unknown;
    call_id?: string;
    output?: unknown;
    command?: string;
    parsed_cmd?: unknown;
    stdout?: string;
    stderr?: string;
    aggregated_output?: string;
    formatted_output?: string;
    exit_code?: number;
    status?: string;
    success?: boolean;
    changes?: unknown;
    invocation?: unknown;
    plugin_id?: string;
    result?: unknown;
    query?: string;
    action?: unknown;
    message?: string;
    codex_error_info?: unknown;
  };
}

export interface CodeBuddyConversationLine {
  id?: string;
  parentId?: string;
  timestamp?: number;
  type?: string;
  role?: "user" | "assistant" | string;
  content?: Array<{ type?: string; text?: string }>;
  sessionId?: string;
  cwd?: string;
  providerData?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      cache_read_input_tokens?: number;
      reasoning_output_tokens?: number;
    };
    rawUsage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      cache_read_input_tokens?: number;
      reasoning_output_tokens?: number;
    };
    model?: string;
    messageId?: string;
  };
}
