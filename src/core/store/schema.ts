import type { SessionStoreDatabase } from "./database";

export function migrateSessionStore(db: SessionStoreDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  // WAL lets a read-only consumer (the MCP server) read concurrently while the app writes.
  // Harmless for the in-memory test DB, which ignores the journal mode.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Some environments (e.g. in-memory) reject WAL; fall back to the default journal.
  }
  db.exec(`
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
      portable_identity TEXT NOT NULL DEFAULT '',
      remote_skill_id TEXT NOT NULL UNIQUE,
      remote_updated_at TEXT NOT NULL,
      remote_version INTEGER NOT NULL DEFAULT 1,
      last_content_hash TEXT NOT NULL DEFAULT '',
      last_synced_at INTEGER NOT NULL,
      direction TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_sync_bindings (
      local_session_key TEXT PRIMARY KEY,
      remote_session_id TEXT NOT NULL UNIQUE,
      last_local_revision TEXT NOT NULL,
      last_remote_revision TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS data_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_session_sync_bindings_remote_id
      ON session_sync_bindings(remote_session_id);
    CREATE INDEX IF NOT EXISTS idx_session_migrations_source_session_key_created_at_id
      ON session_migrations(source_session_key, created_at DESC, id DESC);
  `);
  addColumnIfMissing(db, "sessions", "favorited", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "environment_id", "TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "sessions", "ai_summary", "TEXT");
  addColumnIfMissing(db, "sessions", "ai_summary_model", "TEXT");
  addColumnIfMissing(db, "sessions", "ai_summary_at", "INTEGER");
  addColumnIfMissing(db, "sessions", "ai_summary_basis", "INTEGER");
  addColumnIfMissing(db, "sessions", "indexed_at", "INTEGER NOT NULL DEFAULT 0");
  const addedSubagentColumn = addColumnIfMissing(db, "sessions", "is_subagent", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "parent_session_id", "TEXT");
  if (addedSubagentColumn) {
    db
      .prepare(
        "UPDATE sessions SET file_mtime_ms = 0 WHERE source IN ('claude-cli', 'claude-app', 'claude-internal', 'tclaude-cli', 'codex-cli', 'codex-app', 'codex-internal', 'tcodex-cli')",
      )
      .run();
  }
  runCodexDesktopOriginatorMigration(db);
  addColumnIfMissing(db, "skill_sync_bindings", "remote_version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "skill_sync_bindings", "portable_identity", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "skill_sync_bindings", "last_content_hash", "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_sync_bindings_portable_identity
    ON skill_sync_bindings(portable_identity)
    WHERE portable_identity <> '';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_environment
      ON sessions(environment_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_environment_source
      ON sessions(environment_id, source);
    DROP INDEX IF EXISTS idx_session_migrations_source_session_key;
    DROP INDEX IF EXISTS idx_session_migrations_created_at_desc;
  `);
  db.exec(`
    INSERT OR IGNORE INTO message_events (session_key, message_index, timestamp)
    SELECT
      session_key,
      message_index,
      COALESCE(CAST(strftime('%s', timestamp) AS INTEGER) * 1000, 0)
    FROM messages;
  `);
  upgradeFtsTokenizer(db);
  ensureLocalEnvironment(db);
}

function runCodexDesktopOriginatorMigration(db: SessionStoreDatabase): void {
  const migrationId = "codex-work-desktop-originator-v1";
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(migrationId);
    if (!applied) {
      db.prepare("UPDATE sessions SET file_mtime_ms = 0 WHERE source = 'codex-cli' AND environment_id = 'local'").run();
      db.prepare("INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)").run(migrationId, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


function upgradeFtsTokenizer(db: SessionStoreDatabase): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_fts'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql || !row.sql.includes("unicode61")) return;
  db.exec("DROP TABLE IF EXISTS session_fts");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      session_key UNINDEXED,
      title,
      first_question,
      content_text,
      project_path,
      tokenize = 'trigram'
    );
  `);
  const sessionKeys = db.prepare("SELECT session_key FROM sessions").all() as Array<{ session_key: string }>;
  for (const { session_key: sessionKey } of sessionKeys) refreshFtsForSession(db, sessionKey);
}

function addColumnIfMissing(
  db: SessionStoreDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  return true;
}

function ensureLocalEnvironment(db: SessionStoreDatabase): void {
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO environments (
        id, kind, label, host_alias, host, user, port, auth_mode, identity_file,
        enabled, sync_state, last_synced_at, last_error, created_at, updated_at
      )
      VALUES ('local', 'local', 'Local', NULL, NULL, NULL, NULL, 'none', NULL, 1, 'idle', NULL, NULL, ?, ?)
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
  ).run(now, now);
}

function refreshFtsForSession(db: SessionStoreDatabase, sessionKey: string): void {
  const row = db.prepare(
    `
      SELECT custom_title, original_title, first_question, ai_summary, project_path
      FROM sessions
      WHERE session_key = ?
    `,
  ).get(sessionKey) as {
    custom_title: string | null;
    original_title: string;
    first_question: string;
    ai_summary: string | null;
    project_path: string;
  } | undefined;
  if (!row) return;

  const contentText = (db.prepare(
    "SELECT content FROM messages WHERE session_key = ? ORDER BY message_index",
  ).all(sessionKey) as Array<{ content: string }>)
    .map((message) => message.content)
    .join("\n\n");
  const title = row.custom_title || row.original_title || row.first_question || "Untitled Session";
  const summary = row.ai_summary?.trim();
  const ftsContent = summary ? `${summary}\n\n${contentText}` : contentText;
  db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
  db.prepare(
    "INSERT INTO session_fts (session_key, title, first_question, content_text, project_path) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionKey, title, row.first_question, ftsContent, row.project_path);
}
