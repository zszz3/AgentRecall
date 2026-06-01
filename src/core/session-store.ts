import Database from "better-sqlite3";
import type {
  IndexedSession,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionSortBy,
  SessionSource,
} from "./types";

type Db = Database.Database;

interface SessionRow {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  project_path: string;
  file_path: string;
  original_title: string;
  first_question: string;
  timestamp: number;
  file_mtime_ms: number;
  file_size: number;
  pr_url: string | null;
  pr_number: number | null;
  custom_title: string | null;
  favorited: 0 | 1;
  pinned: 0 | 1;
  hidden: 0 | 1;
  last_opened_at: number | null;
  last_resumed_at: number | null;
  message_count: number;
}

export class SessionStore {
  private readonly db: Db;

  constructor(dbPathOrInstance: string | Db) {
    this.db = typeof dbPathOrInstance === "string" ? new Database(dbPathOrInstance) : dbPathOrInstance;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertIndexedSession(session: IndexedSession, messages: SessionMessage[]): void {
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO sessions (
            session_key, raw_id, source, project_path, file_path, original_title, first_question,
            timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count
          )
          VALUES (@sessionKey, @rawId, @source, @projectPath, @filePath, @originalTitle, @firstQuestion,
            @timestamp, @fileMtimeMs, @fileSize, @prUrl, @prNumber, @messageCount)
          ON CONFLICT(session_key) DO UPDATE SET
            raw_id = excluded.raw_id,
            source = excluded.source,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            timestamp = excluded.timestamp,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count
        `,
        )
        .run({ ...session, messageCount: messages.length });

      this.db.prepare("DELETE FROM messages WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(session.sessionKey);

      const insertMessage = this.db.prepare(
        "INSERT INTO messages (session_key, message_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      );
      for (const message of messages) {
        insertMessage.run(session.sessionKey, message.index, message.role, message.content, message.timestamp);
      }

      this.refreshFtsForSession(session.sessionKey);
    });

    write();
  }

  setCustomTitle(sessionKey: string, title: string | null): void {
    const normalized = title?.trim() || null;
    this.db.prepare("UPDATE sessions SET custom_title = ? WHERE session_key = ?").run(normalized, sessionKey);
    this.refreshFtsForSession(sessionKey);
  }

  setPinned(sessionKey: string, pinned: boolean): void {
    this.db.prepare("UPDATE sessions SET pinned = ? WHERE session_key = ?").run(pinned ? 1 : 0, sessionKey);
  }

  setFavorited(sessionKey: string, favorited: boolean): void {
    this.db.prepare("UPDATE sessions SET favorited = ? WHERE session_key = ?").run(favorited ? 1 : 0, sessionKey);
  }

  setHidden(sessionKey: string, hidden: boolean): void {
    this.db.prepare("UPDATE sessions SET hidden = ? WHERE session_key = ?").run(hidden ? 1 : 0, sessionKey);
  }

  markOpened(sessionKey: string): void {
    this.db.prepare("UPDATE sessions SET last_opened_at = ? WHERE session_key = ?").run(Date.now(), sessionKey);
  }

  markResumed(sessionKey: string): void {
    this.db.prepare("UPDATE sessions SET last_resumed_at = ? WHERE session_key = ?").run(Date.now(), sessionKey);
  }

  addTag(sessionKey: string, tagName: string): void {
    const name = tagName.trim();
    if (!name) return;
    const write = this.db.transaction(() => {
      this.db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
      const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number };
      this.db
        .prepare("INSERT INTO session_tags (session_key, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(sessionKey, tag.id);
    });
    write();
  }

  removeTag(sessionKey: string, tagName: string): void {
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `
          DELETE FROM session_tags
          WHERE session_key = ?
            AND tag_id = (SELECT id FROM tags WHERE name = ?)
        `,
        )
        .run(sessionKey, tagName);
      this.deleteUnusedTag(tagName);
    });
    write();
  }

  deleteTag(tagName: string): void {
    this.db.prepare("DELETE FROM tags WHERE name = ?").run(tagName.trim());
  }

  listTags(): string[] {
    return (this.db.prepare("SELECT name FROM tags ORDER BY lower(name)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT project_path, COUNT(*) AS session_count
        FROM sessions
        WHERE trim(project_path) != ''
        GROUP BY project_path
      `,
      )
      .all() as Array<{ project_path: string; session_count: number }>;
    const summaries = rows.map((row) => ({
      path: row.project_path,
      label: projectLabel(row.project_path),
      sessionCount: row.session_count,
    }));
    const basenameCounts = new Map<string, number>();
    for (const summary of summaries) {
      const basename = projectBasename(summary.path);
      basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
    }

    return summaries
      .map((summary) => ({
        ...summary,
        label: (basenameCounts.get(projectBasename(summary.path)) || 0) > 1 ? projectParentLabel(summary.path) : summary.label,
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
  }

  getSession(sessionKey: string): SessionSearchResult | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | undefined;
    return row ? this.hydrateRow(row, null) : null;
  }

  getMessages(sessionKey: string, offset = 0, limit = 120): SessionMessage[] {
    return (
      this.db
        .prepare(
          `
          SELECT message_index, role, content, timestamp
          FROM messages
          WHERE session_key = ?
          ORDER BY message_index
          LIMIT ? OFFSET ?
        `,
        )
        .all(sessionKey, limit, offset) as Array<{
        message_index: number;
        role: "user" | "assistant";
        content: string;
        timestamp: string;
      }>
    ).map((row) => ({ index: row.message_index, role: row.role, content: row.content, timestamp: row.timestamp }));
  }

  getAllMessages(sessionKey: string): SessionMessage[] {
    return this.getMessages(sessionKey, 0, 100_000);
  }

  searchSessions(options: SearchOptions = {}): SessionSearchResult[] {
    const limit = options.limit ?? 200;
    const query = options.query?.trim() || "";
    const ftsMatches = query ? this.searchFts(query) : new Map<string, string | null>();
    const rows = this.getCandidateRows(options);
    const merged = new Map<string, SessionSearchResult>();

    for (const row of rows) {
      const ftsSnippet = ftsMatches.get(row.session_key);
      const hydrated = this.hydrateRow(row, query ? ftsSnippet || this.findSnippet(row.session_key, query) : null);
      if (!this.matchesFilters(hydrated, options)) continue;
      if (query && !ftsMatches.has(row.session_key) && !this.matchesTextQuery(hydrated, query)) continue;
      merged.set(hydrated.sessionKey, hydrated);
    }

    return [...merged.values()]
      .sort((a, b) => this.score(b, query) - this.score(a, query) || this.sortValue(b, options.sortBy) - this.sortValue(a, options.sortBy))
      .slice(0, limit);
  }

  clearSearchIndex(): void {
    const clear = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM session_fts").run();
      this.db
        .prepare(
          "UPDATE sessions SET file_mtime_ms = 0, file_size = 0, message_count = 0, original_title = '', first_question = ''",
        )
        .run();
    });
    clear();
  }

  private migrate(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        raw_id TEXT NOT NULL,
        source TEXT NOT NULL,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_title TEXT NOT NULL,
        first_question TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        pr_url TEXT,
        pr_number INTEGER,
        custom_title TEXT,
        favorited INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        last_resumed_at INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        session_key TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (session_key, message_index),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS session_tags (
        session_key TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (session_key, tag_id),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_key UNINDEXED,
        title,
        first_question,
        content_text,
        project_path,
        tokenize = 'unicode61'
      );
    `);
    this.addColumnIfMissing("sessions", "favorited", "INTEGER NOT NULL DEFAULT 0");
  }

  private addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  private refreshFtsForSession(sessionKey: string): void {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | undefined;
    if (!row) return;
    const contentText = (this.db.prepare("SELECT content FROM messages WHERE session_key = ? ORDER BY message_index").all(
      sessionKey,
    ) as Array<{ content: string }>)
      .map((message) => message.content)
      .join("\n\n");
    const title = row.custom_title || row.first_question || row.original_title || "Untitled Session";
    this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
    this.db
      .prepare(
        "INSERT INTO session_fts (session_key, title, first_question, content_text, project_path) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionKey, title, row.first_question, contentText, row.project_path);
  }

  private deleteUnusedTag(tagName: string): void {
    this.db
      .prepare(
        `
        DELETE FROM tags
        WHERE name = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_tags
            WHERE session_tags.tag_id = tags.id
          )
      `,
      )
      .run(tagName);
  }

  private getCandidateRows(options: SearchOptions): SessionRow[] {
    const rows = this.db.prepare("SELECT * FROM sessions").all() as SessionRow[];
    if (options.visibility === "hidden") return rows.filter((row) => row.hidden === 1);
    if (options.visibility === "favorites") return rows.filter((row) => row.hidden === 0 && row.favorited === 1);
    if (options.visibility === "pinned") return rows.filter((row) => row.hidden === 0 && row.pinned === 1);
    return rows.filter((row) => row.hidden === 0);
  }

  private matchesFilters(result: SessionSearchResult, options: SearchOptions): boolean {
    if (options.tag && !result.tags.includes(options.tag)) return false;
    if (options.projectPath && result.projectPath !== options.projectPath) return false;
    if (options.source && options.source !== "all") {
      if (options.source === "claude" && !result.source.startsWith("claude-")) return false;
      else if (options.source === "codex" && !result.source.startsWith("codex-")) return false;
      else if (options.source !== "claude" && options.source !== "codex" && result.source !== options.source) return false;
    }
    return true;
  }

  private matchesTextQuery(result: SessionSearchResult, query: string): boolean {
    const lower = query.toLowerCase();
    if (result.displayTitle.toLowerCase().includes(lower)) return true;
    if (result.originalTitle.toLowerCase().includes(lower)) return true;
    if (result.firstQuestion.toLowerCase().includes(lower)) return true;
    if (result.projectPath.toLowerCase().includes(lower)) return true;
    if (result.rawId.toLowerCase().includes(lower)) return true;
    return this.findSnippet(result.sessionKey, query) !== null;
  }

  private findSnippet(sessionKey: string, query: string): string | null {
    const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
    const row = this.db
      .prepare(
        `
        SELECT content
        FROM messages
        WHERE session_key = ? AND lower(content) LIKE lower(?) ESCAPE '\\'
        ORDER BY message_index
        LIMIT 1
      `,
      )
      .get(sessionKey, like) as { content: string } | undefined;
    if (!row) return null;
    const content = row.content.replace(/\s+/g, " ");
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return content.slice(0, 180);
    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + query.length + 80);
    return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
  }

  private searchFts(query: string): Map<string, string | null> {
    const expression = buildFtsQuery(query);
    if (!expression) return new Map();
    try {
      const rows = this.db
        .prepare(
          `
          SELECT session_key, snippet(session_fts, 3, '', '', '...', 18) AS snippet
          FROM session_fts
          WHERE session_fts MATCH ?
        `,
        )
        .all(expression) as Array<{ session_key: string; snippet: string | null }>;
      return new Map(rows.map((row) => [row.session_key, row.snippet]));
    } catch {
      return new Map();
    }
  }

  private hydrateRow(row: SessionRow, snippet: string | null): SessionSearchResult {
    const tags = (
      this.db
        .prepare(
          `
          SELECT tags.name
          FROM tags
          JOIN session_tags ON session_tags.tag_id = tags.id
          WHERE session_tags.session_key = ?
          ORDER BY lower(tags.name)
        `,
        )
        .all(row.session_key) as Array<{ name: string }>
    ).map((tag) => tag.name);
    const displayTitle = row.custom_title || row.first_question || row.original_title || "Untitled Session";
    return {
      sessionKey: row.session_key,
      rawId: row.raw_id,
      source: row.source,
      projectPath: row.project_path,
      filePath: row.file_path,
      originalTitle: row.original_title,
      firstQuestion: row.first_question,
      timestamp: row.timestamp,
      fileMtimeMs: row.file_mtime_ms,
      fileSize: row.file_size,
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      customTitle: row.custom_title,
      displayTitle,
      favorited: row.favorited === 1,
      pinned: row.pinned === 1,
      hidden: row.hidden === 1,
      tags,
      matchSnippet: snippet,
      lastOpenedAt: row.last_opened_at,
      lastResumedAt: row.last_resumed_at,
      messageCount: row.message_count,
    };
  }

  private score(result: SessionSearchResult, query: string): number {
    if (!query) return result.pinned ? 1_000_000_000_000 : 0;
    const q = query.toLowerCase();
    const title = result.displayTitle.toLowerCase();
    let score = 0;
    if (title === q) score += 1000;
    else if (title.startsWith(q)) score += 700;
    else if (title.includes(q)) score += 500;
    if (result.firstQuestion.toLowerCase().includes(q)) score += 300;
    if (result.matchSnippet) score += 120;
    if (result.projectPath.toLowerCase().includes(q) || result.rawId.toLowerCase().includes(q)) score += 50;
    if (result.pinned) score += 25;
    return score;
  }

  private sortValue(result: SessionSearchResult, sortBy: SessionSortBy = "created"): number {
    if (sortBy === "created") return result.timestamp || 0;
    if (sortBy === "updated") return result.fileMtimeMs || result.timestamp || 0;
    return Math.max(result.lastResumedAt || 0, result.fileMtimeMs || 0, result.timestamp || 0);
  }
}

export function createInMemoryStore(): SessionStore {
  return new SessionStore(new Database(":memory:"));
}

function buildFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens
    .map((token) => token.replace(/"/g, ""))
    .filter(Boolean)
    .map((token) => `${token}*`)
    .join(" ");
}

function projectParts(projectPath: string): string[] {
  return projectPath.split(/[\\/]+/).filter(Boolean);
}

function projectBasename(projectPath: string): string {
  const parts = projectParts(projectPath);
  return parts.at(-1) || projectPath;
}

function projectLabel(projectPath: string): string {
  return projectBasename(projectPath) || projectPath;
}

function projectParentLabel(projectPath: string): string {
  const parts = projectParts(projectPath);
  if (parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`;
  return projectLabel(projectPath);
}
