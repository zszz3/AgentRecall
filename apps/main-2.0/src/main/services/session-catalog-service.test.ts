import { describe, expect, it, vi } from "vitest";
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
  const store = {
    getSession: vi.fn(async () => current),
    getSessionDeletionTargets: vi.fn(async () => [{
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
    }]),
    listEnvironments: vi.fn(async () => []),
    deleteSession: vi.fn(async () => true),
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

    expect(store.deleteSessionRecords).toHaveBeenCalledWith(["cursor:remote:cached"]);
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

  it("rejects Pi deletion before the source file deletion path", async () => {
    const { service, store } = createService(session({
      sessionKey: "pi:local",
      source: "pi-cli",
      environmentId: "local",
      environmentKind: "local",
      filePath: "/fixtures/pi-session.jsonl",
    }));

    await expect(service.delete("pi:local")).rejects.toThrow("Pi session source files are read-only.");

    expect(store.deleteSessionRecord).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
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

    await expect(service.delete(current.sessionKey)).rejects.toThrow("currently live");

    expect(loadLiveSessions).toHaveBeenCalledWith(true);
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
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
