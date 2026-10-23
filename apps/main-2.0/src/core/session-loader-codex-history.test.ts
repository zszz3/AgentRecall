import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { loadCodexSessionRows, loadCodexSessions, loadCodexSessionsIterator, loadCodexSessionsAsyncIterator } from "./session-loader";
import { canDeleteSessionLocally, isSharedSessionSourceDatabase } from "./session-environment";
import { sessionSourceDeletionPaths } from "./session-source-delete";
import { readSessionSourceArtifacts } from "./session-source-archive";
import type { LoadedSession, SessionSearchResult } from "./types";
import { createInMemoryStore } from "./postgres/test-session-store";
import { syncDefaultSessionsInBatches } from "./indexer";
import { extractSessionContextComponents } from "./session-context-components";
import { resolveCodexResponsesRequest } from "./codex-request-export";
import { defaultSettings, getResumeCommand } from "./platform";

const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof Database };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-codex-history-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const root = path.join(home, ".codex");
  fs.mkdirSync(root);
  const state = new DatabaseSync(path.join(root, "state_5.sqlite"));
  cleanup.push(() => state.close());
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,"
    + " source TEXT, cwd TEXT, title TEXT, history_mode TEXT, archived INTEGER, originator TEXT, git_branch TEXT)");
  const historyPath = path.join(root, "thread_history_1.sqlite");
  const db = new DatabaseSync(historyPath);
  cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,"
    + " started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, error_json TEXT);"
    + "CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,"
    + " created_at_ms INTEGER, item_json TEXT);"
    + "CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER)");
  function thread(id: string, archived = 0) {
    const rollout = path.join(root, "sessions", id + ".jsonl");
    state.prepare("INSERT INTO threads VALUES (?,?,100,110,'appServer',?,?,'paginated',?,'Codex Desktop','feature')")
      .run(id, rollout, path.join(home, "project"), "Title " + id, archived);
    db.prepare("INSERT INTO thread_turns VALUES (?, 'turn-1', 1, 'completed', 100, 110, 10000, NULL)").run(id);
    db.prepare("INSERT INTO thread_history_projection_state VALUES (?,0,1)").run(id);
    return rollout;
  }
  function item(id: string, ordinal: number, itemValue: Record<string, unknown>) {
    db.prepare("INSERT INTO thread_items VALUES (?, 'turn-1', ?, ?, ?, ?)").run(
      id, String(itemValue.id), ordinal, 100000 + ordinal * 1000, JSON.stringify(itemValue),
    );
  }
  return { home, root, state, db, historyPath, thread, item };
}

function localSession(loaded: LoadedSession): SessionSearchResult {
  return {
    ...loaded.session, environmentId: "local", environmentKind: "local", environmentLabel: "Local",
    tokenUsage: loaded.session.tokenUsage!, customTitle: null, displayTitle: loaded.session.originalTitle, favorited: false,
    hidden: false, tags: [], matchSnippet: null, lastOpenedAt: null, lastResumedAt: null,
    lastActivityAt: 110000, messageCount: loaded.messages.length, aiSummary: null, aiSummaryStale: false,
  };
}

describe("Codex SQLite paginated history", () => {
  it.each(["sync", "async"])("discovers database-only threads with ordered messages and tools (%s)", async (mode) => {
    const f = fixture();
    f.thread("history");
    // Deliberately insert rows out of their source order.
    f.item("history", 4, { type: "agentMessage", id: "answer", text: "完整的中文回答", phase: "final_answer" });
    f.item("history", 2, { type: "userMessage", id: "question", content: [{ type: "text", text: "SQLite 中的问题" }] });
    f.item("history", 3, { type: "commandExecution", id: "command", command: "echo synthetic",
      cwd: f.home, status: "completed", aggregatedOutput: "synthetic output", exitCode: 0 });
    f.thread("archived", 1);
    f.item("archived", 2, { type: "agentMessage", id: "private-answer", text: "archived answer" });
    expect(fs.existsSync(path.join(f.root, "sessions"))).toBe(false);
    const loaded = mode === "sync" ? loadCodexSessions(f.root)
      : await collect(loadCodexSessionsAsyncIterator(f.root));
    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      rawId: "history", sessionKey: "codex:history", source: "codex-app",
      projectPath: path.join(f.home, "project"), originalTitle: "Title history", gitBranch: "feature",
      filePath: f.historyPath, timestamp: 110000,
    });
    expect(loaded[0].messages).toMatchObject([
      { role: "user", content: "SQLite 中的问题", sourceTurnId: "turn-1" },
      { role: "assistant", content: "完整的中文回答", phase: "final_answer", sourceTurnId: "turn-1" },
    ]);
    expect(loaded[0].traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "codex.command_execution", detail: expect.stringContaining("synthetic output") }),
      expect.objectContaining({ eventType: "codex.turn.completed", status: "completed", sourceTurnId: "turn-1" }),
    ]));
    expect(loaded[0].session.tokenUsage?.totalTokens).toBe(0);
    const onSkippedFile = vi.fn();
    f.db.prepare("UPDATE thread_items SET item_json = 'not parsed on a requested skip' WHERE thread_id = 'history'").run();
    const skipOptions = { shouldSkipCodexSqliteSession: () => true, onSkippedFile };
    const skipped = mode === "sync" ? [...loadCodexSessionsIterator(f.root, undefined, skipOptions)]
      : await collect(loadCodexSessionsAsyncIterator(f.root, undefined, skipOptions));
    expect(skipped).toEqual([]);
    expect(onSkippedFile).toHaveBeenCalledWith(f.historyPath, expect.any(Object));
  });

  it("keeps legacy files and merges a paginated rollout once without losing its usage", async () => {
    const f = fixture();
    const rollout = f.thread("mixed");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const rawRows = [
      { type: "session_meta", payload: { id: "mixed", cwd: f.home, title: "Old title", history_mode: "paginated" } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1",
        item: { type: "UserMessage", id: "question", content: [{ type: "text", text: "原问题" }] } } },
      { type: "event_msg", timestamp: "1970-01-01T00:01:44Z", payload: { type: "token_count",
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } },
    ];
    fs.writeFileSync(rollout, rawRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.writeFileSync(path.join(path.dirname(rollout), "legacy.jsonl"), [
      { type: "session_meta", payload: { id: "legacy", cwd: f.home } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "legacy question" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    f.item("mixed", 2, { type: "userMessage", id: "question", content: [{ type: "text", text: "原问题" }] });
    f.item("mixed", 3, { type: "agentMessage", id: "answer", text: "数据库回答" });
    f.db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset = ? WHERE thread_id = ?").run(fs.statSync(rollout).size, "mixed");
    const loaded = await collect(loadCodexSessionsAsyncIterator(f.root));
    expect(loaded.map((value) => value.session.rawId).sort()).toEqual(["legacy", "mixed"]);
    const mixed = loaded.find((value) => value.session.rawId === "mixed")!;
    expect(mixed.session).toMatchObject({ originalTitle: "Title mixed", projectPath: path.join(f.home, "project") });
    expect(mixed.messages.map((message) => message.content)).toEqual(["原问题", "数据库回答"]);
    expect(mixed.session.tokenUsage?.totalTokens).toBe(15);
  });

  it("indexes database-only history, preserves user state and refreshes shared WAL changes", async () => {
    const f = fixture();
    f.thread("indexed");
    f.item("indexed", 2, { type: "userMessage", id: "question", content: [{ type: "text", text: "database question" }] });
    f.item("indexed", 3, { type: "agentMessage", id: "answer", text: "before" });
    const store = createInMemoryStore();
    cleanup.push(() => store.close());
    const options = { loadOptions: { homeDir: f.home } };
    expect(await syncDefaultSessionsInBatches(store, options)).toMatchObject({ indexed: 1, error: null });
    await store.setFavorited("codex:indexed", true);
    const onSkippedFile = vi.fn();
    expect(await syncDefaultSessionsInBatches(store, { loadOptions: { ...options.loadOptions, onSkippedFile } }))
      .toMatchObject({ indexed: 0, skipped: 1, error: null });
    expect(onSkippedFile).toHaveBeenCalledWith(f.historyPath, expect.any(Object));
    f.db.prepare("UPDATE thread_items SET item_json = ? WHERE item_id = 'answer'").run(
      JSON.stringify({ type: "agentMessage", id: "answer", text: "after" }),
    );
    f.thread("second");
    f.item("second", 2, { type: "agentMessage", id: "answer-2", text: "new thread" });
    expect(await syncDefaultSessionsInBatches(store, options)).toMatchObject({ indexed: 2, error: null });
    expect(await store.searchSessions({ query: "after" })).toHaveLength(1);
    expect(await store.searchSessions({ query: "before" })).toHaveLength(0);
    expect(await store.getSession("codex:indexed")).toMatchObject({ favorited: true });
    expect(await store.searchSessions({ query: "new thread" })).toHaveLength(1);
    await expect(Promise.resolve().then(() => store.deleteSession("codex:indexed"))).rejects.toThrow("read-only");
    expect(f.db.prepare("SELECT count(*) AS count FROM thread_items").get()?.count).toBe(3);
  });

  it("retains failed, interrupted and running turns with their original identities", () => {
    const f = fixture();
    for (const status of ["failed", "interrupted", "inProgress"]) {
      f.thread(status);
      f.item(status, 2, { type: "agentMessage", id: status + "-answer", text: status });
      f.db.prepare("UPDATE thread_turns SET status = ?, error_json = ? WHERE thread_id = ?")
        .run(status, status === "failed" ? '{"message":"synthetic failure"}' : null, status);
    }
    f.state.prepare("UPDATE threads SET source = ?, originator = NULL WHERE id = 'interrupted'")
      .run(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent" } } }));
    const loaded = loadCodexSessions(f.root);
    expect(loaded.find((value) => value.session.rawId === "failed")?.traceEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: "codex.turn.completed", status: "failed" })]),
    );
    expect(loaded.find((value) => value.session.rawId === "interrupted")?.session).toMatchObject({
      isSubagent: true, parentSessionId: "parent",
    });
    expect(loaded.find((value) => value.session.rawId === "interrupted")?.traceEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: "codex.turn.aborted", status: "aborted" })]),
    );
    expect(loaded.find((value) => value.session.rawId === "inProgress")?.codexIncrementalState?.activeTurnIds).toEqual(["turn-1"]);
  });

  it("exports only the requested thread and rejects filesystem deletion of the shared source", () => {
    const f = fixture();
    const rollout = f.thread("selected");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: "selected", cwd: f.home } })
      + "\n" + JSON.stringify({ type: "turn_context", payload: { model: "synthetic-raw-context" } }) + "\n");
    f.item("selected", 2, { type: "agentMessage", id: "selected-answer", text: "selected content" });
    f.thread("other");
    f.item("other", 2, { type: "agentMessage", id: "other-answer", text: "unrelated private content" });
    const loaded = loadCodexSessions(f.root)[0];
    const session = localSession(loaded);
    const artifact = readSessionSourceArtifacts(session)[0];
    const exported = Buffer.from(artifact.bytes).toString("utf8");
    expect(exported).toContain("selected content");
    expect(exported).toContain("synthetic-raw-context");
    expect(exported).not.toContain("unrelated private content");
    expect(artifact.fileName).toBe("selected.jsonl");
    const restored = loadCodexSessionRows("selected.jsonl", exported.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    expect(restored?.messages.map((message) => message.content)).toEqual(["selected content"]);
    expect(canDeleteSessionLocally(session)).toBe(false);
    expect(isSharedSessionSourceDatabase(session)).toBe(true);
    for (const filePath of [f.historyPath, "C:\\synthetic\\thread_history_1.sqlite", "/synthetic/thread_history_1.sqlite"]) {
      expect(() => sessionSourceDeletionPaths([{
        source: "codex-app", rawId: "selected", filePath, isSubagent: false,
      }])).toThrow("read-only");
    }
    expect(f.db.prepare("SELECT count(*) AS count FROM thread_items").get()?.count).toBe(2);
  });

  it("replays durable JSONL updates after a lagging SQLite projection, including exported snapshots", async () => {
    const f = fixture();
    const rollout = f.thread("lagging");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const prefix = JSON.stringify({
      type: "session_meta", payload: { id: "lagging", cwd: f.home, history_mode: "paginated" },
    }) + "\n";
    const tail = JSON.stringify({ type: "event_msg", timestamp: "1970-01-01T00:02:00Z", payload: {
      type: "item_completed", turn_id: "turn-1",
      item: { type: "AgentMessage", id: "answer", content: [{ type: "output_text", text: "new durable answer" }] },
    } }) + "\n";
    fs.writeFileSync(rollout, prefix + tail);
    f.item("lagging", 2, { type: "agentMessage", id: "answer", text: "old projection answer" });
    f.db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset = ? WHERE thread_id = ?")
      .run(Buffer.byteLength(prefix), "lagging");
    const loaded = await collect(loadCodexSessionsAsyncIterator(f.root));
    expect(loaded[0].messages.map((message) => message.content)).toEqual(["new durable answer"]);
    const artifact = readSessionSourceArtifacts(localSession(loaded[0]))[0];
    const exportedRows = Buffer.from(artifact.bytes).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(loadCodexSessionRows("lagging.jsonl", exportedRows)?.messages.map((message) => message.content))
      .toEqual(["new durable answer"]);
  });

  it("resolves context and migrated Resume to the selected rollout and clears removed threads", async () => {
    const f = fixture();
    const rollout = f.thread("context");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: {
      id: "context", base_instructions: "selected context", cwd: f.home,
      originator: "agent-session-search", cli_version: "migration",
    } }) + "\n");
    f.item("context", 2, { type: "agentMessage", id: "answer", text: "context answer" });
    const context = await extractSessionContextComponents({ source: "codex-app", filePath: f.historyPath, rawId: "context" });
    expect(JSON.stringify(context.components)).toContain("selected context");
    expect((await resolveCodexResponsesRequest({ filePath: f.historyPath, rawId: "context" }))?.body.instructions)
      .toBe("selected context");
    const selected = localSession(loadCodexSessions(f.root)[0]);
    expect(getResumeCommand(selected, defaultSettings)).toContain('model_provider=');
    const largeInstructions = "完整上下文".repeat(60_000);
    fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: {
      id: "context", cwd: f.home, base_instructions: largeInstructions,
    } }) + "\n");
    expect((await resolveCodexResponsesRequest({ filePath: f.historyPath, rawId: "context" }))?.body.instructions)
      .toBe(largeInstructions);
    expect(loadCodexSessions(f.root)).toHaveLength(1);
    const otherRollout = f.thread("retained");
    f.item("retained", 2, { type: "agentMessage", id: "retained-answer", text: "retained" });
    fs.writeFileSync(otherRollout, JSON.stringify({ type: "session_meta", payload: {
      id: "retained", cwd: f.home, base_instructions: "unrelated private context",
    } }) + "\n");
    f.state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(otherRollout, "context");
    expect((await extractSessionContextComponents({ source: "codex-app", filePath: f.historyPath, rawId: "context" })).status)
      .toBe("source_unavailable");
    expect(await resolveCodexResponsesRequest({ filePath: f.historyPath, rawId: "context" })).toBeNull();
    f.state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(rollout, "context");
    const store = createInMemoryStore();
    cleanup.push(() => store.close());
    const options = { loadOptions: { homeDir: f.home } };
    await syncDefaultSessionsInBatches(store, options);
    f.state.prepare("UPDATE threads SET archived = 1 WHERE id = ?").run("context");
    await syncDefaultSessionsInBatches(store, options);
    expect(await store.getSession("codex:context")).toBeNull();
    expect(await store.getSession("codex:retained")).not.toBeNull();
    fs.unlinkSync(rollout);
    expect((await extractSessionContextComponents({ source: "codex-app", filePath: f.historyPath, rawId: "context" })).status)
      .toBe("source_unavailable");
    expect(await resolveCodexResponsesRequest({ filePath: f.historyPath, rawId: "context" })).toBeNull();
  });

  it("reports unsupported history schemas and releases its read handles", () => {
    const f = fixture();
    f.thread("invalid");
    f.db.prepare("INSERT INTO thread_items VALUES ('invalid', 'turn-1', 'item', 2, 100000, ?)").run("private-malformed-json");
    expect(() => loadCodexSessions(f.root)).toThrow("Invalid JSON in Codex paginated history");
    f.db.exec("DROP TABLE thread_items");
    expect(() => loadCodexSessions(f.root)).toThrow("Unsupported Codex history schema");
    f.db.exec("CREATE TABLE thread_items (thread_id TEXT)");
    // A failed reader leaves no transaction or statement blocking the writer.
    expect(() => f.db.exec("DROP TABLE thread_items")).not.toThrow();
  });
});
