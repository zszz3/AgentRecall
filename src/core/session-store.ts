import * as fs from "node:fs";

import type {
  SkillUsageEvent,
  SkillUsageSnapshot,
  SkillUsageSource,
} from "./skill-usage";
import { PostgresDatabase } from "./postgres/database";
import { PostgresEnvironmentRepository } from "./postgres/environment-repository";
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
  type SkillSyncBinding,
} from "./postgres/skill-repository";
import { findRelatedSessions, type RelatedSession } from "./related-sessions";
import type {
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

export type {
  ApiProviderKeyTarget,
  SessionSyncBinding,
  SessionSyncDirection,
} from "./postgres/metadata-repository";
export type { SavedSearch } from "./store/saved-searches";
export type { SearchHistoryEntry } from "./store/search-history-store";
export type { RelatedSession } from "./related-sessions";
export type { TraceEventQueryOptions } from "./postgres/session-turn-repository";
export type {
  SkillSyncBinding,
  SkillSyncDirection,
} from "./postgres/skill-repository";

export class SessionStore {
  private readonly sessions: PostgresSessionRepository;
  private readonly search: PostgresSessionSearchRepository;
  private readonly stats: PostgresSessionStatsRepository;
  private readonly turns: PostgresSessionTurnRepository;
  private readonly environments: PostgresEnvironmentRepository;
  private readonly metadata: PostgresMetadataRepository;
  private readonly skills: PostgresSkillRepository;
  private readonly savedSearches: SavedSearchStore;
  private readonly historyStore: SearchHistoryStore;

  constructor(
    private readonly database: PostgresDatabase,
    private readonly ready: Promise<void> = Promise.resolve(),
  ) {
    this.sessions = new PostgresSessionRepository(database);
    this.search = new PostgresSessionSearchRepository(database);
    this.stats = new PostgresSessionStatsRepository(database);
    this.turns = new PostgresSessionTurnRepository(database);
    this.environments = new PostgresEnvironmentRepository(database);
    this.metadata = new PostgresMetadataRepository(database);
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
  ): Promise<void> {
    await this.ready;
    await this.sessions.upsertIndexedSession(session, messages, tokenEvents, traceEvents);
  }

  async isIndexedSessionFresh(session: IndexedSession): Promise<boolean> {
    await this.ready;
    return this.sessions.isIndexedSessionFresh(session);
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    await this.ready;
    await this.sessions.touchIndexedAtIfMissing(sessionKey);
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>> {
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

  async setPinned(sessionKey: string, pinned: boolean): Promise<void> {
    await this.ready;
    await this.sessions.setPinned(sessionKey, pinned);
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
    const target = await this.sessions.getSessionDeletionTarget(sessionKey);
    if (!target) return false;
    if (target.source === "hermes") throw new Error("Cannot delete shared Hermes source database.");
    if (target.source === "opencode-cli") throw new Error("Cannot delete shared OpenCode source database.");
    deleteSessionSourceFile(target.filePath);
    return this.sessions.deleteSessionRecord(sessionKey);
  }

  async deleteSessionRecord(sessionKey: string): Promise<boolean> {
    await this.ready;
    return this.sessions.deleteSessionRecord(sessionKey);
  }

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    await this.ready;
    return this.sessions.migrateSessionKeyPreservingUserState(legacyKey, targetKey);
  }

  async listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
  ): Promise<string[]> {
    await this.ready;
    return this.sessions.listSessionKeysByFilePath(environmentId, filePaths);
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

  async getSession(sessionKey: string): Promise<SessionSearchResult | null> {
    await this.ready;
    return this.sessions.getSession(sessionKey);
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

  async getRelatedSessions(sessionKey: string, limit = 8): Promise<RelatedSession[]> {
    await this.ready;
    return findRelatedSessions(this.database, sessionKey, limit);
  }
}

function deleteSessionSourceFile(filePath: string): void {
  const normalized = filePath.trim();
  if (!normalized) throw new Error("Session source file path is missing.");
  try {
    const stat = fs.lstatSync(normalized);
    if (stat.isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(normalized, { force: true });
}
