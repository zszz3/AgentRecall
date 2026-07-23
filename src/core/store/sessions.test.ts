import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { IndexedSession } from "../types";
import { EnvironmentStore } from "./environments";
import { migrateSessionStore } from "./schema";
import { SessionsStore } from "./sessions";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function indexedSession(overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey: "codex:session-1",
    rawId: "session-1",
    source: "codex-cli",
    projectPath: "/work/project",
    filePath: "/tmp/session-1.jsonl",
    originalTitle: "Original title",
    firstQuestion: "How do I refresh a token?",
    timestamp: 100,
    fileMtimeMs: 200,
    fileSize: 300,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    ...overrides,
  };
}

describe("SessionsStore", () => {
  it("indexes and searches session messages while preserving user metadata", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const session = indexedSession();
      store.upsertIndexedSession(session, [
        { role: "user", content: "The refresh token is stale", timestamp: "2026-07-16T00:00:00.000Z", index: 0 },
        { role: "assistant", content: "Rotate the token and retry", timestamp: "2026-07-16T00:01:00.000Z", index: 1 },
      ]);
      store.setCustomTitle(session.sessionKey, "Token repair");
      store.setPinned(session.sessionKey, true);
      store.addTag(session.sessionKey, "authentication");

      expect(store.searchSessions({ query: "refresh token" })).toEqual([
        expect.objectContaining({
          sessionKey: session.sessionKey,
          displayTitle: "Token repair",
          pinned: true,
          tags: ["authentication"],
          messageCount: 2,
        }),
      ]);
      expect(store.getMessages(session.sessionKey)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("smart sort ranks recent partial matches above ancient exact title matches", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      // Ancient session whose title exactly matches the query (90 days old).
      store.upsertIndexedSession(indexedSession({
        sessionKey: "codex:ancient",
        rawId: "ancient",
        originalTitle: "deploy",
        firstQuestion: "deploy the app",
        timestamp: now - 90 * dayMs,
        fileMtimeMs: now - 90 * dayMs,
      }), [
        { role: "user", content: "deploy the app", timestamp: new Date(now - 90 * dayMs).toISOString(), index: 0 },
      ]);

      // Recent session that only mentions the query in body text (1 day old).
      store.upsertIndexedSession(indexedSession({
        sessionKey: "codex:recent",
        rawId: "recent",
        originalTitle: "Fix login bug",
        firstQuestion: "deploy pipeline broke after merge",
        timestamp: now - 1 * dayMs,
        fileMtimeMs: now - 1 * dayMs,
      }), [
        { role: "user", content: "deploy pipeline broke after merge", timestamp: new Date(now - 1 * dayMs).toISOString(), index: 0 },
      ]);

      // Smart sort: recent partial match should outrank ancient exact title match.
      const smartResults = store.searchSessions({ query: "deploy", sortBy: "smart" });
      expect(smartResults.map((s) => s.sessionKey)).toEqual(["codex:recent", "codex:ancient"]);

      // Activity sort: exact title match still wins (pure relevance first).
      const activityResults = store.searchSessions({ query: "deploy", sortBy: "activity" });
      expect(activityResults[0].sessionKey).toBe("codex:ancient");
    } finally {
      db.close();
    }
  });

  it("composes environment, subagent, project, and statistics boundaries", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const environments = new EnvironmentStore(db);
      const remote = environments.upsertEnvironment({ kind: "ssh", label: "devbox", host: "dev.example.com" });
      const store = new SessionsStore(db, environments);
      store.upsertIndexedSession(indexedSession(), [
        { role: "user", content: "local", timestamp: "2026-07-16T00:00:00.000Z", index: 0 },
      ]);
      store.upsertIndexedSession(indexedSession({
        sessionKey: "ssh:devbox:codex:subagent",
        rawId: "subagent",
        environmentId: remote.id,
        projectPath: "/work/remote",
        filePath: "/tmp/subagent.jsonl",
        isSubagent: true,
      }), [
        { role: "user", content: "remote", timestamp: "2026-07-16T00:00:00.000Z", index: 0 },
      ]);

      expect(store.searchSessions({ excludeSubagents: true }).map((session) => session.sessionKey)).toEqual([
        "codex:session-1",
      ]);
      expect(store.listProjects({ excludeSubagents: true }).map((project) => project.path)).toEqual([
        "/work/project",
      ]);
      expect(store.getStats({ period: "allTime", excludeSubagents: true }, 1_000).total.sessionCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("reports the previous comparable period for day/week/month and none for allTime", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const DAY = 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00.000Z").getTime();
      const at = (offsetMs: number): string => new Date(now - offsetMs).toISOString();

      // Two messages "today", one message "yesterday".
      store.upsertIndexedSession(indexedSession({ sessionKey: "codex:today", rawId: "today", filePath: "/tmp/today.jsonl" }), [
        { role: "user", content: "a", timestamp: at(1 * 60 * 60 * 1000), index: 0 },
        { role: "assistant", content: "b", timestamp: at(2 * 60 * 60 * 1000), index: 1 },
      ]);
      store.upsertIndexedSession(indexedSession({ sessionKey: "codex:yesterday", rawId: "yesterday", filePath: "/tmp/yesterday.jsonl" }), [
        { role: "user", content: "c", timestamp: at(DAY + 1 * 60 * 60 * 1000), index: 0 },
      ]);

      const today = store.getStats({ period: "today" }, now);
      expect(today.total.messageCount).toBe(2);
      expect(today.previousTotal?.messageCount).toBe(1);

      const allTime = store.getStats({ period: "allTime" }, now);
      expect(allTime.previousTotal).toBeNull();
    } finally {
      db.close();
    }
  });
});
