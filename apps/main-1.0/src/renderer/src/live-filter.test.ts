import { afterEach, describe, expect, it, vi } from "vitest";

import { filterSessionsByLiveStatus, getLiveSessionState } from "./live-filter";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const LIVE_KEYS = new Set(["codex:session-1", "codex:session-2"]);

describe("live session inactivity fallback", () => {
  afterEach(() => vi.useRealTimers());

  it("closes a detected session after 24 hours and reopens it after new activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = {
      source: "codex-cli" as const,
      rawId: "session-1",
      lastActivityAt: NOW - 24 * HOUR_MS,
    };

    expect(getLiveSessionState(session, LIVE_KEYS, false)).toBe("closed");

    session.lastActivityAt = NOW - HOUR_MS;
    expect(getLiveSessionState(session, LIVE_KEYS, false)).toBe("open");
  });

  it("applies the inactivity fallback to open and closed filters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const sessions = [
      { source: "codex-cli" as const, rawId: "session-1", lastActivityAt: NOW - HOUR_MS },
      { source: "codex-cli" as const, rawId: "session-2", lastActivityAt: NOW - 25 * HOUR_MS },
    ];

    expect(filterSessionsByLiveStatus(sessions, LIVE_KEYS, "open", false).map((session) => session.rawId)).toEqual([
      "session-1",
    ]);
    expect(filterSessionsByLiveStatus(sessions, LIVE_KEYS, "closed", false).map((session) => session.rawId)).toEqual([
      "session-2",
    ]);
  });
});
