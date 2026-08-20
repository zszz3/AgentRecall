import { deleteDeepSeekCliSessionDirectory } from "./deepseek-harness";
import { deleteHermesSessions } from "./hermes-session-writer";
import {
  canDeleteSessionLocally,
  isLocalSessionStorage,
  isSharedSessionSourceDatabase,
} from "./session-environment";
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
  type OpenVikingSourceSessionReference,
  type RecordOpenVikingMemoryFeedbackInput,
  type SaveOpenVikingMemoryControlInput,
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
import type {
  OpenVikingApplyCommitInput,
  OpenVikingCommitRun,
  OpenVikingControlDiagnostics,
  OpenVikingLockedMemoryConflict,
  OpenVikingMemoryControl,
  OpenVikingMemoryEvidence,
  OpenVikingMemoryFeedback,
  OpenVikingOperationEvent,
  OpenVikingRecallTrace,
} from "./openviking-memory-control";
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
export type {
  TraceEventQueryOptions,
} from "./postgres/session-turn-repository";
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
  private openVikingControlChangedHandler: (() => void | Promise<void>) | null = null;

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

  setOpenVikingControlChangedHandler(handler: (() => void | Promise<void>) | null): void {
    this.openVikingControlChangedHandler = handler;
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
    return this.deleteExactSessionTargets(targets, sessionKey);
  }

  async deleteExactSessionTargets(
    targets: readonly SessionBulkDeleteTarget[],
    requestedSessionKey: string,
  ): Promise<boolean> {
    await this.ready;
    const target = targets.find((item) => item.sessionKey === requestedSessionKey);
    if (!target) return false;
    if (target.source === "pi-cli" || target.source === "workbuddy-cli" || target.source === "kimi-cli") {
      const label = target.source === "pi-cli" ? "Pi" : target.source === "workbuddy-cli" ? "WorkBuddy" : "Kimi Code";
      throw new Error(`${label} session source files are read-only.`);
    }
    if (!canDeleteSessionLocally(target)) {
      throw new Error("Cannot delete sessions stored on SSH remote environments.");
    }
    if (
      target.environmentKind === "wsl"
      && target.sourceAvailable
      && isSharedSessionSourceDatabase(target)
    ) {
      throw new Error("Cannot delete shared source databases on WSL by removing the database file.");
    }
    for (const item of targets) {
      if (!canDeleteSessionLocally(item)) {
        throw new Error("Cannot delete sessions stored on SSH remote environments.");
      }
      if (
        item.environmentKind === "wsl"
        && item.sourceAvailable
        && isSharedSessionSourceDatabase(item)
      ) {
        throw new Error("Cannot delete shared source databases on WSL by removing the database file.");
      }
    }
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
      return this.deleteSessionTargetRecords(targets, requestedSessionKey);
    }
    if (target.source === "hermes") {
      if (target.sourceAvailable) {
        const idsByFilePath = new Map<string, string[]>();
        for (const item of targets.filter((item) => item.sourceAvailable)) {
          const rawIds = idsByFilePath.get(item.filePath) ?? [];
          rawIds.push(item.rawId);
          idsByFilePath.set(item.filePath, rawIds);
        }
        for (const [filePath, rawIds] of idsByFilePath) deleteHermesSessions(filePath, rawIds);
      }
      return this.deleteSessionTargetRecords(targets, requestedSessionKey);
    }
    if (target.source === "opencode-cli") {
      if (!target.sourceAvailable) return this.deleteSessionTargetRecords(targets, requestedSessionKey);
      throw new Error("Cannot delete shared OpenCode source database.");
    }
    if (target.source === "codewiz-cli") {
      if (!target.sourceAvailable) return this.deleteSessionTargetRecords(targets, requestedSessionKey);
      throw new Error("Cannot delete shared CodeWiz source database.");
    }
    if (target.source === "deepseek-cli") {
      for (const item of targets) {
        if (item.sourceAvailable) deleteDeepSeekCliSessionDirectory(item.filePath);
      }
      return this.deleteSessionTargetRecords(targets, requestedSessionKey);
    }
    if (target.source === "cursor-agent" && /(^|[\\/])state\.vscdb$/iu.test(target.filePath)) {
      if (!target.sourceAvailable) {
        return this.deleteSessionTargetRecords(targets, requestedSessionKey);
      }
      throw new Error("Cannot delete shared Cursor source database.");
    }
    if (target.source === "codex-app") {
      deleteLocalSessionSources(targets);
    } else if (target.sourceAvailable) {
      deleteLocalSessionSources(targets.filter((item) => item.sourceAvailable));
    }
    return this.deleteSessionTargetRecords(targets, requestedSessionKey);
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

  async invalidateOpenVikingEvidenceForSessions(
    targets: readonly Pick<SessionBulkDeleteTarget, "rawId" | "source">[],
  ): Promise<string[]> {
    await this.ready;
    const references = targets.flatMap((target): OpenVikingSourceSessionReference[] => {
      const sourceAgent = openVikingAgentForSessionSource(target.source);
      return sourceAgent && target.rawId ? [{ sourceSessionId: target.rawId, sourceAgent }] : [];
    });
    const workspaceIds = await this.openVikingMemory.invalidateSourceSessionEvidence(references);
    if (workspaceIds.length > 0) await this.openVikingControlChangedHandler?.();
    return workspaceIds;
  }

  private async deleteSessionTargetRecords(
    targets: readonly SessionBulkDeleteTarget[],
    requestedSessionKey: string,
  ): Promise<boolean> {
    await this.invalidateOpenVikingEvidenceForSessions(targets);
    const deleted = await this.sessions.deleteSessionRecords(targets.map((item) => item.sessionKey), false);
    return deleted.includes(requestedSessionKey);
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

  async listOpenVikingMemoryControls(workspaceId: string): Promise<OpenVikingMemoryControl[]> {
    await this.ready;
    return this.openVikingMemory.listMemoryControls(workspaceId);
  }

  async getOpenVikingMemoryControl(
    workspaceId: string,
    uri: string,
  ): Promise<OpenVikingMemoryControl | null> {
    await this.ready;
    return this.openVikingMemory.getMemoryControl(workspaceId, uri);
  }

  async saveOpenVikingUserMemory(
    input: SaveOpenVikingMemoryControlInput,
  ): Promise<OpenVikingMemoryControl> {
    await this.ready;
    return this.openVikingMemory.saveUserMemory(input);
  }

  async markOpenVikingMemoryDeleted(workspaceId: string, uri: string): Promise<void> {
    await this.ready;
    await this.openVikingMemory.markMemoryDeleted(workspaceId, uri);
  }

  async listOpenVikingMemoryEvidence(
    workspaceId: string,
    uri: string,
  ): Promise<OpenVikingMemoryEvidence[]> {
    await this.ready;
    return this.openVikingMemory.listMemoryEvidence(workspaceId, uri);
  }

  async listOpenVikingMemoryFeedback(
    workspaceId: string,
    uri: string,
  ): Promise<OpenVikingMemoryFeedback[]> {
    await this.ready;
    return this.openVikingMemory.listMemoryFeedback(workspaceId, uri);
  }

  async recordOpenVikingMemoryFeedback(
    input: RecordOpenVikingMemoryFeedbackInput,
  ): Promise<OpenVikingMemoryControl> {
    await this.ready;
    return this.openVikingMemory.recordMemoryFeedback(input);
  }

  async upsertOpenVikingCommitRun(run: OpenVikingCommitRun): Promise<void> {
    await this.ready;
    await this.openVikingMemory.upsertCommitRun(run);
  }

  async applyOpenVikingCommitResult(
    input: OpenVikingApplyCommitInput,
  ): Promise<OpenVikingLockedMemoryConflict[]> {
    await this.ready;
    return this.openVikingMemory.applyCommitResult(input);
  }

  async recordOpenVikingOperationEvent(event: OpenVikingOperationEvent): Promise<void> {
    await this.ready;
    await this.openVikingMemory.recordOperationEvent(event);
  }

  async recordOpenVikingRecallTrace(trace: OpenVikingRecallTrace): Promise<void> {
    await this.ready;
    await this.openVikingMemory.recordRecallTrace(trace);
  }

  async getOpenVikingControlDiagnostics(limit?: number): Promise<OpenVikingControlDiagnostics> {
    await this.ready;
    return this.openVikingMemory.getControlDiagnostics(limit);
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

function openVikingAgentForSessionSource(source: SessionSource): string | null {
  if (source === "codex-cli" || source === "codex-app" || source === "stepcode-codex") return "codex";
  if (source === "claude-cli" || source === "claude-app" || source === "stepcode-claude") return "claude";
  if (source === "opencode-cli") return "opencode";
  return null;
}
