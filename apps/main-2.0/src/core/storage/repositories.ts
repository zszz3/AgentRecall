import type { McpServerDefinition, McpToolDefinition } from "../../automation/engine/shared/mcp/types";
import type {
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  ListEvaluationRunsRequest,
} from "../../automation/engine/shared/evaluation/types";
import type {
  ApiProviderKeyTarget,
  AssistantTextPosition,
  EvaluationTrajectoryResult,
  EvaluationTrajectorySubject,
  MemoryCard,
  MemoryCardOperation,
  MemoryExtractionInput,
  MemoryExtractionOverview,
  MemoryExtractionState,
  SavedSearch,
  SearchHistoryEntry,
  SessionFamily,
  SessionSyncBinding,
  SkillPerformanceSignals,
  SkillSyncBinding,
  SkillToolOutcome,
  SkillTriggerLink,
  SkillUsageOverviewRow,
  SkillVersionGroup,
  TraceEventQueryOptions,
} from "./types";
import type {
  TeamSessionContent,
  TeamSessionPage,
  TeamSessionSnapshot,
  TeamSessionTurnsPage,
  TeamSharedSession,
} from "../../shared/team-sessions";
import type { SkillUsageEvent, SkillUsageSnapshot, SkillUsageSource } from "../skill-usage";
import type { MaterializedAttachment } from "../session-attachments";
import type { SessionBulkDeleteTarget } from "../session-bulk-delete";
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

export interface SkillRepository {
  isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean>;
  upsertSkillUsageSource(source: SkillUsageSource, events: readonly SkillUsageEvent[]): Promise<void>;
  pruneSkillUsageSources(activePaths: readonly string[]): Promise<void>;
  listRecentSkillTriggers(options?: { skill?: string; limit?: number }): Promise<SkillTriggerLink[]>;
  listSkillTriggersForSession(sessionKey: string): Promise<string[]>;
  listSkillUsageOverview(): Promise<SkillUsageOverviewRow[]>;
  getSkillPerformanceSignals(skill: string): Promise<SkillPerformanceSignals>;
  listSkillVersionGroups(skill: string): Promise<SkillVersionGroup[]>;
  listSkillToolOutcomes(skill: string): Promise<SkillToolOutcome[]>;
  hasClaudeHookUsageEvents(): Promise<boolean>;
  getSkillUsageSnapshot(): Promise<SkillUsageSnapshot>;
  upsertSkillSyncBinding(binding: SkillSyncBinding): Promise<void>;
  getSkillSyncBindingForLocalPath(localSkillPath: string): Promise<SkillSyncBinding | null>;
  getSkillSyncBindingForPortableIdentity(portableIdentity: string): Promise<SkillSyncBinding | null>;
  getSkillSyncBindingForRemoteId(remoteSkillId: string): Promise<SkillSyncBinding | null>;
  listSkillSyncBindings(): Promise<SkillSyncBinding[]>;
  deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: readonly string[]): Promise<void>;
}

export interface MemoryCardRepository {
  pickExtractionSessions(options: { enabledAt: string; now: string; limit: number }): Promise<string[]>;
  loadExtractionInput(sessionKey: string, enabledAt: string): Promise<MemoryExtractionInput | null>;
  findSimilarCards(projectPath: string, terms: readonly string[], limit: number): Promise<MemoryCard[]>;
  applyExtraction(input: {
    sessionKey: string;
    projectPath: string;
    firstTurnIndex: number;
    lastTurnIndex: number;
    candidateIds: readonly string[];
    operations: readonly MemoryCardOperation[];
    model: string;
    now: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<string[]>;
  recordExtractionFailure(
    sessionKey: string,
    error: string,
    now: string,
    options: { maxAttempts: number; baseDelayMs: number },
  ): Promise<void>;
  retryFailedExtractions(now: string, sessionKey?: string): Promise<number>;
  extractionState(sessionKey: string): Promise<MemoryExtractionState | null>;
  extractionOverview(todayStart: string): Promise<MemoryExtractionOverview>;
  listCards(options: { query?: string; includeSuperseded: boolean; limit?: number }): Promise<MemoryCard[]>;
  searchActiveCards(options: { query: string; projectPath?: string; limit?: number }): Promise<MemoryCard[]>;
  deleteCard(id: string): Promise<boolean>;
}

export interface TeamSessionRepository {
  replaceCatalog(scope: string, entries: Array<{ item: TeamSharedSession; key: string }>, signal: AbortSignal): Promise<void>;
  drafts(scope: string): Promise<TeamSharedSession[]>;
  draft(scope: string, id: number): Promise<{ packet: Buffer; item: TeamSharedSession; published: TeamSharedSession | null } | null>;
  receipt(scope: string, id: number, digest: string, published: TeamSharedSession): Promise<void>;
  list(scope: string, page: number, query?: string, mode?: "sessions" | "turns", includeTools?: boolean): Promise<TeamSessionPage>;
  sources(keys: string[]): Promise<Map<string, string | null>>;
  get(key: string): Promise<TeamSessionSnapshot | null>;
  import(
    key: string,
    content: TeamSessionContent,
    signal: AbortSignal,
    origin: { repository: string; assetId: number; digest: string },
    catalog?: { scope: string; item: TeamSharedSession; packet?: Buffer; replaces?: { id: number; digest: string } },
  ): Promise<TeamSessionSnapshot>;
  turns(key: string, record: number, offset: number): Promise<TeamSessionTurnsPage>;
  turn(key: string, record: number, id: string): Promise<SessionTurnDetail | null>;
}

export interface EvaluationRepository {
  listDatasets(): Promise<EvaluationDataset[]>;
  saveDataset(value: EvaluationDataset): Promise<EvaluationDataset>;
  deleteDataset(id: string): Promise<boolean>;
  listEvaluators(): Promise<EvaluationEvaluator[]>;
  saveEvaluator(value: EvaluationEvaluator): Promise<EvaluationEvaluator>;
  deleteEvaluator(id: string): Promise<boolean>;
  listExperiments(): Promise<EvaluationExperiment[]>;
  saveExperiment(value: EvaluationExperiment): Promise<EvaluationExperiment>;
  deleteExperiment(id: string): Promise<boolean>;
  listRuns(input?: ListEvaluationRunsRequest): Promise<EvaluationRunPage>;
  getRun(id: string): Promise<EvaluationRun | undefined>;
  deleteRun(id: string): Promise<boolean>;
  saveRun(value: EvaluationRun): Promise<EvaluationRun>;
  saveTrajectoryResult(value: EvaluationTrajectoryResult): Promise<EvaluationTrajectoryResult>;
  listTrajectoryResults(subject: EvaluationTrajectorySubject): Promise<EvaluationTrajectoryResult[]>;
  close(): void;
}
