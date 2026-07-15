import { createRequire } from "node:module";
import * as fs from "node:fs";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import {
  skillUsageSnapshotFromEvents,
  type SkillUsageEvent,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "./skill-usage";
import { truncateTraceDetail } from "./trace-detail";
import { migrationTargetDescriptor } from "./migration-targets";
import type {
  EnvironmentKind,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  IndexedSession,
  ProjectQueryOptions,
  ProjectSummary,
  SearchOptions,
  SessionMigrationRecord,
  SessionEnvironment,
  SessionMessage,
  SessionMessageEvent,
  SessionMatchHit,
  SessionSearchPage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionStatsPeriod,
  SessionStatsSummary,
  SessionSortBy,
  SessionSource,
  ProjectTagEntry,
  TagListOptions,
  SessionTraceEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type Db = DatabaseSyncType;
type ApiProviderKeyTarget = "codex" | "claude" | "summary";

const LIVE_SESSION_KEY_SQL = `
  CASE
    WHEN source IN ('claude-cli', 'claude-app', 'claude-internal') THEN 'claude:' || raw_id
    WHEN source IN ('codex-cli', 'codex-app', 'codex-internal') THEN 'codex:' || raw_id
    WHEN source = 'tclaude-cli' THEN 'tclaude:' || raw_id
    WHEN source = 'tcodex-cli' THEN 'tcodex:' || raw_id
    WHEN source = 'codebuddy-cli' THEN 'codebuddy:' || raw_id
    WHEN source = 'codewiz-cli' THEN 'codewiz:' || raw_id
    WHEN source = 'trae' THEN 'trae:' || raw_id
    ELSE NULL
  END
`;

interface StatsRange {
  period: SessionStatsPeriod;
  since: number | null;
  until: number;
}

interface SessionRow {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  project_path: string;
  file_path: string;
  original_title: string;
  first_question: string;
  timestamp: number;
  file_mtime_ms: number;
  file_size: number;
  indexed_at: number;
  pr_url: string | null;
  pr_number: number | null;
  custom_title: string | null;
  favorited: 0 | 1;
  pinned: 0 | 1;
  hidden: 0 | 1;
  last_opened_at: number | null;
  last_resumed_at: number | null;
  last_activity_at: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  ai_summary: string | null;
  ai_summary_model: string | null;
  ai_summary_at: number | null;
  ai_summary_basis: number | null;
  is_subagent: 0 | 1;
  parent_session_id: string | null;
}

interface EnvironmentRow {
  id: string;
  kind: EnvironmentKind;
  label: string;
  host_alias: string | null;
  host: string | null;
  user: string | null;
  port: number | null;
  auth_mode: SessionEnvironment["authMode"];
  identity_file: string | null;
  enabled: 0 | 1;
  sync_state: EnvironmentSyncState;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
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

export type SkillSyncDirection = "upload" | "download";

export interface SkillSyncBinding {
  localSkillPath: string;
  remoteSkillId: string;
  remoteUpdatedAt: string;
  remoteVersion: number;
  lastSyncedAt: number;
  direction: SkillSyncDirection;
}

export interface TraceEventQueryOptions {
  startTimestamp?: string;
  endTimestamp?: string;
  limit?: number;
}

interface SkillSyncBindingRow {
  local_skill_path: string;
  remote_skill_id: string;
  remote_updated_at: string;
  remote_version: number;
  last_synced_at: number;
  direction: SkillSyncDirection;
}

interface SessionMigrationRow {
  id: string;
  source_session_key: string;
  source_agent: SessionMigrationRecord["sourceAgent"];
  target_agent: string;
  target_session_id: string;
  target_file_path: string;
  strategy: SessionMigrationRecord["strategy"];
  created_at: number;
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
    const indexedAt = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO sessions (
            session_key, raw_id, source, environment_id, project_path, file_path, original_title, first_question,
            timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count,
            input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            is_subagent, parent_session_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
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
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id
        `,
        )
        .run(
          session.sessionKey,
          session.rawId,
          session.source,
          session.environmentId ?? "local",
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
          indexedAt,
          session.isSubagent ? 1 : 0,
          session.parentSessionId ?? null,
        );

      this.db.prepare("DELETE FROM messages WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM message_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM token_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM trace_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(session.sessionKey);

      const insertMessage = this.db.prepare(
        "INSERT INTO messages (session_key, message_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      );
      for (const message of messages) {
        insertMessage.run(session.sessionKey, message.index, message.role, message.content, message.timestamp);
      }

      const insertMessageEvent = this.db.prepare(
        "INSERT INTO message_events (session_key, message_index, timestamp) VALUES (?, ?, ?)",
      );
      for (const message of messages) {
        const timestamp = Date.parse(message.timestamp);
        insertMessageEvent.run(
          session.sessionKey,
          message.index,
          Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0,
        );
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

  isIndexedSessionFresh(session: IndexedSession): boolean {
    if (session.fileMtimeMs <= 0 && session.fileSize <= 0) return false;
    const row = this.db
      .prepare(
        `
        SELECT raw_id, source, environment_id, project_path, file_path, original_title, first_question,
          timestamp, file_mtime_ms, file_size, pr_url, pr_number, is_subagent, parent_session_id
        FROM sessions
        WHERE session_key = ?
      `,
      )
      .get(session.sessionKey) as
      | Pick<
        SessionRow,
        | "raw_id"
        | "source"
        | "environment_id"
        | "project_path"
        | "file_path"
        | "original_title"
        | "first_question"
        | "timestamp"
        | "file_mtime_ms"
        | "file_size"
        | "pr_url"
        | "pr_number"
        | "is_subagent"
        | "parent_session_id"
      >
      | undefined;
    if (!row) return false;
    return (
      row.raw_id === session.rawId &&
      row.source === session.source &&
      row.environment_id === (session.environmentId ?? "local") &&
      row.project_path === session.projectPath &&
      row.file_path === session.filePath &&
      row.original_title === session.originalTitle &&
      row.first_question === session.firstQuestion &&
      row.timestamp === session.timestamp &&
      Math.abs(row.file_mtime_ms - session.fileMtimeMs) < 0.001 &&
      row.file_size === session.fileSize &&
      (row.pr_url ?? null) === (session.prUrl ?? null) &&
      (row.pr_number ?? null) === (session.prNumber ?? null)
      && row.is_subagent === (session.isSubagent ? 1 : 0)
      && (row.parent_session_id ?? null) === (session.parentSessionId ?? null)
    );
  }

  touchIndexedAtIfMissing(sessionKey: string): void {
    this.db.prepare("UPDATE sessions SET indexed_at = ? WHERE session_key = ? AND indexed_at <= 0").run(Date.now(), sessionKey);
  }

  listIndexedSessionFiles(environmentId = "local"): Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }> {
    return this.db
      .prepare(
        `
        SELECT file_path AS filePath, file_mtime_ms AS fileMtimeMs, file_size AS fileSize, indexed_at AS indexedAt
        FROM sessions
        WHERE environment_id = ?
          AND file_path != ''
          AND file_mtime_ms > 0
      `,
      )
      .all(environmentId) as Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>;
  }

  upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: TokenUsageEvent[],
    messageEvents?: SessionMessageEvent[],
  ): void {
    const normalizedTokenEvents = tokenEvents?.map(normalizeTokenEvent).filter((event) => event.totalTokens > 0 && event.dedupeKey);
    const tokenUsage = normalizedTokenEvents === undefined ? normalizeTokenUsage(session.tokenUsage) : tokenUsageFromEvents(normalizedTokenEvents);
    const indexedAt = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO sessions (
            session_key, raw_id, source, environment_id, project_path, file_path, original_title, first_question,
            timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count,
            input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
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
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at
        `,
        )
        .run(
          session.sessionKey,
          session.rawId,
          session.source,
          session.environmentId ?? "local",
          session.projectPath,
          session.filePath,
          session.originalTitle,
          session.firstQuestion,
          session.timestamp,
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          Math.max(0, Math.floor(messageCount)),
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          indexedAt,
        );

      if (normalizedTokenEvents !== undefined) {
        this.db.prepare("DELETE FROM token_events WHERE session_key = ?").run(session.sessionKey);
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
      }

      if (messageEvents !== undefined) {
        this.db.prepare("DELETE FROM message_events WHERE session_key = ?").run(session.sessionKey);
        const insertMessageEvent = this.db.prepare(
          "INSERT INTO message_events (session_key, message_index, timestamp) VALUES (?, ?, ?)",
        );
        for (const event of messageEvents) {
          insertMessageEvent.run(session.sessionKey, event.index, event.timestamp);
        }
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

  deleteSession(sessionKey: string): boolean {
    let deleted = false;
    this.transaction(() => {
      const row = this.db.prepare("SELECT source, file_path FROM sessions WHERE session_key = ?").get(sessionKey) as
        | { source: SessionSource; file_path: string }
        | undefined;
      if (!row) return;
      if (row.source === "hermes") throw new Error("Cannot delete shared Hermes source database.");
      if (row.source === "opencode-cli") throw new Error("Cannot delete shared OpenCode source database.");
      this.deleteSessionSourceFile(row.file_path);
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
      this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
      this.deleteUnusedTags();
      deleted = true;
    });
    return deleted;
  }

  deleteSessionRecord(sessionKey: string): boolean {
    let deleted = false;
    this.transaction(() => {
      const row = this.db.prepare("SELECT session_key FROM sessions WHERE session_key = ?").get(sessionKey);
      if (!row) return;
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
      this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
      this.deleteUnusedTags();
      deleted = true;
    });
    return deleted;
  }

  listSessionKeysByFilePath(environmentId: string, filePaths: ReadonlySet<string>): string[] {
    const rows = this.db
      .prepare("SELECT session_key, file_path FROM sessions WHERE environment_id = ? AND file_path != ''")
      .all(environmentId) as Array<{ session_key: string; file_path: string }>;
    return rows.filter((row) => !filePaths.has(row.file_path)).map((row) => row.session_key);
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

  listTags(options: TagListOptions = {}): string[] {
    const conditions: string[] = [];
    const args: SQLInputValue[] = [];
    if (options.environmentId && options.environmentId !== "all") {
      conditions.push("sessions.environment_id = ?");
      args.push(options.environmentId);
    }
    if (options.projectPath) {
      conditions.push("sessions.project_path = ?");
      args.push(options.projectPath);
    }
    if (options.excludeSubagents) {
      conditions.push("sessions.is_subagent = 0");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT tags.name AS name
        FROM tags
        INNER JOIN session_tags ON session_tags.tag_id = tags.id
        INNER JOIN sessions ON sessions.session_key = session_tags.session_key
        ${where}
        ORDER BY lower(tags.name)
      `,
      )
      .all(...args) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  listTagsByProject(options: { excludeSubagents?: boolean } = {}): ProjectTagEntry[] {
    const subagentPredicate = options.excludeSubagents ? "AND sessions.is_subagent = 0" : "";
    const rows = this.db
      .prepare(
        `
        SELECT
          sessions.environment_id AS environment_id,
          sessions.project_path AS project_path,
          tags.name AS tag_name
        FROM tags
        INNER JOIN session_tags ON session_tags.tag_id = tags.id
        INNER JOIN sessions ON sessions.session_key = session_tags.session_key
        WHERE trim(sessions.project_path) != ''
          ${subagentPredicate}
        ORDER BY sessions.environment_id, sessions.project_path, lower(tags.name)
      `,
      )
      .all() as Array<{ environment_id: string; project_path: string; tag_name: string }>;
    const map = new Map<string, ProjectTagEntry>();
    for (const row of rows) {
      const key = `${row.environment_id}\0${row.project_path}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { environmentId: row.environment_id, projectPath: row.project_path, tags: [] };
        map.set(key, entry);
      }
      if (!entry.tags.includes(row.tag_name)) {
        entry.tags.push(row.tag_name);
      }
    }
    return [...map.values()];
  }

  listEnvironments(): SessionEnvironment[] {
    return (this.db.prepare("SELECT * FROM environments ORDER BY kind, lower(label), id").all() as unknown as EnvironmentRow[]).map(
      hydrateEnvironmentRow,
    );
  }

  upsertEnvironment(input: EnvironmentUpsertInput): SessionEnvironment {
    const now = Date.now();
    const id = input.id ?? this.findEnvironmentIdByHostAlias(input) ?? this.createUniqueEnvironmentId(input.label);
    const existing = this.getEnvironment(id);
    if (input.id === "local") {
      const current = existing ?? localEnvironment();
      const environment = {
        ...localEnvironment(),
        syncState: current.syncState,
        lastSyncedAt: current.lastSyncedAt,
        lastError: current.lastError,
        createdAt: current.createdAt,
        updatedAt: now,
      };
      this.writeEnvironment(environment);
      return environment;
    }
    const environment: SessionEnvironment = {
      id,
      kind: input.kind,
      label: input.label,
      hostAlias: input.hostAlias ?? null,
      host: input.host ?? null,
      user: input.user ?? null,
      port: input.port ?? null,
      authMode: input.authMode ?? "none",
      identityFile: input.identityFile ?? null,
      enabled: input.enabled ?? true,
      syncState: existing?.syncState ?? "idle",
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeEnvironment(environment);
    return environment;
  }

  private findEnvironmentIdByHostAlias(input: EnvironmentUpsertInput): string | null {
    if (input.kind !== "ssh" || !input.hostAlias) return null;
    const row = this.db.prepare("SELECT id FROM environments WHERE kind = 'ssh' AND host_alias = ? ORDER BY created_at, id LIMIT 1").get(
      input.hostAlias,
    ) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private createUniqueEnvironmentId(label: string): string {
    const base = generatedEnvironmentIdBase(label);
    let candidate = base;
    let suffix = 2;
    while (this.getEnvironment(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private writeEnvironment(environment: SessionEnvironment): void {
    this.db
      .prepare(
        `
        INSERT INTO environments (
          id, kind, label, host_alias, host, user, port, auth_mode, identity_file,
          enabled, sync_state, last_synced_at, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          host_alias = excluded.host_alias,
          host = excluded.host,
          user = excluded.user,
          port = excluded.port,
          auth_mode = excluded.auth_mode,
          identity_file = excluded.identity_file,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        environment.id,
        environment.kind,
        environment.label,
        environment.hostAlias,
        environment.host,
        environment.user,
        environment.port,
        environment.authMode,
        environment.identityFile,
        environment.enabled ? 1 : 0,
        environment.syncState,
        environment.lastSyncedAt,
        environment.lastError,
        environment.createdAt,
        environment.updatedAt,
      );
  }

  getEnvironment(id: string): SessionEnvironment | null {
    const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as EnvironmentRow | undefined;
    return row ? hydrateEnvironmentRow(row) : null;
  }

  updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): void {
    const existing = this.getEnvironment(id);
    const hasLastSyncedAt = Object.prototype.hasOwnProperty.call(options, "lastSyncedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(options, "lastError");
    const lastSyncedAt = hasLastSyncedAt ? (options.lastSyncedAt ?? null) : existing?.lastSyncedAt ?? null;
    const lastError = hasLastError ? (options.lastError ?? null) : existing?.lastError ?? null;
    this.db
      .prepare(
        `
        UPDATE environments
        SET sync_state = ?,
          last_synced_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `,
      )
      .run(state, lastSyncedAt, lastError, Date.now(), id);
  }

  listProjects(options: ProjectQueryOptions = {}): ProjectSummary[] {
    const subagentPredicate = options.excludeSubagents ? "AND sessions.is_subagent = 0" : "";
    const environmentPredicate =
      options.environmentId && options.environmentId !== "all" ? "AND sessions.environment_id = ?" : "";
    const environmentArgs =
      options.environmentId && options.environmentId !== "all" ? [options.environmentId] : [];
    const rows = this.db
      .prepare(
        `
        SELECT
          sessions.project_path,
          sessions.environment_id,
          environments.label AS environment_label,
          COUNT(*) AS session_count,
          MAX(COALESCE(sessions.timestamp, 0)) AS created_at,
          MAX(${sessionActivitySql("sessions")}) AS last_activity_at
        FROM sessions
        LEFT JOIN environments ON environments.id = sessions.environment_id
        WHERE trim(project_path) != ''
          ${subagentPredicate}
          ${environmentPredicate}
        GROUP BY sessions.project_path, sessions.environment_id
      `,
      )
      .all(...environmentArgs) as Array<{
        project_path: string;
        environment_id: string;
        environment_label: string | null;
        session_count: number;
        created_at: number;
        last_activity_at: number;
      }>;
    const summaries = rows.map((row) => ({
      path: row.project_path,
      label: projectLabel(row.project_path),
      sessionCount: row.session_count,
      environmentId: row.environment_id,
      environmentLabel: row.environment_label ?? localEnvironment().label,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    }));
    const basenameCounts = new Map<string, number>();
    const environmentsByPath = new Map<string, Set<string>>();
    for (const summary of summaries) {
      const basename = projectBasename(summary.path);
      basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
      const environmentIds = environmentsByPath.get(summary.path) ?? new Set<string>();
      environmentIds.add(summary.environmentId);
      environmentsByPath.set(summary.path, environmentIds);
    }

    return summaries
      .map((summary) => ({
        ...summary,
        label:
          (environmentsByPath.get(summary.path)?.size ?? 0) > 1
            ? `${summary.label} · ${summary.environmentLabel}`
            : (basenameCounts.get(projectBasename(summary.path)) || 0) > 1
              ? projectParentLabel(summary.path)
              : summary.label,
      }))
      .sort(
        (a, b) =>
          environmentSortValue(a.environmentId) - environmentSortValue(b.environmentId) ||
          b.lastActivityAt - a.lastActivityAt ||
          a.label.localeCompare(b.label),
      );
  }

  getSession(sessionKey: string): SessionSearchResult | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | undefined;
    return row ? this.hydrateRow(row, null) : null;
  }

  findByRawId(rawId: string): SessionSearchResult | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE raw_id = ? ORDER BY file_mtime_ms DESC LIMIT 1")
      .get(rawId) as SessionRow | undefined;
    return row ? this.hydrateRow(row, null) : null;
  }

  setAiSummary(sessionKey: string, summary: string, model: string): boolean {
    const row = this.db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = ?").get(sessionKey) as
      | { file_mtime_ms: number }
      | undefined;
    if (!row) return false;
    this.db
      .prepare(
        "UPDATE sessions SET ai_summary = ?, ai_summary_model = ?, ai_summary_at = ?, ai_summary_basis = ? WHERE session_key = ?",
      )
      .run(summary.trim(), model.trim(), Date.now(), row.file_mtime_ms, sessionKey);
    this.refreshFtsForSession(sessionKey);
    return true;
  }

  // Sessions eligible for batch/auto summary: recently active and missing or stale.
  // Mirrors needsBackfill in session-summarizer (file_mtime_ms is the freshness signal).
  listSessionsNeedingSummary(now: number, maxAgeMs: number, limit: number): SessionSearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE file_mtime_ms >= ?
           AND (ai_summary IS NULL OR file_mtime_ms > COALESCE(ai_summary_basis, 0))
         ORDER BY file_mtime_ms DESC
         LIMIT ?`,
      )
      .all(now - maxAgeMs, limit) as unknown as SessionRow[];
    return rows.map((row) => this.hydrateRow(row, null));
  }

  getMessageCount(sessionKey: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?").get(sessionKey) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
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

  getTraceEvents(sessionKey: string, options: TraceEventQueryOptions = {}): SessionTraceEvent[] {
    const where = ["session_key = ?"];
    const params: Array<string | number> = [sessionKey];
    if (options.startTimestamp) {
      where.push("timestamp >= ?");
      params.push(options.startTimestamp);
    }
    if (options.endTimestamp) {
      where.push("timestamp <= ?");
      params.push(options.endTimestamp);
    }
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit ?? 0)) : 0;
    if (limit > 0) params.push(limit);
    return (
      this.db
        .prepare(
          `
          SELECT trace_index, kind, source, title, detail, timestamp, call_id, event_type, status
          FROM trace_events
          WHERE ${where.join(" AND ")}
          ORDER BY trace_index
          ${limit > 0 ? "LIMIT ?" : ""}
        `,
        )
        .all(...params) as unknown as TraceEventRow[]
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

  upsertSkillSyncBinding(binding: SkillSyncBinding): void {
    const localSkillPath = binding.localSkillPath.trim();
    const remoteSkillId = binding.remoteSkillId.trim();
    if (!localSkillPath || !remoteSkillId) return;
    // A remote skill maps to exactly one local path. Two local skills that share an agent+name
    // resolve to the same remote fingerprint/id, so re-binding must move the remote pointer to the
    // latest local path rather than violating the UNIQUE(remote_skill_id) constraint.
    this.transaction(() => {
      this.db
        .prepare(`DELETE FROM skill_sync_bindings WHERE remote_skill_id = ? AND local_skill_path <> ?`)
        .run(remoteSkillId, localSkillPath);
      this.db
        .prepare(
          `
        INSERT INTO skill_sync_bindings (local_skill_path, remote_skill_id, remote_updated_at, remote_version, last_synced_at, direction)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_skill_path) DO UPDATE SET
          remote_skill_id = excluded.remote_skill_id,
          remote_updated_at = excluded.remote_updated_at,
          remote_version = excluded.remote_version,
          last_synced_at = excluded.last_synced_at,
          direction = excluded.direction
      `,
        )
        .run(
          localSkillPath,
          remoteSkillId,
          binding.remoteUpdatedAt,
          nonNegativeNumber(binding.remoteVersion) || 1,
          binding.lastSyncedAt,
          binding.direction,
        );
    });
  }

  getSkillSyncBindingForLocalPath(localSkillPath: string): SkillSyncBinding | null {
    const row = this.db
      .prepare(
        `
        SELECT local_skill_path, remote_skill_id, remote_updated_at, remote_version, last_synced_at, direction
        FROM skill_sync_bindings
        WHERE local_skill_path = ?
      `,
      )
      .get(localSkillPath) as SkillSyncBindingRow | undefined;
    return row ? skillSyncBindingFromRow(row) : null;
  }

  getSkillSyncBindingForRemoteId(remoteSkillId: string): SkillSyncBinding | null {
    const row = this.db
      .prepare(
        `
        SELECT local_skill_path, remote_skill_id, remote_updated_at, remote_version, last_synced_at, direction
        FROM skill_sync_bindings
        WHERE remote_skill_id = ?
      `,
      )
      .get(remoteSkillId) as SkillSyncBindingRow | undefined;
    return row ? skillSyncBindingFromRow(row) : null;
  }

  listSkillSyncBindings(): SkillSyncBinding[] {
    const rows = this.db
      .prepare(
        `
        SELECT local_skill_path, remote_skill_id, remote_updated_at, remote_version, last_synced_at, direction
        FROM skill_sync_bindings
        ORDER BY last_synced_at DESC, local_skill_path
      `,
      )
      .all() as unknown as SkillSyncBindingRow[];
    return rows.map(skillSyncBindingFromRow);
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

  recordSessionMigration(record: SessionMigrationRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO session_migrations (
          id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.sourceSessionKey,
        record.sourceAgent,
        record.targetAgent,
        record.targetSessionId,
        record.targetFilePath,
        record.strategy,
        record.createdAt,
      );
  }

  listSessionMigrations(sourceSessionKey: string): SessionMigrationRecord[] {
    return (
      this.db
        .prepare(
          `
          SELECT id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
          FROM session_migrations
          WHERE source_session_key = ?
          ORDER BY created_at DESC, id DESC
        `,
        )
        .all(sourceSessionKey) as unknown as SessionMigrationRow[]
    ).map((row) => ({
      id: row.id,
      sourceSessionKey: row.source_session_key,
      sourceAgent: row.source_agent,
      targetAgent: migrationTargetDescriptor(row.target_agent).id,
      targetSessionId: row.target_session_id,
      targetFilePath: row.target_file_path,
      strategy: row.strategy,
      createdAt: row.created_at,
    }));
  }

  getStats(options: SessionStatsOptions = {}, now = Date.now()): SessionStats {
    const range = resolveStatsRange(options, now);
    const summariesBySource = new Map<SessionSource, SessionStatsSummary>();

    for (const row of this.aggregateActiveSessionsBySource(range, options.excludeSubagents ?? false)) {
      summaryForSource(summariesBySource, row.source).sessionCount = row.session_count;
    }
    for (const row of this.aggregateMessagesBySource(range, options.excludeSubagents ?? false)) {
      summaryForSource(summariesBySource, row.source).messageCount = row.message_count;
    }

    const tokenRows = this.aggregateTokenEventsBySource(range, options.excludeSubagents ?? false);
    const tokenSourceRows =
      range.since === null && tokenRows.length === 0
        ? this.aggregateSessionTokensBySource(options.excludeSubagents ?? false)
        : tokenRows;
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
    return this.searchSessionPage(options).sessions;
  }

  searchSessionPage(options: SearchOptions = {}): SessionSearchPage {
    const limit = options.limit ?? 200;
    const query = normalizeExplicitAnd(options.query?.trim() || "");
    const ftsMatches = query ? this.searchFts(query) : new Map<string, string | null>();
    const rows = this.getCandidateRows(options, query, limit);
    const tagsBySession = this.getTagsForSessions(rows.map((row) => row.session_key));
    const merged = new Map<string, SessionSearchResult>();

    for (const row of rows) {
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

    const sorted = [...merged.values()].sort(
      (a, b) => this.score(b, query) - this.score(a, query) || this.sortValue(b, options.sortBy) - this.sortValue(a, options.sortBy),
    );
    const totalCount = query ? sorted.length : this.countCandidateRows(options);
    const sessions = sorted.slice(0, limit);
    if (query) this.attachSearchMatchDetails(sessions, query);
    return {
      sessions,
      totalCount,
      hasMore: totalCount > sessions.length,
    };
  }

  clearSearchIndex(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM message_events").run();
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

  deleteEnvironment(environmentId: string): void {
    if (environmentId === "local") throw new Error("Local environment cannot be deleted.");
    this.transaction(() => {
      this.deleteEnvironmentSessionsInTransaction(environmentId);
      this.db.prepare("DELETE FROM environments WHERE id = ?").run(environmentId);
      this.deleteUnusedTags();
    });
  }

  deleteEnvironmentSessions(environmentId: string): void {
    this.transaction(() => {
      this.deleteEnvironmentSessionsInTransaction(environmentId);
      this.deleteUnusedTags();
    });
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    // WAL lets a read-only consumer (the MCP server) read concurrently while the app writes.
    // Harmless for the in-memory test DB, which ignores the journal mode.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Some environments (e.g. in-memory) reject WAL; fall back to the default journal.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        raw_id TEXT NOT NULL,
        source TEXT NOT NULL,
        environment_id TEXT NOT NULL DEFAULT 'local',
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
        total_tokens INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL DEFAULT 0,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        host_alias TEXT,
        host TEXT,
        user TEXT,
        port INTEGER,
        auth_mode TEXT NOT NULL,
        identity_file TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sync_state TEXT NOT NULL DEFAULT 'idle',
        last_synced_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
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

      CREATE TABLE IF NOT EXISTS message_events (
        session_key TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
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

      CREATE TABLE IF NOT EXISTS skill_sync_bindings (
        local_skill_path TEXT PRIMARY KEY,
        remote_skill_id TEXT NOT NULL UNIQUE,
        remote_updated_at TEXT NOT NULL,
        remote_version INTEGER NOT NULL DEFAULT 1,
        last_synced_at INTEGER NOT NULL,
        direction TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_provider_keys (
        target TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (target, provider_id)
      );

      CREATE TABLE IF NOT EXISTS session_migrations (
        id TEXT PRIMARY KEY,
        source_session_key TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        target_file_path TEXT NOT NULL,
        strategy TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_key UNINDEXED,
        title,
        first_question,
        content_text,
        project_path,
        tokenize = 'trigram'
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
      CREATE INDEX IF NOT EXISTS idx_message_events_timestamp
        ON message_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_token_events_dedupe
        ON token_events(dedupe_key, total_tokens, timestamp);
      CREATE INDEX IF NOT EXISTS idx_trace_events_session
        ON trace_events(session_key, trace_index);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_agent_skill
        ON skill_usage_events(agent, skill);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_timestamp
        ON skill_usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_skill_sync_bindings_remote_id
        ON skill_sync_bindings(remote_skill_id);
      CREATE INDEX IF NOT EXISTS idx_session_migrations_source_session_key_created_at_id
        ON session_migrations(source_session_key, created_at DESC, id DESC);
    `);
    this.addColumnIfMissing("sessions", "favorited", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "environment_id", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("sessions", "ai_summary", "TEXT");
    this.addColumnIfMissing("sessions", "ai_summary_model", "TEXT");
    this.addColumnIfMissing("sessions", "ai_summary_at", "INTEGER");
    this.addColumnIfMissing("sessions", "ai_summary_basis", "INTEGER");
    this.addColumnIfMissing("sessions", "indexed_at", "INTEGER NOT NULL DEFAULT 0");
    const addedSubagentColumn = this.addColumnIfMissing("sessions", "is_subagent", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "parent_session_id", "TEXT");
    if (addedSubagentColumn) {
      this.db
        .prepare(
          "UPDATE sessions SET file_mtime_ms = 0 WHERE source IN ('claude-cli', 'claude-app', 'claude-internal', 'tclaude-cli', 'codex-cli', 'codex-app', 'codex-internal', 'tcodex-cli')",
        )
        .run();
    }
    this.addColumnIfMissing("skill_sync_bindings", "remote_version", "INTEGER NOT NULL DEFAULT 1");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_environment
        ON sessions(environment_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_environment_source
        ON sessions(environment_id, source);
      DROP INDEX IF EXISTS idx_session_migrations_source_session_key;
      DROP INDEX IF EXISTS idx_session_migrations_created_at_desc;
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO message_events (session_key, message_index, timestamp)
      SELECT
        session_key,
        message_index,
        COALESCE(CAST(strftime('%s', timestamp) AS INTEGER) * 1000, 0)
      FROM messages;
    `);
    this.upgradeFtsTokenizer();
    this.ensureLocalEnvironment();
  }

  private upgradeFtsTokenizer(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_fts'").get() as { sql: string } | undefined;
    if (!row?.sql || !row.sql.includes("unicode61")) return;
    this.db.exec("DROP TABLE IF EXISTS session_fts");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_key UNINDEXED,
        title,
        first_question,
        content_text,
        project_path,
        tokenize = 'trigram'
      );
    `);
    const sessionKeys = this.db.prepare("SELECT session_key FROM sessions").all() as Array<{ session_key: string }>;
    for (const { session_key } of sessionKeys) {
      this.refreshFtsForSession(session_key);
    }
  }

  private addColumnIfMissing(tableName: string, columnName: string, definition: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      return true;
    }
    return false;
  }

  private ensureLocalEnvironment(): void {
    this.upsertEnvironment(localEnvironment());
  }

  private deleteEnvironmentSessionsInTransaction(environmentId: string): void {
    this.db
      .prepare("DELETE FROM session_fts WHERE session_key IN (SELECT session_key FROM sessions WHERE environment_id = ?)")
      .run(environmentId);
    this.db.prepare("DELETE FROM sessions WHERE environment_id = ?").run(environmentId);
  }

  private refreshFtsForSession(sessionKey: string): void {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as SessionRow | undefined;
    if (!row) return;
    const contentText = (this.db.prepare("SELECT content FROM messages WHERE session_key = ? ORDER BY message_index").all(
      sessionKey,
    ) as Array<{ content: string }>)
      .map((message) => message.content)
      .join("\n\n");
    const title = row.custom_title || row.original_title || row.first_question || "Untitled Session";
    // Prepend the AI summary so its normalized wording is searchable alongside the raw transcript.
    const summary = row.ai_summary?.trim();
    const ftsContent = summary ? `${summary}\n\n${contentText}` : contentText;
    this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
    this.db
      .prepare(
        "INSERT INTO session_fts (session_key, title, first_question, content_text, project_path) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionKey, title, row.first_question, ftsContent, row.project_path);
  }

  private deleteSessionSourceFile(filePath: string): void {
    const normalized = filePath.trim();
    if (!normalized) throw new Error("Session source file path is missing.");
    try {
      const stat = fs.lstatSync(normalized);
      if (stat.isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    fs.rmSync(normalized, { force: true });
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

  private aggregateActiveSessionsBySource(range: StatsRange, excludeSubagents: boolean): Array<{ source: SessionSource; session_count: number }> {
    const subagentWhere = excludeSubagents ? "WHERE is_subagent = 0" : "";
    const subagentAnd = excludeSubagents ? "AND sessions.is_subagent = 0" : "";
    if (range.since === null) {
      return this.db
        .prepare(
          `
          SELECT source, COUNT(*) AS session_count
          FROM sessions
          ${subagentWhere}
          GROUP BY source
          ORDER BY source
        `,
        )
        .all() as Array<{ source: SessionSource; session_count: number }>;
    }

    return this.db
      .prepare(
        `
        WITH active AS (
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN message_events ON message_events.session_key = sessions.session_key
          WHERE message_events.timestamp >= ? AND message_events.timestamp <= ? ${subagentAnd}
          UNION
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN token_events ON token_events.session_key = sessions.session_key
          WHERE token_events.timestamp >= ? AND token_events.timestamp <= ? ${subagentAnd}
        )
        SELECT source, COUNT(DISTINCT session_key) AS session_count
        FROM active
        GROUP BY source
        ORDER BY source
      `,
      )
      .all(range.since, range.until, range.since, range.until) as Array<{ source: SessionSource; session_count: number }>;
  }

  private aggregateMessagesBySource(range: StatsRange, excludeSubagents: boolean): Array<{ source: SessionSource; message_count: number }> {
    const subagentWhere = excludeSubagents ? "WHERE is_subagent = 0" : "";
    const subagentAnd = excludeSubagents ? "AND sessions.is_subagent = 0" : "";
    if (range.since === null) {
      return this.db
        .prepare(
          `
          SELECT source, COALESCE(SUM(message_count), 0) AS message_count
          FROM sessions
          ${subagentWhere}
          GROUP BY source
          ORDER BY source
        `,
        )
        .all() as Array<{ source: SessionSource; message_count: number }>;
    }

    return this.db
      .prepare(
        `
        SELECT sessions.source AS source, COUNT(*) AS message_count
        FROM message_events
        JOIN sessions ON sessions.session_key = message_events.session_key
        WHERE message_events.timestamp >= ? AND message_events.timestamp <= ? ${subagentAnd}
        GROUP BY sessions.source
        ORDER BY sessions.source
      `,
      )
      .all(range.since, range.until) as Array<{ source: SessionSource; message_count: number }>;
  }

  private aggregateTokenEventsBySource(range: StatsRange, excludeSubagents: boolean): Array<{
    source: SessionSource;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  }> {
    const conditions: string[] = [];
    if (range.since !== null) conditions.push("token_events.timestamp >= ? AND token_events.timestamp <= ?");
    if (excludeSubagents) conditions.push("sessions.is_subagent = 0");
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
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

  private aggregateSessionTokensBySource(excludeSubagents: boolean): Array<{
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
        ${excludeSubagents ? "WHERE is_subagent = 0" : ""}
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

  private getCandidateRows(options: SearchOptions, query: string, limit: number): SessionRow[] {
    const { where, args } = this.sessionWhereClause(options);

    if (!query) {
      args.push(limit);
      return this.db
        .prepare(
          `
          SELECT sessions.*, ${sessionActivitySql("sessions")} AS last_activity_at
          FROM sessions
          WHERE ${where.join(" AND ")}
          ORDER BY pinned DESC, ${sessionSortSql(options.sortBy)} DESC
          LIMIT ?
        `,
        )
        .all(...args) as unknown as SessionRow[];
    }

    return this.db
      .prepare(`SELECT sessions.*, ${sessionActivitySql("sessions")} AS last_activity_at FROM sessions WHERE ${where.join(" AND ")}`)
      .all(...args) as unknown as SessionRow[];
  }

  private countCandidateRows(options: SearchOptions): number {
    const { where, args } = this.sessionWhereClause(options);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${where.join(" AND ")}`).get(...args) as { count: number };
    return row.count;
  }

  private sessionWhereClause(options: SearchOptions): { where: string[]; args: SQLInputValue[] } {
    const where: string[] = [];
    const args: SQLInputValue[] = [];

    if (options.visibility === "hidden") where.push("hidden = 1");
    else if (options.visibility === "favorites") where.push("hidden = 0 AND favorited = 1");
    else if (options.visibility === "pinned") where.push("hidden = 0 AND pinned = 1");
    else where.push("hidden = 0");

    if (options.excludeSubagents) where.push("is_subagent = 0");

    if (options.projectPath) {
      where.push("project_path = ?");
      args.push(options.projectPath);
    }

    if (options.environmentId && options.environmentId !== "all") {
      where.push("environment_id = ?");
      args.push(options.environmentId);
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

    if (options.liveStatus) {
      const liveSessionKeys = [...new Set(options.liveSessionKeys ?? [])].filter(Boolean);
      if (options.liveStatus === "open") {
        if (liveSessionKeys.length === 0) {
          where.push("0 = 1");
        } else {
          where.push(`${LIVE_SESSION_KEY_SQL} IN (${liveSessionKeys.map(() => "?").join(", ")})`);
          args.push(...liveSessionKeys);
        }
      } else if (liveSessionKeys.length > 0) {
        where.push(`(${LIVE_SESSION_KEY_SQL} IS NULL OR ${LIVE_SESSION_KEY_SQL} NOT IN (${liveSessionKeys.map(() => "?").join(", ")}))`);
        args.push(...liveSessionKeys);
      }
    }

    if (Number.isFinite(options.dateFrom)) {
      where.push(`${sessionActivitySql("sessions")} >= ?`);
      args.push(options.dateFrom as number);
    }
    if (Number.isFinite(options.dateTo)) {
      where.push(`${sessionActivitySql("sessions")} <= ?`);
      args.push(options.dateTo as number);
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

    return { where, args };
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
          SELECT session_key
          FROM session_fts
          WHERE session_fts MATCH ?
        `,
        )
        .all(expression) as Array<{ session_key: string }>;
      return new Map(rows.map((row) => [row.session_key, null]));
    } catch {
      return new Map();
    }
  }

  private attachSearchMatchDetails(sessions: SessionSearchResult[], query: string): void {
    const terms = searchTerms(query);
    if (sessions.length === 0 || terms.length === 0) return;
    for (const session of sessions) {
      session.matchHits = [];
      session.messageMatchCount = 0;
      session.metadataMatch = null;
    }

    try {
      const sessionKeys = sessions.map((session) => session.sessionKey);
      const keyPlaceholders = sessionKeys.map(() => "?").join(", ");
      const termPredicates = terms.map(() => "lower(messages.content) LIKE ? ESCAPE '\\'").join(" OR ");
      const rows = this.db
        .prepare(
          `
          WITH matching AS (
            SELECT session_key, message_index, role, content, timestamp
            FROM messages
            WHERE session_key IN (${keyPlaceholders})
              AND (${termPredicates})
          ), ranked AS (
            SELECT *,
              COUNT(*) OVER (PARTITION BY session_key) AS match_count,
              ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY message_index) AS match_rank
            FROM matching
          )
          SELECT session_key, message_index, role, content, timestamp, match_count
          FROM ranked
          WHERE match_rank <= 2
          ORDER BY session_key, message_index
        `,
        )
        .all(...sessionKeys, ...terms.map((term) => `%${escapeLike(term)}%`)) as Array<{
        session_key: string;
        message_index: number;
        role: SessionMessage["role"];
        content: string;
        timestamp: string;
        match_count: number;
      }>;
      const sessionsByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
      for (const row of rows) {
        const session = sessionsByKey.get(row.session_key);
        if (!session) continue;
        const matchedTerms = terms.filter((term) => row.content.toLocaleLowerCase().includes(term));
        const hit: SessionMatchHit = {
          messageIndex: row.message_index,
          role: row.role,
          timestamp: row.timestamp,
          snippet: messageMatchSnippet(row.content, matchedTerms),
          matchedTerms,
        };
        session.matchHits?.push(hit);
        session.messageMatchCount = row.match_count;
      }
    } catch {
      // Structured context is supplementary; never fail the primary search.
    }

    for (const session of sessions) {
      session.matchSnippet ??= session.matchHits?.[0]?.snippet ?? null;
      if ((session.messageMatchCount ?? 0) > 0) continue;
      if (allTermsIn(`${session.displayTitle} ${session.originalTitle} ${session.firstQuestion}`, terms)) {
        session.metadataMatch = "title";
      } else if (allTermsIn(session.projectPath, terms)) {
        session.metadataMatch = "project";
      } else {
        session.metadataMatch = "summary";
      }
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
    const displayTitle = row.custom_title || row.original_title || row.first_question || "Untitled Session";
    const environment = this.getEnvironment(row.environment_id) ?? localEnvironment();
    return {
      sessionKey: row.session_key,
      rawId: row.raw_id,
      source: row.source,
      environmentId: environment.id,
      environmentKind: environment.kind,
      environmentLabel: environment.label,
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
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      aiSummary: row.ai_summary?.trim() || null,
      aiSummaryStale: Boolean(row.ai_summary) && row.file_mtime_ms > (row.ai_summary_basis ?? 0),
      matchHits: [],
      messageMatchCount: 0,
      metadataMatch: null,
      isSubagent: row.is_subagent === 1,
      parentSessionId: row.parent_session_id,
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

  private sortValue(result: SessionSearchResult, sortBy: SessionSortBy = "activity"): number {
    if (sortBy === "created") return result.timestamp || 0;
    return result.lastActivityAt || result.fileMtimeMs || result.timestamp || 0;
  }
}

export function createInMemoryStore(): SessionStore {
  return new SessionStore(new DatabaseSync(":memory:"));
}

function hydrateEnvironmentRow(row: EnvironmentRow): SessionEnvironment {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    hostAlias: row.host_alias,
    host: row.host,
    user: row.user,
    port: row.port,
    authMode: row.auth_mode,
    identityFile: row.identity_file,
    enabled: row.enabled === 1,
    syncState: row.sync_state,
    lastSyncedAt: row.last_synced_at,
    lastError: truncateEnvironmentError(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function truncateEnvironmentError(error: string | null): string | null {
  if (!error) return error;
  const bytes = Buffer.byteLength(error);
  if (error.length <= 600) return error;
  if (/^\s*\{"kind":\s*"(?:codex-session|codex-index|claude-project|claude-session-index)"/.test(error)) {
    return `Remote sync error output was truncated (${formatEnvironmentErrorBytes(bytes)}). The hidden output looked like session payload data, not a readable error.`;
  }
  return `${error.slice(0, 520)}... truncated ${formatEnvironmentErrorBytes(bytes)}`;
}

function formatEnvironmentErrorBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function localEnvironment(): SessionEnvironment {
  return {
    id: "local",
    kind: "local",
    label: "Local",
    hostAlias: null,
    host: null,
    user: null,
    port: null,
    authMode: "none",
    identityFile: null,
    enabled: true,
    syncState: "idle",
    lastSyncedAt: null,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createEnvironmentId(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "environment";
}

function generatedEnvironmentIdBase(label: string): string {
  const id = createEnvironmentId(label);
  return id === "local" ? "ssh-local" : id;
}

function environmentSortValue(environmentId: string): number {
  return environmentId === "local" ? 0 : 1;
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

function skillSyncBindingFromRow(row: SkillSyncBindingRow): SkillSyncBinding {
  return {
    localSkillPath: row.local_skill_path,
    remoteSkillId: row.remote_skill_id,
    remoteUpdatedAt: row.remote_updated_at,
    remoteVersion: typeof row.remote_version === "number" && Number.isFinite(row.remote_version) ? row.remote_version : 1,
    lastSyncedAt: row.last_synced_at,
    direction: row.direction,
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
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" ");
}

function searchTerms(query: string): string[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(terms.map((term) => term.toLocaleLowerCase()).filter((term) => term !== "and"))];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function allTermsIn(value: string, terms: string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function messageMatchSnippet(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const firstMatch = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, firstMatch - 70);
  const end = Math.min(normalized.length, firstMatch + 170);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

function normalizeExplicitAnd(query: string): string {
  return query
    .split(/\s+/u)
    .filter((token) => token.toLocaleLowerCase() !== "and")
    .join(" ")
    .trim();
}

function sessionSortSql(sortBy: SessionSortBy = "activity"): string {
  if (sortBy === "activity") return sessionActivitySql("sessions");
  return "COALESCE(timestamp, 0)";
}

function sessionActivitySql(sessionTable: string): string {
  return `
    COALESCE(
      (
        SELECT MAX(message_events.timestamp)
        FROM message_events
        WHERE message_events.session_key = ${sessionTable}.session_key
      ),
      (
        SELECT MAX(CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000)
        FROM messages
        WHERE messages.session_key = ${sessionTable}.session_key
      ),
      CASE WHEN ${sessionTable}.file_mtime_ms > 0 THEN ${sessionTable}.file_mtime_ms ELSE ${sessionTable}.timestamp END,
      0
    )
  `;
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
