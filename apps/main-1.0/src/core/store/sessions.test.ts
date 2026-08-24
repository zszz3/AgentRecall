import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CodexIncrementalState, IndexedSession } from "../types";
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
  it("stores AI summary freshness for millisecond file timestamps", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const fileMtimeMs = 1_786_512_474_899.402;
      const session = indexedSession({ fileMtimeMs });
      store.upsertIndexedSession(session, []);

      expect(store.setAiSummary(session.sessionKey, "Summary", "test-model")).toBe(true);
      const row = db.prepare("SELECT ai_summary_basis FROM sessions WHERE session_key = ?")
        .get(session.sessionKey) as { ai_summary_basis: number };
      expect(row.ai_summary_basis).toBe(fileMtimeMs);
    } finally {
      db.close();
    }
  });

  it("round-trips Codex lifecycle fields and reconstructs private incremental state", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const session = indexedSession();
      const toolCallState: NonNullable<CodexIncrementalState["toolCallState"]> = {
        observations: [{
          callId: "exec-parent#ast-0",
          parentCallId: "exec-parent",
          turnId: "turn-1",
          namespace: null,
          rawName: "exec_command",
          input: { cmd: "pwd" },
          cwd: "/repo",
          status: "unknown",
          evidence: "code-mode-ast",
          durationMs: null,
          timestamp: Date.parse("2026-07-30T08:00:00.000Z"),
        }],
        cwd: "/repo",
        declaredSessionFormat: "paginated",
        sawToolCompletion: false,
      };
      store.upsertIndexedSession(
        session,
        [{
          role: "assistant",
          content: "done",
          timestamp: "2026-07-30T08:00:01.000Z",
          index: 0,
          sourceTurnId: "turn-1",
          phase: "final_answer",
        }],
        [{
          timestamp: Date.parse("2026-07-30T08:00:02.000Z"),
          dedupeKey: "turn-1-usage",
          inputTokens: 10,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 11,
          sourceTurnId: "turn-1",
        }],
        [{
          index: 0,
          kind: "event",
          source: "codex",
          title: "Turn started",
          detail: "",
          timestamp: "2026-07-30T08:00:00.000Z",
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId: "turn-1",
          attributes: { startedAt: "2026-07-30T08:00:00.000Z" },
        }],
        {
          historyMode: "paginated",
          messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:message-1" }],
          activeTurnIds: ["turn-1"],
          toolCallState,
        },
      );

      expect(store.getMessages(session.sessionKey)).toMatchObject([{
        sourceTurnId: "turn-1",
        phase: "final_answer",
      }]);
      expect(store.getTraceEvents(session.sessionKey)).toMatchObject([{
        sourceTurnId: "turn-1",
        attributes: { startedAt: "2026-07-30T08:00:00.000Z" },
      }]);
      expect(store.getTokenEvents(session.sessionKey)).toMatchObject([{
        dedupeKey: "turn-1-usage",
        sourceTurnId: "turn-1",
      }]);
      expect(store.getCodexIncrementalState(session.sessionKey)).toEqual({
        historyMode: "paginated",
        messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:message-1" }],
        activeTurnIds: ["turn-1"],
        toolCallState,
      });
    } finally {
      db.close();
    }
  });

  it("normalizes legacy trace statuses when reading SQLite rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const session = indexedSession();
      store.upsertIndexedSession(session, [], [], [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "result",
        detail: "done",
        timestamp: "2026-07-16T00:00:00.000Z",
        status: "completed",
      }]);
      db.prepare("UPDATE trace_events SET status = 'success' WHERE session_key = ?").run(session.sessionKey);

      expect(store.getTraceEvents(session.sessionKey)[0]?.status).toBe("completed");
    } finally {
      db.close();
    }
  });

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
      store.addTag(session.sessionKey, "authentication");

      expect(store.searchSessions({ query: "refresh token" })).toEqual([
        expect.objectContaining({
          sessionKey: session.sessionKey,
          displayTitle: "Token repair",
          tags: ["authentication"],
          messageCount: 2,
        }),
      ]);
      expect(store.getMessages(session.sessionKey)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("keeps an AgentRecall title when the Cursor title changes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const cursor = indexedSession({
        sessionKey: "cursor:repo:session-1",
        source: "cursor-agent",
        originalTitle: "Old Cursor title",
      });
      store.upsertIndexedSession(cursor, []);
      store.setCustomTitle(cursor.sessionKey, "Old AgentRecall title");

      store.upsertIndexedSession({
        ...cursor,
        originalTitle: "Renamed in Cursor",
        fileMtimeMs: cursor.fileMtimeMs + 1,
      }, []);

      expect(store.getSession(cursor.sessionKey)).toMatchObject({
        originalTitle: "Renamed in Cursor",
        customTitle: "Old AgentRecall title",
        displayTitle: "Old AgentRecall title",
      });

      store.setCustomTitle(cursor.sessionKey, null);
      expect(store.getSession(cursor.sessionKey)).toMatchObject({
        customTitle: null,
        displayTitle: "Renamed in Cursor",
      });
    } finally {
      db.close();
    }
  });

  it("chunks very large FTS content while preserving metadata and migrated keys", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const session = indexedSession({ fileSize: 900_000 });
      store.upsertIndexedSession(session, [{
        role: "user",
        content: `start marker ${"x".repeat(700_000)} end marker`,
        timestamp: "2026-07-16T00:00:00.000Z",
        index: 0,
      }]);

      const fts = db.prepare(`
        SELECT COUNT(*) AS count, MAX(length(content_text)) AS max_length
        FROM session_fts
        WHERE session_key = ?
      `).get(session.sessionKey) as { count: number; max_length: number };
      expect(fts.count).toBeGreaterThan(1);
      expect(fts.max_length).toBeLessThanOrEqual(256 * 1024);
      expect(store.searchSessions({ query: "end marker" })).toHaveLength(1);
      expect(store.searchSessions({ query: "start marker end marker" })).toHaveLength(1);
      expect(store.isIndexedSessionFresh(session)).toBe(true);

      store.setCustomTitle(session.sessionKey, "Chunked session title");
      expect(store.setAiSummary(session.sessionKey, "Chunked summary marker", "test-model")).toBe(true);
      expect(store.searchSessions({ query: "Chunked session title" })).toHaveLength(1);
      expect(store.searchSessions({ query: "Chunked summary marker" })).toHaveLength(1);
      expect(store.searchSessions({ query: "end marker" })).toHaveLength(1);

      const targetKey = `${session.sessionKey}:migrated`;
      expect(store.migrateSessionKeyPreservingUserState(session.sessionKey, targetKey)).toBe(true);
      for (const query of ["Chunked session title", "Chunked summary marker", "end marker"]) {
        expect(store.searchSessions({ query })).toEqual([
          expect.objectContaining({ sessionKey: targetKey }),
        ]);
      }
      const migratedFts = db.prepare(`
        SELECT
          COUNT(*) AS count,
          MAX(length(content_text)) AS max_length,
          SUM(CASE WHEN title <> '' THEN 1 ELSE 0 END) AS title_rows
        FROM session_fts
        WHERE session_key = ?
      `).get(targetKey) as { count: number; max_length: number; title_rows: number };
      expect(migratedFts.count).toBeGreaterThan(1);
      expect(migratedFts.max_length).toBeLessThanOrEqual(256 * 1024);
      expect(migratedFts.title_rows).toBe(1);
      const migratedSession = { ...session, sessionKey: targetKey };
      expect(store.isIndexedSessionFresh(migratedSession)).toBe(true);

      db.prepare(`
        UPDATE sessions
        SET content_indexed_mtime_ms = 0, content_indexed_size = 0
        WHERE session_key = ?
      `).run(targetKey);
      expect(store.isIndexedSessionFresh(migratedSession)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("moves metadata off a legacy oversized FTS row without retaining stale matches", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const store = new SessionsStore(db, new EnvironmentStore(db));
      const session = indexedSession({ fileSize: 400_000 });
      store.upsertIndexedSession(session, [{
        role: "user",
        content: "current searchable content",
        timestamp: "2026-07-16T00:00:00.000Z",
        index: 0,
      }]);
      db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(session.sessionKey);
      db.prepare(`
        INSERT INTO session_fts (session_key, title, first_question, content_text, project_path)
        VALUES (?, 'legacy stale marker', '', ?, '')
      `).run(session.sessionKey, "x".repeat(300_000));

      store.setCustomTitle(session.sessionKey, "Fresh title marker");

      expect(store.searchSessions({ query: "legacy stale marker" })).toHaveLength(0);
      expect(store.searchSessions({ query: "Fresh title marker" })).toHaveLength(1);
      const rows = db.prepare(`
        SELECT title, length(content_text) AS content_length
        FROM session_fts
        WHERE session_key = ?
        ORDER BY CASE WHEN content_text = '' THEN 0 ELSE 1 END, rowid
      `).all(session.sessionKey) as Array<{ title: string; content_length: number }>;
      expect(rows).toEqual([
        { title: "Fresh title marker", content_length: 0 },
        { title: "", content_length: 300_000 },
      ]);
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
