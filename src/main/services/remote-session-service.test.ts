import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../../core/platform";
import { STALE_SESSION_SYNC_EVENT_AGE_MS } from "../../core/refresh-policy";
import type { RemoteSessionRestoreDependencies } from "../../core/remote-session-restore";
import type {
  RemoteSessionDetailSnapshot,
  RemoteSessionListItem,
} from "../../core/remote-session-sync";
import type { SessionSyncBinding } from "../../core/session-store";
import type { SessionSyncQueueEvent } from "../../core/session-sync-queue";
import type {
  PortableSession,
  SessionEnvironment,
  SessionMigrationResult,
  SessionSearchResult,
} from "../../core/types";
import {
  RemoteSessionService,
  type RemoteSessionClientPort,
  type RemoteSessionServiceOperations,
  type RemoteSessionStorePort,
} from "./remote-session-service";

function configuredSettings(): AppSettings {
  return {
    ...structuredClone(defaultSettings),
    remoteSyncEnabled: true,
    remoteSyncSupabaseUrl: "https://project.supabase.co",
    remoteSyncSupabaseAnonKey: "anon-key",
  };
}

function localSession(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey: "local:session-1",
    rawId: "session-1",
    source: "claude-cli",
    projectPath: "/tmp/project",
    filePath: "/tmp/session-1.jsonl",
    originalTitle: "Session 1",
    firstQuestion: "Question",
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    displayTitle: "Session 1",
    favorited: false,
    pinned: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 1,
    messageCount: 1,
    aiSummary: null,
    aiSummaryStale: false,
    ...overrides,
  };
}

function remoteSession(overrides: Partial<RemoteSessionListItem> = {}): RemoteSessionListItem {
  return {
    id: "remote-1",
    sourceSessionKey: "local:session-1",
    sourceAgent: "claude",
    sourceSource: "claude-cli",
    sourceEnvironmentId: "local",
    sourceEnvironmentKind: "local",
    sourceEnvironmentLabel: "Local",
    title: "Session 1",
    projectPath: "/tmp/project",
    startedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: 2,
    contentHash: "remote-revision",
    revisionVersion: 2,
    messageCount: 1,
    traceEventCount: 0,
    aiSummary: null,
    tags: [],
    searchText: "Session 1",
    detailObjectKey: "remote-1/detail.json",
    portableObjectKey: "remote-1/portable.json",
    detailSha256: "detail-hash",
    portableSha256: "portable-hash",
    createdAt: 1,
    syncedAt: 2,
    ...overrides,
  };
}

function portableSession(): PortableSession {
  return {
    sourceSessionKey: "local:session-1",
    sourceAgent: "claude",
    title: "Session 1",
    projectPath: "/tmp/project",
    startedAt: "2026-07-16T00:00:00.000Z",
    messages: [{ role: "user", content: "Question", timestamp: "2026-07-16T00:00:00.000Z", index: 0 }],
  };
}

function migrationResult(): SessionMigrationResult {
  return {
    target: "codex",
    targetSessionId: "restored-session",
    targetFilePath: "/tmp/restored.jsonl",
    strategy: "complete",
    resumeCommand: "codex resume restored-session",
    indexed: true,
    launched: true,
  };
}

function restoreDependencies(): RemoteSessionRestoreDependencies {
  return {
    inspectCli: vi.fn(),
    prepare: vi.fn(async (session) => ({ session, strategy: "complete" as const })),
    write: vi.fn(async () => ({ sessionId: "restored-session", filePath: "/tmp/restored.jsonl" })),
    record: vi.fn(),
    refreshIndex: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    resumeCommand: vi.fn(() => "codex resume restored-session"),
    fallbackResumeCommand: vi.fn(() => "codex resume restored-session"),
    idFactory: vi.fn(() => "migration-1"),
    now: vi.fn(() => 123),
    projectPathExists: vi.fn(async () => true),
    projectPathIsDirectory: vi.fn(async () => true),
  };
}

function queueEvent(overrides: Partial<SessionSyncQueueEvent> = {}): SessionSyncQueueEvent {
  return {
    version: 1,
    agent: "claude",
    sessionId: "session-1",
    transcriptPath: "/tmp/session-1.jsonl",
    cwd: "/tmp/project",
    queuedAt: "2026-07-16T00:00:00.000Z",
    filePath: "/tmp/queue/session-1.json",
    ...overrides,
  };
}

function createHarness(options: {
  settings?: AppSettings;
  sessions?: SessionSearchResult[];
  bindings?: SessionSyncBinding[];
  remote?: RemoteSessionListItem;
  environment?: SessionEnvironment | null;
  queueEvents?: SessionSyncQueueEvent[];
  localRevision?: string;
  now?: number;
} = {}) {
  const settings = options.settings ?? structuredClone(defaultSettings);
  const sessions = options.sessions ?? [localSession()];
  const bindings = [...(options.bindings ?? [])];
  const remote = options.remote ?? remoteSession();
  const environment = options.environment ?? null;
  const queueEvents = options.queueEvents ?? [];
  const localRevision = options.localRevision ?? "local-revision";

  const getSession = vi.fn((sessionKey: string) =>
    sessions.find((session) => session.sessionKey === sessionKey) ?? null);
  const getSessionSyncBindingForLocalKey = vi.fn((sessionKey: string) =>
    bindings.find((binding) => binding.localSessionKey === sessionKey) ?? null);
  const upsertSessionSyncBinding = vi.fn((binding: SessionSyncBinding) => {
    const index = bindings.findIndex((candidate) => candidate.localSessionKey === binding.localSessionKey);
    if (index >= 0) bindings[index] = binding;
    else bindings.push(binding);
  });
  const deleteSessionSyncBindingForRemoteId = vi.fn((remoteId: string) => {
    const index = bindings.findIndex((binding) => binding.remoteSessionId === remoteId);
    if (index >= 0) bindings.splice(index, 1);
  });
  const store = {
    getSession,
    getAllMessages: vi.fn(() => []),
    getTraceEvents: vi.fn(() => []),
    searchSessions: vi.fn((searchOptions?: { excludeSubagents?: boolean }) =>
      searchOptions?.excludeSubagents
        ? sessions.filter((session) => session.isSubagent !== true)
        : sessions),
    getEnvironment: vi.fn((environmentId: string) =>
      environment?.id === environmentId ? environment : null),
    getSessionSyncBindingForLocalKey,
    listSessionSyncBindings: vi.fn(() => bindings),
    upsertSessionSyncBinding,
    deleteSessionSyncBindingForRemoteId,
  } as unknown as RemoteSessionStorePort;

  const client: RemoteSessionClientPort = {
    checkStatus: vi.fn(async () => ({ kind: "ready" as const, setupSql: "setup sql" })),
    listRemoteSessions: vi.fn(async () => [remote]),
    getRemoteSession: vi.fn(async () => remote),
    uploadSession: vi.fn(async () => ({ status: "uploaded" as const, remoteSession: remote })),
    getDetailSnapshot: vi.fn(async () => ({} as RemoteSessionDetailSnapshot)),
    getPortableSession: vi.fn(async () => portableSession()),
    deleteRemoteSessions: vi.fn(async (remoteIds) => ({
      requested: remoteIds.length,
      deletedIds: remoteIds,
      missingIds: [],
      failures: [],
    })),
  };
  const createClient = vi.fn(() => client);
  const buildUpload = vi.fn(() => ({
    payload: { content_hash: localRevision },
    detailJson: "{}",
    portableJson: "{}",
  } as unknown as ReturnType<RemoteSessionServiceOperations["buildUpload"]>));
  const removeQueueFiles = vi.fn();
  const clearQueue = vi.fn();
  const restorePortable = vi.fn(async () => migrationResult());
  const buildSyncItems = vi.fn(() => []);
  const operations: RemoteSessionServiceOperations = {
    buildSetupSql: vi.fn(() => "setup sql"),
    buildUpload,
    buildSyncItems,
    readQueue: vi.fn(() => ({ events: queueEvents, invalidFiles: [] })),
    coalesceQueue: vi.fn((events) => ({ events, supersededFiles: [] })),
    removeQueueFiles,
    clearQueue,
    restorePortable,
  };
  const hookSetup = {
    installSessionSyncHooks: vi.fn(() => ({ status: "installed" })),
    uninstallSessionSyncHooks: vi.fn(() => ({
      status: "removed",
      detail: undefined as string | undefined,
    })),
    sessionSyncHookStatus: vi.fn(() => ({ installed: true, claude: true, codex: true })),
  };
  const ensureSessionDetails = vi.fn(async () => undefined);
  const runIndexSync = vi.fn(async () => undefined);
  const localRestoreDependencies = restoreDependencies();
  const sourceRestoreDependencies = restoreDependencies();
  const createLocalRestoreDependencies = vi.fn(async () => localRestoreDependencies);
  const createSourceRestoreDependencies = vi.fn(async () => sourceRestoreDependencies);
  const intervalToken: ReturnType<typeof globalThis.setInterval> = 123 as never;
  const intervalCallbacks: Array<() => void> = [];
  const setInterval = vi.fn((callback: () => void): ReturnType<typeof globalThis.setInterval> => {
    intervalCallbacks.push(callback);
    return intervalToken;
  });
  const clearInterval = vi.fn();
  const logError = vi.fn();
  const service = new RemoteSessionService({
    getStore: () => store,
    getSettings: () => settings,
    getHookSetup: () => hookSetup,
    createClient,
    ensureSessionDetails,
    runIndexSync,
    chooseLocalProject: vi.fn(async () => "/tmp/project"),
    createLocalRestoreDependencies,
    createSourceRestoreDependencies,
    copyText: vi.fn(),
    now: () => options.now ?? 123,
    logError,
    operations,
    timers: { setInterval, clearInterval },
  });

  return {
    service,
    settings,
    sessions,
    bindings,
    store,
    client,
    createClient,
    buildUpload,
    buildSyncItems,
    operations,
    hookSetup,
    ensureSessionDetails,
    runIndexSync,
    createLocalRestoreDependencies,
    createSourceRestoreDependencies,
    localRestoreDependencies,
    sourceRestoreDependencies,
    removeQueueFiles,
    clearQueue,
    restorePortable,
    setInterval,
    clearInterval,
    intervalCallbacks,
    intervalToken,
    logError,
  };
}

describe("RemoteSessionService cloud orchestration", () => {
  it("returns an unconfigured status without constructing a client", async () => {
    const harness = createHarness();

    await expect(harness.service.getStatus()).resolves.toEqual({
      kind: "unconfigured",
      setupSql: "setup sql",
      remediation: "settings",
      message: "Configure Supabase URL and anon key in Settings to sync remote sessions.",
    });
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it("hydrates details before building an upload and records the resulting binding", async () => {
    const harness = createHarness({ settings: configuredSettings() });

    await expect(harness.service.upload("local:session-1")).resolves.toMatchObject({ status: "uploaded" });

    expect(harness.ensureSessionDetails).toHaveBeenCalledWith("local:session-1");
    expect(harness.ensureSessionDetails.mock.invocationCallOrder[0]).toBeLessThan(
      harness.buildUpload.mock.invocationCallOrder[0],
    );
    expect(harness.store.upsertSessionSyncBinding).toHaveBeenCalledWith({
      localSessionKey: "local:session-1",
      remoteSessionId: "remote-1",
      lastLocalRevision: "local-revision",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 123,
      direction: "upload",
    });
  });

  it("rejects ZCode uploads before building a portable remote session", async () => {
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [localSession({ sessionKey: "zcode:session-1", rawId: "session-1", source: "zcode-cli" })],
    });

    await expect(harness.service.upload("zcode:session-1")).rejects.toThrow("ZCode sessions cannot be saved remotely yet.");
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildUpload).not.toHaveBeenCalled();
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
  });

  it("rejects an upload when both the bound local and cloud revisions changed", async () => {
    const harness = createHarness({
      settings: configuredSettings(),
      bindings: [{
        localSessionKey: "local:session-1",
        remoteSessionId: "remote-1",
        lastLocalRevision: "old-local",
        lastRemoteRevision: "old-remote",
        lastSyncedAt: 1,
        direction: "upload",
      }],
      localRevision: "new-local",
      remote: remoteSession({ contentHash: "new-remote" }),
    });

    await expect(harness.service.upload("local:session-1")).rejects.toThrow(
      "Both local and cloud copies changed",
    );
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
    expect(harness.store.upsertSessionSyncBinding).not.toHaveBeenCalled();
  });

  it("deletes bindings for cloud copies that were deleted or already missing", async () => {
    const harness = createHarness({ settings: configuredSettings() });
    vi.mocked(harness.client.deleteRemoteSessions).mockResolvedValue({
      requested: 3,
      deletedIds: ["remote-1"],
      missingIds: ["remote-2"],
      failures: [{ id: "remote-3", message: "denied" }],
    });

    await expect(harness.service.deleteMany(["remote-1", "remote-2", "remote-3"])).resolves.toMatchObject({
      deletedIds: ["remote-1"],
      missingIds: ["remote-2"],
    });
    expect(harness.store.deleteSessionSyncBindingForRemoteId).toHaveBeenCalledTimes(2);
    expect(harness.store.deleteSessionSyncBindingForRemoteId).toHaveBeenNthCalledWith(1, "remote-1");
    expect(harness.store.deleteSessionSyncBindingForRemoteId).toHaveBeenNthCalledWith(2, "remote-2");
  });

  it("excludes local and cloud subagent conversations from the sync comparison", async () => {
    const regular = localSession();
    const subagent = localSession({
      sessionKey: "local:subagent",
      rawId: "subagent",
      filePath: "/tmp/subagent.jsonl",
      isSubagent: true,
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [regular, subagent],
      remote: remoteSession({ sourceSessionKey: subagent.sessionKey }),
    });

    await harness.service.listSyncItems();

    expect(harness.store.searchSessions).toHaveBeenCalledWith({
      limit: 100_000,
      excludeSubagents: true,
    });
    expect(harness.ensureSessionDetails).toHaveBeenCalledOnce();
    expect(harness.ensureSessionDetails).toHaveBeenCalledWith(regular.sessionKey);
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session: regular, revision: "local-revision" }],
      [],
      [],
    );
  });

  it("records a restore binding after the restored session appears in the local index", async () => {
    const restored = localSession({ sessionKey: "local:restored", rawId: "restored-session" });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [restored],
      localRevision: "restored-revision",
    });
    const onProgress = vi.fn();

    await expect(harness.service.restore("remote-1", "codex", "/tmp/project", onProgress)).resolves.toEqual(
      migrationResult(),
    );

    expect(harness.createLocalRestoreDependencies).toHaveBeenCalledWith(onProgress);
    expect(harness.restorePortable).toHaveBeenCalledWith(expect.objectContaining({
      remoteId: "remote-1",
      target: "codex",
      localProjectPath: "/tmp/project",
      deps: harness.localRestoreDependencies,
    }));
    expect(harness.store.upsertSessionSyncBinding).toHaveBeenCalledWith({
      localSessionKey: "local:restored",
      remoteSessionId: "remote-1",
      lastLocalRevision: "restored-revision",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 123,
      direction: "restore",
    });
  });

  it("rejects source-environment restore for non-SSH sessions or unavailable SSH environments", async () => {
    const localRemote = createHarness({ settings: configuredSettings() });
    await expect(localRemote.service.restoreToSource("remote-1", "codex", vi.fn())).rejects.toThrow(
      "was not saved from an SSH environment",
    );
    expect(localRemote.client.getPortableSession).not.toHaveBeenCalled();

    const sshRemote = createHarness({
      settings: configuredSettings(),
      remote: remoteSession({ sourceEnvironmentKind: "ssh", sourceEnvironmentId: "ssh-1" }),
    });
    await expect(sshRemote.service.restoreToSource("remote-1", "codex", vi.fn())).rejects.toThrow(
      "SSH environment for this remote session is not configured",
    );
    expect(sshRemote.createSourceRestoreDependencies).not.toHaveBeenCalled();
  });
});

describe("RemoteSessionService automatic queue lifecycle", () => {
  it("keeps a fresh unmatched event for a later index retry", async () => {
    const event = queueEvent();
    const queuedAt = Date.parse(event.queuedAt);
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [],
      queueEvents: [event],
      now: queuedAt + STALE_SESSION_SYNC_EVENT_AGE_MS - 1,
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).not.toHaveBeenCalledWith([event.filePath]);
    expect(harness.createClient).not.toHaveBeenCalled();
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
  });

  it("removes an unmatched event when its grace period expires", async () => {
    const event = queueEvent();
    const queuedAt = Date.parse(event.queuedAt);
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [],
      queueEvents: [event],
      now: queuedAt + STALE_SESSION_SYNC_EVENT_AGE_MS,
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.createClient).not.toHaveBeenCalled();
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.service.getHookStatus()).toMatchObject({ lastProcessedAt: null, lastError: null });
  });

  it("processes an old event when its session can still be matched", async () => {
    const event = queueEvent();
    const queuedAt = Date.parse(event.queuedAt);
    const harness = createHarness({
      settings: configuredSettings(),
      queueEvents: [event],
      now: queuedAt + STALE_SESSION_SYNC_EVENT_AGE_MS,
    });

    await harness.service.drainQueue();

    expect(harness.client.uploadSession).toHaveBeenCalledOnce();
    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.service.getHookStatus()).toMatchObject({
      lastProcessedAt: queuedAt + STALE_SESSION_SYNC_EVENT_AGE_MS,
      lastError: null,
    });
  });

  it("removes subagent events without uploading their conversations", async () => {
    const event = queueEvent();
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [localSession({ isSubagent: true })],
      queueEvents: [event],
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
  });

  it("removes an unchanged revision without creating a cloud client", async () => {
    const event = queueEvent();
    const harness = createHarness({
      settings: configuredSettings(),
      queueEvents: [event],
      localRevision: "same-revision",
      bindings: [{
        localSessionKey: "local:session-1",
        remoteSessionId: "remote-1",
        lastLocalRevision: "same-revision",
        lastRemoteRevision: "remote-revision",
        lastSyncedAt: 1,
        direction: "upload",
      }],
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.createClient).not.toHaveBeenCalled();
    expect(harness.service.getHookStatus()).toMatchObject({ lastProcessedAt: 123, lastError: null });
  });

  it("drops a conflicting event and exposes the conflict as the Hook error", async () => {
    const event = queueEvent();
    const harness = createHarness({
      settings: configuredSettings(),
      queueEvents: [event],
      localRevision: "new-local",
      remote: remoteSession({ contentHash: "new-remote" }),
      bindings: [{
        localSessionKey: "local:session-1",
        remoteSessionId: "remote-1",
        lastLocalRevision: "old-local",
        lastRemoteRevision: "old-remote",
        lastSyncedAt: 1,
        direction: "upload",
      }],
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.service.getHookStatus().lastError).toContain("Both local and cloud copies changed");
  });

  it("starts its timer once and clears the same timer when stopped", () => {
    const harness = createHarness();

    harness.service.startQueue();
    harness.service.startQueue();
    expect(harness.setInterval).toHaveBeenCalledOnce();

    harness.service.stopQueue();
    harness.service.stopQueue();
    expect(harness.clearInterval).toHaveBeenCalledOnce();
    expect(harness.clearInterval).toHaveBeenCalledWith(harness.intervalToken);
  });

  it("logs failures from fire-and-forget queue drains", async () => {
    const event = queueEvent();
    const harness = createHarness({
      settings: configuredSettings(),
      queueEvents: [event],
    });
    harness.runIndexSync.mockRejectedValueOnce(new Error("index unavailable"));

    harness.service.startQueue();
    await vi.waitFor(() => {
      expect(harness.logError).toHaveBeenCalledWith(
        "Failed to drain the session sync queue: index unavailable",
      );
    });
    expect(harness.removeQueueFiles).not.toHaveBeenCalledWith([event.filePath]);
    harness.service.stopQueue();
  });

  it("uninstalls hooks before clearing the queue and preserves the queue on failure", () => {
    const harness = createHarness();

    harness.service.disableSync();
    expect(harness.hookSetup.uninstallSessionSyncHooks.mock.invocationCallOrder[0]).toBeLessThan(
      harness.clearQueue.mock.invocationCallOrder[0],
    );

    harness.clearQueue.mockClear();
    harness.hookSetup.uninstallSessionSyncHooks.mockReturnValue({
      status: "error",
      detail: "hook config is read-only",
    });
    expect(() => harness.service.disableSync()).toThrow("hook config is read-only");
    expect(harness.clearQueue).not.toHaveBeenCalled();
  });
});
