import type { McpServerDefinition, McpToolDefinition } from "../../automation/engine/shared/mcp/types";
import type { ApiProviderKeyTarget, SessionSyncBinding } from "../postgres/metadata-repository";
import type { AssistantTextPosition, TraceEventQueryOptions } from "../postgres/session-turn-repository";
import type { MaterializedAttachment } from "../session-attachments";
import type { SessionBulkDeleteTarget } from "../session-bulk-delete";
import type { SessionFamily } from "../session-family";
import type { SavedSearch } from "../store/saved-searches";
import type { SearchHistoryEntry } from "../store/search-history-store";
import type { DerivedSessionTimeline } from "../turns/derive-turns";
import type {
  CodexIncrementalState,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  IndexedSession,
  IndexedSessionFileState,
  LoadedSession,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  RuntimeInvocationLookup,
  RuntimeInvocationSessionResolution,
  SearchOptions,
  SessionContextSample,
  SessionEnvironment,
  SessionMessage,
  SessionMessageEvent,
  SessionMigrationRecord,
  SessionSearchPage,
  SessionSearchResult,
  SessionSource,
  SessionSourceMetadata,
  SessionStats,
  SessionStatsOptions,
  SessionStatsTrend,
  SessionTraceEvent,
  SessionTurnDetail,
  SessionTurnSummary,
  TagListOptions,
  TokenUsageEvent,
} from "../types";

export interface EnvironmentRepository {
  listEnvironments(): Promise<SessionEnvironment[]>;
  getEnvironment(id: string): Promise<SessionEnvironment | null>;
  upsertEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment>;
  updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options?: { lastSyncedAt?: number | null; lastError?: string | null },
  ): Promise<void>;
  deleteEnvironmentSessions(environmentId: string): Promise<void>;
  deleteEnvironment(environmentId: string): Promise<void>;
}

export interface MetadataRepository {
  upsertSessionSyncBinding(binding: SessionSyncBinding): Promise<void>;
  getSessionSyncBindingForLocalKey(localSessionKey: string): Promise<SessionSyncBinding | null>;
  getSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<SessionSyncBinding | null>;
  listSessionSyncBindings(): Promise<SessionSyncBinding[]>;
  deleteSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<void>;
  getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): Promise<string>;
  setApiProviderKey(target: ApiProviderKeyTarget, providerId: string, apiKey: string): Promise<void>;
  recordSessionMigration(record: SessionMigrationRecord): Promise<void>;
  listSessionMigrations(sourceSessionKey: string): Promise<SessionMigrationRecord[]>;
}

export interface SavedSearchRepository {
  listSavedSearches(): Promise<SavedSearch[]>;
  getSavedSearch(id: number): Promise<SavedSearch | null>;
  createSavedSearch(name: string, options: SearchOptions): Promise<SavedSearch>;
  deleteSavedSearch(id: number): Promise<boolean>;
  touchSavedSearch(id: number): Promise<void>;
}

export interface SearchHistoryRepository {
  recordSearch(query: string, resultCount: number, options?: SearchOptions): Promise<void>;
  listRecentSearches(limit?: number): Promise<SearchHistoryEntry[]>;
  searchHistory(query: string, limit?: number): Promise<SearchHistoryEntry[]>;
  clearHistory(): Promise<void>;
  deleteEntry(id: number): Promise<boolean>;
}

export interface McpRegistryRepository {
  list(): Promise<McpServerDefinition[]>;
  upsert(server: McpServerDefinition): Promise<McpServerDefinition>;
  recordTest(
    server: McpServerDefinition,
    tools: McpToolDefinition[],
    error?: string,
  ): Promise<McpServerDefinition>;
  delete(id: string): Promise<boolean>;
  close(): void;
}

export interface SessionRepository {
  appendIndexedMessages(loaded: LoadedSession): Promise<void>;
  upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents?: readonly TokenUsageEvent[],
    traceEvents?: readonly SessionTraceEvent[],
    codexIncrementalState?: CodexIncrementalState,
    importedTimeline?: DerivedSessionTimeline,
  ): Promise<void>;
  getAttachmentFile(
    sessionKey: string,
    attachmentId: string,
  ): Promise<(MaterializedAttachment & { cachePath: string }) | null>;
  upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: readonly TokenUsageEvent[],
    messageEvents?: readonly SessionMessageEvent[],
  ): Promise<void>;
  isIndexedSessionFresh(session: IndexedSession): Promise<boolean>;
  isSessionContentFresh(sessionKey: string, fileMtimeMs: number, fileSize: number): Promise<boolean>;
  refreshSessionSourceMetadata(updates: readonly SessionSourceMetadata[]): Promise<void>;
  touchIndexedAtIfMissing(sessionKey: string): Promise<void>;
  setSessionSourceAvailable(sessionKey: string, available: boolean): Promise<void>;
  listIndexedSessionFiles(environmentId?: string): Promise<IndexedSessionFileState[]>;
  getTokenEvents(sessionKey: string): Promise<TokenUsageEvent[]>;
  setCustomTitle(sessionKey: string, title: string | null): Promise<void>;
  setFavorited(sessionKey: string, favorited: boolean): Promise<void>;
  setHidden(sessionKey: string, hidden: boolean): Promise<void>;
  markOpened(sessionKey: string): Promise<void>;
  markResumed(sessionKey: string): Promise<void>;
  addTag(sessionKey: string, tagName: string): Promise<void>;
  removeTag(sessionKey: string, tagName: string): Promise<void>;
  deleteTag(tagName: string): Promise<void>;
  listTags(options?: TagListOptions): Promise<string[]>;
  listTagsByProject(options?: { excludeSubagents?: boolean }): Promise<ProjectTagEntry[]>;
  listProjects(options?: ProjectQueryOptions): Promise<ProjectSummary[]>;
  deleteSessionRecord(sessionKey: string): Promise<boolean>;
  getSessionDeletionTargets(
    sessionKeys: readonly string[],
    includeOrphanedSubagents?: boolean,
  ): Promise<SessionBulkDeleteTarget[]>;
  deleteSessionRecords(sessionKeys: readonly string[], expandDescendants?: boolean): Promise<string[]>;
  migrateSessionKeyPreservingUserState(legacyKey: string, targetKey: string): Promise<boolean>;
  listSessionIdentitiesBySource(source: SessionSource): Promise<Array<{
    sessionKey: string;
    rawId: string;
    storageEnvironmentId: string;
  }>>;
  listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
    sessionKeys?: ReadonlySet<string>,
  ): Promise<string[]>;
  getSession(sessionKey: string): Promise<SessionSearchResult | null>;
  findByRawId(rawId: string): Promise<SessionSearchResult | null>;
  resolveRuntimeInvocationSession(
    lookup: RuntimeInvocationLookup,
  ): Promise<RuntimeInvocationSessionResolution>;
  setAiSummary(sessionKey: string, summary: string, model: string): Promise<boolean>;
  listSessionsNeedingSummary(
    now: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<SessionSearchResult[]>;
  clearSearchIndex(): Promise<void>;
  deleteSessionsBySource(sources: readonly SessionSource[]): Promise<void>;
}

export interface SessionTurnRepository {
  getMessageCount(sessionKey: string): Promise<number>;
  listSessionTurns(sessionKey: string, page?: { offset: number; limit: number }): Promise<SessionTurnSummary[]>;
  getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null>;
  listSessionTrajectory(sessionKey: string): Promise<SessionTurnDetail[]>;
  listSessionContext(sessionKey: string): Promise<SessionContextSample[]>;
  getMessages(sessionKey: string, offset?: number, limit?: number, fromTurnIndex?: number): Promise<SessionMessage[]>;
  getCodexMessageTail(
    sessionKey: string,
    expectedSize: number,
  ): Promise<Pick<LoadedSession, "messages" | "codexIncrementalState" | "messageAppend"> | null>;
  getAllMessages(sessionKey: string): Promise<SessionMessage[]>;
  getCodexIncrementalState(sessionKey: string): Promise<CodexIncrementalState>;
  getTraceEvents(sessionKey: string, options?: TraceEventQueryOptions): Promise<SessionTraceEvent[]>;
  getAssistantTextPositions(sessionKey: string): Promise<AssistantTextPosition[]>;
}

export interface SessionSearchRepository {
  searchSessions(options?: SearchOptions): Promise<SessionSearchResult[]>;
  searchSessionPage(options?: SearchOptions): Promise<SessionSearchPage>;
}

export interface SessionStatsRepository {
  getStats(options?: SessionStatsOptions, now?: number): Promise<SessionStats>;
  getStatsTrend(options?: SessionStatsOptions, now?: number): Promise<SessionStatsTrend>;
}

export type SessionFamilyFinder = (sessionKey: string) => Promise<SessionFamily>;
