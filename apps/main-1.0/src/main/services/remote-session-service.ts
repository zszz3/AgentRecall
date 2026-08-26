import { createHash } from "node:crypto";
import * as path from "node:path";
import type { AppSettings } from "../../core/platform";
import { restoreRemotePortableSession, type RemoteSessionRestoreDependencies } from "../../core/remote-session-restore";
import {
  buildRemoteSessionSetupSql,
  buildRemoteSessionRevisionFromStore,
  buildRemoteSessionUploadFromStore,
  buildSessionSyncItems,
  findCursorSessionSyncBindingRepairs,
  remoteSessionId,
  supabaseConnectionErrorMessage,
  SupabaseRemoteSessionClient,
  type RemoteSessionDeleteResult,
  type RemoteSessionDetailSnapshot,
  type RemoteSessionListItem,
  type RemoteSessionSyncSnapshot,
  type RemoteSessionStatus,
  type RemoteSessionUploadResult,
  type SessionSyncItem,
} from "../../core/remote-session-sync";
import { remoteSessionAgentForSource, sessionSourceDescriptor } from "../../core/session-sources";
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
import { SessionSourceUnavailableError } from "../../core/session-source-archive";
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
  | "getAttachmentFile"
  | "getSessionSourceArtifacts"
  | "isSessionContentFresh"
  | "searchSessions"
  | "getEnvironment"
  | "setSessionSourceAvailable"
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
  listRemoteSessionsForSync(): Promise<RemoteSessionListItem[]>;
  getRemoteSession(remoteId: string): Promise<RemoteSessionListItem>;
  uploadSession(
    payload: Parameters<SupabaseRemoteSessionClient["uploadSession"]>[0],
    detailJson: string,
    portableJson: string,
    attachmentObjects?: Parameters<SupabaseRemoteSessionClient["uploadSession"]>[3],
  ): Promise<RemoteSessionUploadResult>;
  getDetailSnapshot(remoteId: string): Promise<RemoteSessionDetailSnapshot>;
  downloadAttachment?(objectKey: string): Promise<Uint8Array>;
  getPortableSession(remoteId: string): ReturnType<SupabaseRemoteSessionClient["getPortableSession"]>;
  deleteRemoteSessions(remoteIds: string[]): Promise<RemoteSessionDeleteResult>;
}

export interface RemoteSessionServiceOperations {
  buildSetupSql: typeof buildRemoteSessionSetupSql;
  buildRevision: typeof buildRemoteSessionRevisionFromStore;
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
  buildRevision: buildRemoteSessionRevisionFromStore,
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

const MISSING_SOURCE_UPLOAD_MESSAGE =
  "The original session file no longer exists, and its full transcript is not cached locally, so it cannot be uploaded.";

function cloudComparisonSkip(error: unknown): { reason: string; sourceUnavailable: boolean } {
  if (error instanceof SessionSourceUnavailableError) {
    return { reason: error.message, sourceUnavailable: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("FileNotFoundError") && message.includes("No such file or directory")) {
    return { reason: "The original session file no longer exists.", sourceUnavailable: true };
  }
  const reason = message.split(/\r?\n/, 1)[0].replace(/\s+Traceback.*$/u, "").trim();
  return { reason: reason || "The session details could not be loaded.", sourceUnavailable: false };
}

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

  async loadSyncSnapshot(): Promise<RemoteSessionSyncSnapshot> {
    if (!this.syncConfigured(this.dependencies.getSettings())) {
      return { status: await this.getStatus(), items: [] };
    }
    const [statusResult, itemsResult] = await Promise.allSettled([
      this.getStatus(),
      this.listSyncItems(),
    ]);
    if (statusResult.status === "rejected") throw statusResult.reason;
    if (statusResult.value.kind !== "ready") return { status: statusResult.value, items: [] };
    if (itemsResult.status === "rejected") {
      return {
        status: {
          kind: "error",
          setupSql: statusResult.value.setupSql,
          remediation: "settings",
          message: supabaseConnectionErrorMessage(itemsResult.reason),
        },
        items: [],
      };
    }
    return { status: statusResult.value, items: itemsResult.value };
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
    const store = this.dependencies.getStore();
    const initialSession = store.getSession(sessionKey);
    if (!initialSession) throw new Error("Session not found.");
    const binding = store.getSessionSyncBindingForLocalKey(sessionKey);
    const sourceDescriptor = sessionSourceDescriptor(initialSession.source);
    if (!sourceDescriptor.capabilities.sessionSync) {
      throw new Error(`${sourceDescriptor.label} sessions cannot be saved remotely yet.`);
    }
    if (initialSession.environmentKind === "wsl") throw new Error("WSL sessions cannot be saved to cloud yet.");
    const client = this.createClient();
    const session = await this.prepareSessionForUpload(store, initialSession);
    const descendants = descendantSessions(session, store.searchSessions({ limit: 100_000, excludeSubagents: false }));
    await this.runBounded(descendants, 4, async (descendant) => {
      await this.prepareSessionForUpload(store, descendant);
    });
    const targetRemoteId = binding?.remoteSessionId ?? remoteSessionId(sessionKey);
    const existingRemote = binding || session.sourceAvailable === false
      ? await client.getRemoteSession(targetRemoteId).catch((error) => {
          if (error instanceof Error && error.message === "Remote session was not found.") return null;
          throw error;
        })
      : null;
    let preservedSourceArchive: RemoteSessionDetailSnapshot["sourceArchive"];
    if (existingRemote) {
      try {
        preservedSourceArchive = (await client.getDetailSnapshot(existingRemote.id)).sourceArchive;
      } catch (error) {
        if (session.sourceAvailable === false) throw error;
      }
    }
    const { payload, detailJson, portableJson, attachmentObjects, sourceObjects } = await this.operations.buildUpload(
      store,
      sessionKey,
      this.dependencies.now(),
      binding?.remoteSessionId,
      this.dependencies.getSettings().syncSessionAttachments,
      preservedSourceArchive,
    );
    if (existingRemote && existingRemote.messageCount > payload.message_count) {
      throw new Error("This upload cannot overwrite a cloud session with fewer messages than the complete remote copy.");
    }
    if (existingRemote?.contentHash === payload.content_hash) {
      store.upsertSessionSyncBinding({
        localSessionKey: sessionKey,
        remoteSessionId: existingRemote.id,
        lastLocalRevision: payload.content_hash,
        lastRemoteRevision: existingRemote.contentHash,
        lastSyncedAt: this.dependencies.now(),
        direction: "upload",
      });
      return { status: "skipped", remoteSession: existingRemote };
    }
    if (binding && !force) {
      const remote = existingRemote ?? await client.getRemoteSession(binding.remoteSessionId).catch((error) => {
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
    const result = await client.uploadSession(payload, detailJson, portableJson, [...sourceObjects, ...attachmentObjects]);
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

  private async prepareSessionForUpload(
    store: RemoteSessionStorePort,
    session: SessionSearchResult,
  ): Promise<SessionSearchResult> {
    if (session.sourceAvailable === false) {
      if (!await store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize)) {
        throw new SessionSourceUnavailableError(MISSING_SOURCE_UPLOAD_MESSAGE);
      }
      return await store.getSession(session.sessionKey) ?? session;
    }
    try {
      await this.dependencies.ensureSessionDetails(session.sessionKey);
    } catch (error) {
      const skipped = cloudComparisonSkip(error);
      if (!skipped.sourceUnavailable) throw error;
      await store.setSessionSourceAvailable(session.sessionKey, false);
      if (!await store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize)) {
        throw new SessionSourceUnavailableError(MISSING_SOURCE_UPLOAD_MESSAGE);
      }
    }
    return await store.getSession(session.sessionKey) ?? session;
  }

  list(query = ""): Promise<RemoteSessionListItem[]> {
    return this.createClient().listRemoteSessions(query);
  }

  async listSyncItems(): Promise<SessionSyncItem[]> {
    const store = this.dependencies.getStore();
    const remoteCandidates = await this.createClient().listRemoteSessionsForSync();
    const bindings = store.listSessionSyncBindings();
    const indexedSessions = store.searchSessions({ limit: 100_000, excludeSubagents: false })
      .filter((session) =>
        session.environmentKind !== "wsl"
        && remoteSessionAgentForSource(session.source) !== null);
    const indexedBySessionKey = new Map(indexedSessions.map((session) => [session.sessionKey, session]));
    const remotes = remoteCandidates
      .filter((remote) => indexedBySessionKey.get(remote.sourceSessionKey)?.isSubagent !== true);
    const locals: Array<{ session: SessionSearchResult; revision: null }> = [];
    let sliceStartedAt = performance.now();
    for (const session of indexedSessions) {
      if (session.isSubagent === true) continue;
      if (session.sourceAvailable === false
        && !store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize)) continue;
      locals.push({ session, revision: null });
      if (performance.now() - sliceStartedAt < 8) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStartedAt = performance.now();
    }
    const bindingRepairs = findCursorSessionSyncBindingRepairs(locals, remotes, bindings);
    for (const binding of bindingRepairs) store.upsertSessionSyncBinding(binding);
    const effectiveBindings = bindingRepairs.length > 0 ? store.listSessionSyncBindings() : bindings;
    return this.operations.buildSyncItems(locals, remotes, effectiveBindings);
  }

  getDetail(remoteId: string): Promise<RemoteSessionDetailSnapshot> {
    return this.createClient().getDetailSnapshot(remoteId);
  }

  async previewAttachment(
    objectKey: string,
    expectedSha256: string,
    mimeType: string,
    previewKind: "image" | "pdf" | "text" | "file",
  ): Promise<{ kind: "image" | "text" | "unavailable"; data?: string }> {
    const client = this.createClient();
    const download = client.downloadAttachment;
    if (!download) throw new Error("Remote attachment preview is unavailable.");
    const bytes = await download.call(client, objectKey);
    if (bytes.byteLength > 25 * 1024 * 1024) {
      throw new Error("Remote attachment is too large to preview.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedSha256) throw new Error("Remote attachment checksum mismatch.");
    if (previewKind === "image") {
      return { kind: "image", data: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
    }
    if (previewKind === "text") {
      return { kind: "text", data: Buffer.from(bytes).toString("utf8").slice(0, 256 * 1024) };
    }
    return { kind: "unavailable" };
  }

  chooseProject(): Promise<string | null> {
    return this.dependencies.chooseLocalProject();
  }

  async restore(
    remoteId: string,
    target: MigrationAgent,
    localProjectPath: string,
    onProgress: (progress: SessionMigrationProgress) => void,
    bind = false,
  ): Promise<SessionMigrationResult> {
    const client = this.createClient();
    const portable = await client.getPortableSession(remoteId);
    const deps = await this.dependencies.createLocalRestoreDependencies(onProgress);
    const result = await this.operations.restorePortable({ remoteId, portable, target, localProjectPath, deps });
    if (bind) await this.bindRestoredSession(client, remoteId, result.targetSessionId);
    return result;
  }

  async restoreToSource(
    remoteId: string,
    target: MigrationAgent,
    onProgress: (progress: SessionMigrationProgress) => void,
    bind = false,
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
    if (bind) await this.bindRestoredSession(client, remoteId, result.targetSessionId);
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
      const grouped = new Map<string, { session: SessionSearchResult; events: SessionSyncQueueEvent[] }>();
      for (const event of coalesced.events) {
        const session = localSessions.find((candidate) =>
          remoteSessionAgentForSource(candidate.source) === event.agent
          && ((event.transcriptPath && path.resolve(candidate.filePath) === path.resolve(event.transcriptPath))
            || candidate.rawId === event.sessionId));
        if (!session) {
          if (this.dependencies.now() - Date.parse(event.queuedAt) >= STALE_SESSION_SYNC_EVENT_AGE_MS) {
            this.operations.removeQueueFiles([event.filePath]);
          }
          continue;
        }
        const syncSession = rootSessionFor(session, localSessions);
        const group = grouped.get(syncSession.sessionKey) ?? { session: syncSession, events: [] };
        group.events.push(event);
        grouped.set(syncSession.sessionKey, group);
      }
      for (const group of grouped.values()) await this.processQueueSession(group.session, group.events);
    } finally {
      this.queueRunning = false;
    }
  }

  private async processQueueSession(syncSession: SessionSearchResult, events: SessionSyncQueueEvent[]): Promise<void> {
    if (!this.dependencies.getSettings().remoteSyncEnabled
      || !this.dependencies.getHookSetup().sessionSyncHookStatus().installed) return;
    try {
      await this.upload(syncSession.sessionKey);
      this.operations.removeQueueFiles(events.map((event) => event.filePath));
      this.hookLastProcessedAt = this.dependencies.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hookLastError = message;
      if (message.includes("Both local and cloud copies changed")) {
        this.operations.removeQueueFiles(events.map((event) => event.filePath));
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
      const built = await this.operations.buildRevision(store, local.sessionKey, remoteId);
      const remote = await client.getRemoteSession(remoteId);
      store.upsertSessionSyncBinding({
        localSessionKey: local.sessionKey,
        remoteSessionId: remoteId,
        lastLocalRevision: built.payload.content_hash,
        lastRemoteRevision: remote.contentHash,
        lastSyncedAt: this.dependencies.now(),
        direction: "upload",
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
      while (true) {
        const index = cursor;
        if (index >= items.length) return;
        cursor += 1;
        await action(items[index]);
      }
    });
    await Promise.all(workers);
  }
}

function descendantSessions(root: SessionSearchResult, sessions: SessionSearchResult[]): SessionSearchResult[] {
  const childrenByParentId = new Map<string, SessionSearchResult[]>();
  for (const candidate of sessions) {
    if (
      candidate.isSubagent !== true
      || candidate.source !== root.source
      || candidate.environmentId !== root.environmentId
      || !candidate.parentSessionId
    ) continue;
    const children = childrenByParentId.get(candidate.parentSessionId) ?? [];
    children.push(candidate);
    childrenByParentId.set(candidate.parentSessionId, children);
  }
  const descendants: SessionSearchResult[] = [];
  const pending = [root.rawId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    for (const child of childrenByParentId.get(pending.shift()!) ?? []) {
      if (visited.has(child.sessionKey)) continue;
      visited.add(child.sessionKey);
      descendants.push(child);
      pending.push(child.rawId);
    }
  }
  return descendants;
}

function rootSessionFor(session: SessionSearchResult, sessions: SessionSearchResult[]): SessionSearchResult {
  const byRawId = new Map(
    sessions
      .filter((candidate) =>
        candidate.source === session.source && candidate.environmentId === session.environmentId)
      .map((candidate) => [candidate.rawId, candidate]),
  );
  let current = session;
  const visited = new Set([current.rawId]);
  while (current.isSubagent && current.parentSessionId) {
    const parent = byRawId.get(current.parentSessionId);
    if (!parent || visited.has(parent.rawId)) break;
    visited.add(parent.rawId);
    current = parent;
  }
  return current;
}
