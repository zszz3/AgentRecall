import { describe, expect, it } from "vitest";
import { filterSessionsByLiveStatus, getLiveSessionState, liveSessionKeyForSession } from "./live-filter";

const codex = { source: "codex-cli", rawId: "codex-1", sessionKey: "codex:codex-1" } as const;
const claude = { source: "claude-cli", rawId: "claude-1", sessionKey: "claude:claude-1" } as const;
const codebuddy = { source: "codebuddy-cli", rawId: "codebuddy-1", sessionKey: "codebuddy:codebuddy-1" } as const;

describe("live session filtering", () => {
  it("builds stable live keys from session source family and raw id", () => {
    expect(liveSessionKeyForSession(codex)).toBe("codex:codex-1");
    expect(liveSessionKeyForSession(claude)).toBe("claude:claude-1");
    expect(liveSessionKeyForSession(codebuddy)).toBe("codebuddy:codebuddy-1");
  });

  it("filters sessions by open and closed live status", () => {
    const liveKeys = new Set(["codex:codex-1"]);

    expect(filterSessionsByLiveStatus([codex, claude], liveKeys, "all", false).map((session) => session.sessionKey)).toEqual([
      "codex:codex-1",
      "claude:claude-1",
    ]);
    expect(filterSessionsByLiveStatus([codex, claude], liveKeys, "open", false).map((session) => session.sessionKey)).toEqual([
      "codex:codex-1",
    ]);
    expect(filterSessionsByLiveStatus([codex, claude], liveKeys, "closed", false).map((session) => session.sessionKey)).toEqual([
      "claude:claude-1",
    ]);
  });

  it("treats sessions as unknown when live detection fails", () => {
    expect(getLiveSessionState(codex, new Set(["codex:codex-1"]), true)).toBe("unknown");
    expect(filterSessionsByLiveStatus([codex], new Set(["codex:codex-1"]), "open", true)).toEqual([]);
  });
});
