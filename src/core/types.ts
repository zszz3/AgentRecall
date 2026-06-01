export type SessionSource = "claude-cli" | "claude-app" | "codex-cli" | "codex-app";
export type SessionFormat = "claude" | "codex";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  index: number;
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
}

export interface LoadedSession {
  session: IndexedSession;
  messages: SessionMessage[];
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  source?: SessionSource | "claude" | "codex" | "all";
  visibility?: "default" | "hidden" | "pinned";
  limit?: number;
}

export interface SessionSearchResult extends IndexedSession {
  customTitle: string | null;
  displayTitle: string;
  pinned: boolean;
  hidden: boolean;
  tags: string[];
  matchSnippet: string | null;
  lastOpenedAt: number | null;
  lastResumedAt: number | null;
  messageCount: number;
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
  message?: {
    role: "user" | "assistant";
    content?: string | Array<{ type?: string; text?: string }>;
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
    originator?: string;
  };
}
