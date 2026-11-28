#!/usr/bin/env node
// MCP stdio server exposing the local AgentRecall SQLite database, so
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

export const SESSION_MCP_DESCRIPTIONS = {
  searchSessions: "按关键词检索历史 AI 编程会话（如 Claude Code、Codex）。会匹配标题、首个问题、对话正文和 AI 摘要，用于回顾以前如何解决某个问题。",
  searchQuery: "要检索的关键词。",
  sourceFilter: "可选的来源筛选，例如 claude-cli 或 codex-cli。",
  projectFilter: "可选的项目路径子串筛选。",
  resultLimit50: "最多返回 1～50 条，默认 20 条。",
  getSession: "根据 sessionKey 获取单个会话的元数据、AI 摘要和消息。从 offset（默认 0）开始返回；长会话可把响应中的 nextOffset 作为下一次 offset 继续分页。",
  sessionKey: "search_sessions 返回的 sessionKey。",
  maxMessages: "最多返回 1～200 条消息，默认 40 条。",
  messageOffset: "开始读取的消息序号，默认 0；继续分页时使用上次返回的 nextOffset。",
  latestSessions: "按修改时间倒序获取最近活跃的会话，用于查找当前会话或最近的 Codex、Claude 会话，无需预先知道 sessionKey。迁移最近会话时，先调用本工具取得 sessionKey，再调用 migrate_session。可按 source 和 projectPath 筛选。",
  latestProjectFilter: "可选的项目路径子串筛选。",
  resultLimit20: "最多返回 1～20 条，默认 5 条。",
  tagSession: "为会话添加或移除标签，可用于标记重要、待复查等状态。操作具备幂等性，并返回会话当前的标签列表。",
  tagAction: "标签操作：add 为添加，remove 为移除。",
  tagName: "标签名称，例如 important。",
  toggleFavorite: "收藏或取消收藏会话。操作具备幂等性，请把 favorited 设置为期望的最终状态。",
  favorited: "设为 true 表示收藏，false 表示取消收藏。",
  setVisibility: "设置会话可见性：default 表示正常显示，favorites 表示收藏，hidden 表示隐藏。",
  visibility: "目标可见性：default、favorites 或 hidden。",
  migrateSession: "在 Agent 之间迁移本地会话，不修改原会话。迁入 Antigravity CLI 时生成交接文档，不创建原生会话。先用 search_sessions 获取 sessionKey，再传入 sessionKey 和 target。完成后会返回 resumeCommand，用户需自行在终端执行；不支持远程会话。",
  migrationSessionKey: "要迁移的源会话 sessionKey，可通过 search_sessions 获取。",
  migrationTarget: "目标 Agent。可选目标需先在“设置 > 可选来源”中启用。选择 antigravity 会返回在 agy 中加载交接文档的命令。",
};

export function resolveAppVersion(packageUrl = new URL("../package.json", import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8"));
    return typeof value.version === "string" && value.version ? value.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Mirrors src/core/app-paths.ts (this file runs standalone, outside the bundle).
export function resolveDatabaseUrl(env = process.env, home = homedir()) {
  const override = env.AGENT_RECALL_DATABASE_URL && env.AGENT_RECALL_DATABASE_URL.trim();
  if (override) return override;
  const pointer = path.join(home, ".agent-recall-v2", "database-url");
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

export function cleanUserMessageContent(text) {
  const source = String(text ?? "");
  const wrappedQuery = /<system_notification\b/iu.test(source)
    ? source.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/iu)?.[1]
    : undefined;
  const cleaned = (wrappedQuery ?? source)
    .replace(/<(?:subagent_notification|task-notification)\b[^>]*>[\s\S]*?<\/(?:subagent_notification|task-notification)>\s*/giu, "")
    .trim();
  if (/^Perform any necessary follow-up actions in response to the subagent completion above\.\s*If no follow-up work is needed, no further action is required\./iu.test(cleaned)) {
    return "";
  }
  return cleaned;
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

const RESULT_COLUMNS = `
  s.session_key, s.source, s.project_path, s.started_at AS timestamp, s.original_title,
  s.first_question, s.custom_title, s.ai_summary
`;

function fts5Phrase(term) {
  return `"${String(term).replaceAll('"', '""')}"`;
}

export async function openSqliteMcpDatabase(databaseUrl) {
  const trimmed = String(databaseUrl ?? "").trim();
  const filePath = trimmed.toLowerCase().startsWith("sqlite:")
    ? trimmed.slice("sqlite:".length)
    : trimmed;
  if (!filePath) throw new Error("SQLite database path is missing.");
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(filePath, { enableForeignKeyConstraints: true, timeout: 10_000 });
  sqlite.exec("PRAGMA busy_timeout = 10000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.prepare("SELECT 1").get();
  return {
    kind: "sqlite",
    sqlite,
    async end() {
      sqlite.close();
    },
  };
}

export async function searchSessions(db, { query = "", source = "", project = "", limit = 20 } = {}) {
  const { parseSearchClauses, escapeLike } = await import("../out/mcp/session-search-query.js");
  const cap = clamp(limit, 20, MAX_RESULTS);
  const q = String(query || "").trim();
  const terms = q ? parseSearchClauses(q) : [];

  const filters = ["s.team_snapshot_key IS NULL"];
  const params = [];
  if (source) {
    filters.push("s.source = ?");
    params.push(source);
  }
  if (project) {
    filters.push("lower(s.project_path) LIKE lower(?) ESCAPE '\\'");
    params.push(`%${escapeLike(project)}%`);
  }
  if (terms.length > 0) {
    const searchable = "lower(concat_ws(' ', t.search_text, s.original_title, s.first_question, s.custom_title, s.ai_summary))";
    for (const term of terms) {
      const likePattern = `%${escapeLike(term)}%`;
      if ([...term].length >= 3) {
        const phrase = fts5Phrase(term);
        filters.push(
          `((t.rowid IN (SELECT rowid FROM session_turns_fts WHERE session_turns_fts MATCH ?) OR s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?)) AND ${searchable} LIKE lower(?) ESCAPE '\\')`,
        );
        params.push(phrase, phrase, likePattern);
      } else {
        filters.push(`${searchable} LIKE lower(?) ESCAPE '\\'`);
        params.push(likePattern);
      }
    }
    params.push(cap);
    const rows = db.sqlite.prepare(
      `SELECT ${RESULT_COLUMNS}
         FROM sessions s
         LEFT JOIN session_turns t ON t.session_key = s.session_key
        WHERE ${filters.join(" AND ")}
        GROUP BY s.session_key
        ORDER BY s.file_mtime_ms DESC
        LIMIT ?`,
    ).all(...params);
    return rows.map(toResult);
  }
  params.push(cap);
  const rows = db.sqlite.prepare(
    `SELECT ${RESULT_COLUMNS}
       FROM sessions s
      WHERE ${filters.join(" AND ")}
      ORDER BY s.file_mtime_ms DESC
      LIMIT ?`,
  ).all(...params);
  return rows.map(toResult);
}

export async function getSession(db, { sessionKey, maxMessages = 40, offset = 0 } = {}) {
  if (!sessionKey) return null;
  const cap = clamp(maxMessages, 40, MAX_MESSAGES);
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

  const row = db.sqlite.prepare(
    `SELECT ${RESULT_COLUMNS}
       FROM sessions s
      WHERE s.team_snapshot_key IS NULL AND s.session_key = ?`,
  ).get(sessionKey);
  if (!row) return null;
  const hasInjectedNoise = Boolean(db.sqlite.prepare(
    `SELECT 1
       FROM turn_messages m
       JOIN session_turns t ON t.id = m.turn_id
      WHERE t.session_key = ? AND m.role = 'user'
        AND (
          instr(lower(m.content), '<subagent_notification') > 0
          OR instr(lower(m.content), '<task-notification') > 0
          OR instr(lower(m.content), '<system_notification') > 0
          OR lower(ltrim(m.content)) LIKE
            'perform any necessary follow-up actions in response to the subagent completion above.%'
        )
      LIMIT 1`,
  ).get(sessionKey));
  let totalMessages;
  let page;
  if (hasInjectedNoise) {
    const messages = db.sqlite.prepare(
      `SELECT m.role, m.content
         FROM turn_messages m
         JOIN session_turns t ON t.id = m.turn_id
        WHERE t.session_key = ?
        ORDER BY t.turn_index, m.message_index`,
    ).all(sessionKey)
      .map((message) => ({
        role: message.role,
        content: message.role === "user" ? cleanUserMessageContent(message.content) : message.content,
      }))
      .filter((message) => message.role !== "user" || message.content);
    totalMessages = messages.length;
    page = messages.slice(start, start + cap);
  } else {
    const totalRow = db.sqlite.prepare(
      `SELECT count(*) AS n
         FROM turn_messages m
         JOIN session_turns t ON t.id = m.turn_id
        WHERE t.session_key = ?`,
    ).get(sessionKey);
    totalMessages = Number(totalRow?.n ?? 0);
    page = db.sqlite.prepare(
      `SELECT m.role, m.content
         FROM turn_messages m
         JOIN session_turns t ON t.id = m.turn_id
        WHERE t.session_key = ?
        ORDER BY t.turn_index, m.message_index
        LIMIT ? OFFSET ?`,
    ).all(sessionKey, cap, start);
  }
  const nextOffset = start + page.length < totalMessages ? start + page.length : null;
  return {
    ...toResult(row),
    totalMessages,
    offset: start,
    returned: page.length,
    nextOffset,
    messages: page,
  };
}

// Returns the most recently active sessions (by file mtime / last activity).
export async function getLatestSessions(db, { source = "", projectPath = "", limit = 5 } = {}) {
  const { escapeLike } = await import("../out/mcp/session-search-query.js");
  const cap = clamp(limit, 1, 20);
  const filters = ["s.team_snapshot_key IS NULL"];
  const params = [];
  if (source) {
    filters.push("s.source = ?");
    params.push(source);
  }
  if (projectPath) {
    filters.push("lower(s.project_path) LIKE lower(?) ESCAPE '\\'");
    params.push(`%${escapeLike(projectPath)}%`);
  }
  params.push(cap);
  const rows = db.sqlite.prepare(
    `SELECT ${RESULT_COLUMNS}
       FROM sessions s
      WHERE ${filters.join(" AND ")}
      ORDER BY s.file_mtime_ms DESC
      LIMIT ?`,
  ).all(...params);
  return rows.map(toResult);
}

// --- Write operations -----------------------------------------------------

function sessionExists(db, sessionKey) {
  return Boolean(db.sqlite.prepare(
    "SELECT 1 FROM sessions WHERE team_snapshot_key IS NULL AND session_key = ?",
  ).get(sessionKey));
}

function currentTags(db, sessionKey) {
  return db.sqlite.prepare(
    `SELECT tags.name
       FROM session_tags
       JOIN tags ON tags.id = session_tags.tag_id
      WHERE session_tags.session_key = ?
      ORDER BY lower(tags.name)`,
  ).all(sessionKey).map((row) => row.name);
}

function deleteUnusedTag(db, tagName) {
  db.sqlite.prepare(
    `DELETE FROM tags
      WHERE name = ?
        AND NOT EXISTS (
          SELECT 1
            FROM session_tags
           WHERE session_tags.tag_id = tags.id
        )`,
  ).run(tagName);
}

export async function tagSession(db, { sessionKey, action, tag } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  const name = String(tag ?? "").trim();
  if (!name) return { ok: false, error: "Tag must not be empty." };
  if (action !== "add" && action !== "remove") return { ok: false, error: 'action must be "add" or "remove".' };

  if (action === "add") {
    db.sqlite.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    db.sqlite.prepare(
      `INSERT INTO session_tags (session_key, tag_id)
       SELECT ?, id FROM tags WHERE name = ?
       ON CONFLICT DO NOTHING`,
    ).run(sessionKey, name);
  } else {
    db.sqlite.prepare(
      `DELETE FROM session_tags
        WHERE session_key = ?
          AND tag_id = (SELECT id FROM tags WHERE name = ?)`,
    ).run(sessionKey, name);
    deleteUnusedTag(db, name);
  }
  return { ok: true, sessionKey, action, tag: name, tags: currentTags(db, sessionKey) };
}

export async function toggleFavorite(db, { sessionKey, favorited } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  db.sqlite.prepare(
    "UPDATE sessions SET favorited = ? WHERE team_snapshot_key IS NULL AND session_key = ?",
  ).run(favorited ? 1 : 0, sessionKey);
  return { ok: true, sessionKey, favorited: Boolean(favorited) };
}

export async function setVisibility(db, { sessionKey, visibility } = {}) {
  if (!sessionKey || !sessionExists(db, sessionKey)) return { ok: false, error: "Session not found." };
  switch (visibility) {
    case "default":
      db.sqlite.prepare("UPDATE sessions SET hidden = 0 WHERE team_snapshot_key IS NULL AND session_key = ?").run(sessionKey);
      break;
    case "favorites":
      db.sqlite.prepare("UPDATE sessions SET favorited = 1, hidden = 0 WHERE team_snapshot_key IS NULL AND session_key = ?").run(sessionKey);
      break;
    case "hidden":
      db.sqlite.prepare("UPDATE sessions SET hidden = 1 WHERE team_snapshot_key IS NULL AND session_key = ?").run(sessionKey);
      break;
    default:
      return { ok: false, error: 'visibility must be one of "default", "favorites", or "hidden".' };
  }
  const row = db.sqlite.prepare(
    "SELECT favorited, hidden FROM sessions WHERE team_snapshot_key IS NULL AND session_key = ?",
  ).get(sessionKey);
  return {
    ok: true,
    sessionKey,
    visibility,
    favorited: Boolean(row.favorited),
    hidden: Boolean(row.hidden),
  };
}

let migrationBundle = null;

function validateMigrationBundle(bundle) {
  if (
    !Array.isArray(bundle?.MIGRATION_TARGET_IDS) ||
    bundle.MIGRATION_TARGET_IDS.length === 0 ||
    !bundle.MIGRATION_TARGET_IDS.every((value) => typeof value === "string")
  ) {
    throw new Error("migration bundle is missing MIGRATION_TARGET_IDS");
  }
  for (const name of ["isMigrationTarget", "openMcpSessionStore", "migrateSessionForMcp"]) {
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

export async function migrateSession(connectionUrl, { sessionKey, target } = {}) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return { ok: false, error: "sessionKey is required." };
  }
  const bundle = await loadMigrationBundle();
  if (!bundle.isMigrationTarget(target)) {
    return { ok: false, error: `target must be one of ${bundle.MIGRATION_TARGET_IDS.map((value) => `"${value}"`).join(", ")}.` };
  }
  if (!connectionUrl || typeof connectionUrl !== "string") {
    return { ok: false, error: "SQLite database URL is unavailable." };
  }
  const store = await bundle.openMcpSessionStore(connectionUrl);
  try {
    const result = await bundle.migrateSessionForMcp(
      { sessionKey, target },
      { store },
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await store.close().catch(() => undefined);
  }
}

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
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    process.stderr.write(
      "AgentRecall database endpoint not found. Open the app, or set AGENT_RECALL_DATABASE_URL.\n",
    );
    process.exit(1);
  }

  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const db = await openSqliteMcpDatabase(databaseUrl);
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
      description: SESSION_MCP_DESCRIPTIONS.searchSessions,
      inputSchema: {
        query: z.string().describe(SESSION_MCP_DESCRIPTIONS.searchQuery).optional(),
        source: z.string().describe(SESSION_MCP_DESCRIPTIONS.sourceFilter).optional(),
        project: z.string().describe(SESSION_MCP_DESCRIPTIONS.projectFilter).optional(),
        limit: z.number().describe(SESSION_MCP_DESCRIPTIONS.resultLimit50).optional(),
      },
    },
    async (args) => jsonContent(await searchSessions(db, args)),
  );

  server.registerTool(
    "get_session",
    {
      description: SESSION_MCP_DESCRIPTIONS.getSession,
      inputSchema: {
        sessionKey: z.string().describe(SESSION_MCP_DESCRIPTIONS.sessionKey),
        maxMessages: z.number().describe(SESSION_MCP_DESCRIPTIONS.maxMessages).optional(),
        offset: z.number().describe(SESSION_MCP_DESCRIPTIONS.messageOffset).optional(),
      },
    },
    async (args) => {
      const result = await getSession(db, args);
      return result ? jsonContent(result) : { content: [{ type: "text", text: "Session not found." }], isError: true };
    },
  );

  server.registerTool(
    "get_latest_sessions",
    {
      description: SESSION_MCP_DESCRIPTIONS.latestSessions,
      inputSchema: {
        source: z.string().describe(SESSION_MCP_DESCRIPTIONS.sourceFilter).optional(),
        projectPath: z.string().describe(SESSION_MCP_DESCRIPTIONS.latestProjectFilter).optional(),
        limit: z.number().describe(SESSION_MCP_DESCRIPTIONS.resultLimit20).optional(),
      },
    },
    async (args) => jsonContent(await getLatestSessions(db, args)),
  );

  server.registerTool(
    "tag_session",
    {
      description: SESSION_MCP_DESCRIPTIONS.tagSession,
      inputSchema: {
        sessionKey: z.string().describe(SESSION_MCP_DESCRIPTIONS.sessionKey),
        action: z.enum(["add", "remove"]).describe(SESSION_MCP_DESCRIPTIONS.tagAction),
        tag: z.string().describe(SESSION_MCP_DESCRIPTIONS.tagName),
      },
    },
    async (args) => {
      const result = await tagSession(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "toggle_favorite",
    {
      description: SESSION_MCP_DESCRIPTIONS.toggleFavorite,
      inputSchema: {
        sessionKey: z.string().describe(SESSION_MCP_DESCRIPTIONS.sessionKey),
        favorited: z.boolean().describe(SESSION_MCP_DESCRIPTIONS.favorited),
      },
    },
    async (args) => {
      const result = await toggleFavorite(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  server.registerTool(
    "set_visibility",
    {
      description: SESSION_MCP_DESCRIPTIONS.setVisibility,
      inputSchema: {
        sessionKey: z.string().describe(SESSION_MCP_DESCRIPTIONS.sessionKey),
        visibility: z.enum(["default", "favorites", "hidden"]).describe(SESSION_MCP_DESCRIPTIONS.visibility),
      },
    },
    async (args) => {
      const result = await setVisibility(db, args);
      return result.ok ? jsonContent(result) : errorContent(result.error);
    },
  );

  if (migrateTargetSchema) {
    server.registerTool(
      "migrate_session",
      {
        description: SESSION_MCP_DESCRIPTIONS.migrateSession,
        inputSchema: {
          sessionKey: z.string().describe(SESSION_MCP_DESCRIPTIONS.migrationSessionKey),
          target: migrateTargetSchema.describe(SESSION_MCP_DESCRIPTIONS.migrationTarget),
        },
      },
      async (args) => {
        const result = await migrateSession(databaseUrl, args);
        return result.ok ? jsonContent(result) : errorContent(result.error);
      },
    );
  }

  const close = async () => {
    await db.end().catch(() => undefined);
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    process.stderr.write(`agent-recall MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
