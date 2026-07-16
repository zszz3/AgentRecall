#!/usr/bin/env node
// MCP stdio server exposing the local agent-recall database, so
// Claude Code / Codex can recall "how did I solve X before" from past sessions
// and manage them (tag, favorite, visibility).
//
// The query and write functions below are exported and SDK-free so they can be
// unit tested; the MCP wiring is loaded lazily in runServer().

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_RESULTS = 50;
const MAX_MESSAGES = 200;

export function resolveAppVersion(packageUrl = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8"));
    return typeof value.version === "string" && value.version ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Mirrors src/core/app-paths.ts (this file runs standalone, outside the bundle).
export function resolveDbPath(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_DB && env.AGENT_RECALL_DB.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall", "db-path");
  try {
    if (!existsSync(pointer)) return null;
    return readFileSync(pointer, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

// Quote each term so user input cannot break FTS5 MATCH syntax; terms AND together.
function ftsMatchExpr(query) {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, "").trim())
    .filter(Boolean);
  return terms.length ? terms.map((term) => `"${term}"`).join(" ") : '""';
}

function toResult(row) {
  return {
    sessionKey: row.session_key,
    title: row.custom_title || row.first_question || row.original_title || "Untitled Session",
    source: row.source,
    project: row.project_path,
    timestamp: new Date(row.timestamp).toISOString(),
    summary: (row.ai_summary && row.ai_summary.trim()) || null,
  };
}

const BASE_COLUMNS = ["session_key", "source", "project_path", "timestamp", "original_title", "first_question", "custom_title"];

// ai_summary only exists once the app has migrated the DB; tolerate an older DB
// (the MCP server is read-only and cannot migrate it itself).
function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function resultColumns(db, prefix = "") {
  const summary = hasColumn(db, "sessions", "ai_summary") ? `${prefix}ai_summary` : "NULL AS ai_summary";
  return [...BASE_COLUMNS.map((c) => `${prefix}${c}`), summary].join(", ");
}

export function searchSessions(db, { query = "", source = "", project = "", limit = 20 } = {}) {
  const cap = clamp(limit, 20, MAX_RESULTS);
  const filters = [];
  const params = [];
  if (source) {
    filters.push("s.source = ?");
    params.push(source);
  }
  if (project) {
    filters.push("s.project_path LIKE ?");
    params.push(`%${project}%`);
  }

  const q = String(query || "").trim();
  if (q) {
    const where = ["session_fts MATCH ?", ...filters].join(" AND ");
    const rows = db
      .prepare(
        `SELECT ${resultColumns(db, "s.")}
         FROM session_fts JOIN sessions s ON s.session_key = session_fts.session_key
         WHERE ${where}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsMatchExpr(q), ...params, cap);
    return rows.map(toResult);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT ${resultColumns(db, "s.")} FROM sessions s ${where} ORDER BY s.file_mtime_ms DESC LIMIT ?`)
    .all(...params, cap);
  return rows.map(toResult);
}

export function getSession(db, { sessionKey, maxMessages = 40, offset = 0 } = {}) {
  if (!sessionKey) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey);
  if (!row) return null;
  const cap = clamp(maxMessages, 40, MAX_MESSAGES);
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const totalRow = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?").get(sessionKey);
  const totalMessages = totalRow?.n ?? 0;
  const messages = db
    .prepare("SELECT role, content FROM messages WHERE session_key = ? ORDER BY message_index LIMIT ? OFFSET ?")
    .all(sessionKey, cap, start);
  const nextOffset = start + messages.length < totalMessages ? start + messages.length : null;
  return {
    ...toResult(row),
    totalMessages,
    offset: start,
    returned: messages.length,
    // Non-null when the session has more messages; pass it back as `offset` to continue.
    nextOffset,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

export function listProjects(db) {
  return db
    .prepare(
      "SELECT project_path, COUNT(*) AS sessions FROM sessions WHERE project_path <> '' GROUP BY project_path ORDER BY sessions DESC LIMIT 100",
    )
    .all()
    .map((row) => ({ project: row.project_path, sessions: row.sessions }));
}

export function listTags(db) {
  return db.prepare("SELECT name FROM tags ORDER BY lower(name)").all().map((row) => row.name);
}

// Returns the most recently active sessions (by file mtime / last activity).
// This lets an agent find "the session I'm currently in" or "my latest codex
// session" without a sessionKey — the missing piece for natural-language
// migration like "把这次会话迁移到 claude".
export function getLatestSessions(db, { source = "", projectPath = "", limit = 5 } = {}) {
  const cap = clamp(limit, 1, 20);
  const filters = [];
  const params = [];
  if (source) {
    filters.push("s.source = ?");
    params.push(source);
  }
  if (projectPath) {
    filters.push("s.project_path LIKE ?");
    params.push(`%${projectPath}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${resultColumns(db, "s.")} FROM sessions s ${where} ORDER BY s.file_mtime_ms DESC LIMIT ?`,
    )
    .all(...params, cap);
  return rows.map(toResult);
}

// --- Write operations -----------------------------------------------------
// These mirror the semantics of SessionStore's write methods, reimplemented in
// raw SQL because this bin runs standalone (outside the app bundle) and can't
// import SessionStore. All are idempotent.

function sessionExists(db, sessionKey) {
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE session_key = ?").get(sessionKey));
}

function currentTags(db, sessionKey) {
  return db
    .prepare(
      `SELECT tags.name
       FROM session_tags JOIN tags ON tags.id = session_tags.tag_id
       WHERE session_tags.session_key = ?
       ORDER BY lower(tags.name)`,
    )
    .all(sessionKey)
    .map((row) => row.name);
}

// Drop a tag from the tags table once no session references it (matches
// SessionStore.deleteUnusedTag), so removing the last use doesn't leave orphans.
function deleteUnusedTag(db, tagName) {
  db.prepare(
    `DELETE FROM tags
     WHERE name = ?
       AND NOT EXISTS (SELECT 1 FROM session_tags WHERE session_tags.tag_id = tags.id)`,
  ).run(tagName);
}

export function tagSession(db, { sessionKey, action, tag } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  const name = String(tag ?? "").trim();
  if (!name) return { ok: false, error: "Tag must not be empty." };
  if (action !== "add" && action !== "remove") return { ok: false, error: 'action must be "add" or "remove".' };

  if (action === "add") {
    db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(name);
    db.prepare("INSERT INTO session_tags (session_key, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(sessionKey, row.id);
  } else {
    db.prepare(
      `DELETE FROM session_tags
       WHERE session_key = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)`,
    ).run(sessionKey, name);
    deleteUnusedTag(db, name);
  }
  return { ok: true, sessionKey, action, tag: name, tags: currentTags(db, sessionKey) };
}

export function toggleFavorite(db, { sessionKey, favorited } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  db.prepare("UPDATE sessions SET favorited = ? WHERE session_key = ?").run(favorited ? 1 : 0, sessionKey);
  return { ok: true, sessionKey, favorited: Boolean(favorited) };
}

// Visibility is not a single column: it's derived from independent favorited /
// pinned / hidden flags (see App.tsx ViewMode). Each call sets the requested
// dimension and clears what would otherwise hide the session from that view,
// without disturbing unrelated flags (e.g. favoriting doesn't unpin).
export function setVisibility(db, { sessionKey, visibility } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  switch (visibility) {
    case "default":
      // Return to the normal list: un-hide and un-pin, leave favorite as-is.
      db.prepare("UPDATE sessions SET hidden = 0, pinned = 0 WHERE session_key = ?").run(sessionKey);
      break;
    case "favorites":
      db.prepare("UPDATE sessions SET favorited = 1, hidden = 0 WHERE session_key = ?").run(sessionKey);
      break;
    case "pinned":
      db.prepare("UPDATE sessions SET pinned = 1, hidden = 0 WHERE session_key = ?").run(sessionKey);
      break;
    case "hidden":
      db.prepare("UPDATE sessions SET hidden = 1 WHERE session_key = ?").run(sessionKey);
      break;
    default:
      return { ok: false, error: 'visibility must be one of "default", "favorites", "hidden", "pinned".' };
  }
  const row = db.prepare("SELECT favorited, pinned, hidden FROM sessions WHERE session_key = ?").get(sessionKey);
  return {
    ok: true,
    sessionKey,
    visibility,
    favorited: row.favorited === 1,
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
  };
}

// The migration logic lives in src/core/mcp-migration.ts and is bundled (via
// scripts/build-mcp-bundle.mjs) so this standalone bin can call it without
// --experimental-strip-types. The bundle is resolved relative to this file.
let migrationBundle = null;

function validateMigrationBundle(bundle) {
  if (
    !Array.isArray(bundle?.MIGRATION_TARGET_IDS) ||
    bundle.MIGRATION_TARGET_IDS.length === 0 ||
    !bundle.MIGRATION_TARGET_IDS.every((value) => typeof value === "string")
  ) {
    throw new Error("migration bundle is missing MIGRATION_TARGET_IDS");
  }
  for (const name of ["isMigrationTarget", "SessionStore", "migrateSessionForMcp"]) {
    if (typeof bundle[name] !== "function") {
      throw new Error(`migration bundle is missing ${name}`);
    }
  }
}

async function loadMigrationBundle() {
  if (migrationBundle) return migrationBundle;
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "mcp", "migration-entry.js"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "migration-entry.js"),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const candidateBundle = await import(pathToFileURL(candidate).href);
      validateMigrationBundle(candidateBundle);
      migrationBundle = candidateBundle;
      return migrationBundle;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "MCP migration bundle not found. Run `npm run build:mcp` first." +
    (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ""),
  );
}

// SDK-free, unit-testable wrapper. Accepts a raw DatabaseSync (the same handle
// the query/write tools use) and delegates to the bundled migration facade.
export async function migrateSession(db, { sessionKey, target } = {}) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return { ok: false, error: "sessionKey is required." };
  }
  const bundle = await loadMigrationBundle();
  if (!bundle.isMigrationTarget(target)) {
    return { ok: false, error: `target must be one of ${bundle.MIGRATION_TARGET_IDS.map((value) => `"${value}"`).join(", ")}.` };
  }
  const store = new bundle.SessionStore(db);
  try {
    const result = await bundle.migrateSessionForMcp(
      { sessionKey, target },
      { store },
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// This is the same schema used by runServer's migrate_session registration.
// Its values come from the bundled core registry, keeping the standalone MCP
// boundary in lock-step with the typed migration facade.
export async function migrationTargetSchema(zod) {
  const bundle = await loadMigrationBundle();
  return zod.enum(bundle.MIGRATION_TARGET_IDS);
}

function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function runServer() {
  const dbPath = resolveDbPath();
  if (!dbPath || !existsSync(dbPath)) {
    process.stderr.write(
      "agent-recall database not found. Open the app at least once, or set AGENT_RECALL_DB.\n",
    );
    process.exit(1);
  }

  const { DatabaseSync } = await import("node:sqlite");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  // Read-write: the write tools (tag/favorite/visibility) mutate this DB. The
  // app keeps it in WAL mode, so this separate process writes safely alongside
  // it (SQLite serializes writers). busy_timeout tolerates brief write contention.
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const server = new McpServer({ name: "agent-recall", version: resolveAppVersion() });
  let migrateTargetSchema = null;
  try {
    migrateTargetSchema = await migrationTargetSchema(z);
  } catch (error) {
    process.stderr.write(
      `agent-recall MCP migration tools disabled: ${error instanceof Error ? error.message : String(error)}. ` +
        "Run `npm run build:mcp` in the AgentRecall install directory, then restart the MCP client.\n",
    );
  }

  server.registerTool(
    "search_sessions",
    {
      description:
        "Search past AI coding sessions (Claude Code, Codex, etc.) by keywords. Matches titles, first questions, transcripts, and AI summaries. Use this to recall how a problem was solved before.",
      inputSchema: {
        query: z.string().describe("Keywords to search for.").optional(),
        source: z.string().describe("Optional source filter, e.g. claude-cli or codex-cli.").optional(),
        project: z.string().describe("Optional substring match on the project path.").optional(),
        limit: z.number().describe("Max results (1-50, default 20).").optional(),
      },
    },
    async (args) => jsonContent(searchSessions(db, args)),
  );

  server.registerTool(
    "get_session",
    {
      description:
        "Fetch a single session's metadata, AI summary, and messages by sessionKey. Returns messages from `offset` (default 0); for long sessions use the returned `nextOffset` as the next `offset` to page through the rest.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        maxMessages: z.number().describe("Max messages to return (1-200, default 40).").optional(),
        offset: z.number().describe("Message index to start from (default 0). Use nextOffset from a previous call to continue.").optional(),
      },
    },
    async (args) => {
      const result = getSession(db, args);
      return result ? jsonContent(result) : { content: [{ type: "text", text: "Session not found." }], isError: true };
    },
  );

  server.registerTool(
    "list_projects",
    { description: "List indexed projects with session counts, to scope a search.", inputSchema: {} },
    async () => jsonContent(listProjects(db)),
  );

  server.registerTool(
    "list_tags",
    { description: "List all tags, to scope a search.", inputSchema: {} },
    async () => jsonContent(listTags(db)),
  );

  server.registerTool(
    "get_latest_sessions",
    {
      description:
        "获取最近活跃的会话（按修改时间倒序）。Get the most recently active sessions by mtime. " +
        "用于找到「当前会话」「最近的 codex/claude 会话」等，不需要 sessionKey。" +
        "典型场景：用户说「把这次会话迁移到 claude」「迁移最近的 codex 会话」时，" +
        "先调本工具拿到 sessionKey，再调 migrate_session。" +
        "可选按 source（如 codex-cli、claude-cli）和 projectPath 过滤。",
      inputSchema: {
        source: z.string().describe("Optional source filter, e.g. codex-cli or claude-cli.").optional(),
        projectPath: z.string().describe("Optional project path substring to filter by.").optional(),
        limit: z.number().describe("Max results (1-20, default 5).").optional(),
      },
    },
    async (args) => jsonContent(getLatestSessions(db, args)),
  );

  server.registerTool(
    "tag_session",
    {
      description:
        "Add or remove a tag on a session. Use to mark sessions (e.g. 'important', 'review'). Idempotent. Returns the session's current tags.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        action: z.enum(["add", "remove"]).describe("Whether to add or remove the tag."),
        tag: z.string().describe("Tag name, e.g. 'important'."),
      },
    },
    async (args) => {
      const result = tagSession(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "toggle_favorite",
    {
      description: "Favorite or unfavorite a session. Idempotent — set favorited to the desired final state.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        favorited: z.boolean().describe("true to favorite, false to unfavorite."),
      },
    },
    async (args) => {
      const result = toggleFavorite(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "set_visibility",
    {
      description:
        "Set a session's visibility dimension. 'default' un-hides and un-pins; 'favorites' favorites it; 'pinned' pins it; 'hidden' hides it. These flags are independent (favoriting does not unpin), so this sets the chosen dimension rather than toggling exclusively.",
      inputSchema: {
        sessionKey: z.string().describe("The sessionKey from search_sessions."),
        visibility: z.enum(["default", "favorites", "hidden", "pinned"]).describe("Target visibility."),
      },
    },
    async (args) => {
      const result = setVisibility(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  if (migrateTargetSchema) {
    server.registerTool(
      "migrate_session",
    {
      description:
        "跨 Agent 迁移会话（Migrate session across agents）。把一个本地会话（Claude Code / Codex / CodeBuddy / CodeWiz）迁移到另一个目标 Agent，生成目标 Agent 能直接 resume 的会话文件。" +
        "典型场景：用户说「把这个会话迁移到 Claude/Codex/CodeBuddy」「把当前对话搬过去」「迁移会话」时调用此工具。" +
        "流程：先用 search_sessions 找到源会话的 sessionKey，再调用本工具传入 sessionKey 和 target。" +
        "迁移完成后返回 resumeCommand（如 cd /repo && claude --resume <id>），launched 恒为 false，需要用户自行在终端执行该命令。" +
        "四个可选目标 tclaude、tcodex、claude-internal、codex-internal 必须先在 Settings > Optional sources 中启用。" +
        "仅支持本地会话（environmentKind=local），远程会话不可迁移。",
      inputSchema: {
        sessionKey: z.string().describe("要迁移的源会话 sessionKey，可通过 search_sessions 获取。"),
        target: migrateTargetSchema.describe("目标 Agent：claude、codex、codebuddy、codewiz、cursor、tclaude、tcodex、claude-internal 或 codex-internal。四个可选目标需先在 Settings > Optional sources 启用。"),
      },
    },
    async (args) => {
      const result = await migrateSession(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
    );
  }

  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    process.stderr.write(`agent-recall MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
