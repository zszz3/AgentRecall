import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";
import { loadDefaultSessions, loadZcodeSessions } from "./session-loader";
import { SessionStore } from "./session-store";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

const roots: string[] = [];

function tempZcodeRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-zcode-${name}-`));
  roots.push(root);
  return root;
}

function databasePath(root: string): string {
  const dbPath = path.join(root, "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

function createCoreSchema(db: import("node:sqlite").DatabaseSync, includeUsage = true): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      parent_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  if (!includeUsage) return;
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      assistant_message_id TEXT,
      query_source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insertSession(db: import("node:sqlite").DatabaseSync, id: string, directory: string, parentId: string | null = null): void {
  db.prepare("INSERT INTO session (id, title, directory, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    id === "session-child" ? "Child investigation" : "ZCode checkout fix",
    directory,
    Date.parse("2026-07-21T08:00:00Z"),
    Date.parse("2026-07-21T08:10:00Z"),
    parentId,
  );
}

function insertMessage(
  db: import("node:sqlite").DatabaseSync,
  id: string,
  sessionId: string,
  time: number,
  data: string,
): void {
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, time, time, data);
}

function insertPart(
  db: import("node:sqlite").DatabaseSync,
  id: string,
  messageId: string,
  sessionId: string,
  time: number,
  data: string,
): void {
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    messageId,
    sessionId,
    time,
    time,
    data,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ZCode session loader", () => {
  it("returns no sessions for a missing, corrupt, or incompatible database", () => {
    const missingRoot = tempZcodeRoot("missing");
    expect(loadZcodeSessions(missingRoot)).toEqual([]);

    const corruptRoot = tempZcodeRoot("corrupt");
    fs.writeFileSync(databasePath(corruptRoot), "not a sqlite database");
    expect(() => loadZcodeSessions(corruptRoot)).not.toThrow();
    expect(loadZcodeSessions(corruptRoot)).toEqual([]);

    const incompatibleRoot = tempZcodeRoot("schema");
    const incompatible = new DatabaseSync(databasePath(incompatibleRoot));
    incompatible.exec("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT);");
    incompatible.close();
    expect(() => loadZcodeSessions(incompatibleRoot)).not.toThrow();
    expect(loadZcodeSessions(incompatibleRoot)).toEqual([]);
  });

  it("loads ordered messages, bounded tool traces, parent metadata, and authoritative model usage", () => {
    const root = tempZcodeRoot("complete");
    const projectPath = path.join(root, "project");
    const db = new DatabaseSync(databasePath(root));
    createCoreSchema(db);
    insertSession(db, "session-main", projectPath);
    insertSession(db, "session-child", projectPath, "session-main");

    const userTime = Date.parse("2026-07-21T08:01:00Z");
    const assistantTime = Date.parse("2026-07-21T08:02:00Z");
    insertMessage(db, "message-user", "session-main", userTime, JSON.stringify({ role: "user" }));
    insertPart(db, "part-user-2", "message-user", "session-main", userTime + 2, JSON.stringify({ type: "text", text: "second line" }));
    insertPart(db, "part-user-bad", "message-user", "session-main", userTime + 1, "{bad-json");
    insertPart(db, "part-user-1", "message-user", "session-main", userTime, JSON.stringify({ type: "text", text: "Fix checkout" }));

    insertMessage(db, "message-assistant", "session-main", assistantTime, JSON.stringify({ role: "assistant", modelID: "GLM-5.2" }));
    insertPart(db, "part-assistant", "message-assistant", "session-main", assistantTime, JSON.stringify({ type: "text", text: "I will inspect it." }));
    insertMessage(db, "message-bad", "session-main", assistantTime + 1, "{bad-json");
    insertPart(db, "part-bad-message", "message-bad", "session-main", assistantTime + 1, JSON.stringify({ type: "text", text: "must be skipped" }));

    const longOutput = "x".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS + 500);
    const tools = [
      ["running", "call-running", "unknown", ""],
      ["completed", "call-completed", "success", longOutput],
      ["error", "call-error", "failure", "command failed"],
      ["cancelled", "call-cancelled", "unknown", "cancelled by user"],
    ] as const;
    tools.forEach(([status, callId, _expectedStatus, output], index) => {
      insertPart(
        db,
        `part-tool-${index}`,
        "message-assistant",
        "session-main",
        assistantTime + index + 1,
        JSON.stringify({
          type: "tool",
          callID: callId,
          tool: "Bash",
          state: {
            status,
            input: { command: "npm test", description: "Run tests" },
            ...(output ? { output } : {}),
            time: { start: assistantTime + index + 10, end: assistantTime + index + 20 },
          },
        }),
      );
    });

    insertMessage(db, "message-child", "session-child", assistantTime + 10, JSON.stringify({ role: "user" }));
    insertPart(db, "part-child", "message-child", "session-child", assistantTime + 10, JSON.stringify({ type: "text", text: "Investigate child" }));

    const insertUsage = db.prepare(`
      INSERT INTO model_usage (
        id, session_id, assistant_message_id, query_source, status, started_at, completed_at,
        input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens
      ) VALUES (?, 'session-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertUsage.run("usage-1", "message-assistant", "main", "completed", assistantTime + 100, assistantTime + 200, 100, 20, 5, 10, 30);
    const oldUsageTime = Date.parse("2026-06-01T08:00:00Z");
    insertUsage.run("usage-2", "message-assistant", "agent", "completed", oldUsageTime, null, 50, 10, 0, 0, 5);
    insertUsage.run("usage-error", null, "main", "error", assistantTime + 400, assistantTime + 500, 500, 500, 0, 0, 0);
    insertUsage.run("usage-title", "message-assistant", "session_title", "completed", assistantTime + 500, assistantTime + 600, 999, 999, 0, 0, 0);
    insertUsage.run("usage-user", "message-user", "main", "completed", assistantTime + 600, assistantTime + 700, 999, 999, 0, 0, 0);
    insertUsage.run("usage-orphan", null, "main", "completed", assistantTime + 700, assistantTime + 800, 999, 999, 0, 0, 0);
    db.close();

    const loaded = loadZcodeSessions(root);
    expect(loaded).toHaveLength(2);
    const main = loaded.find((item) => item.session.rawId === "session-main");
    const child = loaded.find((item) => item.session.rawId === "session-child");
    expect(main?.session).toMatchObject({
      sessionKey: "zcode:session-main",
      source: "zcode-cli",
      projectPath,
      originalTitle: "ZCode checkout fix",
      firstQuestion: "Fix checkout",
      isSubagent: false,
      parentSessionId: null,
      tokenUsage: {
        inputTokens: 105,
        cachedInputTokens: 45,
        outputTokens: 30,
        reasoningOutputTokens: 5,
        totalTokens: 185,
      },
    });
    expect(main?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Fix checkout\nsecond line",
      "assistant:I will inspect it.",
    ]);
    expect(child?.session).toMatchObject({ isSubagent: true, parentSessionId: "session-main" });
    expect(main?.tokenEvents).toEqual([
      {
        timestamp: oldUsageTime,
        dedupeKey: "usage-2",
        inputTokens: 45,
        cachedInputTokens: 5,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 60,
      },
      {
        timestamp: assistantTime + 200,
        dedupeKey: "usage-1",
        inputTokens: 60,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 125,
      },
    ]);
    expect(main?.traceEvents?.map((event) => [event.callId, event.status])).toEqual(
      tools.map(([, callId, expectedStatus]) => [callId, expectedStatus]),
    );
    expect(main?.traceEvents?.[0]).toMatchObject({ kind: "tool_call", source: "zcode", title: "Bash · npm test" });
    expect(main?.traceEvents?.[0].detail).toContain('"command": "npm test"');
    expect(main?.traceEvents?.[1].detail).toContain("[Indexed preview truncated:");
    expect(main?.traceEvents?.[1].detail.length).toBeLessThanOrEqual(TRACE_DETAIL_PREVIEW_MAX_CHARS);

    expect(main).toBeDefined();
    if (!main) throw new Error("Expected the synthetic ZCode session to load.");
    const store = new SessionStore(":memory:");
    try {
      store.upsertIndexedSession(main.session, main.messages, main.tokenEvents, main.traceEvents);
      expect(store.searchSessions({ query: "checkout", source: "zcode-cli" }).map((session) => session.sessionKey)).toEqual(["zcode:session-main"]);
      expect(store.listProjects().map((project) => project.path)).toContain(projectPath);
      expect(store.getMessages("zcode:session-main")).toEqual(main.messages);
      expect(store.getTraceEvents("zcode:session-main")).toHaveLength(4);
      const now = Date.parse("2026-07-21T12:00:00Z");
      expect(store.getStats({ period: "today" }, now).bySource).toEqual([
        expect.objectContaining({ source: "zcode-cli", totalTokens: 125 }),
      ]);
      expect(store.getStats({ period: "allTime" }, now).bySource).toEqual([
        expect.objectContaining({ source: "zcode-cli", totalTokens: 185 }),
      ]);
    } finally {
      store.close();
    }
  });

  it("indexes legacy sessions without usage tables with zero token usage", () => {
    const root = tempZcodeRoot("legacy");
    const db = new DatabaseSync(databasePath(root));
    createCoreSchema(db, false);
    insertSession(db, "legacy-session", path.join(root, "legacy-project"));
    insertMessage(db, "legacy-message", "legacy-session", 1, JSON.stringify({ role: "user" }));
    insertPart(db, "legacy-part", "legacy-message", "legacy-session", 1, JSON.stringify({ type: "text", text: "Legacy question" }));
    db.close();

    const loaded = loadZcodeSessions(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    });
    expect(loaded[0].tokenEvents).toEqual([]);
  });

  it("keeps ZCode out of the default index until the optional source is enabled", () => {
    const homeDir = tempZcodeRoot("optional-setting");
    const db = new DatabaseSync(databasePath(path.join(homeDir, ".zcode")));
    createCoreSchema(db, false);
    insertSession(db, "optional-session", path.join(homeDir, "optional-project"));
    insertMessage(db, "optional-message", "optional-session", 1, JSON.stringify({ role: "user" }));
    insertPart(db, "optional-part", "optional-message", "optional-session", 1, JSON.stringify({ type: "text", text: "Optional question" }));
    db.close();

    expect(loadDefaultSessions({ homeDir }).some((item) => item.session.source === "zcode-cli")).toBe(false);
    expect(loadDefaultSessions({ homeDir, includeZcode: true }).map((item) => item.session.sessionKey)).toContain("zcode:optional-session");
  });

  it("uses WAL changes in the database fingerprint when the main file is unchanged", () => {
    const root = tempZcodeRoot("wal");
    const dbPath = databasePath(root);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    createCoreSchema(db, false);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    insertSession(db, "wal-session", path.join(root, "wal-project"));
    insertMessage(db, "wal-message", "wal-session", 1, JSON.stringify({ role: "user" }));
    insertPart(db, "wal-part", "wal-message", "wal-session", 1, JSON.stringify({ type: "text", text: "Before WAL update" }));

    const walPath = `${dbPath}-wal`;
    const mainBefore = fs.statSync(dbPath);
    const first = loadZcodeSessions(root)[0].session;
    expect(first.fileSize).toBe(fs.statSync(dbPath).size + fs.statSync(walPath).size);

    db.prepare("UPDATE session SET title = ?, time_updated = ? WHERE id = ?").run("Updated through WAL", 2, "wal-session");
    const future = new Date(first.fileMtimeMs + 2_000);
    fs.utimesSync(walPath, future, future);
    const mainAfter = fs.statSync(dbPath);
    const second = loadZcodeSessions(root)[0].session;

    expect(mainAfter.mtimeMs).toBe(mainBefore.mtimeMs);
    expect(second.fileMtimeMs).toBeGreaterThan(first.fileMtimeMs);
    expect(second.originalTitle).toBe("Updated through WAL");
    db.close();
  });
});
