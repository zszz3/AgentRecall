import type { SkillUsageAgent } from "../skill-usage";
import type { SearchOptions, SessionSource } from "../types";

/**
 * Pure domain types and constants shared across storage repositories, IPC contracts,
 * preload bridges, and renderer views. Must remain browser-safe (zero `node:*` imports).
 */

export const SESSION_TRAJECTORY_PREVIEW_LENGTH = 300;
export const TEAM_SESSION_CACHE_VERSION = 2;

export type ApiProviderKeyTarget = "codex" | "claude" | "summary" | "agent" | "gateway";
export type SessionSyncDirection = "upload" | "restore";

export interface SessionSyncBinding {
  localSessionKey: string;
  remoteSessionId: string;
  lastLocalRevision: string;
  lastRemoteRevision: string;
  lastSyncedAt: number;
  direction: SessionSyncDirection;
}

export interface SavedSearch {
  id: number;
  name: string;
  options: SearchOptions;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export interface SearchHistoryEntry {
  id: number;
  query: string;
  resultCount: number;
  searchedAt: number;
  options: SearchOptions | null;
}

export interface SubagentSessionSummary {
  sessionKey: string;
  rawId: string;
  title: string;
  source: SessionSource;
  environmentId: string;
  environmentLabel: string;
  messageCount: number;
  lastActivityAt: number;
  aiSummary: string | null;
  originTurnIndex?: number | null;
}

export interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

export interface SessionFamily {
  parent: SubagentSessionSummary | null;
  parentOriginTurnIndex?: number | null;
  forkOrigin?: { rawId: string; sessionKey: string | null; title: string | null };
  children: SubagentSessionNode[];
  truncated: boolean;
}

export interface TraceEventQueryOptions {
  startTimestamp?: string;
  endTimestamp?: string;
  limit?: number;
}

/**
 * One assistant message, placed at the trace position it follows.
 *
 * A range of trace positions can then claim the text that belongs to it without
 * guessing an alignment from timestamps.
 */
export interface AssistantTextPosition {
  /** Trace index of the last event before the message; null when there was none. */
  traceIndex: number | null;
  text: string;
}

export type SkillSyncDirection = "upload" | "download";
export type SkillTriggerLinkState = "linked-turn" | "linked-session" | "unlinked";

export interface SkillTriggerLink {
  agent: SkillUsageAgent;
  skill: string;
  occurredAt: number;
  linkState: SkillTriggerLinkState;
  sessionKey: string | null;
  sessionTitle: string | null;
  projectPath: string | null;
  turnId: string | null;
}

export interface SkillUsageOverviewRow {
  agent: SkillUsageAgent;
  skill: string;
  totalTriggers: number;
  triggers7d: number;
  triggers30d: number;
  lastTriggeredAt: number;
  linkedTriggers: number;
}

export interface SkillPerformanceSignals {
  sampleSize: number;
  medianTotalTokens: number | null;
  medianDurationMs: number | null;
  errorTurnRatio: number | null;
  baselineTurnCount: number;
  baselineMedianTotalTokens: number | null;
  baselineMedianDurationMs: number | null;
  baselineErrorTurnRatio: number | null;
}

export interface SkillVersionGroup {
  skillHash: string | null;
  triggerCount: number;
  firstTriggeredAt: number;
  lastTriggeredAt: number;
}

export interface SkillToolOutcome {
  toolName: string;
  callCount: number;
  failureCount: number;
  sampleSpanIds: string[];
  sampleErrors: string[];
}

export interface SkillSyncBinding {
  localSkillPath: string;
  portableIdentity?: string;
  remoteSkillId: string;
  remoteUpdatedAt: string;
  remoteVersion: number;
  lastContentHash?: string;
  lastSyncedAt: number;
  direction: SkillSyncDirection;
}

export type MemoryCardKind = "experience" | "decision";
export type MemoryCardStatus = "active" | "superseded";

export interface MemoryCardSource {
  sessionKey: string;
  firstTurnIndex: number;
  lastTurnIndex: number;
  /** When the last Turn of the range started; when that Turn is no longer indexed, when the source was recorded. */
  lastTurnAt: string;
}

export interface MemoryCard {
  id: string;
  projectPath: string;
  kind: MemoryCardKind;
  problem: string;
  solution: string;
  previousSolution: string | null;
  failedAttempts: string[];
  keywords: string[];
  status: MemoryCardStatus;
  supersededBy: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  sources: MemoryCardSource[];
}

/** One validated change proposed by the extraction model. */
export type MemoryCardOperation =
  | { op: "create"; ref: string; kind: MemoryCardKind; problem: string; solution: string; failedAttempts: string[]; keywords: string[] }
  | { op: "update"; id: string; solution?: string; failedAttempts: string[]; keywords: string[] }
  /** The new Turns show the card still holds; only a source is added. */
  | { op: "confirm"; id: string }
  | { op: "supersede"; id: string; replacedBy: string };

export type MemoryExtractionStatus = "pending" | "succeeded" | "succeeded_no_output" | "failed";

export interface MemoryExtractionState {
  sessionKey: string;
  lastExtractedTurnIndex: number | null;
  status: MemoryExtractionStatus;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastRunAt: string | null;
}

export interface MemoryExtractionTurn {
  turnIndex: number;
  startedAt: string;
  userText: string;
  assistantText: string;
  toolText: string;
  toolNames: string[];
}

export interface MemoryExtractionInput {
  sessionKey: string;
  source: string;
  projectPath: string;
  title: string;
  turns: MemoryExtractionTurn[];
}

export interface MemoryExtractionFailure {
  sessionKey: string;
  title: string;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string;
}

export interface MemoryExtractionOverview {
  activeCards: number;
  supersededCards: number;
  processedSessions: number;
  processedToday: number;
  /** Null when no extraction reported usage; Runtimes that do not report usage are not counted as zero. */
  inputTokens: number | null;
  outputTokens: number | null;
  failures: MemoryExtractionFailure[];
}

export type EvaluationTrajectorySubject =
  | { type: "session"; sessionKey: string }
  | { type: "turn"; turnId: string }
  | { type: "span"; spanId: string };

export interface EvaluationTrajectoryResult {
  id: string;
  subject: EvaluationTrajectorySubject;
  evaluatorId?: string;
  metric: string;
  score?: number;
  label?: string;
  passed?: boolean;
  explanation?: string;
  evidence?: Record<string, unknown>;
  evaluatorVersion?: string;
  createdAt: number;
}
