import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import {
  skillUsageSnapshotFromEvents,
  type SkillUsageEvent,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "./skill-usage";
import { groupProjectPath } from "./project-grouping";
import { truncateTraceDetail } from "./trace-detail";
import type {
  IndexedSession,
  ProjectGroupingMode,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionStatsPeriod,
  SessionStatsSummary,
  SessionSortBy,
  SessionSource,
  SessionTraceEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type Db = DatabaseSyncType;
type ApiProviderKeyTarget = "codex" | "claude";

interface StatsRange {
  period: SessionStatsPeriod;
  since: number | null;
  until: number;
}

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
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface TraceEventRow {
  trace_index: number;
  kind: SessionTraceEvent["kind"];
  source: SessionTraceEvent["source"];
  title: string;
  detail: string;
  timestamp: string;
  call_id: string | null;
  event_type: string | null;
  status: SessionTraceEvent["status"] | null;
}

interface SkillUsageEventRow {
  agent: SkillUsageEvent["agent"];
  skill: string;
  timestamp: number;
}

export class SessionStore {
  private readonly db: Db;

  constructor(dbPathOrInstance: string | Db) {
    this.db = typeof dbPathOrInstance === "string" ? new DatabaseSync(dbPathOrInstance) : dbPathOrInstance;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertIndexedSession(
    session: IndexedSession,
    messages: SessionMessage[],
    tokenEvents: TokenUsageEvent[] = [],
    traceEvents: SessionTraceEvent[] = [],
  ): void {
    const normalizedTokenEvents = tokenEvents.map(normalizeTokenEvent).filter((event) => event.totalTokens > 0 && event.dedupeKey);
    const tokenUsage = normalizedTokenEvents.length > 0 ? tokenUsageFromEvents(normalizedTokenEvents) : normalizeTokenUsage(session.tokenUsage);
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO sessions (
            session_key, raw_id, source, project_path, file_path, original_title, first_question,
            timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count,
            input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens
        `,
        )
        .run(
          session.sessionKey,
          session.rawId,
          session.source,
          session.projectPath,
          session.filePath,
          session.originalTitle,
          session.firstQuestion,
          session.timestamp,
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          messages.length,
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
        );

      this.db.prepare("DELETE FROM messages WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM token_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM trace_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(session.sessionKey);

      const insertMessage = this.db.prepare(
        "INSERT INTO messages (session_key, message_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      );
      for (const message of messages) {
        insertMessage.run(session.sessionKey, message.index, message.role, message.content, message.timestamp);
      }

      const insertTokenEvent = this.db.prepare(
        `
        INSERT INTO token_events (
          session_key, dedupe_key, timestamp, input_tokens, output_tokens,
          cached_input_tokens, reasoning_output_tokens, total_tokens
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const event of normalizedTokenEvents) {
        insertTokenEvent.run(
          session.sessionKey,
          event.dedupeKey,
          event.timestamp,
          event.inputTokens,
          event.outputTokens,
          event.cachedInputTokens,
          event.reasoningOutputTokens,
          event.totalTokens,
        );
      }

      const insertTraceEvent = this.db.prepare(
        `
        INSERT INTO trace_events (
          session_key, trace_index, kind, source, title, detail,
          timestamp, call_id, event_type, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const event of traceEvents) {
        insertTraceEvent.run(
          session.sessionKey,
          event.index,
          event.kind,
          event.source,
          event.title,
          truncateTraceDetail(event.detail),
          event.timestamp,
          event.callId ?? null,
          event.eventType ?? null,
          event.status ?? null,
        );
      }

      this.refreshFtsForSession(session.sessionKey);
      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) this.addTagToSession(session.sessionKey, branchTag);
    });
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
    this.transaction(() => {
      this.addTagToSession(sessionKey, name);
    });
  }

  removeTag(sessionKey: string, tagName: string): void {
    this.transaction(() => {
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
  }

  deleteTag(tagName: string): void {
    this.db.prepare("DELETE FROM tags WHERE name = ?").run(tagName.trim());
  }

  listTags(): string[] {
    return (this.db.prepare("SELECT name FROM tags ORDER BY lower(name)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  listProjects(grouping: ProjectGroupingMode = "cwd", promotedRoots: string[] = []): ProjectSummary[] {
    if (grouping === "repo") {
      const rows = this.db
        .prepare(
          `
          SELECT project_path
          FROM sessions
          WHERE trim(project_path) != ''
        `,
        )
        .all() as Array<{ project_path: string }>;
      const groupedCounts = new Map<string, number>();
      for (const row of rows) {
        const groupedPath = groupProjectPath(row.project_path, grouping, promotedRoots);
        if (!groupedPath) continue;
        groupedCounts.set(groupedPath, (groupedCounts.get(groupedPath) || 0) + 1);
      }
      return this.sortProjectSummaries(
        [...groupedCounts.entries()].map(([path, sessionCount]) => ({
          path,
          label: projectLabel(path),
          sessionCount,
        })),
      );
    }

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
    return this.sortProjectSummaries(
      rows.map((row) => ({
        path: row.project_path,
        label: projectLabel(row.project_path),
        sessionCount: row.session_count,
      })),
    );
  }

  private sortProjectSummaries(summaries: ProjectSummary[]): ProjectSummary[] {
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

  getTraceEvents(sessionKey: string): SessionTraceEvent[] {
    return (
      this.db
        .prepare(
          `
          SELECT trace_index, kind, source, title, detail, timestamp, call_id, event_type, status
          FROM trace_events
          WHERE session_key = ?
          ORDER BY trace_index
        `,
        )
        .all(sessionKey) as unknown as TraceEventRow[]
    ).map((row) => ({
      index: row.trace_index,
      kind: row.kind,
      source: row.source,
      title: row.title,
      detail: row.detail,
      timestamp: row.timestamp,
      ...(row.call_id ? { callId: row.call_id } : {}),
      ...(row.event_type ? { eventType: row.event_type } : {}),
      ...(row.status ? { status: row.status } : {}),
    }));
  }

  isSkillUsageSourceFresh(source: SkillUsageSource): boolean {
    const row = this.db
      .prepare("SELECT mtime_ms, file_size FROM skill_usage_sources WHERE source_path = ?")
      .get(source.path) as { mtime_ms: number; file_size: number } | undefined;
    return Boolean(row && Math.abs(row.mtime_ms - source.mtimeMs) < 0.001 && row.file_size === source.fileSize);
  }

  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO skill_usage_sources (source_path, agent, kind, mtime_ms, file_size, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET
            agent = excluded.agent,
            kind = excluded.kind,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            scanned_at = excluded.scanned_at
        `,
        )
        .run(source.path, source.agent, source.kind, source.mtimeMs, source.fileSize, Date.now());

      this.db.prepare("DELETE FROM skill_usage_events WHERE source_path = ?").run(source.path);
      const insertEvent = this.db.prepare(
        `
        INSERT INTO skill_usage_events (source_path, event_index, agent, skill, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `,
      );
      events.forEach((event, index) => {
        const skill = event.skill.trim();
        if (!skill) return;
        insertEvent.run(source.path, index, event.agent, skill, event.timestamp);
      });
    });
  }

  pruneSkillUsageSources(activePaths: string[]): void {
    const active = new Set(activePaths);
    const rows = this.db.prepare("SELECT source_path FROM skill_usage_sources").all() as Array<{ source_path: string }>;
    this.transaction(() => {
      for (const row of rows) {
        if (!active.has(row.source_path)) this.db.prepare("DELETE FROM skill_usage_sources WHERE source_path = ?").run(row.source_path);
      }
    });
  }

  getSkillUsageSnapshot(): SkillUsageSnapshot {
    const sourceCountRow = this.db.prepare("SELECT COUNT(*) AS count FROM skill_usage_sources").get() as { count: number };
    const rows = this.db
      .prepare(
        `
        SELECT agent, skill, timestamp
        FROM skill_usage_events
        ORDER BY source_path, event_index
      `,
      )
      .all() as unknown as SkillUsageEventRow[];
    return skillUsageSnapshotFromEvents(rows, "", sourceCountRow.count > 0 || rows.length > 0);
  }

  getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): string {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return "";
    const row = this.db
      .prepare("SELECT api_key FROM api_provider_keys WHERE target = ? AND provider_id = ?")
      .get(target, normalizedProviderId) as { api_key: string } | undefined;
    return row?.api_key ?? "";
  }

  setApiProviderKey(target: ApiProviderKeyTarget, providerId: string, apiKey: string): void {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return;
    this.db
      .prepare(
        `
        INSERT INTO api_provider_keys (target, provider_id, api_key, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(target, provider_id) DO UPDATE SET
          api_key = excluded.api_key,
          updated_at = excluded.updated_at
      `,
      )
      .run(target, normalizedProviderId, apiKey.trim(), Date.now());
  }

  getStats(options: SessionStatsOptions = {}, now = Date.now()): SessionStats {
    const range = resolveStatsRange(options, now);
    const summariesBySource = new Map<SessionSource, SessionStatsSummary>();

    for (const row of this.aggregateActiveSessionsBySource(range)) {
      summaryForSource(summariesBySource, row.source).sessionCount = row.session_count;
    }
    for (const row of this.aggregateMessagesBySource(range)) {
      summaryForSource(summariesBySource, row.source).messageCount = row.message_count;
    }

    const tokenRows = this.aggregateTokenEventsBySource(range);
    const tokenSourceRows = range.since === null && tokenRows.length === 0 ? this.aggregateSessionTokensBySource() : tokenRows;
    for (const row of tokenSourceRows) {
      const summary = summaryForSource(summariesBySource, row.source);
      summary.inputTokens = row.input_tokens;
      summary.outputTokens = row.output_tokens;
      summary.cachedInputTokens = row.cached_input_tokens;
      summary.reasoningOutputTokens = row.reasoning_output_tokens;
      summary.totalTokens = row.total_tokens;
    }

    const bySource = [...summariesBySource.entries()]
      .map(([source, summary]) => ({ source, ...summary }))
      .filter((summary) => summary.sessionCount > 0 || summary.messageCount > 0 || summary.totalTokens > 0)
      .sort((a, b) => a.source.localeCompare(b.source));
    const total = bySource.reduce<SessionStatsSummary>(
      (acc, row) => ({
        sessionCount: acc.sessionCount + row.sessionCount,
        messageCount: acc.messageCount + row.messageCount,
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + row.reasoningOutputTokens,
        totalTokens: acc.totalTokens + row.totalTokens,
      }),
      emptyStatsSummary(),
    );

    return {
      total,
      bySource,
      range,
    };
  }

  searchSessions(options: SearchOptions = {}): SessionSearchResult[] {
    const limit = options.limit ?? 200;
    const query = options.query?.trim() || "";
    const projectGrouping = options.projectGrouping ?? "cwd";
    const promotedRoots = options.promotedProjectRoots ?? [];
    const ftsMatches = query ? this.searchFts(query) : new Map<string, string | null>();
    const rows = this.getCandidateRows(options, projectGrouping);
    const tagsBySession = this.getTagsForSessions(rows.map((row) => row.session_key));
    const merged = new Map<string, SessionSearchResult>();

    for (const row of rows) {
      if (options.projectPath && groupProjectPath(row.project_path, projectGrouping, promotedRoots) !== options.projectPath) continue;
      const hasFtsMatch = ftsMatches.has(row.session_key);
      const ftsSnippet = hasFtsMatch ? (ftsMatches.get(row.session_key) ?? null) : null;
      const hydrated = this.hydrateRow(row, query ? ftsSnippet : null, tagsBySession.get(row.session_key) ?? []);
      if (query && !hasFtsMatch && !this.matchesTextFields(hydrated, query)) {
        const snippet = this.findSnippet(row.session_key, query);
        if (!snippet) continue;
        hydrated.matchSnippet = snippet;
      }
      merged.set(hydrated.sessionKey, hydrated);
    }

    return [...merged.values()]
      .sort((a, b) => this.score(b, query) - this.score(a, query) || this.sortValue(b, options.sortBy) - this.sortValue(a, options.sortBy))
      .slice(0, limit);
  }

  clearSearchIndex(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM token_events").run();
      this.db.prepare("DELETE FROM trace_events").run();
      this.db.prepare("DELETE FROM session_fts").run();
      this.db
        .prepare(
          `
          UPDATE sessions
          SET file_mtime_ms = 0,
            file_size = 0,
            message_count = 0,
            input_tokens = 0,
            output_tokens = 0,
            cached_input_tokens = 0,
            reasoning_output_tokens = 0,
            total_tokens = 0,
            original_title = '',
            first_question = ''
        `,
        )
        .run();
    });
  }

  deleteSessionsBySource(sources: SessionSource[]): void {
    if (sources.length === 0) return;
    const placeholders = sources.map(() => "?").join(", ");
    this.transaction(() => {
      this.db.prepare(`DELETE FROM session_fts WHERE session_key IN (SELECT session_key FROM sessions WHERE source IN (${placeholders}))`).run(...sources);
      this.db.prepare(`DELETE FROM sessions WHERE source IN (${placeholders})`).run(...sources);
      this.deleteUnusedTags();
    });
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
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
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS token_events (
        session_key TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_key, dedupe_key),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS trace_events (
        session_key TEXT NOT NULL,
        trace_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        call_id TEXT,
        event_type TEXT,
        status TEXT,
        PRIMARY KEY (session_key, trace_index),
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

      CREATE TABLE IF NOT EXISTS skill_usage_sources (
        source_path TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        scanned_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_usage_events (
        source_path TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        agent TEXT NOT NULL,
        skill TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (source_path, event_index),
        FOREIGN KEY (source_path) REFERENCES skill_usage_sources(source_path) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_provider_keys (
        target TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (target, provider_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_key UNINDEXED,
        title,
        first_question,
        content_text,
        project_path,
        tokenize = 'unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_hidden_favorited_pinned
        ON sessions(hidden, favorited, pinned);
      CREATE INDEX IF NOT EXISTS idx_sessions_source
        ON sessions(source);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_path
        ON sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_session_tags_tag_session
        ON session_tags(tag_id, session_key);
      CREATE INDEX IF NOT EXISTS idx_token_events_timestamp
        ON token_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_token_events_dedupe
        ON token_events(dedupe_key, total_tokens, timestamp);
      CREATE INDEX IF NOT EXISTS idx_trace_events_session
        ON trace_events(session_key, trace_index);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_agent_skill
        ON skill_usage_events(agent, skill);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_timestamp
        ON skill_usage_events(timestamp);
    `);
    this.addColumnIfMissing("sessions", "favorited", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
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

  private deleteUnusedTags(): void {
    this.db
      .prepare(
        `
        DELETE FROM tags
        WHERE NOT EXISTS (
          SELECT 1
          FROM session_tags
          WHERE session_tags.tag_id = tags.id
        )
      `,
      )
      .run();
  }

  private addTagToSession(sessionKey: string, tagName: string): void {
    const name = tagName.trim();
    if (!name) return;
    this.db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number };
    this.db
      .prepare("INSERT INTO session_tags (session_key, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(sessionKey, tag.id);
  }

  private aggregateActiveSessionsBySource(range: StatsRange): Array<{ source: SessionSource; session_count: number }> {
    if (range.since === null) {
      return this.db
        .prepare(
          `
          SELECT source, COUNT(*) AS session_count
          FROM sessions
          GROUP BY source
          ORDER BY source
        `,
        )
        .all() as Array<{ source: SessionSource; session_count: number }>;
    }

    const messageTimestampMs = "CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000";
    return this.db
      .prepare(
        `
        WITH active AS (
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN messages ON messages.session_key = sessions.session_key
          WHERE ${messageTimestampMs} >= ? AND ${messageTimestampMs} <= ?
          UNION
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN token_events ON token_events.session_key = sessions.session_key
          WHERE token_events.timestamp >= ? AND token_events.timestamp <= ?
        )
        SELECT source, COUNT(DISTINCT session_key) AS session_count
        FROM active
        GROUP BY source
        ORDER BY source
      `,
      )
      .all(range.since, range.until, range.since, range.until) as Array<{ source: SessionSource; session_count: number }>;
  }

  private aggregateMessagesBySource(range: StatsRange): Array<{ source: SessionSource; message_count: number }> {
    if (range.since === null) {
      return this.db
        .prepare(
          `
          SELECT source, COALESCE(SUM(message_count), 0) AS message_count
          FROM sessions
          GROUP BY source
          ORDER BY source
        `,
        )
        .all() as Array<{ source: SessionSource; message_count: number }>;
    }

    const messageTimestampMs = "CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000";
    return this.db
      .prepare(
        `
        SELECT sessions.source AS source, COUNT(*) AS message_count
        FROM messages
        JOIN sessions ON sessions.session_key = messages.session_key
        WHERE ${messageTimestampMs} >= ? AND ${messageTimestampMs} <= ?
        GROUP BY sessions.source
        ORDER BY sessions.source
      `,
      )
      .all(range.since, range.until) as Array<{ source: SessionSource; message_count: number }>;
  }

  private aggregateTokenEventsBySource(range: StatsRange): Array<{
    source: SessionSource;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  }> {
    const whereClause = range.since === null ? "" : "WHERE token_events.timestamp >= ? AND token_events.timestamp <= ?";
    const args = range.since === null ? [] : [range.since, range.until];
    return this.db
      .prepare(
        `
        WITH ranked AS (
          SELECT
            sessions.source AS source,
            token_events.dedupe_key AS dedupe_key,
            token_events.timestamp AS timestamp,
            token_events.input_tokens AS input_tokens,
            token_events.output_tokens AS output_tokens,
            token_events.cached_input_tokens AS cached_input_tokens,
            token_events.reasoning_output_tokens AS reasoning_output_tokens,
            token_events.total_tokens AS total_tokens,
            ROW_NUMBER() OVER (
              PARTITION BY token_events.dedupe_key
              ORDER BY
                token_events.total_tokens DESC,
                CASE sessions.source
                  WHEN 'codex-cli' THEN 1
                  WHEN 'claude-cli' THEN 1
                  WHEN 'codex-app' THEN 2
                  WHEN 'claude-app' THEN 2
                  ELSE 9
                END,
                token_events.timestamp ASC
            ) AS row_rank
          FROM token_events
          JOIN sessions ON sessions.session_key = token_events.session_key
          ${whereClause}
        ),
        deduped AS (
          SELECT
            source,
            dedupe_key,
            timestamp,
            input_tokens,
            output_tokens,
            cached_input_tokens,
            reasoning_output_tokens,
            total_tokens
          FROM ranked
          WHERE row_rank = 1
        )
        SELECT
          source,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM deduped
        GROUP BY source
        ORDER BY source
      `,
      )
      .all(...args) as Array<{
      source: SessionSource;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
    }>;
  }

  private aggregateSessionTokensBySource(): Array<{
    source: SessionSource;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  }> {
    return this.db
      .prepare(
        `
        SELECT
          source,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM sessions
        GROUP BY source
        ORDER BY source
      `,
      )
      .all() as Array<{
      source: SessionSource;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
    }>;
  }

  private getCandidateRows(options: SearchOptions, projectGrouping: ProjectGroupingMode): SessionRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];

    if (options.visibility === "hidden") where.push("hidden = 1");
    else if (options.visibility === "favorites") where.push("hidden = 0 AND favorited = 1");
    else if (options.visibility === "pinned") where.push("hidden = 0 AND pinned = 1");
    else where.push("hidden = 0");

    if (options.projectPath && projectGrouping === "cwd") {
      where.push("project_path = ?");
      args.push(options.projectPath);
    }

    if (options.source && options.source !== "all") {
      if (options.source === "claude") {
        where.push("source IN ('claude-cli', 'claude-app')");
      } else if (options.source === "codex") {
        where.push("source IN ('codex-cli', 'codex-app')");
      } else {
        where.push("source = ?");
        args.push(options.source);
      }
    }

    if (options.tag) {
      where.push(
        `
        EXISTS (
          SELECT 1
          FROM session_tags
          JOIN tags ON tags.id = session_tags.tag_id
          WHERE session_tags.session_key = sessions.session_key
            AND tags.name = ?
        )
      `,
      );
      args.push(options.tag);
    }

    return this.db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")}`).all(...args) as unknown as SessionRow[];
  }

  private matchesTextFields(result: SessionSearchResult, query: string): boolean {
    const lower = query.toLowerCase();
    if (result.displayTitle.toLowerCase().includes(lower)) return true;
    if (result.originalTitle.toLowerCase().includes(lower)) return true;
    if (result.firstQuestion.toLowerCase().includes(lower)) return true;
    if (result.projectPath.toLowerCase().includes(lower)) return true;
    if (result.rawId.toLowerCase().includes(lower)) return true;
    return false;
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

  private getTagsForSession(sessionKey: string): string[] {
    return (
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
        .all(sessionKey) as Array<{ name: string }>
    ).map((tag) => tag.name);
  }

  private getTagsForSessions(sessionKeys: string[]): Map<string, string[]> {
    const tagsBySession = new Map<string, string[]>();
    if (sessionKeys.length === 0) return tagsBySession;

    const shouldFilterBySession = sessionKeys.length <= 900;
    const placeholders = shouldFilterBySession ? sessionKeys.map(() => "?").join(",") : "";
    const rows = this.db
      .prepare(
        `
        SELECT session_tags.session_key, tags.name
        FROM session_tags
        JOIN tags ON tags.id = session_tags.tag_id
        ${shouldFilterBySession ? `WHERE session_tags.session_key IN (${placeholders})` : ""}
        ORDER BY session_tags.session_key, lower(tags.name)
      `,
      )
      .all(...(shouldFilterBySession ? sessionKeys : [])) as Array<{ session_key: string; name: string }>;

    const allowed = shouldFilterBySession ? null : new Set(sessionKeys);
    for (const row of rows) {
      if (allowed && !allowed.has(row.session_key)) continue;
      const tags = tagsBySession.get(row.session_key) ?? [];
      tags.push(row.name);
      tagsBySession.set(row.session_key, tags);
    }
    return tagsBySession;
  }

  private hydrateRow(row: SessionRow, snippet: string | null, tags = this.getTagsForSession(row.session_key)): SessionSearchResult {
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
      tokenUsage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedInputTokens: row.cached_input_tokens,
        reasoningOutputTokens: row.reasoning_output_tokens,
        totalTokens: row.total_tokens,
      },
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
  return new SessionStore(new DatabaseSync(":memory:"));
}

function emptyStatsSummary(): SessionStatsSummary {
  return {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function summaryForSource(summariesBySource: Map<SessionSource, SessionStatsSummary>, source: SessionSource): SessionStatsSummary {
  const existing = summariesBySource.get(source);
  if (existing) return existing;
  const summary = emptyStatsSummary();
  summariesBySource.set(source, summary);
  return summary;
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeTokenUsage(tokenUsage: TokenUsage | undefined): TokenUsage {
  const inputTokens = nonNegativeNumber(tokenUsage?.inputTokens);
  const outputTokens = nonNegativeNumber(tokenUsage?.outputTokens);
  const cachedInputTokens = nonNegativeNumber(tokenUsage?.cachedInputTokens);
  const reasoningOutputTokens = nonNegativeNumber(tokenUsage?.reasoningOutputTokens);
  const derivedTotal = inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: nonNegativeNumber(tokenUsage?.totalTokens) || derivedTotal,
  };
}

function normalizeTokenEvent(event: TokenUsageEvent): TokenUsageEvent {
  return {
    ...normalizeTokenUsage(event),
    timestamp: nonNegativeNumber(event.timestamp),
    dedupeKey: event.dedupeKey.trim(),
  };
}

function tokenUsageFromEvents(events: TokenUsageEvent[]): TokenUsage {
  return events.reduce<TokenUsage>(
    (acc, event) => ({
      inputTokens: acc.inputTokens + event.inputTokens,
      outputTokens: acc.outputTokens + event.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + event.cachedInputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + event.reasoningOutputTokens,
      totalTokens: acc.totalTokens + event.totalTokens,
    }),
    emptyTokenUsage(),
  );
}

function nonNegativeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function resolveStatsRange(options: SessionStatsOptions, now: number): StatsRange {
  const period = options.period ?? "today";
  if (period === "allTime") return { period, since: null, until: now };
  if (period === "today") return { period, since: startOfLocalDay(now), until: now };
  if (period === "thirtyDay") return { period, since: now - 30 * 24 * 60 * 60 * 1000, until: now };
  return { period: "sevenDay", since: now - 7 * 24 * 60 * 60 * 1000, until: now };
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function buildFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens
    .map((token) => token.replace(/"/g, ""))
    .filter(Boolean)
    .map((token) => `${token}*`)
    .join(" ");
}

function branchTagName(branch: string | null | undefined): string | null {
  const normalized = branch?.trim();
  return normalized ? `branch:${normalized}` : null;
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
