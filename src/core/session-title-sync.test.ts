import { describe, expect, it, vi } from "vitest";
import { setSessionCustomTitleAndSyncTerminal } from "./session-title-sync";
import type { SessionSearchResult } from "./types";

function session(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey: "codex-cli:1",
    rawId: "1",
    source: "codex-cli",
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    projectPath: "/repo",
    filePath: "/repo/session.jsonl",
    originalTitle: "Original",
    firstQuestion: "Original",
    timestamp: 0,
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    displayTitle: "Original",
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 0,
    aiSummary: null,
    aiSummaryStale: false,
    ...overrides,
  };
}

describe("session title synchronization", () => {
  it("persists first and then syncs the updated display title", async () => {
    const calls: string[] = [];
    let current = session();

    await setSessionCustomTitleAndSyncTerminal(current.sessionKey, "Renamed", {
      getSession: () => current,
      setCustomTitle: (_key, title) => {
        calls.push(`persist:${title}`);
        current = { ...current, customTitle: title, displayTitle: title || current.originalTitle };
      },
      loadLiveSessions: async () => ({
        generatedAt: new Date(0).toISOString(),
        sessions: [{ family: "codex", rawId: current.rawId, pid: 303 }],
      }),
      setLiveTerminalTitle: async (pid, title) => {
        calls.push(`sync:${pid}:${title}`);
        return true;
      },
    });

    expect(calls).toEqual(["persist:Renamed", "sync:303:Renamed"]);
  });

  it("keeps the rename successful when terminal synchronization throws", async () => {
    let persisted = false;
    const current = session();
    const onSyncError = vi.fn();

    await expect(
      setSessionCustomTitleAndSyncTerminal(current.sessionKey, "Renamed", {
        getSession: () => current,
        setCustomTitle: () => {
          persisted = true;
          current.customTitle = "Renamed";
          current.displayTitle = "Renamed";
        },
        loadLiveSessions: async () => ({
          generatedAt: new Date(0).toISOString(),
          sessions: [{ family: "codex", rawId: current.rawId, pid: 303 }],
        }),
        setLiveTerminalTitle: async () => {
          throw new Error("automation denied");
        },
        onSyncError,
      }),
    ).resolves.toBeUndefined();

    expect(persisted).toBe(true);
    expect(onSyncError).toHaveBeenCalledOnce();
  });

  it("uses the fallback display title when the custom title is cleared", async () => {
    let current = session({ customTitle: "Renamed", displayTitle: "Renamed" });
    const syncedTitles: string[] = [];

    await setSessionCustomTitleAndSyncTerminal(current.sessionKey, null, {
      getSession: () => current,
      setCustomTitle: () => {
        current = { ...current, customTitle: null, displayTitle: current.originalTitle };
      },
      loadLiveSessions: async () => ({
        generatedAt: new Date(0).toISOString(),
        sessions: [{ family: "codex", rawId: current.rawId, pid: 303 }],
      }),
      setLiveTerminalTitle: async (_pid, title) => {
        syncedTitles.push(title);
        return true;
      },
    });

    expect(syncedTitles).toEqual(["Original"]);
  });

  it("persists remote sessions without trying local terminal synchronization", async () => {
    const current = session({ environmentId: "remote-1", environmentKind: "ssh", environmentLabel: "Remote" });
    const loadLiveSessions = vi.fn();
    let persisted = false;

    await setSessionCustomTitleAndSyncTerminal(current.sessionKey, "Renamed", {
      getSession: () => current,
      setCustomTitle: () => {
        persisted = true;
      },
      loadLiveSessions,
      setLiveTerminalTitle: vi.fn(),
    });

    expect(persisted).toBe(true);
    expect(loadLiveSessions).not.toHaveBeenCalled();
  });

  it("skips terminal synchronization when no matching live PID exists", async () => {
    const current = session();
    const setLiveTerminalTitle = vi.fn();

    await setSessionCustomTitleAndSyncTerminal(current.sessionKey, "Renamed", {
      getSession: () => current,
      setCustomTitle: () => {
        current.customTitle = "Renamed";
        current.displayTitle = "Renamed";
      },
      loadLiveSessions: async () => ({ generatedAt: new Date(0).toISOString(), sessions: [] }),
      setLiveTerminalTitle,
    });

    expect(setLiveTerminalTitle).not.toHaveBeenCalled();
  });

  it("does nothing for a missing session", async () => {
    const setCustomTitle = vi.fn();

    await setSessionCustomTitleAndSyncTerminal("missing", "Renamed", {
      getSession: () => null,
      setCustomTitle,
      loadLiveSessions: vi.fn(),
      setLiveTerminalTitle: vi.fn(),
    });

    expect(setCustomTitle).not.toHaveBeenCalled();
  });

  it("downgrades a live-snapshot error after persisting", async () => {
    const current = session();
    const setLiveTerminalTitle = vi.fn();
    const onSyncError = vi.fn();

    await setSessionCustomTitleAndSyncTerminal(current.sessionKey, "Renamed", {
      getSession: () => current,
      setCustomTitle: () => {
        current.customTitle = "Renamed";
        current.displayTitle = "Renamed";
      },
      loadLiveSessions: async () => ({ generatedAt: new Date(0).toISOString(), sessions: [], error: "ps failed" }),
      setLiveTerminalTitle,
      onSyncError,
    });

    expect(current.displayTitle).toBe("Renamed");
    expect(setLiveTerminalTitle).not.toHaveBeenCalled();
    expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: "ps failed" }));
  });
});
