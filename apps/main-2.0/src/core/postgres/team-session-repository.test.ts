import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TeamSessionContent } from "../../shared/team-sessions";
import { PostgresDatabase } from "./database";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";
import { PostgresTeamSessionRepository } from "./team-session-repository";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionSearchRepository } from "./session-search-repository";
import { PostgresSessionStatsRepository } from "./session-stats-repository";

const origin = { repository: "https://github.com/example/assets", assetId: 17, digest: "a".repeat(64) };
let db: PostgresDatabase;
let cache: PostgresTeamSessionRepository;
beforeEach(async () => { db = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS }); await db.initialize(); cache = new PostgresTeamSessionRepository(db); });
afterEach(async () => { await db.close(); });
function content(count = 1): TeamSessionContent {
  return { bytes: 10, files: [], missingAttachments: [], children: [], root: {
    schemaVersion: 2, exportedAt: 1700000000000, session: { sessionKey: "codex:original", source: "codex-cli", originalTitle: "Fixture", displayTitle: "Fixture" },
    messages: Array.from({ length: count * 2 }, (_, index) => ({ index, role: index % 2 ? "assistant" as const : "user" as const, content: index % 2 ? "answer".repeat(2000) : `Question ${index / 2}`, timestamp: new Date(1700000000000 + index * 1000).toISOString() })), traceEvents: [],
  } };
}
it("stores messages in ordinary Session tables, pages summaries, and persists across reader instances", async () => {
  const input = content(105);
  const snapshot = await cache.import("share-a", input, new AbortController().signal, origin);
  expect(snapshot.records[0].turnCount).toBe(105);
  expect((await db.query("select count(*)::int as count from agent_recall.turn_messages")).rows[0].count).toBe(210);
  const reopened = new PostgresTeamSessionRepository(db);
  expect(await reopened.get("share-a")).toEqual(snapshot);
  const first = await reopened.turns("share-a", 0, 0), last = await reopened.turns("share-a", 0, 100);
  expect(first.turns).toHaveLength(50); expect(first.hasMore).toBe(true);
  expect(last.turns).toHaveLength(5); expect(last.hasMore).toBe(false);
  expect(JSON.stringify(first).length).toBeLessThan(60000);
  expect(await reopened.turn("share-a", 0, first.turns[0].id)).toMatchObject({ messages: [{ content: "Question 0" }, { content: "answer".repeat(2000) }] });
  expect(await reopened.turn("other-share", 0, first.turns[0].id)).toBeNull();
  expect(await reopened.turn("share-a", 1, first.turns[0].id)).toBeNull();
});
it("isolates shares with identical source IDs from local history, stats and source cleanup", async () => {
  await cache.import("member-a", content(), new AbortController().signal, origin);
  await cache.import("member-b", content(), new AbortController().signal, origin);
  const ordinary = new PostgresSessionRepository(db);
  expect(await new PostgresSessionSearchRepository(db).searchSessions()).toEqual([]);
  expect((await new PostgresSessionStatsRepository(db).getStats()).total.sessionCount).toBe(0);
  expect(await ordinary.getSession("team:member-a:0")).toBeNull();
  expect((await cache.turns("member-a", 0, 0)).turns[0].id).not.toBe((await cache.turns("member-b", 0, 0)).turns[0].id);
  await ordinary.clearSearchIndex();
  expect((await cache.turns("member-a", 0, 0)).turns).toHaveLength(1);
  await ordinary.deleteSessionsBySource(["codex-cli"]);
  expect((await cache.turns("member-a", 0, 0)).turns).toHaveLength(1);
});
it("rolls back failed and cancelled imports without publishing a partial snapshot", async () => {
  const input = content(); input.children.push({ ...input.root, session: { ...input.root.session, source: "unsupported" } });
  await expect(cache.import("broken", input, new AbortController().signal, origin)).rejects.toThrow();
  expect(await cache.get("broken")).toBeNull();
  expect((await db.query("select count(*)::int as count from agent_recall.sessions")).rows[0].count).toBe(0);
  const abort = new AbortController(); abort.abort();
  await expect(cache.import("cancelled", content(), abort.signal, origin)).rejects.toThrow();
  expect(await cache.get("cancelled")).toBeNull();
  const duringImport = new AbortController();
  const write = PostgresSessionRepository.prototype.upsertIndexedSession;
  const spy = vi.spyOn(PostgresSessionRepository.prototype, "upsertIndexedSession").mockImplementation(async function (this: PostgresSessionRepository, ...args) {
    await write.apply(this, args); duringImport.abort();
  });
  try {
    await expect(cache.import("interrupted", content(), duringImport.signal, origin)).rejects.toThrow();
    expect(await cache.get("interrupted")).toBeNull();
    expect((await db.query("select count(*)::int as count from agent_recall.turn_messages")).rows[0].count).toBe(0);
  } finally { spy.mockRestore(); }
});
it("preserves selected turn numbering and spans without reading uploaded filesystem paths", async () => {
  const full = content(); await cache.import("original", full, new AbortController().signal, origin);
  const summary = (await cache.turns("original", 0, 0)).turns[0];
  const turn = (await cache.turn("original", 0, summary.id))!;
  turn.turnIndex = 42;
  turn.messages[0].attachments = [{ id: "remote", fileName: "remote.txt", mimeType: "text/plain", previewKind: "text", status: "available", source: { kind: "path", value: "/must-not-be-read" } }];
  turn.spans = [{ id: "span", parentSpanId: null, spanIndex: 0, kind: "tool", name: "read", status: "completed", startedAt: null, endedAt: null, callId: "call", input: { path: "synthetic" }, output: { text: "result" }, error: null, attributes: {} }];
  full.root.messages = []; full.selectedTurns = [turn];
  expect((await cache.import("excerpt", full, new AbortController().signal, origin)).partial).toBe(true);
  const page = await cache.turns("excerpt", 0, 0);
  expect(page.turns[0].turnIndex).toBe(42);
  const read = (await cache.turn("excerpt", 0, page.turns[0].id))!;
  expect(read.messages[0].attachments?.[0]).toMatchObject({ status: "missing" });
  expect(read.messages[0].attachments?.[0].source).toBeUndefined();
  expect(read.spans[0]).toMatchObject({ callId: "call", output: { text: "result" } });
});
