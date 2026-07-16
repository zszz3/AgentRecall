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
});
