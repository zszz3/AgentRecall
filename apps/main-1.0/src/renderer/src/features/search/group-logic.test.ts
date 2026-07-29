import { describe, expect, it } from "vitest";
import { groupSessions, isNoProjectGroupKey, timeBucket, type GroupableSession } from "./group-logic";

const NOW = new Date("2026-07-15T12:00:00.000Z").getTime();

function session(overrides: Partial<GroupableSession> = {}): GroupableSession {
  return {
    sessionKey: "s1",
    source: "codex-cli",
    projectPath: "/work/app",
    timestamp: NOW,
    ...overrides,
  };
}

describe("groupSessions", () => {
  it("returns a single flat group for flat mode", () => {
    const groups = groupSessions([session(), session({ sessionKey: "s2" })], "flat", NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("all");
    expect(groups[0].sessions).toHaveLength(2);
  });

  it("returns empty for no sessions", () => {
    expect(groupSessions([], "project", NOW)).toEqual([]);
  });

  it("groups by project path", () => {
    const groups = groupSessions(
      [
        session({ sessionKey: "a", projectPath: "/work/app" }),
        session({ sessionKey: "b", projectPath: "/work/other" }),
        session({ sessionKey: "c", projectPath: "/work/app" }),
      ],
      "project",
      NOW,
    );
    expect(groups).toHaveLength(2);
    const app = groups.find((g) => g.key === "/work/app");
    expect(app?.sessions).toHaveLength(2);
  });

  it("groups Codex task workspaces and empty paths as source-specific no-project groups", () => {
    const groups = groupSessions(
      [
        session({ sessionKey: "codex-a", source: "codex-cli", projectPath: "/Users/me/Documents/Codex/2026-07-16/1" }),
        session({ sessionKey: "codex-b", source: "codex-app", projectPath: "C:\\Users\\me\\Documents\\Codex\\2026-07-16\\2" }),
        session({ sessionKey: "cursor", source: "cursor-agent", projectPath: "" }),
        session({ sessionKey: "repo", source: "codex-cli", projectPath: "/work/app" }),
      ],
      "project",
      NOW,
    );
    const noProjectGroups = groups.filter((group) => isNoProjectGroupKey(group.key));
    expect(noProjectGroups).toHaveLength(2);
    expect(noProjectGroups.find((group) => group.sessions[0]?.source.startsWith("codex"))?.sessions).toHaveLength(2);
    expect(noProjectGroups.find((group) => group.sessions[0]?.source === "cursor-agent")?.sessions).toHaveLength(1);
    expect(groups.find((group) => group.key === "/work/app")?.sessions).toHaveLength(1);
  });

  it("keeps date-like non-Codex paths as real projects", () => {
    const [group] = groupSessions(
      [session({ projectPath: "/work/archive/2026-07-16/1" })],
      "project",
      NOW,
    );
    expect(group.key).toBe("/work/archive/2026-07-16/1");
  });

  it("groups by source", () => {
    const groups = groupSessions(
      [
        session({ sessionKey: "a", source: "codex-cli" }),
        session({ sessionKey: "b", source: "claude-cli" }),
      ],
      "source",
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(["claude-cli", "codex-cli"]);
  });

  it("groups by time bucket", () => {
    const day = 24 * 60 * 60 * 1000;
    const groups = groupSessions(
      [
        session({ sessionKey: "today", timestamp: NOW }),
        session({ sessionKey: "old", timestamp: NOW - 30 * day }),
      ],
      "time",
      NOW,
    );
    expect(groups.map((g) => g.key)).toContain("today");
    expect(groups.map((g) => g.key)).toContain("older");
  });

  it("orders time buckets chronologically", () => {
    const day = 24 * 60 * 60 * 1000;
    const groups = groupSessions(
      [
        session({ sessionKey: "old", timestamp: NOW - 30 * day }),
        session({ sessionKey: "today", timestamp: NOW }),
      ],
      "time",
      NOW,
    );
    expect(groups[0].key).toBe("today");
    expect(groups[groups.length - 1].key).toBe("older");
  });
});

describe("timeBucket", () => {
  const day = 24 * 60 * 60 * 1000;
  it("classifies today", () => {
    expect(timeBucket(NOW, NOW)).toBe("today");
  });
  it("classifies yesterday", () => {
    expect(timeBucket(NOW - day, NOW)).toBe("yesterday");
  });
  it("classifies this week", () => {
    expect(timeBucket(NOW - 3 * day, NOW)).toBe("thisWeek");
  });
  it("classifies older", () => {
    expect(timeBucket(NOW - 30 * day, NOW)).toBe("older");
  });
});
