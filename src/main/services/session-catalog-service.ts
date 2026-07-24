import type { IndexStatus } from "../../core/indexer";
import { isLocalSessionEnvironment } from "../../core/session-environment";
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

export interface SessionCatalogServiceDependencies {
  store: SessionStore;
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
  loadLiveSessions(): Promise<LiveSessionSnapshot>;
  refreshIndex(): Promise<IndexStatus>;
  getIndexStatus(): IndexStatus;
  setCustomTitle(sessionKey: string, title: string | null): Promise<void>;
  deleteWslSession(environment: SessionEnvironment, filePath: string): Promise<void>;
}

/**
 * Owns the Session catalog boundary used by the desktop UI.
 *
 * Remote hydration, visibility policy, and local persistence deliberately meet
 * here so IPC handlers and windows do not need to understand those branches.
 */
export class SessionCatalogService {
  constructor(private readonly dependencies: SessionCatalogServiceDependencies) {}

  search(options: SearchOptions): Promise<SessionSearchResult[]> {
    return this.dependencies.store.searchSessions(this.dependencies.visibleSearchOptions(options));
  }

  searchPage(options: SearchOptions): Promise<SessionSearchPage> {
    return this.dependencies.store.searchSessionPage(this.dependencies.visibleSearchOptions(options));
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

  getLiveSessions(): Promise<LiveSessionSnapshot> {
    return this.dependencies.loadLiveSessions();
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
    return this.dependencies.store.listProjects({
      ...this.dependencies.visibleProjectOptions(),
      ...options,
    });
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

  setPinned(sessionKey: string, pinned: boolean): Promise<void> {
    return this.dependencies.store.setPinned(sessionKey, pinned);
  }

  setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    return this.dependencies.store.setHidden(sessionKey, hidden);
  }

  async delete(sessionKey: string): Promise<boolean> {
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || session.environmentKind !== "wsl") {
      return this.dependencies.store.deleteSession(sessionKey);
    }
    const environment = await this.dependencies.requireWslEnvironment(session);
    await this.dependencies.deleteWslSession(environment, session.filePath);
    return this.dependencies.store.deleteSessionRecord(sessionKey);
  }

  refreshIndex(): Promise<IndexStatus> {
    return this.dependencies.refreshIndex();
  }

  getIndexStatus(): IndexStatus {
    return this.dependencies.getIndexStatus();
  }
}
