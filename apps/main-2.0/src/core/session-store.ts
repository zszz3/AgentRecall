import { deleteHermesSession } from "./hermes-session-writer";
import { isLocalSessionStorage } from "./session-environment";
import { deleteLocalSessionSources } from "./session-source-delete";
import { deleteZcodeSessions } from "./zcode-session-writer";
import {
  readSessionSourceArtifacts,
  type SessionSourceArtifact,
} from "./session-source-archive";
import type {
  SkillUsageEvent,
  SkillUsageSnapshot,
  SkillUsageSource,
} from "./skill-usage";
import { PostgresDatabase } from "./postgres/database";
import { PostgresEnvironmentRepository } from "./postgres/environment-repository";
import {
  PostgresOpenVikingMemoryRepository,
  type AddOpenVikingWorkspaceInput,
  type CreateOpenVikingImportTaskInput,
  type OpenVikingImportedTurnCheckpoint,
  type OpenVikingImportJob,
  type OpenVikingImportTask,
  type OpenVikingSessionCheckpoint,
  type UpdateOpenVikingImportJobInput,
} from "./postgres/openviking-memory-repository";
import {
  PostgresMetadataRepository,
  type ApiProviderKeyTarget,
  type SessionSyncBinding,
} from "./postgres/metadata-repository";
import { SavedSearchStore, type SavedSearch } from "./store/saved-searches";
import { SearchHistoryStore, type SearchHistoryEntry } from "./store/search-history-store";
import { PostgresSessionRepository } from "./postgres/session-repository";
import { PostgresSessionSearchRepository } from "./postgres/session-search-repository";
import { PostgresSessionStatsRepository } from "./postgres/session-stats-repository";
import {
  PostgresSessionTurnRepository,
  type TraceEventQueryOptions,
} from "./postgres/session-turn-repository";
import {
  PostgresSkillRepository,
  type SkillPerformanceSignals,
  type SkillSyncBinding,
  type SkillToolOutcome,
  type SkillTriggerLink,
  type SkillUsageOverviewRow,
  type SkillVersionGroup,
} from "./postgres/skill-repository";
import { findSessionFamily, type SessionFamily as SessionFamilyResult } from "./session-family";
import type {
  CodexIncrementalState,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  IndexedSession,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  SearchOptions,
  SessionEnvironment,
  SessionMessage,
  SessionMessageEvent,
  SessionMigrationRecord,
  SessionSearchPage,
  SessionSearchResult,
  SessionSource,
  SessionStats,
  SessionStatsOptions,
  SessionStatsTrend,
  SessionTraceEvent,
  SessionTurnDetail,
  SessionTurnSummary,
  TagListOptions,
  TokenUsageEvent,
} from "./types";
import type { OpenVikingWorkspace } from "./openviking-memory";
import type { SessionBulkDeleteTarget } from "./session-bulk-delete";

export type {
  ApiProviderKeyTarget,
  SessionSyncBinding,
  SessionSyncDirection,
} from "./postgres/metadata-repository";
export type { SavedSearch } from "./store/saved-searches";
export type { SearchHistoryEntry } from "./store/search-history-store";
export type {
  SessionFamily,
  SubagentSessionNode,
  SubagentSessionSummary,
} from "./session-family";
export type { TraceEventQueryOptions } from "./postgres/session-turn-repository";
export type {
  SkillPerformanceSignals,
  SkillSyncBinding,
  SkillSyncDirection,
  SkillToolOutcome,
  SkillTriggerLink,
  SkillTriggerLinkState,
  SkillUsageOverviewRow,
  SkillVersionGroup,
} from "./postgres/skill-repository";

export class SessionStore {
  private readonly sessions: PostgresSessionRepository;
  private readonly search: PostgresSessionSearchRepository;
  private readonly stats: PostgresSessionStatsRepository;
  private readonly turns: PostgresSessionTurnRepository;
  private readonly environments: PostgresEnvironmentRepository;
  private readonly metadata: PostgresMetadataRepository;
  private readonly openVikingMemory: PostgresOpenVikingMemoryRepository;
  private readonly skills: PostgresSkillRepository;
  private readonly savedSearches: SavedSearchStore;
  private readonly historyStore: SearchHistoryStore;

  constructor(
    private readonly database: PostgresDatabase,
    private readonly ready: Promise<void> = Promise.resolve(),
    attachmentCacheRoot: string | null = null,
  ) {
    this.sessions = new PostgresSessionRepository(database, attachmentCacheRoot);
    this.search = new PostgresSessionSearchRepository(database);
    this.stats = new PostgresSessionStatsRepository(database);
    this.turns = new PostgresSessionTurnRepository(database);
    this.environments = new PostgresEnvironmentRepository(database);
    this.metadata = new PostgresMetadataRepository(database);
    this.openVikingMemory = new PostgresOpenVikingMemoryRepository(database);
    this.skills = new PostgresSkillRepository(database);
    this.savedSearches = new SavedSearchStore(database);
    this.historyStore = new SearchHistoryStore(database);
  }

  async close(): Promise<void> {
    await this.ready;
    await this.database.close();
  }

  async upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents: readonly TokenUsageEvent[] = [],
    traceEvents: readonly SessionTraceEvent[] = [],
    codexIncrementalState?: CodexIncrementalState,
  ): Promise<void> {
    await this.ready;
    const sanitizedMessages = messages.map((message) => {
      const content = message.content.replaceAll("\u0000", "");
      return content === message.content ? message : { ...message, content };
    });
    const sanitizedTraceEvents = traceEvents.map((event) => {
      const title = event.title.replaceAll("\u0000", "");
      const detail = event.detail.replaceAll("\u0000", "");
      return title === event.title && detail === event.detail ? event : { ...event, title, detail };
    });
    await this.sessions.upsertIndexedSession(
      session,
      sanitizedMessages,
      tokenEvents,
      sanitizedTraceEvents,
      codexIncrementalState,
    );
  }

  async isIndexedSessionFresh(session: IndexedSession): Promise<boolean> {
    await this.ready;
    return this.sessions.isIndexedSessionFresh(session);
  }

  async isSessionContentFresh(
    sessionKey: string,
    fileMtimeMs: number,
    fileSize: number,
  ): Promise<boolean> {
    await this.ready;
    return this.sessions.isSessionContentFresh(sessionKey, fileMtimeMs, fileSize);
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    await this.ready;
    await this.sessions.touchIndexedAtIfMissing(sessionKey);
  }

  async setSessionSourceAvailable(sessionKey: string, available: boolean): Promise<void> {
    await this.ready;
    await this.sessions.setSessionSourceAvailable(sessionKey, available);
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<Array<{ sessionKey: string; source: SessionSource; filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>> {
    await this.ready;
    return this.sessions.listIndexedSessionFiles(environmentId);
  }

  async upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: readonly TokenUsageEvent[],
    messageEvents?: readonly SessionMessageEvent[],
  ): Promise<void> {
    await this.ready;
    await this.sessions.upsertIndexedSessionSummary(session, messageCount, tokenEvents, messageEvents);
  }

  async setCustomTitle(sessionKey: string, title: string | null): Promise<void> {
    await this.ready;
    await this.sessions.setCustomTitle(sessionKey, title);
  }

  async setFavorited(sessionKey: string, favorited: boolean): Promise<void> {
    await this.ready;
    await this.sessions.setFavorited(sessionKey, favorited);
  }

  async setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    await this.ready;
    await this.sessions.setHidden(sessionKey, hidden);
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    await this.ready;
    const targets = await this.sessions.getSessionDeletionTargets([sessionKey]);
    const target = targets.find((item) => item.sessionKey === sessionKey);
    if (!target) return false;
    if (target.source === "pi-cli") throw new Error("Pi session source files are read-only.");
    if (target.source === "zcode-cli") {
      const idsByFilePath = new Map<string, string[]>();
      if (target.sourceAvailable) {
        for (const item of targets.filter((item) => item.sourceAvailable)) {
          const rawIds = idsByFilePath.get(item.filePath) ?? [];
          rawIds.push(item.rawId);
          idsByFilePath.set(item.filePath, rawIds);
        }
      }
      for (const [filePath, rawIds] of idsByFilePath) deleteZcodeSessions(filePath, rawIds);
      return (await this.sessions.deleteSessionRecords(targets.map((item) => item.sessionKey), false)).includes(sessionKey);
    }
    if (target.source === "hermes") {
      if (target.sourceAvailable) deleteHermesSession(target.filePath, target.rawId);
      return (await this.sessions.deleteSessionRecords(targets.map((item) => item.sessionKey), false)).includes(sessionKey);
    }
    if (target.source === "opencode-cli") throw new Error("Cannot delete shared OpenCode source database.");
    if (target.source === "codewiz-cli") throw new Error("Cannot delete shared CodeWiz source database.");
    if (target.source === "cursor-agent" && /(^|[\\/])state\.vscdb$/iu.test(target.filePath)) {
      if (!target.sourceAvailable) {
        return (await this.sessions.deleteSessionRecords(targets.map((item) => item.sessionKey), false)).includes(sessionKey);
      }
      throw new Error("Cannot delete shared Cursor source database.");
    }
    if (target.sourceAvailable) deleteLocalSessionSources(targets.filter((item) => item.sourceAvailable));
    return (await this.sessions.deleteSessionRecords(targets.map((item) => item.sessionKey), false)).includes(sessionKey);
  }

  async deleteSessionRecord(sessionKey: string): Promise<boolean> {
    await this.ready;
    return this.sessions.deleteSessionRecord(sessionKey);
  }

  async getSessionDeletionTargets(
    sessionKeys: readonly string[],
    includeOrphanedSubagents = false,
  ): Promise<SessionBulkDeleteTarget[]> {
    await this.ready;
    return this.sessions.getSessionDeletionTargets(sessionKeys, includeOrphanedSubagents);
  }

  async deleteSessionRecords(sessionKeys: readonly string[], expandDescendants = true): Promise<string[]> {
    await this.ready;
    return this.sessions.deleteSessionRecords(sessionKeys, expandDescendants);
  }

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    await this.ready;
    return this.sessions.migrateSessionKeyPreservingUserState(legacyKey, targetKey);
  }

  async listSessionIdentitiesBySource(source: SessionSource): Promise<Array<{
    sessionKey: string;
    rawId: string;
    storageEnvironmentId: string;
  }>> {
    await this.ready;
    return this.sessions.listSessionIdentitiesBySource(source);
  }

  async listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
    sessionKeys: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    await this.ready;
    return this.sessions.listSessionKeysByFilePath(environmentId, filePaths, sessionKeys);
  }

  async markOpened(sessionKey: string): Promise<void> {
    await this.ready;
    await this.sessions.markOpened(sessionKey);
  }

  async markResumed(sessionKey: string): Promise<void> {
    await this.ready;
    await this.sessions.markResumed(sessionKey);
  }

  async addTag(sessionKey: string, tagName: string): Promise<void> {
    await this.ready;
    await this.sessions.addTag(sessionKey, tagName);
  }

  async removeTag(sessionKey: string, tagName: string): Promise<void> {
    await this.ready;
    await this.sessions.removeTag(sessionKey, tagName);
  }

  async deleteTag(tagName: string): Promise<void> {
    await this.ready;
    await this.sessions.deleteTag(tagName);
  }

  async listTags(options: TagListOptions = {}): Promise<string[]> {
    await this.ready;
    return this.sessions.listTags(options);
  }

  async listTagsByProject(
    options: { excludeSubagents?: boolean } = {},
  ): Promise<ProjectTagEntry[]> {
    await this.ready;
    return this.sessions.listTagsByProject(options);
  }

  async listEnvironments(): Promise<SessionEnvironment[]> {
    await this.ready;
    return this.environments.listEnvironments();
  }

  async upsertEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment> {
    await this.ready;
    return this.environments.upsertEnvironment(input);
  }

  async getEnvironment(id: string): Promise<SessionEnvironment | null> {
    await this.ready;
    return this.environments.getEnvironment(id);
  }

  async updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): Promise<void> {
    await this.ready;
    await this.environments.updateEnvironmentSyncState(id, state, options);
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.ready;
    await this.environments.deleteEnvironment(environmentId);
  }

  async deleteEnvironmentSessions(environmentId: string): Promise<void> {
    await this.ready;
    await this.environments.deleteEnvironmentSessions(environmentId);
  }

  async listProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
    await this.ready;
    return this.sessions.listProjects(options);
  }

  async addOpenVikingWorkspace(input: AddOpenVikingWorkspaceInput): Promise<OpenVikingWorkspace> {
    await this.ready;
    return this.openVikingMemory.addWorkspace(input);
  }

  async listOpenVikingWorkspaces(): Promise<OpenVikingWorkspace[]> {
    await this.ready;
    return this.openVikingMemory.listWorkspaces();
  }

  async getOpenVikingWorkspace(id: string): Promise<OpenVikingWorkspace | null> {
    await this.ready;
    return this.openVikingMemory.getWorkspace(id);
  }

  async findOpenVikingWorkspaceByRootPath(rootPath: string): Promise<OpenVikingWorkspace | null> {
    await this.ready;
    return this.openVikingMemory.findWorkspaceByRootPath(rootPath);
  }

  async findOpenVikingWorkspaceByIdentity(identity: string): Promise<OpenVikingWorkspace | null> {
    await this.ready;
    return this.openVikingMemory.findWorkspaceByIdentity(identity);
  }

  async relinkOpenVikingWorkspace(
    id: string,
    rootPath: string,
    displayName: string,
  ): Promise<OpenVikingWorkspace> {
    await this.ready;
    return this.openVikingMemory.relinkWorkspace(id, rootPath, displayName);
  }

  async setOpenVikingWorkspaceManaged(
    id: string,
    managed: boolean,
  ): Promise<OpenVikingWorkspace> {
    await this.ready;
    return this.openVikingMemory.setWorkspaceManaged(id, managed);
  }

  async deleteOpenVikingWorkspace(id: string): Promise<boolean> {
    await this.ready;
    return this.openVikingMemory.deleteWorkspace(id);
  }

  async updateOpenVikingImportJob(
    workspaceId: string,
    input: UpdateOpenVikingImportJobInput,
  ): Promise<OpenVikingImportJob> {
    await this.ready;
    return this.openVikingMemory.updateImportJob(workspaceId, input);
  }

  async getOpenVikingImportJob(workspaceId: string): Promise<OpenVikingImportJob | null> {
    await this.ready;
    return this.openVikingMemory.getImportJob(workspaceId);
  }

  async setOpenVikingImportSelection(
    workspaceId: string,
    sessionKeys: string[],
  ): Promise<OpenVikingImportJob> {
    await this.ready;
    return this.openVikingMemory.setImportSelection(workspaceId, sessionKeys);
  }

  async hasOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<boolean> {
    await this.ready;
    return this.openVikingMemory.hasImportedTurn(workspaceId, sourceTurnId, fingerprint);
  }

  async recordOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<void> {
    await this.ready;
    await this.openVikingMemory.recordImportedTurn(workspaceId, sourceTurnId, fingerprint);
  }

  async listOpenVikingImportedTurns(
    workspaceId: string,
  ): Promise<OpenVikingImportedTurnCheckpoint[]> {
    await this.ready;
    return this.openVikingMemory.listImportedTurns(workspaceId);
  }

  async listOpenVikingSessionCheckpoints(
    workspaceId: string,
  ): Promise<OpenVikingSessionCheckpoint[]> {
    await this.ready;
    return this.openVikingMemory.listSessionCheckpoints(workspaceId);
  }

  async recordOpenVikingSessionCheckpoint(
    workspaceId: string,
    sessionKey: string,
    sourceRevision: string,
    importedTurns: number,
  ): Promise<void> {
    await this.ready;
    await this.openVikingMemory.recordSessionCheckpoint(
      workspaceId,
      sessionKey,
      sourceRevision,
      importedTurns,
    );
  }

  async syncOpenVikingImportTasks(
    workspaceId: string,
    inputs: CreateOpenVikingImportTaskInput[],
    activeRevisions: Array<{ sessionKey: string; sourceRevision: string }>,
  ): Promise<OpenVikingImportTask[]> {
    await this.ready;
    return this.openVikingMemory.syncImportTasks(workspaceId, inputs, activeRevisions);
  }

  async listOpenVikingImportTasks(workspaceId: string): Promise<OpenVikingImportTask[]> {
    await this.ready;
    return this.openVikingMemory.listImportTasks(workspaceId);
  }

  async beginOpenVikingImportTaskAttempt(taskId: string): Promise<OpenVikingImportTask> {
    await this.ready;
    return this.openVikingMemory.beginImportTaskAttempt(taskId);
  }

  async waitForOpenVikingImportTask(taskId: string, remoteTaskId: string): Promise<void> {
    await this.ready;
    await this.openVikingMemory.waitForImportTask(taskId, remoteTaskId);
  }

  async completeOpenVikingImportTask(taskId: string): Promise<void> {
    await this.ready;
    await this.openVikingMemory.completeImportTask(taskId);
  }

  async failOpenVikingImportTask(taskId: string, error: string): Promise<void> {
    await this.ready;
    await this.openVikingMemory.failImportTask(taskId, error);
  }

  async getSession(sessionKey: string): Promise<SessionSearchResult | null> {
    await this.ready;
    return this.sessions.getSession(sessionKey);
  }

  async getSessionSourceArtifacts(sessionKey: string): Promise<SessionSourceArtifact[]> {
    const session = await this.getSession(sessionKey);
    if (!session || !isLocalSessionStorage(session)) return [];
    if (session.source === "cursor-agent" && session.sourceAvailable === false) return [];
    return readSessionSourceArtifacts(session);
  }

  async findByRawId(rawId: string): Promise<SessionSearchResult | null> {
    await this.ready;
    return this.sessions.findByRawId(rawId);
  }

  async setAiSummary(sessionKey: string, summary: string, model: string): Promise<boolean> {
    await this.ready;
    return this.sessions.setAiSummary(sessionKey, summary, model);
  }

  async listSessionsNeedingSummary(
    now: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<SessionSearchResult[]> {
    await this.ready;
    return this.sessions.listSessionsNeedingSummary(now, maxAgeMs, limit);
  }

  async getMessageCount(sessionKey: string): Promise<number> {
    await this.ready;
    return this.turns.getMessageCount(sessionKey);
  }

  async getMessages(sessionKey: string, offset = 0, limit = 120): Promise<SessionMessage[]> {
    await this.ready;
    return this.turns.getMessages(sessionKey, offset, limit);
  }

  async getAllMessages(sessionKey: string): Promise<SessionMessage[]> {
    await this.ready;
    return this.turns.getAllMessages(sessionKey);
  }

  async getCodexIncrementalState(sessionKey: string): Promise<CodexIncrementalState> {
    await this.ready;
    return this.turns.getCodexIncrementalState(sessionKey);
  }

  async getAttachmentFile(sessionKey: string, attachmentId: string) {
    await this.ready;
    return this.sessions.getAttachmentFile(sessionKey, attachmentId);
  }

  async listSessionTurns(sessionKey: string): Promise<SessionTurnSummary[]> {
    await this.ready;
    return this.turns.listSessionTurns(sessionKey);
  }

  async getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null> {
    await this.ready;
    return this.turns.getSessionTurn(sessionKey, turnId);
  }

  async getTraceEvents(
    sessionKey: string,
    options: TraceEventQueryOptions = {},
  ): Promise<SessionTraceEvent[]> {
    await this.ready;
    return this.turns.getTraceEvents(sessionKey, options);
  }

  async getTokenEvents(sessionKey: string): Promise<TokenUsageEvent[]> {
    await this.ready;
    return this.sessions.getTokenEvents(sessionKey);
  }

  async isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean> {
    await this.ready;
    return this.skills.isSkillUsageSourceFresh(source);
  }

  async upsertSkillUsageSource(
    source: SkillUsageSource,
    events: readonly SkillUsageEvent[],
  ): Promise<void> {
    await this.ready;
    await this.skills.upsertSkillUsageSource(source, events);
  }

  async pruneSkillUsageSources(activePaths: readonly string[]): Promise<void> {
    await this.ready;
    await this.skills.pruneSkillUsageSources(activePaths);
  }

  async listRecentSkillTriggers(
    options: { skill?: string; limit?: number } = {},
  ): Promise<SkillTriggerLink[]> {
    await this.ready;
    return this.skills.listRecentSkillTriggers(options);
  }

  async listSkillUsageOverview(): Promise<SkillUsageOverviewRow[]> {
    await this.ready;
    return this.skills.listSkillUsageOverview();
  }

  async getSkillPerformanceSignals(skill: string): Promise<SkillPerformanceSignals> {
    await this.ready;
    return this.skills.getSkillPerformanceSignals(skill);
  }

  async listSkillVersionGroups(skill: string): Promise<SkillVersionGroup[]> {
    await this.ready;
    return this.skills.listSkillVersionGroups(skill);
  }

  async listSkillToolOutcomes(skill: string): Promise<SkillToolOutcome[]> {
    await this.ready;
    return this.skills.listSkillToolOutcomes(skill);
  }

  async hasClaudeHookUsageEvents(): Promise<boolean> {
    await this.ready;
    return this.skills.hasClaudeHookUsageEvents();
  }

  async getSkillUsageSnapshot(): Promise<SkillUsageSnapshot> {
    await this.ready;
    return this.skills.getSkillUsageSnapshot();
  }

  async upsertSkillSyncBinding(binding: SkillSyncBinding): Promise<void> {
    await this.ready;
    await this.skills.upsertSkillSyncBinding(binding);
  }

  async getSkillSyncBindingForLocalPath(localSkillPath: string): Promise<SkillSyncBinding | null> {
    await this.ready;
    return this.skills.getSkillSyncBindingForLocalPath(localSkillPath);
  }

  async getSkillSyncBindingForPortableIdentity(
    portableIdentity: string,
  ): Promise<SkillSyncBinding | null> {
    await this.ready;
    return this.skills.getSkillSyncBindingForPortableIdentity(portableIdentity);
  }

  async getSkillSyncBindingForRemoteId(remoteSkillId: string): Promise<SkillSyncBinding | null> {
    await this.ready;
    return this.skills.getSkillSyncBindingForRemoteId(remoteSkillId);
  }

  async listSkillSyncBindings(): Promise<SkillSyncBinding[]> {
    await this.ready;
    return this.skills.listSkillSyncBindings();
  }

  async deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: readonly string[]): Promise<void> {
    await this.ready;
    await this.skills.deleteSkillSyncBindingsForRemoteIds(remoteSkillIds);
  }

  async upsertSessionSyncBinding(binding: SessionSyncBinding): Promise<void> {
    await this.ready;
    await this.metadata.upsertSessionSyncBinding(binding);
  }

  async getSessionSyncBindingForLocalKey(
    localSessionKey: string,
  ): Promise<SessionSyncBinding | null> {
    await this.ready;
    return this.metadata.getSessionSyncBindingForLocalKey(localSessionKey);
  }

  async getSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<SessionSyncBinding | null> {
    await this.ready;
    return this.metadata.getSessionSyncBindingForRemoteId(remoteSessionId);
  }

  async listSessionSyncBindings(): Promise<SessionSyncBinding[]> {
    await this.ready;
    return this.metadata.listSessionSyncBindings();
  }

  async deleteSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<void> {
    await this.ready;
    await this.metadata.deleteSessionSyncBindingForRemoteId(remoteSessionId);
  }

  async getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): Promise<string> {
    await this.ready;
    return this.metadata.getApiProviderKey(target, providerId);
  }

  async setApiProviderKey(
    target: ApiProviderKeyTarget,
    providerId: string,
    apiKey: string,
  ): Promise<void> {
    await this.ready;
    await this.metadata.setApiProviderKey(target, providerId, apiKey);
  }

  async recordSessionMigration(record: SessionMigrationRecord): Promise<void> {
    await this.ready;
    await this.metadata.recordSessionMigration(record);
  }

  async listSessionMigrations(sourceSessionKey: string): Promise<SessionMigrationRecord[]> {
    await this.ready;
    return this.metadata.listSessionMigrations(sourceSessionKey);
  }

  async getStats(options: SessionStatsOptions = {}, now = Date.now()): Promise<SessionStats> {
    await this.ready;
    return this.stats.getStats(options, now);
  }

  async getStatsTrend(options: SessionStatsOptions = {}, now = Date.now()): Promise<SessionStatsTrend> {
    await this.ready;
    return this.stats.getStatsTrend(options, now);
  }

  async searchSessions(options: SearchOptions = {}): Promise<SessionSearchResult[]> {
    await this.ready;
    return this.search.searchSessions(options);
  }

  async searchSessionPage(options: SearchOptions = {}): Promise<SessionSearchPage> {
    await this.ready;
    return this.search.searchSessionPage(options);
  }

  async clearSearchIndex(): Promise<void> {
    await this.ready;
    await this.sessions.clearSearchIndex();
  }

  async deleteSessionsBySource(sources: readonly SessionSource[]): Promise<void> {
    await this.ready;
    await this.sessions.deleteSessionsBySource(sources);
  }

  async listSavedSearches(): Promise<SavedSearch[]> {
    await this.ready;
    return this.savedSearches.listSavedSearches();
  }

  async createSavedSearch(name: string, options: SearchOptions): Promise<SavedSearch> {
    await this.ready;
    return this.savedSearches.createSavedSearch(name, options);
  }

  async deleteSavedSearch(id: number): Promise<boolean> {
    await this.ready;
    return this.savedSearches.deleteSavedSearch(id);
  }

  async touchSavedSearch(id: number): Promise<void> {
    await this.ready;
    await this.savedSearches.touchSavedSearch(id);
  }

  async recordSearch(query: string, resultCount: number, options?: SearchOptions): Promise<void> {
    await this.ready;
    await this.historyStore.recordSearch(query, resultCount, options);
  }

  async listRecentSearches(limit = 20): Promise<SearchHistoryEntry[]> {
    await this.ready;
    return this.historyStore.listRecentSearches(limit);
  }

  async searchHistory(query: string, limit = 20): Promise<SearchHistoryEntry[]> {
    await this.ready;
    return this.historyStore.searchHistory(query, limit);
  }

  async clearSearchHistory(): Promise<void> {
    await this.ready;
    await this.historyStore.clearHistory();
  }

  async getSessionFamily(sessionKey: string): Promise<SessionFamilyResult> {
    await this.ready;
    return findSessionFamily(this.database, sessionKey);
  }
}
