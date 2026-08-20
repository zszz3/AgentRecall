import { describe, expect, it, vi } from "vitest";
import {
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionBulkDeleteTarget,
} from "../../core/session-bulk-delete";
import type { SessionStore } from "../../core/session-store";
import type { LiveSessionSnapshot, SessionSearchResult } from "../../core/types";
import {
  SessionCatalogService,
  type SessionCatalogServiceDependencies,
} from "./session-catalog-service";

function session(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey: "cursor:remote:cached",
    rawId: "cached",
    source: "cursor-agent",
    projectPath: "/remote/repo",
    filePath: "/remote/state.vscdb",
    originalTitle: "Cached Cursor session",
    firstQuestion: "Question",
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "ssh-dev",
    environmentKind: "ssh",
    environmentLabel: "SSH · dev",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    displayTitle: "Cached Cursor session",
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

function createService(current: SessionSearchResult) {
  const deletionTarget: SessionBulkDeleteTarget = {
    sessionKey: current.sessionKey,
    cascadeRootSessionKey: current.sessionKey,
    orphanedParentSessionId: null,
    rawId: current.rawId,
    source: current.source,
    filePath: current.filePath,
    isSubagent: current.isSubagent === true,
    parentSessionId: current.parentSessionId ?? null,
    ancestorRawIds: [],
    sourceAvailable: current.sourceAvailable !== false,
    favorited: current.favorited,
    lastActivityAt: current.lastActivityAt,
    environmentId: current.environmentId,
    environmentKind: current.environmentKind,
  };
  const store = {
    getSession: vi.fn(async () => current),
    getSessionDeletionTargets: vi.fn(async (): Promise<SessionBulkDeleteTarget[]> => [deletionTarget]),
    listEnvironments: vi.fn(async () => []),
    invalidateOpenVikingEvidenceForSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => true),
    deleteExactSessionTargets: vi.fn(async (
      targets: readonly SessionBulkDeleteTarget[],
      requestedSessionKey: string,
    ) => targets.some((target) => target.sessionKey === requestedSessionKey)),
    deleteSessionRecord: vi.fn(async () => true),
    deleteSessionRecords: vi.fn(async (keys: readonly string[]) => [...keys]),
  };
  const loadLiveSessions = vi.fn(async (): Promise<LiveSessionSnapshot> => ({
    generatedAt: "2026-08-03T00:00:00.000Z",
    sessions: [],
  }));
  const service = new SessionCatalogService({
    store: store as unknown as SessionStore,
    loadLiveSessions,
  } as unknown as SessionCatalogServiceDependencies);
  return { service, store, loadLiveSessions };
}

describe("SessionCatalogService deletion policy", () => {
  it("deletes only the indexed record for an unavailable SSH Cursor cache", async () => {
    const { service, store } = createService(session({ sourceAvailable: false }));

    await expect(service.delete("cursor:remote:cached")).resolves.toBe(true);

    expect(store.deleteExactSessionTargets).toHaveBeenCalledWith([
      expect.objectContaining({ sessionKey: "cursor:remote:cached" }),
    ], "cursor:remote:cached");
    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });

  it("does not expose destructive deletion for an available SSH source", async () => {
    const { service, store } = createService(session({ sourceAvailable: true }));

    await expect(service.delete("cursor:remote:cached")).rejects.toThrow(
      "Cannot delete sessions stored on SSH remote environments.",
    );

    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });

  it("rechecks final SSH target availability after the live-session scan", async () => {
    const current = session({ sourceAvailable: false });
    const { service, store } = createService(current);
    store.getSessionDeletionTargets.mockResolvedValue([{
      sessionKey: current.sessionKey,
      cascadeRootSessionKey: current.sessionKey,
      orphanedParentSessionId: null,
      rawId: current.rawId,
      source: current.source,
      filePath: current.filePath,
      isSubagent: false,
      parentSessionId: null,
      ancestorRawIds: [],
      sourceAvailable: true,
      favorited: false,
      lastActivityAt: current.lastActivityAt,
      environmentId: current.environmentId,
      environmentKind: current.environmentKind,
    }]);

    await expect(service.delete(current.sessionKey)).rejects.toThrow(
      "Cannot delete sessions stored on SSH remote environments.",
    );
    expect(store.deleteExactSessionTargets).not.toHaveBeenCalled();
  });

  it("rejects an unavailable SSH cache when an expanded descendant is still available", async () => {
    const current = session({ sourceAvailable: false });
    const { service, store } = createService(current);
    const root = (await store.getSessionDeletionTargets())[0];
    store.getSessionDeletionTargets.mockResolvedValue([
      root,
      {
        ...root,
        sessionKey: "cursor:remote:available-child",
        rawId: "available-child",
        filePath: "/remote/available-child.jsonl",
        isSubagent: true,
        parentSessionId: current.rawId,
        ancestorRawIds: [current.rawId],
        sourceAvailable: true,
      },
    ]);

    await expect(service.delete(current.sessionKey)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    const preview = await service.previewBulkDelete({
      sessionKeys: [current.sessionKey],
      liveSessionKeys: [],
    });
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
      confirmationFingerprint: preview.confirmationFingerprint,
    })).rejects.toThrow("Cannot delete sessions stored on SSH remote environments.");
    expect(store.deleteExactSessionTargets).not.toHaveBeenCalled();
  });

  it("passes the exact confirmed SSH session tree to the store", async () => {
    const current = session({ sourceAvailable: false });
    const { service, store } = createService(current);
    const root: SessionBulkDeleteTarget = {
      sessionKey: current.sessionKey,
      cascadeRootSessionKey: current.sessionKey,
      orphanedParentSessionId: null,
      rawId: current.rawId,
      source: current.source,
      filePath: current.filePath,
      isSubagent: false,
      parentSessionId: null,
      ancestorRawIds: [],
      sourceAvailable: false,
      favorited: false,
      lastActivityAt: current.lastActivityAt,
      environmentId: current.environmentId,
      environmentKind: current.environmentKind,
    };
    const child = {
      sessionKey: "cursor:remote:child",
      cascadeRootSessionKey: current.sessionKey,
      orphanedParentSessionId: null,
      rawId: "child",
      source: current.source,
      filePath: "/remote/child.jsonl",
      isSubagent: true,
      parentSessionId: current.rawId,
      ancestorRawIds: [current.rawId],
      sourceAvailable: false,
      favorited: false,
      lastActivityAt: current.lastActivityAt,
      environmentId: current.environmentId,
      environmentKind: current.environmentKind,
    } satisfies SessionBulkDeleteTarget;
    store.getSessionDeletionTargets.mockResolvedValue([root, child]);

    await expect(service.delete(current.sessionKey)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    const preview = await service.previewBulkDelete({ sessionKeys: [current.sessionKey], liveSessionKeys: [] });
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
      confirmationFingerprint: preview.confirmationFingerprint,
    })).resolves.toBe(true);
    expect(store.deleteExactSessionTargets).toHaveBeenCalledWith([
      expect.objectContaining({ sessionKey: current.sessionKey }),
      child,
    ], current.sessionKey);
  });

  it("rejects Pi deletion before the source file deletion path", async () => {
    const { service, store } = createService(session({
      sessionKey: "pi:local",
      source: "pi-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/pi-session.jsonl",
    }));

    await expect(service.delete("pi:local", {
      confirmed: true,
      allowLiveSessions: true,
    })).rejects.toThrow("Pi session source files are read-only.");

    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });

  it("rejects WorkBuddy deletion before the source file deletion path", async () => {
    const { service, store } = createService(session({
      sessionKey: "workbuddy:local",
      source: "workbuddy-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/workbuddy-session.jsonl",
    }));

    await expect(service.delete("workbuddy:local")).rejects.toThrow("WorkBuddy session source files are read-only.");

    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.getSessionDeletionTargets).not.toHaveBeenCalled();
  });

  it("rejects Kimi deletion before the source file deletion path", async () => {
    const { service, store } = createService(session({
      sessionKey: "kimi:local",
      source: "kimi-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/kimi/context.jsonl",
    }));

    await expect(service.delete("kimi:local")).rejects.toThrow("Kimi Code session source files are read-only.");

    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.getSessionDeletionTargets).not.toHaveBeenCalled();
  });

  it("refreshes live sessions in the main process before deleting a local session", async () => {
    const current = session({
      sessionKey: "codex:live",
      rawId: "live",
      source: "codex-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/live.jsonl",
      sourceAvailable: true,
    });
    const { service, store, loadLiveSessions } = createService(current);
    loadLiveSessions.mockResolvedValue({
      generatedAt: "2026-08-03T00:00:01.000Z",
      sessions: [{ family: "codex", rawId: "live", pid: 42 }],
    });

    await expect(service.delete(current.sessionKey)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
    })).rejects.toThrow(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
      allowLiveSessions: true,
      confirmationFingerprint: (await service.previewBulkDelete({
        sessionKeys: [current.sessionKey],
        liveSessionKeys: ["codex:live"],
      })).confirmationFingerprint,
    })).resolves.toBe(true);

    expect(loadLiveSessions).toHaveBeenCalledWith(true);
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.deleteSessionRecords).toHaveBeenCalledWith([current.sessionKey], false);
  });

  it("requires confirmation when the final preflight discovers related sessions", async () => {
    const current = session({
      sessionKey: "codex:parent",
      rawId: "parent",
      source: "codex-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/parent.jsonl",
      sourceAvailable: true,
    });
    const { service, store } = createService(current);
    store.getSessionDeletionTargets.mockResolvedValue([
      {
        sessionKey: current.sessionKey,
        cascadeRootSessionKey: current.sessionKey,
        orphanedParentSessionId: null,
        rawId: current.rawId,
        source: current.source,
        filePath: current.filePath,
        isSubagent: false,
        parentSessionId: null,
        ancestorRawIds: [],
        sourceAvailable: true,
        favorited: false,
        lastActivityAt: current.lastActivityAt,
        environmentId: "local",
        environmentKind: "local",
      },
      {
        sessionKey: "codex:child",
        cascadeRootSessionKey: current.sessionKey,
        orphanedParentSessionId: null,
        rawId: "child",
        source: current.source,
        filePath: "/fixtures/child.jsonl",
        isSubagent: true,
        parentSessionId: current.rawId,
        ancestorRawIds: [current.rawId],
        sourceAvailable: true,
        favorited: false,
        lastActivityAt: current.lastActivityAt,
        environmentId: "local",
        environmentKind: "local",
      },
    ]);

    await expect(service.delete(current.sessionKey)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();

    const preview = await service.previewBulkDelete({ sessionKeys: [current.sessionKey], liveSessionKeys: [] });
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
      confirmationFingerprint: preview.confirmationFingerprint,
    })).resolves.toBe(true);
    expect(store.deleteSessionRecords).toHaveBeenCalledWith(
      [current.sessionKey, "codex:child"],
      false,
    );
  });

  it("normalizes and rejects invalid deletion options before reading the session", async () => {
    const { service, store } = createService(session());

    await expect(service.delete("cursor:remote:cached", null)).rejects.toThrow(
      "The session deletion options are invalid.",
    );
    await expect(service.delete("cursor:remote:cached", {
      confirmed: "yes",
    })).rejects.toThrow("The session deletion options are invalid.");

    expect(store.getSession).not.toHaveBeenCalled();
  });

  it("allows a confirmed live Hermes deletion without bypassing the shared-database path", async () => {
    const current = session({
      sessionKey: "hermes:live",
      rawId: "live",
      source: "hermes",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/hermes.db",
      sourceAvailable: true,
    });
    const { service, store, loadLiveSessions } = createService(current);
    loadLiveSessions.mockResolvedValue({
      generatedAt: "2026-08-03T00:00:01.000Z",
      sessions: [{ family: "hermes", rawId: "live", pid: 42 }],
    });

    await expect(service.delete(current.sessionKey, {
      confirmed: true,
    })).rejects.toThrow(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    await expect(service.delete(current.sessionKey, {
      confirmed: true,
      allowLiveSessions: true,
      confirmationFingerprint: (await service.previewBulkDelete({
        sessionKeys: [current.sessionKey],
        liveSessionKeys: ["hermes:live"],
      })).confirmationFingerprint,
    })).resolves.toBe(true);

    expect(store.deleteExactSessionTargets).toHaveBeenCalledWith([
      expect.objectContaining({ sessionKey: current.sessionKey }),
    ], current.sessionKey);
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("deletes an unavailable WSL shared-database cache through exact prepared targets", async () => {
    const current = session({
      sessionKey: "hermes:wsl-cache",
      rawId: "wsl-cache",
      source: "hermes",
      environmentId: "ubuntu",
      environmentKind: "wsl",
      filePath: "/home/user/.hermes/state.db",
      sourceAvailable: false,
    });
    const { service, store } = createService(current);

    await expect(service.delete(current.sessionKey)).resolves.toBe(true);

    expect(store.deleteSessionRecords).toHaveBeenCalledWith([current.sessionKey]);
    expect(store.deleteExactSessionTargets).not.toHaveBeenCalled();
  });

  it("uses the family-aware deletion service for a local file session", async () => {
    const current = session({
      sessionKey: "codex:closed",
      rawId: "closed",
      source: "codex-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/missing-closed.jsonl",
      sourceAvailable: true,
    });
    const { service, store } = createService(current);

    await expect(service.delete(current.sessionKey)).resolves.toBe(true);

    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.invalidateOpenVikingEvidenceForSessions).toHaveBeenCalledWith([
      expect.objectContaining({ sessionKey: current.sessionKey }),
    ]);
    expect(store.deleteSessionRecords).toHaveBeenCalledWith([current.sessionKey], false);
  });

  it("keeps sessions that were live in the confirmed preview protected", async () => {
    const current = session({
      sessionKey: "codex:preview-live",
      rawId: "preview-live",
      source: "codex-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/preview-live.jsonl",
      sourceAvailable: true,
    });
    const { service, store, loadLiveSessions } = createService(current);

    await expect(service.bulkDeleteSessions({
      sessionKeys: [current.sessionKey],
      liveSessionKeys: [current.sessionKey],
    })).resolves.toMatchObject({
      deletedSessionKeys: [],
      skipped: [{ sessionKey: current.sessionKey, reason: "live" }],
    });

    expect(loadLiveSessions).toHaveBeenCalledWith(true);
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("fails closed when the fresh live-session scan reports an error until separately confirmed", async () => {
    const current = session({
      sessionKey: "codex:closed",
      rawId: "closed",
      source: "codex-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/missing-closed.jsonl",
      sourceAvailable: true,
    });
    const { service, store, loadLiveSessions } = createService(current);
    loadLiveSessions.mockResolvedValue({
      generatedAt: "2026-08-03T00:00:01.000Z",
      sessions: [],
      error: "process list unavailable",
    });

    const request = {
      sessionKeys: [current.sessionKey],
      liveSessionKeys: [],
    };
    const preview = await service.previewBulkDelete({ ...request, liveSessionCheckFailed: true });
    expect(preview).toMatchObject({
      liveSessionCheckFailed: true,
    });
    await expect(service.previewBulkDelete(request)).resolves.toMatchObject({
      liveSessionCheckFailed: false,
    });
    await expect(service.bulkDeleteSessions(request)).rejects.toThrow(
      SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
    );
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();

    await expect(service.bulkDeleteSessions({
      ...request,
      confirmed: true,
      allowUnverifiedLiveSessions: true,
      confirmationFingerprint: preview.confirmationFingerprint,
    })).resolves.toMatchObject({
      deletedSessionKeys: [current.sessionKey],
      liveSessionCheckFailed: true,
      skipped: [],
      failed: [],
    });

    expect(loadLiveSessions).toHaveBeenCalledWith(true);
    expect(store.deleteSessionRecords).toHaveBeenCalledWith([current.sessionKey], false);
  });

  it.each(["opencode-cli", "codewiz-cli"] as const)(
    "deletes an unavailable SSH %s cache through exact prepared targets",
    async (source) => {
      const current = session({
        sessionKey: `${source}:ssh-cache`,
        rawId: "ssh-cache",
        source,
        environmentId: "ssh-dev",
        environmentKind: "ssh",
        filePath: `/remote/${source}.db`,
        sourceAvailable: false,
      });
      const { service, store } = createService(current);

      await expect(service.delete(current.sessionKey)).resolves.toBe(true);
      expect(store.deleteExactSessionTargets).toHaveBeenCalledWith([
        expect.objectContaining({ source, sourceAvailable: false }),
      ], current.sessionKey);
    },
  );

  it.each(["opencode-cli", "codewiz-cli"] as const)(
    "deletes only the indexed record for an unavailable WSL %s cache",
    async (source) => {
      const current = session({
        sessionKey: `${source}:wsl-cache`,
        rawId: "wsl-cache",
        source,
        environmentId: "ubuntu",
        environmentKind: "wsl",
        filePath: `/home/user/${source}.db`,
        sourceAvailable: false,
      });
      const { service, store } = createService(current);

      await expect(service.delete(current.sessionKey)).resolves.toBe(true);
      expect(store.deleteSessionRecords).toHaveBeenCalledWith([current.sessionKey]);
      expect(store.deleteExactSessionTargets).not.toHaveBeenCalled();
    },
  );

  it("refuses to delete a shared Hermes database file on WSL", async () => {
    const store = {
      getSession: vi.fn(async () => session({
        sessionKey: "hermes:wsl",
        rawId: "wsl",
        source: "hermes",
        environmentId: "ubuntu",
        environmentKind: "wsl",
        filePath: "/home/user/.hermes/state.db",
        sourceAvailable: true,
      })),
      deleteSession: vi.fn(async () => true),
      deleteSessionRecord: vi.fn(async () => true),
      deleteSessionRecords: vi.fn(async (keys: readonly string[]) => [...keys]),
    };
    const service = new SessionCatalogService({
      store: store as unknown as SessionStore,
      requireWslEnvironment: vi.fn(async () => ({ id: "ubuntu", kind: "wsl", label: "WSL" })),
    } as unknown as SessionCatalogServiceDependencies);

    await expect(service.delete("hermes:wsl")).rejects.toThrow(
      "Cannot delete shared source databases on WSL by removing the database file.",
    );
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
  });

});
