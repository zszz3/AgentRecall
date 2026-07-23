import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  SkillUsageEvent,
  SkillUsageSnapshot,
  SkillUsageSource,
} from "./skill-usage";
import type { SessionStoreDatabase } from "./store/database";
import { EnvironmentStore } from "./store/environments";
import {
  MetadataStore,
  type ApiProviderKeyTarget,
  type SessionSyncBinding,
} from "./store/metadata";
import { SavedSearchStore, type SavedSearch } from "./store/saved-searches";
import { SearchHistoryStore, type SearchHistoryEntry } from "./store/search-history-store";
import { migrateSessionStore } from "./store/schema";
import {
  SessionsStore,
  type TraceEventQueryOptions,
} from "./store/sessions";
import {
  SkillStore,
  type SkillSyncBinding,
} from "./store/skills";
import { findRelatedSessions, type RelatedSession } from "./related-sessions";
import {
  findSessionFamily,
  type SessionFamily,
} from "./session-family";
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
  TagListOptions,
  TokenUsageEvent,
} from "./types";

export type {
  ApiProviderKeyTarget,
  SessionSyncBinding,
  SessionSyncDirection,
} from "./store/metadata";
export type { SavedSearch } from "./store/saved-searches";
export type { SearchHistoryEntry } from "./store/search-history-store";
export type { RelatedSession } from "./related-sessions";
export type {
  SessionFamily,
  SubagentSessionNode,
  SubagentSessionSummary,
} from "./session-family";
export type { TraceEventQueryOptions } from "./store/sessions";
export type { SkillSyncBinding, SkillSyncDirection } from "./store/skills";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

export class SessionStore {
  private readonly db: SessionStoreDatabase;
  private readonly environments: EnvironmentStore;
  private readonly metadata: MetadataStore;
  private readonly sessions: SessionsStore;
  private readonly skills: SkillStore;
  private readonly savedSearches: SavedSearchStore;
  private readonly historyStore: SearchHistoryStore;

  constructor(dbPathOrInstance: string | SessionStoreDatabase) {
    this.db = typeof dbPathOrInstance === "string" ? new DatabaseSync(dbPathOrInstance) : dbPathOrInstance;
    migrateSessionStore(this.db);
    this.environments = new EnvironmentStore(this.db);
    this.metadata = new MetadataStore(this.db);
    const attachmentCacheRoot = typeof dbPathOrInstance === "string"
      ? path.join(path.dirname(dbPathOrInstance), "attachments")
      : null;
    this.sessions = new SessionsStore(this.db, this.environments, attachmentCacheRoot);
    this.skills = new SkillStore(this.db);
    this.savedSearches = new SavedSearchStore(this.db);
    this.historyStore = new SearchHistoryStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  upsertIndexedSession(
    session: IndexedSession,
    messages: SessionMessage[],
    tokenEvents: TokenUsageEvent[] = [],
    traceEvents: SessionTraceEvent[] = [],
  ): void {
    this.sessions.upsertIndexedSession(session, messages, tokenEvents, traceEvents);
  }

  isIndexedSessionFresh(session: IndexedSession): boolean {
    return this.sessions.isIndexedSessionFresh(session);
  }

  touchIndexedAtIfMissing(sessionKey: string): void {
    this.sessions.touchIndexedAtIfMissing(sessionKey);
  }

  listIndexedSessionFiles(
    environmentId = "local",
  ): Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }> {
    return this.sessions.listIndexedSessionFiles(environmentId);
  }

  upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: TokenUsageEvent[],
    messageEvents?: SessionMessageEvent[],
  ): void {
    this.sessions.upsertIndexedSessionSummary(session, messageCount, tokenEvents, messageEvents);
  }

  setCustomTitle(sessionKey: string, title: string | null): void {
    this.sessions.setCustomTitle(sessionKey, title);
  }

  setPinned(sessionKey: string, pinned: boolean): void {
    this.sessions.setPinned(sessionKey, pinned);
  }

  setFavorited(sessionKey: string, favorited: boolean): void {
    this.sessions.setFavorited(sessionKey, favorited);
  }

  setHidden(sessionKey: string, hidden: boolean): void {
    this.sessions.setHidden(sessionKey, hidden);
  }

  deleteSession(sessionKey: string): boolean {
    return this.sessions.deleteSession(sessionKey);
  }

  deleteSessionRecord(sessionKey: string): boolean {
    return this.sessions.deleteSessionRecord(sessionKey);
  }

  migrateSessionKeyPreservingUserState(legacyKey: string, targetKey: string): boolean {
    return this.sessions.migrateSessionKeyPreservingUserState(legacyKey, targetKey);
  }

  listSessionKeysByFilePath(environmentId: string, filePaths: ReadonlySet<string>): string[] {
    return this.sessions.listSessionKeysByFilePath(environmentId, filePaths);
  }

  markOpened(sessionKey: string): void {
    this.sessions.markOpened(sessionKey);
  }

  markResumed(sessionKey: string): void {
    this.sessions.markResumed(sessionKey);
  }

  addTag(sessionKey: string, tagName: string): void {
    this.sessions.addTag(sessionKey, tagName);
  }

  removeTag(sessionKey: string, tagName: string): void {
    this.sessions.removeTag(sessionKey, tagName);
  }

  deleteTag(tagName: string): void {
    this.sessions.deleteTag(tagName);
  }

  listTags(options: TagListOptions = {}): string[] {
    return this.sessions.listTags(options);
  }

  listTagsByProject(options: { excludeSubagents?: boolean } = {}): ProjectTagEntry[] {
    return this.sessions.listTagsByProject(options);
  }

  listEnvironments(): SessionEnvironment[] {
    return this.environments.listEnvironments();
  }

  upsertEnvironment(input: EnvironmentUpsertInput): SessionEnvironment {
    return this.environments.upsertEnvironment(input);
  }

  getEnvironment(id: string): SessionEnvironment | null {
    return this.environments.getEnvironment(id);
  }

  updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): void {
    this.environments.updateEnvironmentSyncState(id, state, options);
  }

  listProjects(options: ProjectQueryOptions = {}): ProjectSummary[] {
    return this.sessions.listProjects(options);
  }

  getSession(sessionKey: string): SessionSearchResult | null {
    return this.sessions.getSession(sessionKey);
  }

  findByRawId(rawId: string): SessionSearchResult | null {
    return this.sessions.findByRawId(rawId);
  }

  setAiSummary(sessionKey: string, summary: string, model: string): boolean {
    return this.sessions.setAiSummary(sessionKey, summary, model);
  }

  listSessionsNeedingSummary(now: number, maxAgeMs: number, limit: number): SessionSearchResult[] {
    return this.sessions.listSessionsNeedingSummary(now, maxAgeMs, limit);
  }

  getMessageCount(sessionKey: string): number {
    return this.sessions.getMessageCount(sessionKey);
  }

  getMessages(sessionKey: string, offset = 0, limit = 120): SessionMessage[] {
    return this.sessions.getMessages(sessionKey, offset, limit);
  }

  getAllMessages(sessionKey: string): SessionMessage[] {
    return this.sessions.getAllMessages(sessionKey);
  }

  getAttachmentFile(sessionKey: string, attachmentId: string) {
    return this.sessions.getAttachmentFile(sessionKey, attachmentId);
  }

  getTraceEvents(sessionKey: string, options: TraceEventQueryOptions = {}): SessionTraceEvent[] {
    return this.sessions.getTraceEvents(sessionKey, options);
  }

  isSkillUsageSourceFresh(source: SkillUsageSource): boolean {
    return this.skills.isSkillUsageSourceFresh(source);
  }

  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): void {
    this.skills.upsertSkillUsageSource(source, events);
  }

  pruneSkillUsageSources(activePaths: string[]): void {
    this.skills.pruneSkillUsageSources(activePaths);
  }

  getSkillUsageSnapshot(): SkillUsageSnapshot {
    return this.skills.getSkillUsageSnapshot();
  }

  upsertSkillSyncBinding(binding: SkillSyncBinding): void {
    this.skills.upsertSkillSyncBinding(binding);
  }

  getSkillSyncBindingForLocalPath(localSkillPath: string): SkillSyncBinding | null {
    return this.skills.getSkillSyncBindingForLocalPath(localSkillPath);
  }

  getSkillSyncBindingForPortableIdentity(portableIdentity: string): SkillSyncBinding | null {
    return this.skills.getSkillSyncBindingForPortableIdentity(portableIdentity);
  }

  getSkillSyncBindingForRemoteId(remoteSkillId: string): SkillSyncBinding | null {
    return this.skills.getSkillSyncBindingForRemoteId(remoteSkillId);
  }

  listSkillSyncBindings(): SkillSyncBinding[] {
    return this.skills.listSkillSyncBindings();
  }

  deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: string[]): void {
    this.skills.deleteSkillSyncBindingsForRemoteIds(remoteSkillIds);
  }

  upsertSessionSyncBinding(binding: SessionSyncBinding): void {
    this.metadata.upsertSessionSyncBinding(binding);
  }

  getSessionSyncBindingForLocalKey(localSessionKey: string): SessionSyncBinding | null {
    return this.metadata.getSessionSyncBindingForLocalKey(localSessionKey);
  }

  getSessionSyncBindingForRemoteId(remoteSessionId: string): SessionSyncBinding | null {
    return this.metadata.getSessionSyncBindingForRemoteId(remoteSessionId);
  }

  listSessionSyncBindings(): SessionSyncBinding[] {
    return this.metadata.listSessionSyncBindings();
  }

  deleteSessionSyncBindingForRemoteId(remoteSessionId: string): void {
    this.metadata.deleteSessionSyncBindingForRemoteId(remoteSessionId);
  }

  getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): string {
    return this.metadata.getApiProviderKey(target, providerId);
  }

  setApiProviderKey(target: ApiProviderKeyTarget, providerId: string, apiKey: string): void {
    this.metadata.setApiProviderKey(target, providerId, apiKey);
  }

  recordSessionMigration(record: SessionMigrationRecord): void {
    this.metadata.recordSessionMigration(record);
  }

  listSessionMigrations(sourceSessionKey: string): SessionMigrationRecord[] {
    return this.metadata.listSessionMigrations(sourceSessionKey);
  }

  getStats(options: SessionStatsOptions = {}, now = Date.now()): SessionStats {
    return this.sessions.getStats(options, now);
  }

  getStatsTrend(options: SessionStatsOptions = {}, now = Date.now()): SessionStatsTrend {
    return this.sessions.getStatsTrend(options, now);
  }

  searchSessions(options: SearchOptions = {}): SessionSearchResult[] {
    return this.sessions.searchSessions(options);
  }

  searchSessionPage(options: SearchOptions = {}): SessionSearchPage {
    return this.sessions.searchSessionPage(options);
  }

  clearSearchIndex(): void {
    this.sessions.clearSearchIndex();
  }

  deleteSessionsBySource(sources: SessionSource[]): void {
    this.sessions.deleteSessionsBySource(sources);
  }

  deleteEnvironment(environmentId: string): void {
    this.environments.deleteEnvironment(environmentId);
  }

  deleteEnvironmentSessions(environmentId: string): void {
    this.environments.deleteEnvironmentSessions(environmentId);
  }

  listSavedSearches(): SavedSearch[] {
    return this.savedSearches.listSavedSearches();
  }

  createSavedSearch(name: string, options: SearchOptions): SavedSearch {
    return this.savedSearches.createSavedSearch(name, options);
  }

  deleteSavedSearch(id: number): boolean {
    return this.savedSearches.deleteSavedSearch(id);
  }

  touchSavedSearch(id: number): void {
    this.savedSearches.touchSavedSearch(id);
  }

  recordSearch(query: string, resultCount: number, options?: SearchOptions): void {
    this.historyStore.recordSearch(query, resultCount, options);
  }

  listRecentSearches(limit = 20): SearchHistoryEntry[] {
    return this.historyStore.listRecentSearches(limit);
  }

  searchHistory(query: string, limit = 20): SearchHistoryEntry[] {
    return this.historyStore.searchHistory(query, limit);
  }

  clearSearchHistory(): void {
    this.historyStore.clearHistory();
  }

  getRelatedSessions(sessionKey: string, limit = 8): RelatedSession[] {
    return findRelatedSessions(this.db, sessionKey, limit);
  }

  getSessionFamily(sessionKey: string): SessionFamily {
    return findSessionFamily(this.db, sessionKey);
  }
}

export function createInMemoryStore(): SessionStore {
  return new SessionStore(new DatabaseSync(":memory:"));
}
