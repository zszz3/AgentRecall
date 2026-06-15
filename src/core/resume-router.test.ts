import { describe, expect, it } from "vitest";
import { routeResumeSession } from "./resume-router";
import type { LiveSession, SessionSearchResult } from "./types";

function session(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey: "codex-cli:codex-1",
    rawId: "codex-1",
    source: "codex-cli",
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    projectPath: "",
    filePath: "",
    originalTitle: "",
    firstQuestion: "",
    timestamp: 0,
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    displayTitle: "",
    favorited: false,
    pinned: false,
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

describe("resume routing", () => {
  it("focuses an already-open session on macOS", () => {
    const liveSessions: LiveSession[] = [
      { family: "claude", rawId: "codex-1", pid: 10 },
      { family: "codex", rawId: "codex-1", pid: 20 },
    ];

    expect(routeResumeSession(session(), liveSessions, { platform: "darwin" })).toEqual({ route: "focus", pid: 20 });
  });

  it("focuses an already-open session on Windows", () => {
    expect(routeResumeSession(session(), [{ family: "codex", rawId: "codex-1", pid: 20 }], { platform: "win32" })).toEqual({
      route: "focus",
      pid: 20,
    });
  });

  it("resumes when the session is not open or focusing is unsupported", () => {
    expect(routeResumeSession(session(), [], { platform: "darwin" })).toEqual({ route: "resume" });
    expect(routeResumeSession(session(), [{ family: "codex", rawId: "codex-1", pid: 20 }], { platform: "linux" })).toEqual({ route: "resume" });
  });
});
