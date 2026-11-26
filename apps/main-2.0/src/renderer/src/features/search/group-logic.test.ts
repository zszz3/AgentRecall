import { describe, expect, it } from "vitest";
import { groupSessions } from "./group-logic";

const now = new Date(2026, 10, 23, 21, 0).getTime();
const day = 24 * 60 * 60 * 1000;

function session(sessionKey: string, startedAt: number, lastActivityAt: number) {
  return { sessionKey, source: "codex-cli" as const, projectPath: "/repo", timestamp: startedAt, lastActivityAt };
}

describe("groupSessions", () => {
  it("files each Session under the day of the time its row shows", () => {
    const sessions = [
      session("started-last-week-active-now", now - 5 * day, now - 10 * 60 * 1000),
      session("started-and-active-yesterday", now - day, now - day),
    ];

    const groups = groupSessions(sessions, "time", now, (item) => item.lastActivityAt);

    expect(groups.map((group) => [group.key, group.sessions.map((item) => item.sessionKey)])).toEqual([
      ["today", ["started-last-week-active-now"]],
      ["yesterday", ["started-and-active-yesterday"]],
    ]);
  });
});
