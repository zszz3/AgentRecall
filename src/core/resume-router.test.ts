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
  it("returns an actionable error when the selected session disappeared", () => {
    expect(() => routeResumeSession(undefined, [], { platform: "darwin" })).toThrow(
      "Refresh the session list",
    );
  });

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

  it("opens a local Codex App session directly on macOS and Windows", () => {
    const appSession = session({
      sessionKey: "codex-app:550e8400-e29b-41d4-a716-446655440000",
      rawId: "550e8400-e29b-41d4-a716-446655440000",
      source: "codex-app",
    });

    expect(routeResumeSession(appSession, [{ family: "codex", rawId: appSession.rawId, pid: 20 }], { platform: "darwin" })).toEqual({ route: "app" });
    expect(routeResumeSession(appSession, [], { platform: "win32" })).toEqual({ route: "app" });
  });

  it("keeps Claude App sessions on the Claude CLI resume route", () => {
    const appSession = session({
      sessionKey: "claude-app:claude-1",
      rawId: "claude-1",
      source: "claude-app",
    });

    expect(routeResumeSession(appSession, [], { platform: "darwin" })).toEqual({ route: "resume" });
    expect(routeResumeSession(appSession, [], { platform: "win32" })).toEqual({ route: "resume" });
  });

  it("does not open a local App for remote or unsupported Codex App sessions", () => {
    const appSession = session({ source: "codex-app" });
    expect(routeResumeSession({ ...appSession, environmentId: "server", environmentKind: "ssh" }, [], { platform: "darwin" })).toEqual({ route: "resume" });
    expect(routeResumeSession(appSession, [], { platform: "linux" })).toEqual({ route: "resume" });
  });

  it("resumes when the session is not open or focusing is unsupported", () => {
    expect(routeResumeSession(session(), [], { platform: "darwin" })).toEqual({ route: "resume" });
    expect(routeResumeSession(session(), [{ family: "codex", rawId: "codex-1", pid: 20 }], { platform: "linux" })).toEqual({ route: "resume" });
  });
});
