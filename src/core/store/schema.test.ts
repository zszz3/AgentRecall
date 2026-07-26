import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionStore } from "./schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

describe("session store schema", () => {
  it("creates the complete schema and built-in local environment idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      migrateSessionStore(db);

      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "sessions",
        "messages",
        "message_attachments",
        "trace_events",
        "environments",
        "skill_usage_events",
        "skill_sync_bindings",
        "session_sync_bindings",
        "session_migrations",
        "data_migrations",
        "session_fts",
      ]));
      expect(db.prepare("SELECT id, kind, label, enabled FROM environments WHERE id = 'local'").get()).toEqual({
        id: "local",
        kind: "local",
        label: "Local",
        enabled: 1,
      });
    } finally {
      db.close();
    }
  });

  it("repairs local environment identity without discarding its runtime sync state", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      db.prepare(
        `
          UPDATE environments
          SET kind = 'ssh', label = 'Changed', host = 'example.com', enabled = 0,
              sync_state = 'watching', last_synced_at = 99, last_error = 'offline', created_at = 10
          WHERE id = 'local'
        `,
      ).run();

      migrateSessionStore(db);

      expect(db.prepare(
        `
          SELECT kind, label, host, enabled, sync_state, last_synced_at, last_error, created_at
          FROM environments
          WHERE id = 'local'
        `,
      ).get()).toEqual({
        kind: "local",
        label: "Local",
        host: null,
        enabled: 1,
        sync_state: "watching",
        last_synced_at: 99,
        last_error: "offline",
        created_at: 10,
      });
    } finally {
      db.close();
    }
  });

  it("invalidates legacy Codex source classifications exactly once", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const hasMigrationTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'")
        .get();
      if (hasMigrationTable) {
        db.prepare("DELETE FROM data_migrations WHERE id = 'codex-work-desktop-originator-v1'").run();
      }
      const insert = db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES (?, ?, ?, '/repo', ?, 'Title', 'Question', 1, ?, 10)
      `);
      insert.run("codex:legacy", "legacy", "codex-cli", "/tmp/codex.jsonl", 123);
      insert.run("claude:unchanged", "unchanged", "claude-cli", "/tmp/claude.jsonl", 456);

      migrateSessionStore(db);

      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codex:legacy'").get()).toEqual({ file_mtime_ms: 0 });
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'claude:unchanged'").get()).toEqual({ file_mtime_ms: 456 });

      db.prepare("UPDATE sessions SET file_mtime_ms = 789 WHERE session_key = 'codex:legacy'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codex:legacy'").get()).toEqual({ file_mtime_ms: 789 });
    } finally {
      db.close();
    }
  });

  it("invalidates session relation and branch metadata exactly once", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      db.prepare("DELETE FROM data_migrations WHERE id = 'session-relation-branch-metadata-v1'").run();
      const insert = db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES (?, ?, ?, ?, ?, '/repo', ?, 'Title', 'Question', 1, ?, 10)
      `);
      insert.run("codex:local", "local", "codex-app", "local", "local", "/tmp/codex.jsonl", 123);
      insert.run("ssh:dev:codex-cli:remote", "remote", "codex-cli", "ssh-dev", "ssh-dev", "/tmp/remote.jsonl", 456);
      db.prepare("INSERT INTO tags (name) VALUES ('branch:stale')").run();
      const tag = db.prepare("SELECT id FROM tags WHERE name = 'branch:stale'").get() as { id: number };
      db.prepare("INSERT INTO session_tags (session_key, tag_id) VALUES ('codex:local', ?)").run(tag.id);

      migrateSessionStore(db);

      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codex:local'").get()).toEqual({ file_mtime_ms: 0 });
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'ssh:dev:codex-cli:remote'").get()).toEqual({ file_mtime_ms: 456 });
      expect(db.prepare("SELECT name FROM tags WHERE name = 'branch:stale'").get()).toBeUndefined();

      db.prepare("UPDATE sessions SET file_mtime_ms = 789 WHERE session_key = 'codex:local'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codex:local'").get()).toEqual({ file_mtime_ms: 789 });
    } finally {
      db.close();
    }
  });

  it("invalidates CodeBuddy sessions once so corrected token counts are reparsed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      const hasMigrationTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'")
        .get();
      if (hasMigrationTable) {
        db.prepare("DELETE FROM data_migrations WHERE id = 'codebuddy-token-events-function-calls-v1'").run();
      }
      const insert = db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES (?, ?, ?, '/repo', ?, 'Title', 'Question', 1, ?, 10)
      `);
      insert.run("codebuddy:legacy", "legacy", "codebuddy-cli", "/tmp/codebuddy.jsonl", 123);
      insert.run("claude:unchanged", "unchanged", "claude-cli", "/tmp/claude.jsonl", 456);

      migrateSessionStore(db);

      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codebuddy:legacy'").get()).toEqual({ file_mtime_ms: 0 });
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'claude:unchanged'").get()).toEqual({ file_mtime_ms: 456 });

      db.prepare("UPDATE sessions SET file_mtime_ms = 789 WHERE session_key = 'codebuddy:legacy'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'codebuddy:legacy'").get()).toEqual({ file_mtime_ms: 789 });
    } finally {
      db.close();
    }
  });

  it("invalidates Cursor sessions once so composer titles are backfilled", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      db.prepare("DELETE FROM data_migrations WHERE id = 'cursor-composer-metadata-v1'").run();
      const insert = db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES (?, ?, ?, '/repo', ?, 'Title', 'Question', 1, ?, 10)
      `);
      insert.run("cursor:legacy", "legacy", "cursor-agent", "/tmp/cursor.jsonl", 123);
      insert.run("claude:unchanged", "unchanged", "claude-cli", "/tmp/claude.jsonl", 456);

      migrateSessionStore(db);

      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'cursor:legacy'").get()).toEqual({ file_mtime_ms: 0 });
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'claude:unchanged'").get()).toEqual({ file_mtime_ms: 456 });

      db.prepare("UPDATE sessions SET file_mtime_ms = 789 WHERE session_key = 'cursor:legacy'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'cursor:legacy'").get()).toEqual({ file_mtime_ms: 789 });
    } finally {
      db.close();
    }
  });

  it("backfills the storage environment from the execution environment exactly once", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      db.prepare("DELETE FROM data_migrations WHERE id = 'session-storage-environment-v1'").run();
      db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, environment_id, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES ('ssh:dev:codex:remote', 'remote', 'codex-cli', 'ssh-dev', '/repo', '/tmp/remote.jsonl',
          'Remote title', 'Remote question', 1, 123, 10)
      `).run();

      migrateSessionStore(db);

      expect(db.prepare("SELECT storage_environment_id FROM sessions WHERE session_key = 'ssh:dev:codex:remote'").get()).toEqual({
        storage_environment_id: "ssh-dev",
      });

      db.prepare("UPDATE sessions SET storage_environment_id = 'local' WHERE session_key = 'ssh:dev:codex:remote'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT storage_environment_id FROM sessions WHERE session_key = 'ssh:dev:codex:remote'").get()).toEqual({
        storage_environment_id: "local",
      });
    } finally {
      db.close();
    }
  });

  it("removes empty Cursor composer indexes and invalidates remaining Cursor sessions exactly once", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSessionStore(db);
      db.prepare("DELETE FROM data_migrations WHERE id = 'cursor-runtime-environment-v1'").run();
      const insert = db.prepare(`
        INSERT INTO sessions (
          session_key, raw_id, source, project_path, file_path,
          original_title, first_question, timestamp, file_mtime_ms, file_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 10)
      `);
      insert.run("cursor:empty", "empty-uuid", "cursor-agent", "", "/tmp/state.vscdb", "empty-uuid", "", 123);
      insert.run("cursor:valid", "valid", "cursor-agent", "/repo", "/tmp/state.vscdb", "Named Cursor session", "", 456);
      insert.run("claude:unchanged", "unchanged", "claude-cli", "/repo", "/tmp/claude.jsonl", "Claude", "Question", 789);
      db.prepare(
        "INSERT INTO session_fts (session_key, title, first_question, content_text, project_path) VALUES ('cursor:empty', 'empty-uuid', '', '', '')",
      ).run();

      migrateSessionStore(db);

      expect(db.prepare("SELECT 1 FROM sessions WHERE session_key = 'cursor:empty'").get()).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM session_fts WHERE session_key = 'cursor:empty'").get()).toBeUndefined();
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'cursor:valid'").get()).toEqual({ file_mtime_ms: 0 });
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'claude:unchanged'").get()).toEqual({ file_mtime_ms: 789 });

      db.prepare("UPDATE sessions SET file_mtime_ms = 999 WHERE session_key = 'cursor:valid'").run();
      migrateSessionStore(db);
      expect(db.prepare("SELECT file_mtime_ms FROM sessions WHERE session_key = 'cursor:valid'").get()).toEqual({ file_mtime_ms: 999 });
    } finally {
      db.close();
    }
  });
});
