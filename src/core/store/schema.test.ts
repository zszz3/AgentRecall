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
});
