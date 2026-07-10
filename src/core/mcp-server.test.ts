import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SessionStore } from "./session-store";
import type { IndexedSession, SessionMessage } from "./types";
// The MCP server runs standalone; we exercise its SDK-free query functions here.
// The .mjs bin has no type declarations, so we type the imports explicitly.
// @ts-expect-error -- untyped .mjs bin
import * as mcp from "../../bin/agent-session-search-mcp.mjs";

type Db = import("node:sqlite").DatabaseSync;
type SearchResult = { sessionKey: string; project: string; title: string; summary: string | null };
const searchSessions = mcp.searchSessions as (db: Db, args?: Record<string, unknown>) => SearchResult[];
const getSession = mcp.getSession as (
  db: Db,
  args: Record<string, unknown>,
) => (SearchResult & { messages: Array<{ content: string }>; totalMessages: number; returned: number; nextOffset: number | null }) | null;
const listProjects = mcp.listProjects as (db: Db) => Array<{ project: string; sessions: number }>;
const listTags = mcp.listTags as (db: Db) => string[];
type LatestResult = { sessionKey: string; title: string; source: string; project: string; timestamp: string; summary: string | null };
const getLatestSessions = mcp.getLatestSessions as (db: Db, args?: Record<string, unknown>) => LatestResult[];
type WriteResult = { ok: boolean; error?: string; tags?: string[]; favorited?: boolean; pinned?: boolean; hidden?: boolean };
const tagSession = mcp.tagSession as (db: Db, args: Record<string, unknown>) => WriteResult;
const toggleFavorite = mcp.toggleFavorite as (db: Db, args: Record<string, unknown>) => WriteResult;
const setVisibility = mcp.setVisibility as (db: Db, args: Record<string, unknown>) => WriteResult;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

function seedStore(): { db: import("node:sqlite").DatabaseSync; store: SessionStore } {
  const db = new DatabaseSync(":memory:");
  const store = new SessionStore(db);
  const session = (overrides: Partial<IndexedSession>): IndexedSession => ({
    sessionKey: "codex:abc",
    rawId: "abc",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/a.jsonl",
    originalTitle: "fix login",
    firstQuestion: "fix login expiry bug",
    timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
    fileMtimeMs: 10,
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    ...overrides,
  });
  const messages = (text: string): SessionMessage[] => [
    { role: "user", content: text, timestamp: "2026-06-01T10:00:00Z", index: 0 },
  ];
  store.upsertIndexedSession(session({}), messages("the refresh token expired after 30 minutes"), [], []);
  store.upsertIndexedSession(
    session({ sessionKey: "codex:def", rawId: "def", projectPath: "/other", firstQuestion: "add dark mode toggle", fileMtimeMs: 20 }),
    messages("implement a theme switcher in react"),
    [],
    [],
  );
  store.addTag("codex:abc", "auth");

  // A 60-message session for paging tests.
  const manyMessages: SessionMessage[] = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg-${i}`,
    timestamp: "2026-06-01T10:00:00Z",
    index: i,
  }));
  store.upsertIndexedSession(session({ sessionKey: "codex:multi", rawId: "multi", projectPath: "/multi", fileMtimeMs: 30 }), manyMessages, [], []);

  return { db, store };
}

describe("MCP query functions", () => {
  it("finds a session by transcript keywords via FTS", () => {
    const { db } = seedStore();
    const results = searchSessions(db, { query: "refresh token" });
    expect(results.map((r) => r.sessionKey)).toContain("codex:abc");
    expect(results.find((r) => r.sessionKey === "codex:abc")?.project).toBe("/repo");
  });

  it("returns recent sessions when no query is given", () => {
    const { db } = seedStore();
    const results = searchSessions(db, {});
    // Ordered by file_mtime_ms DESC, so the newest session comes first.
    expect(results[0].sessionKey).toBe("codex:multi");
  });

  it("filters by project substring", () => {
    const { db } = seedStore();
    const results = searchSessions(db, { project: "other" });
    expect(results).toHaveLength(1);
    expect(results[0].sessionKey).toBe("codex:def");
  });

  it("does not break on FTS special characters", () => {
    const { db } = seedStore();
    expect(() => searchSessions(db, { query: 'token" OR (' })).not.toThrow();
  });

  it("gets a single session with messages", () => {
    const { db } = seedStore();
    const session = getSession(db, { sessionKey: "codex:abc" });
    expect(session?.title).toBe("fix login expiry bug");
    expect(session?.messages[0].content).toContain("refresh token");
    expect(getSession(db, { sessionKey: "missing" })).toBeNull();
  });

  it("pages through messages via offset and reports nextOffset", () => {
    const { db } = seedStore();
    const first = getSession(db, { sessionKey: "codex:multi", maxMessages: 40 });
    // Seeded with 60 messages below; first page returns 40 with more remaining.
    expect(first?.totalMessages).toBe(60);
    expect(first?.returned).toBe(40);
    expect(first?.nextOffset).toBe(40);
    const second = getSession(db, { sessionKey: "codex:multi", maxMessages: 40, offset: first!.nextOffset });
    expect(second?.returned).toBe(20);
    expect(second?.nextOffset).toBeNull();
    expect(second?.messages[19].content).toBe("msg-59");
  });

  it("lists projects and tags", () => {
    const { db } = seedStore();
    expect(listProjects(db).map((p) => p.project).sort()).toEqual(["/multi", "/other", "/repo"]);
    expect(listTags(db)).toContain("auth");
  });
});

describe("MCP write functions", () => {
  const flags = (db: import("node:sqlite").DatabaseSync, sessionKey: string) =>
    db.prepare("SELECT favorited, pinned, hidden FROM sessions WHERE session_key = ?").get(sessionKey) as {
      favorited: number;
      pinned: number;
      hidden: number;
    };

  it("adds and removes a tag, cleaning up the orphaned tag", () => {
    const { db } = seedStore();
    const added = tagSession(db, { sessionKey: "codex:abc", action: "add", tag: "important" });
    expect(added.ok).toBe(true);
    expect(added.tags).toContain("important");
    expect(listTags(db)).toContain("important");

    const removed = tagSession(db, { sessionKey: "codex:abc", action: "remove", tag: "important" });
    expect(removed.ok).toBe(true);
    expect(removed.tags).not.toContain("important");
    // "important" had no other users, so it's gone from the tags table entirely.
    expect(listTags(db)).not.toContain("important");
    // "auth" was seeded on this session and untouched.
    expect(listTags(db)).toContain("auth");
  });

  it("is idempotent when adding the same tag twice", () => {
    const { db } = seedStore();
    tagSession(db, { sessionKey: "codex:abc", action: "add", tag: "dup" });
    const second = tagSession(db, { sessionKey: "codex:abc", action: "add", tag: "dup" });
    expect(second.tags?.filter((t) => t === "dup")).toHaveLength(1);
  });

  it("rejects tagging a missing session", () => {
    const { db } = seedStore();
    const result = tagSession(db, { sessionKey: "missing", action: "add", tag: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session not found.");
  });

  it("get_latest_sessions returns the most recently indexed sessions", () => {
    const { db } = seedStore();
    // codex:multi has fileMtimeMs 30 (highest), so it should be first.
    const latest = getLatestSessions(db, { limit: 3 });
    expect(latest[0].sessionKey).toBe("codex:multi");
    expect(latest.length).toBe(3);
  });

  it("get_latest_sessions filters by source", () => {
    const { db } = seedStore();
    const latest = getLatestSessions(db, { source: "codex-cli", limit: 10 });
    expect(latest.every((r) => r.source === "codex-cli")).toBe(true);
    expect(latest.length).toBe(3);
  });

  it("get_latest_sessions filters by projectPath substring", () => {
    const { db } = seedStore();
    const latest = getLatestSessions(db, { projectPath: "other" });
    expect(latest).toHaveLength(1);
    expect(latest[0].sessionKey).toBe("codex:def");
  });

  it("rejects an empty tag and an invalid action", () => {
    const { db } = seedStore();
    expect(tagSession(db, { sessionKey: "codex:abc", action: "add", tag: "  " }).ok).toBe(false);
    expect(tagSession(db, { sessionKey: "codex:abc", action: "flip", tag: "x" }).ok).toBe(false);
  });

  it("toggles favorite on and off", () => {
    const { db } = seedStore();
    expect(toggleFavorite(db, { sessionKey: "codex:abc", favorited: true }).favorited).toBe(true);
    expect(flags(db, "codex:abc").favorited).toBe(1);
    expect(toggleFavorite(db, { sessionKey: "codex:abc", favorited: false }).favorited).toBe(false);
    expect(flags(db, "codex:abc").favorited).toBe(0);
  });

  it("rejects favoriting a missing session", () => {
    const { db } = seedStore();
    expect(toggleFavorite(db, { sessionKey: "missing", favorited: true }).ok).toBe(false);
  });

  it("sets each visibility dimension", () => {
    const { db } = seedStore();

    setVisibility(db, { sessionKey: "codex:abc", visibility: "hidden" });
    expect(flags(db, "codex:abc").hidden).toBe(1);

    // "default" un-hides and un-pins.
    setVisibility(db, { sessionKey: "codex:abc", visibility: "pinned" });
    expect(flags(db, "codex:abc").pinned).toBe(1);
    const back = setVisibility(db, { sessionKey: "codex:abc", visibility: "default" });
    expect(back.pinned).toBe(false);
    expect(back.hidden).toBe(false);

    const fav = setVisibility(db, { sessionKey: "codex:abc", visibility: "favorites" });
    expect(fav.favorited).toBe(true);
    expect(fav.hidden).toBe(false);
  });

  it("leaves unrelated flags alone (favoriting does not unpin)", () => {
    const { db } = seedStore();
    setVisibility(db, { sessionKey: "codex:abc", visibility: "pinned" });
    setVisibility(db, { sessionKey: "codex:abc", visibility: "favorites" });
    const f = flags(db, "codex:abc");
    expect(f.pinned).toBe(1);
    expect(f.favorited).toBe(1);
  });

  it("rejects an invalid visibility and a missing session", () => {
    const { db } = seedStore();
    expect(setVisibility(db, { sessionKey: "codex:abc", visibility: "bogus" }).ok).toBe(false);
    expect(setVisibility(db, { sessionKey: "missing", visibility: "hidden" }).ok).toBe(false);
  });
});

describe("MCP migrate_session tool", () => {
  type MigrationResult = {
    ok: boolean;
    error?: string;
    target?: string;
    targetSessionId?: string;
    targetFilePath?: string;
    strategy?: string;
    resumeCommand?: string;
    indexed?: boolean;
    launched?: boolean;
  };
  const migrateSession = mcp.migrateSession as (db: Db, args: Record<string, unknown>) => Promise<MigrationResult>;
  const migrationTargetSchema = mcp.migrationTargetSchema as (zod: typeof z) => Promise<ReturnType<typeof z.enum>>;

  it("uses the seven-target schema for the real migrate_session tool contract", async () => {
    const schema = await migrationTargetSchema(z);
    expect(schema.parse("tclaude")).toBe("tclaude");
    expect(() => schema.parse("gemini")).toThrow();
    expect(schema.options).toEqual([
      "claude",
      "codex",
      "codebuddy",
      "tclaude",
      "tcodex",
      "claude-internal",
      "codex-internal",
    ]);
  });

  it("accepts tclaude at the handler boundary and reaches the core migration facade", async () => {
    const { db } = seedStore();
    const result = await migrateSession(db, { sessionKey: "codex:abc", target: "tclaude" });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("target must be one of");
    expect(result.error).toContain("project path does not exist");
  });

  it("rejects a missing sessionKey before touching the bundle", async () => {
    const { db } = seedStore();
    const result = await migrateSession(db, { target: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sessionKey");
  });

  it("rejects an invalid target before touching the bundle", async () => {
    const { db } = seedStore();
    const result = await migrateSession(db, { sessionKey: "codex:abc", target: "gemini" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("target");
  });

  it("returns ok=false with an error when the session does not exist", async () => {
    const { db } = seedStore();
    const result = await migrateSession(db, { sessionKey: "codex:missing", target: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});
