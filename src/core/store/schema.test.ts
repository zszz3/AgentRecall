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
});
