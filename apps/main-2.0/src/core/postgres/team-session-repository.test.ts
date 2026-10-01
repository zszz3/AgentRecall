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
  expect(snapshot.records[0]).toMatchObject({turnCount:105,source:"codex-cli"});
  expect((await cache.sources(["share-a", "absent"])).get("share-a")).toBe("codex-cli");
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
  await cache.replaceCatalog("excerpt-team", [{ key: "excerpt", item: { id: 17, digest: origin.digest, title: "Excerpt", author: "fixture", bytes: 1, createdAt: "2026-09-30", canWithdraw: false } }], new AbortController().signal);
  expect((await cache.list("excerpt-team", 1, "result", "turns")).items).toEqual([]);
  expect((await cache.list("excerpt-team", 1, "result", "turns", true)).items[0].match).toMatchObject({ turnIndex: 42, offset: 0 });
});

it("reads source labels for older snapshot metadata without reimporting content", async () => {
  await cache.import("old", content(), new AbortController().signal, origin);
  await db.query("update agent_recall.team_session_snapshots set metadata = jsonb_set(metadata, '{records,0}', (metadata #> '{records,0}') - 'source') where cache_key = $1", ["old"]);
  expect((await cache.get("old"))?.records[0].source).toBe("codex-cli");
});

it("persists scoped catalogs and finds turns beyond the first page without reading remote data", async () => {
  const signal = new AbortController().signal;
  await cache.import("search-a", content(105), signal, origin);
  const item = { id: 17, digest: origin.digest, title: "共享修复", author: "member", createdAt: "2026-09-30", bytes: 10, canWithdraw: false, source: "codex-cli" };
  await cache.replaceCatalog("team-a", [{ item, key: "search-a" }], signal);
  const restarted = new PostgresTeamSessionRepository(db);
  expect((await restarted.list("team-a", 1)).items).toEqual([item]);
  expect((await restarted.list("team-b", 1, "Question", "turns")).items).toEqual([]);
  expect((await restarted.list("team-a", 1, "共享修复", "turns")).items).toEqual([item]);
  expect((await restarted.list("team-a", 1, "member", "turns")).items).toEqual([item]);
  expect((await restarted.list("team-a", 1, "Question", "turns")).items).toHaveLength(1);
  const hits = await restarted.list("team-a", 1, "Question 104", "turns");
  expect(hits.items).toHaveLength(1);
  expect(hits.items[0].match).toMatchObject({ record: 0, turnIndex: 104, offset: 100 });
  expect(hits.items[0].match?.snippet).toContain("Question 104");
  expect(hits.items[0].match!.snippet.length).toBeLessThanOrEqual(240);
  expect((await restarted.turns("search-a", 0, 100)).turns.map(turn => turn.id)).toContain(hits.items[0].match!.turnId);
  expect((await restarted.list("team-a", 1, "%", "turns")).items).toEqual([]);
  const turns = await restarted.turns("search-a", 0, 0);
  await db.query("update agent_recall.session_turns set tool_text = 'secret-output-marker', tool_names = ARRAY['rg'] where id = $1", [turns.turns[0].id]);
  expect((await restarted.list("team-a", 1, "secret-output-marker", "turns")).items).toEqual([]);
  expect((await restarted.list("team-a", 1, "secret-output-marker", "turns", true)).items).toHaveLength(1);
  expect((await restarted.list("team-a", 1, "rg", "turns")).items).toHaveLength(1);
  await restarted.replaceCatalog("team-a", [], signal);
  expect((await restarted.list("team-a", 1)).items).toEqual([]);
  expect(await restarted.get("search-a")).not.toBeNull();
});
