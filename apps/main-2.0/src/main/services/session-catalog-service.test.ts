import { describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../../core/session-store";
import type { SessionSearchResult } from "../../core/types";
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
    deleteSession: vi.fn(async () => true),
    deleteSessionRecord: vi.fn(async () => true),
  };
  const service = new SessionCatalogService({
    store: store as unknown as SessionStore,
  } as SessionCatalogServiceDependencies);
  return { service, store };
}

describe("SessionCatalogService deletion policy", () => {
  it("deletes only the indexed record for an unavailable SSH Cursor cache", async () => {
    const { service, store } = createService(session({ sourceAvailable: false }));

    await expect(service.delete("cursor:remote:cached")).resolves.toBe(true);

    expect(store.deleteSessionRecord).toHaveBeenCalledWith("cursor:remote:cached");
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
});
