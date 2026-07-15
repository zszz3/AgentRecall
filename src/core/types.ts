export type SessionSource =
  | "claude-cli"
  | "claude-app"
  | "claude-internal"
  | "codex-cli"
  | "codex-app"
  | "codex-internal"
  | "tclaude-cli"
  | "tcodex-cli"
  | "codebuddy-cli"
  | "codewiz-cli"
  | "openclaw"
  | "hermes"
  | "opencode-cli"
  | "cursor-agent"
  | "trae";
export type SessionFormat = "claude" | "codex" | "codebuddy" | "codewiz" | "openclaw" | "hermes" | "opencode" | "cursor" | "trae";
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

export interface SessionMessageEvent {
  index: number;
  timestamp: number;
}

export type MigrationAgent = "claude" | "codex" | "codebuddy" | "codewiz" | "cursor";
export type MigrationTarget = MigrationAgent | "tclaude" | "tcodex" | "claude-internal" | "codex-internal";
export type SessionMigrationStrategy = "complete" | "ai-compressed" | "locally-truncated";
export type SessionMigrationStage = "reading" | "compressing" | "writing" | "indexing" | "launching";

// Granular progress emitted from inside the AI compression loop. The compressor
// summarizes the transcript chunk-by-chunk, then makes one final handoff call;
// each completed unit reports back so the UI can render a percentage.
export type MigrationCompressionPhase = "chunk" | "handoff";

export interface MigrationCompressionEvent {
  // Number of chunk summaries completed so far (0..totalChunks). Monotonic
  // whether chunks are summarized sequentially or concurrently, so the percent
  // bar never moves backwards. Reaches totalChunks when the final handoff begins.
  completed: number;
  // Number of chunk-summary calls (>=1); the final handoff is the +1th unit.
  totalChunks: number;
  phase: MigrationCompressionPhase;
}

export interface PortableSession {
  sourceSessionKey: string;
  sourceAgent: MigrationAgent;
  title: string;
  projectPath: string;
  startedAt: string;
  messages: SessionMessage[];
  isSubagent?: boolean;
  parentSessionId?: string | null;
}

export interface SessionMigrationProgress {
  sessionKey: string;
  target: MigrationTarget;
  stage: SessionMigrationStage;
  // 0-100 progress within the current stage. Only meaningful during
  // "compressing" (the only stage with multiple discrete units of work).
  percent?: number;
  // Structured compression detail; the renderer localizes this into text.
  compression?: MigrationCompressionEvent;
}

export interface SessionMigrationResult {
  target: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: SessionMigrationStrategy;
  resumeCommand: string;
  indexed: boolean;
  launched: boolean;
  warning?: string;
}

export interface SessionMigrationRecord {
  id: string;
  sourceSessionKey: string;
  sourceAgent: MigrationAgent;
  targetAgent: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: SessionMigrationStrategy;
  createdAt: number;
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
  isSubagent?: boolean;
  parentSessionId?: string | null;
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
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  excludeSubagents?: boolean;
}

export interface ProjectQueryOptions {
  excludeSubagents?: boolean;
  environmentId?: string;
}

export interface TagListOptions {
  environmentId?: string;
  projectPath?: string;
  projectEnvironmentId?: string;
  excludeSubagents?: boolean;
}

export interface ProjectTagEntry {
  environmentId: string;
  projectPath: string;
  tags: string[];
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
  matchHits?: SessionMatchHit[];
  messageMatchCount?: number;
  metadataMatch?: "title" | "project" | "summary" | null;
}

export interface SessionMatchHit {
  messageIndex: number;
  role: SessionMessage["role"];
  timestamp: string;
  snippet: string;
  matchedTerms: string[];
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
  excludeSubagents?: boolean;
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

export type LiveSessionFamily = "claude" | "codex" | "tclaude" | "tcodex" | "codebuddy" | "codewiz" | "trae";

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
  agentId?: string;
  sessionId?: string;
  isSidechain?: boolean;
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
    title?: string;
    git?: {
      branch?: string;
      commit_hash?: string;
      repository_url?: string;
    };
    originator?: string;
    session_id?: string;
    forked_from_id?: string;
    thread_source?: string;
    parent_thread_id?: string;
    source?:
      | string
      | {
          subagent?: {
            thread_spawn?: {
              parent_thread_id?: string;
              depth?: number;
              agent_path?: string | null;
              agent_nickname?: string;
              agent_role?: string | null;
            };
          };
        };
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
