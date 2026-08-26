import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../../core/platform";
import { STALE_SESSION_SYNC_EVENT_AGE_MS } from "../../core/refresh-policy";
import type { RemoteSessionRestoreDependencies } from "../../core/remote-session-restore";
import type {
  RemoteSessionDetailSnapshot,
  RemoteSessionListItem,
  RemoteSessionSourceArchive,
  RemoteSessionStatus,
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
  uncachedSessionKeys?: string[];
  now?: number;
} = {}) {
  const settings = options.settings ?? structuredClone(defaultSettings);
  const sessions = options.sessions ?? [localSession()];
  const bindings = [...(options.bindings ?? [])];
  const remote = options.remote ?? remoteSession();
  const environment = options.environment ?? null;
  const queueEvents = options.queueEvents ?? [];
  const localRevision = options.localRevision ?? "local-revision";
  const uncachedSessionKeys = new Set(options.uncachedSessionKeys ?? []);

  const getSession = vi.fn((sessionKey: string) =>
    sessions.find((session) => session.sessionKey === sessionKey) ?? null);
  const getSessionSyncBindingForLocalKey = vi.fn((sessionKey: string) =>
    bindings.find((binding) => binding.localSessionKey === sessionKey) ?? null);
  const setSessionSourceAvailable = vi.fn((sessionKey: string, available: boolean) => {
    const session = sessions.find((candidate) => candidate.sessionKey === sessionKey);
    if (session) session.sourceAvailable = available;
  });
  const upsertSessionSyncBinding = vi.fn((binding: SessionSyncBinding) => {
    const remoteIndex = bindings.findIndex((candidate) =>
      candidate.remoteSessionId === binding.remoteSessionId
      && candidate.localSessionKey !== binding.localSessionKey);
    if (remoteIndex >= 0) bindings.splice(remoteIndex, 1);
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
    getAttachmentFile: vi.fn(() => null),
    getSessionSourceArtifacts: vi.fn(() => []),
    isSessionContentFresh: vi.fn((sessionKey: string) => !uncachedSessionKeys.has(sessionKey)),
    searchSessions: vi.fn((searchOptions?: { excludeSubagents?: boolean }) =>
      searchOptions?.excludeSubagents
        ? sessions.filter((session) => session.isSubagent !== true)
        : sessions),
    getEnvironment: vi.fn((environmentId: string) =>
      environment?.id === environmentId ? environment : null),
    setSessionSourceAvailable,
    getSessionSyncBindingForLocalKey,
    listSessionSyncBindings: vi.fn(() => bindings),
    upsertSessionSyncBinding,
    deleteSessionSyncBindingForRemoteId,
  } as unknown as RemoteSessionStorePort;

  const client: RemoteSessionClientPort = {
    checkStatus: vi.fn(async () => ({ kind: "ready" as const, setupSql: "setup sql" })),
    listRemoteSessions: vi.fn(async () => [remote]),
    listRemoteSessionsForSync: vi.fn(async () => [remote]),
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
    attachmentObjects: [],
    sourceObjects: [],
  } as unknown as ReturnType<RemoteSessionServiceOperations["buildUpload"]>));
  const buildRevision = vi.fn(() => ({
    payload: { content_hash: localRevision },
  } as unknown as ReturnType<RemoteSessionServiceOperations["buildRevision"]>));
  const removeQueueFiles = vi.fn();
  const clearQueue = vi.fn();
  const restorePortable = vi.fn(async () => migrationResult());
  const buildSyncItems = vi.fn(() => []);
  const operations: RemoteSessionServiceOperations = {
    buildSetupSql: vi.fn(() => "setup sql"),
    buildRevision,
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
  const ensureSessionDetails = vi.fn(async (_sessionKey: string) => undefined);
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
    buildRevision,
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
    setSessionSourceAvailable,
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

  it("loads readiness and sync items concurrently", async () => {
    const harness = createHarness({ settings: configuredSettings() });
    let resolveStatus!: (status: RemoteSessionStatus) => void;
    vi.mocked(harness.client.checkStatus).mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));

    const snapshot = harness.service.loadSyncSnapshot();
    await vi.waitFor(() => expect(harness.client.listRemoteSessionsForSync).toHaveBeenCalledOnce());
    resolveStatus({ kind: "ready", setupSql: "setup sql" });

    await expect(snapshot).resolves.toEqual({ status: { kind: "ready", setupSql: "setup sql" }, items: [] });
  });

  it("returns a failed readiness status when the parallel session listing also fails", async () => {
    const harness = createHarness({ settings: configuredSettings() });
    const status: RemoteSessionStatus = {
      kind: "error",
      setupSql: "setup sql",
      remediation: "settings",
      message: "fetch failed",
    };
    vi.mocked(harness.client.checkStatus).mockResolvedValue(status);
    vi.mocked(harness.client.listRemoteSessionsForSync).mockRejectedValue(new TypeError("fetch failed"));

    await expect(harness.service.loadSyncSnapshot()).resolves.toEqual({ status, items: [] });
  });

  it("returns a readable status when session listing fails after the readiness check succeeds", async () => {
    const harness = createHarness({ settings: configuredSettings() });
    vi.mocked(harness.client.listRemoteSessionsForSync).mockRejectedValue(new TypeError("fetch failed"));

    await expect(harness.service.loadSyncSnapshot()).resolves.toEqual({
      status: {
        kind: "error",
        setupSql: "setup sql",
        remediation: "settings",
        message: "Could not reach Supabase. Check the Remote sync URL and your network connection, then try again.",
      },
      items: [],
    });
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

  it("uploads raw source artifacts together with optional attachments", async () => {
    const harness = createHarness({ settings: configuredSettings() });
    const sourceObject = {
      objectKey: "sessions/remote/upload/source/session.jsonl",
      bytes: Buffer.from("raw"),
      mimeType: "application/x-ndjson",
    };
    const attachmentObject = {
      objectKey: "sessions/remote/attachments/image.png",
      bytes: Buffer.from("image"),
      mimeType: "image/png",
    };
    harness.buildUpload.mockReturnValue({
      payload: { content_hash: "local-revision" },
      detailJson: "{\"schemaVersion\":3}",
      portableJson: "{}",
      sourceObjects: [sourceObject],
      attachmentObjects: [attachmentObject],
    } as unknown as ReturnType<RemoteSessionServiceOperations["buildUpload"]>);

    await harness.service.upload("local:session-1");

    expect(harness.client.uploadSession).toHaveBeenCalledWith(
      expect.objectContaining({ content_hash: "local-revision" }),
      "{\"schemaVersion\":3}",
      "{}",
      [sourceObject, attachmentObject],
    );
  });

  it("uploads a cached SSH session when its original file has disappeared", async () => {
    const cached = localSession({
      sessionKey: "ssh:cached",
      rawId: "cached",
      environmentId: "ssh-1",
      environmentKind: "ssh",
      environmentLabel: "SSH",
    });
    const harness = createHarness({ settings: configuredSettings(), sessions: [cached] });
    harness.ensureSessionDetails.mockRejectedValue(
      new Error("SSH remote sync failed with exit code 1. Traceback: FileNotFoundError: No such file or directory"),
    );

    await expect(harness.service.upload(cached.sessionKey)).resolves.toMatchObject({ status: "uploaded" });

    expect(harness.setSessionSourceAvailable).toHaveBeenCalledWith(cached.sessionKey, false);
    expect(harness.buildUpload).toHaveBeenCalled();
    expect(harness.client.uploadSession).toHaveBeenCalled();
  });

  it("rejects a missing SSH session when only its summary is cached", async () => {
    const unavailable = localSession({
      sessionKey: "ssh:uncached",
      rawId: "uncached",
      environmentId: "ssh-1",
      environmentKind: "ssh",
      environmentLabel: "SSH",
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [unavailable],
      uncachedSessionKeys: [unavailable.sessionKey],
    });
    harness.ensureSessionDetails.mockRejectedValue(
      new Error("SSH remote sync failed with exit code 1. Traceback: FileNotFoundError: No such file or directory"),
    );

    await expect(harness.service.upload(unavailable.sessionKey)).rejects.toThrow(
      "its full transcript is not cached locally",
    );

    expect(harness.setSessionSourceAvailable).toHaveBeenCalledWith(unavailable.sessionKey, false);
    expect(harness.buildUpload).not.toHaveBeenCalled();
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
  });

  it("uploads a cached Cursor conversation while preserving an existing cloud source archive", async () => {
    const cached = localSession({
      source: "cursor-agent",
      sourceAvailable: false,
    });
    const binding: SessionSyncBinding = {
      localSessionKey: cached.sessionKey,
      remoteSessionId: "remote-1",
      lastLocalRevision: "local-revision",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 1,
      direction: "upload",
    };
    const archive: RemoteSessionSourceArchive = {
      schemaVersion: 1,
      entries: [{
        sessionKey: cached.sessionKey,
        sourceSessionId: cached.rawId,
        parentSessionId: null,
        artifactKind: "cursor-state",
        fileName: "session.cursor-state.json",
        objectKey: "sessions/remote-1/previous/source/session.cursor-state.json",
        sha256: "a".repeat(64),
        sizeBytes: 100,
      }],
    };
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [cached],
      bindings: [binding],
    });
    vi.mocked(harness.client.getDetailSnapshot).mockResolvedValue({
      sourceArchive: archive,
    } as RemoteSessionDetailSnapshot);

    await expect(harness.service.upload(cached.sessionKey)).resolves.toMatchObject({ status: "uploaded" });

    expect(harness.buildUpload).toHaveBeenCalledWith(
      harness.store,
      cached.sessionKey,
      123,
      "remote-1",
      true,
      archive,
    );
  });

  it("reuses an existing source archive when updating an available local session", async () => {
    const binding: SessionSyncBinding = {
      localSessionKey: "local:session-1",
      remoteSessionId: "remote-1",
      lastLocalRevision: "old-local",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 1,
      direction: "upload",
    };
    const archive: RemoteSessionSourceArchive = {
      schemaVersion: 1,
      entries: [{
        sessionKey: "local:session-1",
        sourceSessionId: "session-1",
        parentSessionId: null,
        artifactKind: "session-file",
        fileName: "session-1.jsonl",
        objectKey: "sessions/remote-1/previous/source/session-1.jsonl",
        sha256: "a".repeat(64),
        sizeBytes: 100,
      }],
    };
    const harness = createHarness({
      settings: configuredSettings(),
      bindings: [binding],
    });
    vi.mocked(harness.client.getDetailSnapshot).mockResolvedValue({
      sourceArchive: archive,
    } as RemoteSessionDetailSnapshot);

    await harness.service.upload("local:session-1");

    expect(harness.buildUpload).toHaveBeenCalledWith(
      harness.store,
      "local:session-1",
      123,
      "remote-1",
      true,
      archive,
    );
  });

  it.each([
    { label: "ZCode", sessionKey: "zcode:session-1", source: "zcode-cli" as const },
    { label: "WorkBuddy", sessionKey: "workbuddy:session-1", source: "workbuddy-cli" as const },
  ])("rejects $label uploads before building a portable remote session", async ({ label, sessionKey, source }) => {
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [localSession({ sessionKey, rawId: "session-1", source })],
    });

    await expect(harness.service.upload(sessionKey)).rejects.toThrow(`${label} sessions cannot be saved remotely yet.`);
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildUpload).not.toHaveBeenCalled();
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it("uploads Pi sessions through manual remote sync", async () => {
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [localSession({ sessionKey: "pi:session-1", rawId: "session-1", source: "pi-cli" })],
    });

    await expect(harness.service.upload("pi:session-1")).resolves.toMatchObject({ status: "uploaded" });
    expect(harness.createClient).toHaveBeenCalledOnce();
    expect(harness.ensureSessionDetails).toHaveBeenCalledWith("pi:session-1");
    expect(harness.buildUpload).toHaveBeenCalledWith(
      harness.store,
      "pi:session-1",
      123,
      undefined,
      true,
      undefined,
    );
    expect(harness.client.uploadSession).toHaveBeenCalledOnce();
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

  it("excludes subagents without hydrating or hashing unrelated local-only sessions", async () => {
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

    expect(harness.client.listRemoteSessionsForSync).toHaveBeenCalledOnce();
    expect(harness.client.listRemoteSessions).not.toHaveBeenCalled();
    expect(harness.store.searchSessions).toHaveBeenCalledWith({
      limit: 100_000,
      excludeSubagents: false,
    });
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session: regular, revision: null }],
      [],
      [],
    );
  });

  it("lists indexed sessions without hydrating or hashing their full contents", async () => {
    const healthy = localSession();
    const unavailable = localSession({
      sessionKey: "ssh:unavailable",
      rawId: "unavailable",
      displayTitle: "Unavailable SSH session",
      environmentId: "ssh-1",
      environmentKind: "ssh",
      environmentLabel: "SSH",
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [healthy, unavailable],
      uncachedSessionKeys: [unavailable.sessionKey],
    });
    harness.ensureSessionDetails.mockImplementation(async (sessionKey) => {
      if (sessionKey === unavailable.sessionKey) {
        throw new Error("SSH remote sync failed with exit code 1. Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory");
      }
    });

    await harness.service.listSyncItems();

    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.client.getDetailSnapshot).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [
        { session: healthy, revision: null },
        { session: unavailable, revision: null },
      ],
      [expect.objectContaining({ id: "remote-1" })],
      [],
    );
    expect(harness.setSessionSourceAvailable).not.toHaveBeenCalled();
    expect(harness.logError).not.toHaveBeenCalled();
  });

  it("excludes an unavailable SSH summary without a cached transcript from later comparisons", async () => {
    const unavailable = localSession({
      sessionKey: "ssh:uncached",
      rawId: "uncached",
      environmentId: "ssh-1",
      environmentKind: "ssh",
      environmentLabel: "SSH",
      sourceAvailable: false,
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [unavailable],
      uncachedSessionKeys: [unavailable.sessionKey],
    });
    vi.mocked(harness.client.listRemoteSessionsForSync).mockResolvedValue([]);

    await harness.service.listSyncItems();

    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith([], [], []);
  });

  it("does not force one event-loop turn per local-only session", async () => {
    const sessions = Array.from({ length: 16 }, (_, index) => localSession({
      sessionKey: `local:session-${index}`,
      rawId: `session-${index}`,
      filePath: `/tmp/session-${index}.jsonl`,
    }));
    const harness = createHarness({ settings: configuredSettings(), sessions });
    vi.mocked(harness.client.listRemoteSessionsForSync).mockResolvedValue([]);
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
    await harness.service.listSyncItems();
    expect(setImmediateSpy).not.toHaveBeenCalled();
    setImmediateSpy.mockRestore();
    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      sessions.map((session) => ({ session, revision: null })),
      [],
      [],
    );
  });

  it("does not inspect attachments while preparing the sync overview", async () => {
    const settings = configuredSettings();
    settings.syncSessionAttachments = false;
    const harness = createHarness({ settings });

    await harness.service.listSyncItems();

    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.store.getAttachmentFile).not.toHaveBeenCalled();
    expect(harness.store.getSessionSourceArtifacts).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session: harness.sessions[0], revision: null }],
      [expect.objectContaining({ id: "remote-1" })],
      [],
    );
  });

  it("repairs an orphaned Cursor binding after its workspace key changes", async () => {
    const current = localSession({
      sessionKey: "cursor:empty-window:same-composer",
      rawId: "same-composer",
      source: "cursor-agent",
      storageEnvironmentId: "local",
    });
    const remote = remoteSession({
      sourceSessionKey: "cursor:repo-old:same-composer",
      sourceAgent: "cursor",
      sourceSource: "cursor-agent",
    });
    const oldBinding: SessionSyncBinding = {
      localSessionKey: remote.sourceSessionKey,
      remoteSessionId: remote.id,
      lastLocalRevision: "old-local",
      lastRemoteRevision: "old-remote",
      lastSyncedAt: 42,
      direction: "upload",
    };
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [current],
      bindings: [oldBinding],
      remote,
    });

    await harness.service.listSyncItems();

    const repairedBinding = { ...oldBinding, localSessionKey: current.sessionKey };
    expect(harness.store.upsertSessionSyncBinding).toHaveBeenCalledWith(repairedBinding);
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session: current, revision: null }],
      [remote],
      [repairedBinding],
    );
  });

  it("lists a cached Cursor conversation without downloading its source archive", async () => {
    const cached = localSession({
      source: "cursor-agent",
      sourceAvailable: false,
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [cached],
    });

    await expect(harness.service.listSyncItems()).resolves.toEqual([]);

    expect(harness.client.getDetailSnapshot).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session: cached, revision: null }],
      [expect.objectContaining({ id: "remote-1" })],
      [],
    );
  });

  it("includes sessions without project paths in the sync comparison", async () => {
    const session = localSession({ projectPath: "" });
    const harness = createHarness({ settings: configuredSettings(), sessions: [session] });

    await harness.service.listSyncItems();

    expect(harness.ensureSessionDetails).not.toHaveBeenCalled();
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildSyncItems).toHaveBeenCalledWith(
      [{ session, revision: null }],
      expect.any(Array),
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

    await expect(harness.service.restore("remote-1", "codex", "/tmp/project", onProgress, true)).resolves.toEqual(
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
      direction: "upload",
    });
  });

  it("keeps a default restore independent from its cloud source", async () => {
    const restored = localSession({ sessionKey: "local:restored", rawId: "restored-session" });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [restored],
      localRevision: "restored-revision",
    });

    await expect(harness.service.restore("remote-1", "codex", "/tmp/project", vi.fn(), false)).resolves.toEqual(
      migrationResult(),
    );

    expect(harness.store.upsertSessionSyncBinding).not.toHaveBeenCalled();
  });

  it("lets a bound restore update the same cloud session even when its project path changes", async () => {
    const restored = localSession({
      sessionKey: "local:restored",
      rawId: "restored-session",
      projectPath: "C:/another-project",
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [restored],
      localRevision: "restored-revision",
    });

    await harness.service.restore("remote-1", "codex", "C:/another-project", vi.fn(), true);
    await expect(harness.service.upload("local:restored")).resolves.toMatchObject({ status: "uploaded" });
    expect(harness.buildUpload).toHaveBeenLastCalledWith(
      harness.store,
      "local:restored",
      123,
      "remote-1",
      true,
      undefined,
    );
    expect(harness.client.uploadSession).toHaveBeenCalled();
  });

  it("rejects an upload that would shrink a complete cloud session to the visible branch", async () => {
    const harness = createHarness({
      settings: configuredSettings(),
      bindings: [{
        localSessionKey: "local:session-1",
        remoteSessionId: "remote-1",
        lastLocalRevision: "old-local",
        lastRemoteRevision: "remote-revision",
        lastSyncedAt: 1,
        direction: "upload",
      }],
      remote: remoteSession({ messageCount: 205 }),
    });
    harness.buildUpload.mockReturnValue({
      payload: { content_hash: "new-local", message_count: 41 },
      detailJson: "{}",
      portableJson: "{}",
      attachmentObjects: [],
      sourceObjects: [],
    } as unknown as ReturnType<RemoteSessionServiceOperations["buildUpload"]>);

    await expect(harness.service.upload("local:session-1")).rejects.toThrow(
      "cannot overwrite a cloud session with fewer messages",
    );
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
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

  it("uploads the parent bundle when a subagent event changes", async () => {
    const event = queueEvent({
      sessionId: "child",
      transcriptPath: "/tmp/child.jsonl",
    });
    const parent = localSession();
    const child = localSession({
      sessionKey: "local:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      isSubagent: true,
      parentSessionId: parent.rawId,
    });
    const harness = createHarness({
      settings: configuredSettings(),
      sessions: [parent, child],
      queueEvents: [event],
    });

    await harness.service.drainQueue();

    expect(harness.removeQueueFiles).toHaveBeenCalledWith([event.filePath]);
    expect(harness.ensureSessionDetails).toHaveBeenCalledTimes(2);
    expect(harness.ensureSessionDetails).toHaveBeenCalledWith(parent.sessionKey);
    expect(harness.ensureSessionDetails).toHaveBeenCalledWith(child.sessionKey);
    expect(harness.buildRevision).not.toHaveBeenCalled();
    expect(harness.buildUpload).toHaveBeenCalledOnce();
    expect(harness.client.uploadSession).toHaveBeenCalledOnce();
  });

  it("coalesces parent and subagent queue events into one upload", async () => {
    const parent = localSession();
    const child = localSession({
      sessionKey: "local:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      isSubagent: true,
      parentSessionId: parent.rawId,
    });
    const events = [
      queueEvent(),
      queueEvent({ sessionId: child.rawId, transcriptPath: child.filePath, filePath: "/tmp/queue/child.json" }),
    ];
    const harness = createHarness({ settings: configuredSettings(), sessions: [parent, child], queueEvents: events });

    await harness.service.drainQueue();

    expect(harness.buildUpload).toHaveBeenCalledOnce();
    expect(harness.client.uploadSession).toHaveBeenCalledOnce();
    expect(harness.removeQueueFiles).toHaveBeenCalledWith(events.map((event) => event.filePath));
  });

  it("removes an unchanged revision without uploading storage objects", async () => {
    const event = queueEvent();
    const harness = createHarness({
      settings: configuredSettings(),
      queueEvents: [event],
      localRevision: "same-revision",
      remote: remoteSession({ contentHash: "same-revision" }),
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
    expect(harness.createClient).toHaveBeenCalledOnce();
    expect(harness.client.uploadSession).not.toHaveBeenCalled();
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
    expect(harness.runIndexSync).not.toHaveBeenCalled();
    harness.intervalCallbacks[0]();
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
