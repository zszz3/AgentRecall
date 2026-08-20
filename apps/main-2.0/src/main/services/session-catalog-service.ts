import type { IndexStatus } from "../../core/indexer";
import {
  liveSessionDeleteKey,
  normalizeSessionDeleteOptions,
  type SessionBulkDeletePreview,
  type SessionBulkDeleteRequest,
  type SessionBulkDeleteResult,
} from "../../core/session-bulk-delete";
import {
  canDeleteSessionLocally,
  isLocalSessionEnvironment,
  isSharedSessionSourceDatabase,
} from "../../core/session-environment";
import type { SessionStore, TraceEventQueryOptions } from "../../core/session-store";
import type {
  LiveSessionSnapshot,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  SearchOptions,
  SessionEnvironment,
  SessionMessage,
  SessionSearchPage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionStatsTrend,
  SessionTraceEvent,
  SessionTurnDetail,
  SessionTurnSummary,
  TagListOptions,
} from "../../core/types";
import { SessionBulkDeleteService } from "./session-bulk-delete-service";

export interface SessionCatalogServiceDependencies {
  store: SessionStore;
  listProjects?: (options?: ProjectQueryOptions) => Promise<ProjectSummary[]>;
  visibleSearchOptions(options?: SearchOptions): SearchOptions;
  visibleStatsOptions(options?: SessionStatsOptions): SessionStatsOptions;
  visibleProjectOptions(): ProjectQueryOptions;
  ensureRemoteDetails(sessionKey: string): Promise<void>;
  hasRemoteDetails(sessionKey: string): Promise<boolean>;
  requireWslEnvironment(session: SessionSearchResult): Promise<SessionEnvironment>;
  requireSshEnvironment(session: SessionSearchResult): Promise<SessionEnvironment | null>;
  fetchRemoteMessages(
    environment: SessionEnvironment,
    session: SessionSearchResult,
    offset: number,
    limit: number,
  ): Promise<SessionMessage[]>;
  loadLiveSessions(fresh?: boolean): Promise<LiveSessionSnapshot>;
  refreshIndex(): Promise<IndexStatus>;
  getIndexStatus(): IndexStatus;
  setCustomTitle(sessionKey: string, title: string | null): Promise<void>;
}

/**
 * Owns the Session catalog boundary used by the desktop UI.
 *
 * Remote hydration, visibility policy, and local persistence deliberately meet
 * here so IPC handlers and windows do not need to understand those branches.
 */
export class SessionCatalogService {
  private readonly bulkDelete: SessionBulkDeleteService;
  private openSessionKey: string | undefined;

  constructor(private readonly dependencies: SessionCatalogServiceDependencies) {
    this.bulkDelete = new SessionBulkDeleteService(dependencies.store);
  }

  search(options: SearchOptions): Promise<SessionSearchResult[]> {
    return this.dependencies.store.searchSessions(this.dependencies.visibleSearchOptions(options));
  }

  searchPage(options: SearchOptions): Promise<SessionSearchPage> {
    return this.dependencies.store.searchSessionPage(this.dependencies.visibleSearchOptions(options));
  }

  async findByRawId(rawId: string): Promise<SessionSearchResult | null> {
    return this.dependencies.store.findByRawId(rawId);
  }

  async get(sessionKey: string): Promise<SessionSearchResult | null> {
    await this.dependencies.store.markOpened(sessionKey);
    return this.dependencies.store.getSession(sessionKey);
  }

  async listTurns(sessionKey: string): Promise<SessionTurnSummary[]> {
    await this.dependencies.ensureRemoteDetails(sessionKey);
    return this.dependencies.store.listSessionTurns(sessionKey);
  }

  async getTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null> {
    await this.dependencies.ensureRemoteDetails(sessionKey);
    return this.dependencies.store.getSessionTurn(sessionKey, turnId);
  }

  async getMessages(
    sessionKey: string,
    offset = 0,
    limit = 120,
  ): Promise<SessionMessage[]> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (
      session
      && !isLocalSessionEnvironment(session)
      && !await this.dependencies.hasRemoteDetails(sessionKey)
    ) {
      if (session.messageCount <= 0) return [];
      const environment = session.environmentKind === "wsl"
        ? await this.dependencies.requireWslEnvironment(session)
        : await this.dependencies.requireSshEnvironment(session);
      if (!environment) return [];
      return this.dependencies.fetchRemoteMessages(environment, session, offset, limit);
    }
    await this.dependencies.ensureRemoteDetails(sessionKey);
    return this.dependencies.store.getMessages(sessionKey, offset, limit);
  }

  async getTraceEvents(
    sessionKey: string,
    options?: TraceEventQueryOptions,
  ): Promise<SessionTraceEvent[]> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (
      session
      && !isLocalSessionEnvironment(session)
      && !await this.dependencies.hasRemoteDetails(sessionKey)
    ) {
      return [];
    }
    await this.dependencies.ensureRemoteDetails(sessionKey);
    return this.dependencies.store.getTraceEvents(sessionKey, options);
  }

  getLiveSessions(fresh = false): Promise<LiveSessionSnapshot> {
    return this.dependencies.loadLiveSessions(fresh);
  }

  getStats(options?: SessionStatsOptions): Promise<SessionStats> {
    return this.dependencies.store.getStats(this.dependencies.visibleStatsOptions(options));
  }

  getStatsTrend(options?: SessionStatsOptions): Promise<SessionStatsTrend> {
    return this.dependencies.store.getStatsTrend(this.dependencies.visibleStatsOptions(options));
  }

  listTags(options?: TagListOptions): Promise<string[]> {
    return this.dependencies.store.listTags({
      ...this.dependencies.visibleProjectOptions(),
      ...options,
    });
  }

  listProjects(options?: ProjectQueryOptions): Promise<ProjectSummary[]> {
    const query = {
      ...this.dependencies.visibleProjectOptions(),
      ...options,
    };
    return this.dependencies.listProjects
      ? this.dependencies.listProjects(query)
      : this.dependencies.store.listProjects(query);
  }

  listTagsByProject(): Promise<ProjectTagEntry[]> {
    return this.dependencies.store.listTagsByProject(this.dependencies.visibleProjectOptions());
  }

  listEnvironments(): Promise<SessionEnvironment[]> {
    return this.dependencies.store.listEnvironments();
  }

  setCustomTitle(sessionKey: string, title: string | null): Promise<void> {
    return this.dependencies.setCustomTitle(sessionKey, title);
  }

  addTag(sessionKey: string, tagName: string): Promise<void> {
    return this.dependencies.store.addTag(sessionKey, tagName);
  }

  removeTag(sessionKey: string, tagName: string): Promise<void> {
    return this.dependencies.store.removeTag(sessionKey, tagName);
  }

  deleteTag(tagName: string): Promise<void> {
    return this.dependencies.store.deleteTag(tagName);
  }

  setFavorited(sessionKey: string, favorited: boolean): Promise<void> {
    return this.dependencies.store.setFavorited(sessionKey, favorited);
  }

  setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    return this.dependencies.store.setHidden(sessionKey, hidden);
  }

  setOpenSession(sessionKey?: string): void {
    this.openSessionKey = sessionKey?.trim() || undefined;
  }

  async delete(sessionKey: string, options?: unknown): Promise<boolean> {
    const normalizedOptions = normalizeSessionDeleteOptions(options);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (session?.source === "pi-cli" || session?.source === "workbuddy-cli" || session?.source === "kimi-cli") {
      const label = session.source === "pi-cli" ? "Pi" : session.source === "workbuddy-cli" ? "WorkBuddy" : "Kimi Code";
      throw new Error(`${label} session source files are read-only.`);
    }
    if (session && !canDeleteSessionLocally(session)) {
      throw new Error("Cannot delete sessions stored on SSH remote environments.");
    }
    if (
      session?.environmentKind === "wsl"
      && isSharedSessionSourceDatabase(session)
      && session.sourceAvailable !== false
    ) {
      throw new Error("Cannot delete shared source databases on WSL by removing the database file.");
    }
    if (!session) return false;
    const request = await this.withFreshLiveSessions({ sessionKeys: [sessionKey], liveSessionKeys: [] });
    if (session.environmentKind === "ssh" || isSharedSessionSourceDatabase(session)) {
      const prepared = await this.bulkDelete.prepareSingleDelete(request, normalizedOptions);
      if (
        session.environmentKind === "wsl"
        && session.sourceAvailable === false
        && isSharedSessionSourceDatabase(session)
      ) {
        return (await this.dependencies.store.deleteSessionRecords([sessionKey])).includes(sessionKey);
      }
      const preparedTarget = prepared.allRows.find((target) => target.sessionKey === sessionKey);
      if (!preparedTarget) return false;
      if (prepared.allRows.some((target) => !canDeleteSessionLocally(target))) {
        throw new Error("Cannot delete sessions stored on SSH remote environments.");
      }
      if (
        prepared.allRows.some((target) => (
          target.environmentKind === "wsl"
          && target.sourceAvailable
          && isSharedSessionSourceDatabase(target)
        ))
      ) {
        throw new Error("Cannot delete shared source databases on WSL by removing the database file.");
      }
      return this.dependencies.store.deleteExactSessionTargets(prepared.allRows, sessionKey);
    }
    const result = await this.bulkDelete.delete(request, {
      confirmed: normalizedOptions.confirmed,
      allowLiveSessions: normalizedOptions.allowLiveSessions,
      allowUnverifiedLiveSessions: normalizedOptions.allowUnverifiedLiveSessions,
      confirmationFingerprint: normalizedOptions.confirmationFingerprint,
      requireSingleSession: true,
    });
    if (result.failed[0]) throw new Error(result.failed[0].message);
    return result.deletedSessionKeys.includes(sessionKey);
  }

  previewBulkDelete(request: SessionBulkDeleteRequest): Promise<SessionBulkDeletePreview> {
    return this.bulkDelete.preview({ ...request, openSessionKey: this.openSessionKey });
  }

  async bulkDeleteSessions(request: SessionBulkDeleteRequest): Promise<SessionBulkDeleteResult> {
    return this.bulkDelete.delete(await this.withFreshLiveSessions({
      ...request,
      openSessionKey: this.openSessionKey,
    }));
  }

  private async withFreshLiveSessions(request: SessionBulkDeleteRequest): Promise<SessionBulkDeleteRequest> {
    const liveSessionKeys = new Set(request.liveSessionKeys);
    let liveSessionCheckFailed = request.liveSessionCheckFailed === true;
    try {
      const snapshot = await this.dependencies.loadLiveSessions(true);
      if (snapshot.error) liveSessionCheckFailed = true;
      for (const session of snapshot.sessions) liveSessionKeys.add(liveSessionDeleteKey(session));
    } catch {
      liveSessionCheckFailed = true;
    }
    return {
      ...request,
      openSessionKey: this.openSessionKey,
      liveSessionKeys: [...liveSessionKeys],
      liveSessionCheckFailed,
    };
  }

  refreshIndex(): Promise<IndexStatus> {
    return this.dependencies.refreshIndex();
  }

  getIndexStatus(): IndexStatus {
    return this.dependencies.getIndexStatus();
  }
}
