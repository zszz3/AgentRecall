import * as path from "node:path";
import type { AppSettings } from "../../core/platform";
import { migrationAgentForSource } from "../../core/session-migration";
import { restoreRemotePortableSession, type RemoteSessionRestoreDependencies } from "../../core/remote-session-restore";
import {
  buildRemoteSessionSetupSql,
  buildRemoteSessionUploadFromStore,
  buildSessionSyncItems,
  SupabaseRemoteSessionClient,
  type RemoteSessionDeleteResult,
  type RemoteSessionDetailSnapshot,
  type RemoteSessionListItem,
  type RemoteSessionStatus,
  type RemoteSessionUploadResult,
  type SessionSyncItem,
} from "../../core/remote-session-sync";
import type { SessionStore } from "../../core/session-store";
import {
  clearSessionSyncQueue,
  coalesceSessionSyncQueueEvents,
  readSessionSyncQueue,
  removeSessionSyncQueueFiles,
  type SessionSyncHookStatus,
  type SessionSyncQueueEvent,
} from "../../core/session-sync-queue";
import {
  AUTO_SESSION_SYNC_QUEUE_INTERVAL_MS,
  STALE_SESSION_SYNC_EVENT_AGE_MS,
} from "../../core/refresh-policy";
import { isLocalSessionEnvironment } from "../../core/session-environment";
import type {
  MigrationAgent,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionSearchResult,
} from "../../core/types";

export type RemoteSessionStorePort = Pick<
  SessionStore,
  | "getSession"
  | "getAllMessages"
  | "getTraceEvents"
  | "searchSessions"
  | "getEnvironment"
  | "getSessionSyncBindingForLocalKey"
  | "listSessionSyncBindings"
  | "upsertSessionSyncBinding"
  | "deleteSessionSyncBindingForRemoteId"
>;

export interface SessionSyncHookSetup {
  installSessionSyncHooks(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSessionSyncHooks(options?: Record<string, unknown>): { status: string; detail?: string };
  sessionSyncHookStatus(options?: Record<string, unknown>): {
    installed: boolean;
    claude: boolean;
    codex: boolean;
    error?: string;
  };
}

export interface RemoteSessionClientPort {
  checkStatus(): Promise<RemoteSessionStatus>;
  listRemoteSessions(query?: string): Promise<RemoteSessionListItem[]>;
  getRemoteSession(remoteId: string): Promise<RemoteSessionListItem>;
  uploadSession(payload: Parameters<SupabaseRemoteSessionClient["uploadSession"]>[0], detailJson: string, portableJson: string): Promise<RemoteSessionUploadResult>;
  getDetailSnapshot(remoteId: string): Promise<RemoteSessionDetailSnapshot>;
  getPortableSession(remoteId: string): ReturnType<SupabaseRemoteSessionClient["getPortableSession"]>;
  deleteRemoteSessions(remoteIds: string[]): Promise<RemoteSessionDeleteResult>;
}

export interface RemoteSessionServiceOperations {
  buildSetupSql: typeof buildRemoteSessionSetupSql;
  buildUpload: typeof buildRemoteSessionUploadFromStore;
  buildSyncItems: typeof buildSessionSyncItems;
  readQueue: typeof readSessionSyncQueue;
  coalesceQueue: typeof coalesceSessionSyncQueueEvents;
  removeQueueFiles: typeof removeSessionSyncQueueFiles;
  clearQueue: typeof clearSessionSyncQueue;
  restorePortable: typeof restoreRemotePortableSession;
}

export interface RemoteSessionServiceDependencies {
  getStore(): RemoteSessionStorePort;
  getSettings(): AppSettings;
  getHookSetup(): SessionSyncHookSetup;
  createClient?(options: { url: string; anonKey: string }): RemoteSessionClientPort;
  ensureSessionDetails(sessionKey: string): Promise<void>;
  runIndexSync(): Promise<unknown>;
  chooseLocalProject(): Promise<string | null>;
  createLocalRestoreDependencies(
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies>;
  createSourceRestoreDependencies(
    environment: SessionEnvironment,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<RemoteSessionRestoreDependencies>;
  copyText(text: string): void;
  now(): number;
  logError(message: string): void;
  operations?: Partial<RemoteSessionServiceOperations>;
  timers?: {
    setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
    clearInterval(timer: ReturnType<typeof setInterval>): void;
  };
}

const defaultOperations: RemoteSessionServiceOperations = {
  buildSetupSql: buildRemoteSessionSetupSql,
  buildUpload: buildRemoteSessionUploadFromStore,
  buildSyncItems: buildSessionSyncItems,
  readQueue: readSessionSyncQueue,
  coalesceQueue: coalesceSessionSyncQueueEvents,
  removeQueueFiles: removeSessionSyncQueueFiles,
  clearQueue: clearSessionSyncQueue,
  restorePortable: restoreRemotePortableSession,
};

const defaultTimers = {
  setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
  clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
};

export class RemoteSessionService {
  private readonly operations: RemoteSessionServiceOperations;
  private readonly timers: NonNullable<RemoteSessionServiceDependencies["timers"]>;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private queueRunning = false;
  private hookLastProcessedAt: number | null = null;
  private hookLastError: string | null = null;

  constructor(private readonly dependencies: RemoteSessionServiceDependencies) {
    this.operations = { ...defaultOperations, ...dependencies.operations };
    this.timers = dependencies.timers ?? defaultTimers;
  }

  async getStatus(): Promise<RemoteSessionStatus> {
    const setupSql = this.operations.buildSetupSql();
    const settings = this.dependencies.getSettings();
    if (!this.syncConfigured(settings)) {
      return {
        kind: "unconfigured",
        setupSql,
        remediation: "settings",
        message: "Configure Supabase URL and anon key in Settings to sync remote sessions.",
      };
    }
    return this.createClient().checkStatus();
  }

  copySetupSql(): void {
    this.dependencies.copyText(this.operations.buildSetupSql());
  }

  getHookStatus(): SessionSyncHookStatus {
    const hook = this.dependencies.getHookSetup().sessionSyncHookStatus();
    const queue = this.operations.readQueue();
    return {
      installed: hook.installed,
      claude: hook.claude,
      codex: hook.codex,
      pending: queue.events.length,
      lastProcessedAt: this.hookLastProcessedAt,
      lastError: hook.error || this.hookLastError,
    };
  }

  installHooks(): SessionSyncHookStatus {
    if (!this.syncConfigured(this.dependencies.getSettings())) {
      throw new Error("Enable remote session sync and configure Supabase before installing hooks.");
    }
    const result = this.dependencies.getHookSetup().installSessionSyncHooks();
    if (result.status === "error") throw new Error(result.detail || "Could not configure the session sync hooks.");
    this.drainQueueInBackground();
    return this.getHookStatus();
  }

  uninstallHooks(): SessionSyncHookStatus {
    const result = this.dependencies.getHookSetup().uninstallSessionSyncHooks();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the session sync hooks.");
    this.operations.clearQueue();
    this.hookLastError = null;
    return this.getHookStatus();
  }

  disableSync(): void {
    const result = this.dependencies.getHookSetup().uninstallSessionSyncHooks();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the session sync hooks.");
    this.operations.clearQueue();
    this.hookLastError = null;
  }

  async upload(sessionKey: string, force = false): Promise<RemoteSessionUploadResult> {
    const client = this.createClient();
    const store = this.dependencies.getStore();
    const session = store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    if (session.source === "zcode-cli") throw new Error("ZCode sessions cannot be saved remotely yet.");
    await this.dependencies.ensureSessionDetails(sessionKey);
    const binding = store.getSessionSyncBindingForLocalKey(sessionKey);
    const { payload, detailJson, portableJson } = this.operations.buildUpload(
      store,
      sessionKey,
      this.dependencies.now(),
      binding?.remoteSessionId,
    );
    if (binding && !force) {
      const remote = await client.getRemoteSession(binding.remoteSessionId).catch((error) => {
        if (error instanceof Error && error.message === "Remote session was not found.") return null;
        throw error;
      });
      if (remote) {
        const localChanged = payload.content_hash !== binding.lastLocalRevision;
        const remoteChanged = remote.contentHash !== binding.lastRemoteRevision;
        if (localChanged && remoteChanged) {
          throw new Error("Both local and cloud copies changed. Choose a conflict action before overwriting the cloud copy.");
        }
      }
    }
    const result = await client.uploadSession(payload, detailJson, portableJson);
    store.upsertSessionSyncBinding({
      localSessionKey: sessionKey,
      remoteSessionId: result.remoteSession.id,
      lastLocalRevision: payload.content_hash,
      lastRemoteRevision: result.remoteSession.contentHash,
      lastSyncedAt: this.dependencies.now(),
      direction: "upload",
    });
    return result;
  }

  list(query = ""): Promise<RemoteSessionListItem[]> {
    return this.createClient().listRemoteSessions(query);
  }

  async listSyncItems(): Promise<SessionSyncItem[]> {
    const store = this.dependencies.getStore();
    const remotes = (await this.createClient().listRemoteSessions())
      .filter((remote) => store.getSession(remote.sourceSessionKey)?.isSubagent !== true);
    const locals: Array<{ session: SessionSearchResult; revision: string }> = [];
    await this.runBounded(store.searchSessions({ limit: 100_000, excludeSubagents: true }), 4, async (session) => {
      if (!migrationAgentForSource(session.source) || !session.projectPath.trim()) return;
      try {
        await this.dependencies.ensureSessionDetails(session.sessionKey);
        const hydrated = store.getSession(session.sessionKey);
        if (!hydrated) return;
        const built = this.operations.buildUpload(
          store,
          session.sessionKey,
          0,
          store.getSessionSyncBindingForLocalKey(session.sessionKey)?.remoteSessionId,
        );
        locals.push({ session: hydrated, revision: built.payload.content_hash });
      } catch (error) {
        throw new Error(`Could not load ${session.displayTitle || session.sessionKey} before comparing it with the cloud copy: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return this.operations.buildSyncItems(locals, remotes, store.listSessionSyncBindings());
  }

  getDetail(remoteId: string): Promise<RemoteSessionDetailSnapshot> {
    return this.createClient().getDetailSnapshot(remoteId);
  }

  chooseProject(): Promise<string | null> {
    return this.dependencies.chooseLocalProject();
  }

  async restore(
    remoteId: string,
    target: MigrationAgent,
    localProjectPath: string,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<SessionMigrationResult> {
    const client = this.createClient();
    const portable = await client.getPortableSession(remoteId);
    const deps = await this.dependencies.createLocalRestoreDependencies(onProgress);
    const result = await this.operations.restorePortable({ remoteId, portable, target, localProjectPath, deps });
    await this.bindRestoredSession(client, remoteId, result.targetSessionId);
    return result;
  }

  async restoreToSource(
    remoteId: string,
    target: MigrationAgent,
    onProgress: (progress: SessionMigrationProgress) => void,
  ): Promise<SessionMigrationResult> {
    const client = this.createClient();
    const remote = await client.getRemoteSession(remoteId);
    if (remote.sourceEnvironmentKind !== "ssh") {
      throw new Error("This remote session was not saved from an SSH environment.");
    }
    const environment = this.dependencies.getStore().getEnvironment(remote.sourceEnvironmentId);
    if (!environment || environment.kind !== "ssh") {
      throw new Error("The SSH environment for this remote session is not configured on this machine.");
    }
    const portable = await client.getPortableSession(remoteId);
    const deps = await this.dependencies.createSourceRestoreDependencies(environment, onProgress);
    const result = await this.operations.restorePortable({
      remoteId,
      portable,
      target,
      localProjectPath: portable.projectPath,
      deps,
    });
    await this.bindRestoredSession(client, remoteId, result.targetSessionId);
    return result;
  }

  async delete(remoteId: string): Promise<boolean> {
    const result = await this.deleteMany([remoteId]);
    return result.deletedIds.includes(remoteId);
  }

  async deleteMany(remoteIds: string[]): Promise<RemoteSessionDeleteResult> {
    const result = await this.createClient().deleteRemoteSessions(remoteIds);
    const store = this.dependencies.getStore();
    for (const id of [...result.deletedIds, ...result.missingIds]) store.deleteSessionSyncBindingForRemoteId(id);
    return result;
  }

  startQueue(): void {
    if (this.queueTimer) return;
    this.queueTimer = this.timers.setInterval(() => this.drainQueueInBackground(), AUTO_SESSION_SYNC_QUEUE_INTERVAL_MS);
    this.drainQueueInBackground();
  }

  stopQueue(): void {
    if (!this.queueTimer) return;
    this.timers.clearInterval(this.queueTimer);
    this.queueTimer = null;
  }

  async drainQueue(): Promise<void> {
    if (this.queueRunning || !this.dependencies.getSettings().remoteSyncEnabled) return;
    const queued = this.operations.readQueue();
    this.operations.removeQueueFiles(queued.invalidFiles);
    const coalesced = this.operations.coalesceQueue(queued.events);
    this.operations.removeQueueFiles(coalesced.supersededFiles);
    if (coalesced.events.length === 0) return;
    this.queueRunning = true;
    this.hookLastError = null;
    try {
      await this.dependencies.runIndexSync();
      const store = this.dependencies.getStore();
      const localSessions = store.searchSessions({ limit: 100_000, excludeSubagents: false })
        .filter((session) => isLocalSessionEnvironment(session));
      for (const event of coalesced.events) await this.processQueueEvent(event, localSessions);
    } finally {
      this.queueRunning = false;
    }
  }

  private async processQueueEvent(event: SessionSyncQueueEvent, localSessions: SessionSearchResult[]): Promise<void> {
    if (!this.dependencies.getSettings().remoteSyncEnabled
      || !this.dependencies.getHookSetup().sessionSyncHookStatus().installed) return;
    const store = this.dependencies.getStore();
    const session = localSessions.find((candidate) =>
      migrationAgentForSource(candidate.source) === event.agent
      && ((event.transcriptPath && path.resolve(candidate.filePath) === path.resolve(event.transcriptPath))
        || candidate.rawId === event.sessionId));
    if (!session) {
      if (this.dependencies.now() - Date.parse(event.queuedAt) >= STALE_SESSION_SYNC_EVENT_AGE_MS) {
        this.operations.removeQueueFiles([event.filePath]);
      }
      return;
    }
    if (session.isSubagent) {
      this.operations.removeQueueFiles([event.filePath]);
      return;
    }
    try {
      await this.dependencies.ensureSessionDetails(session.sessionKey);
      const binding = store.getSessionSyncBindingForLocalKey(session.sessionKey);
      const built = this.operations.buildUpload(store, session.sessionKey, 0, binding?.remoteSessionId);
      if (!binding || binding.lastLocalRevision !== built.payload.content_hash) {
        await this.upload(session.sessionKey);
      }
      this.operations.removeQueueFiles([event.filePath]);
      this.hookLastProcessedAt = this.dependencies.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hookLastError = message;
      if (message.includes("Both local and cloud copies changed")) {
        this.operations.removeQueueFiles([event.filePath]);
      }
    }
  }

  private drainQueueInBackground(): void {
    void this.drainQueue().catch((error) => {
      this.dependencies.logError(
        `Failed to drain the session sync queue: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async bindRestoredSession(client: RemoteSessionClientPort, remoteId: string, targetSessionId: string): Promise<void> {
    try {
      const store = this.dependencies.getStore();
      const local = store.searchSessions({ limit: 100_000 }).find((session) => session.rawId === targetSessionId);
      if (!local) return;
      const built = this.operations.buildUpload(store, local.sessionKey, 0, remoteId);
      const remote = await client.getRemoteSession(remoteId);
      store.upsertSessionSyncBinding({
        localSessionKey: local.sessionKey,
        remoteSessionId: remoteId,
        lastLocalRevision: built.payload.content_hash,
        lastRemoteRevision: remote.contentHash,
        lastSyncedAt: this.dependencies.now(),
        direction: "restore",
      });
    } catch {
      // The restored conversation remains usable if recording its sync relation fails.
    }
  }

  private syncConfigured(settings: AppSettings): boolean {
    return Boolean(settings.remoteSyncEnabled && settings.remoteSyncSupabaseUrl && settings.remoteSyncSupabaseAnonKey);
  }

  private createClient(): RemoteSessionClientPort {
    const settings = this.dependencies.getSettings();
    if (!this.syncConfigured(settings)) throw new Error("Supabase remote session sync is not configured.");
    const options = { url: settings.remoteSyncSupabaseUrl, anonKey: settings.remoteSyncSupabaseAnonKey };
    return this.dependencies.createClient?.(options) ?? new SupabaseRemoteSessionClient(options);
  }

  private async runBounded<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (cursor < items.length) await action(items[cursor++]);
    });
    await Promise.all(workers);
  }
}
