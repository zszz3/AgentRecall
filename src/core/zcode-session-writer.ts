import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

const SESSION_ID_PATTERN = /^[^\x00]+$/;
const SESSION_RELATED_TABLES = [
  "part",
  "message",
  "model_usage",
  "turn_usage",
  "tool_usage",
  "input_history",
] as const;

function tableExists(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

function hasColumn(db: DatabaseSyncType, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>).some(
    (column) => column.name === columnName,
  );
}

function assertZcodeDatabasePath(dbPath: string): string {
  const normalized = path.resolve(dbPath.trim());
  const segments = normalized.split(path.sep).map((segment) => segment.toLowerCase());
  if (segments.at(-1) !== "db.sqlite" || segments.at(-2) !== "db" || segments.at(-3) !== "cli") {
    throw new Error("Refusing to modify a non-ZCode database path.");
  }
  return normalized;
}

/** Permanently removes one ZCode session while keeping the shared database and all other sessions intact. */
export function deleteZcodeSession(dbPath: string, sessionId: string): boolean {
  const normalizedPath = assertZcodeDatabasePath(dbPath);
  const normalizedId = sessionId.trim();
  if (!SESSION_ID_PATTERN.test(normalizedId)) throw new Error("ZCode session id is invalid.");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) throw new Error("ZCode database path is not a regular file.");

  const db = new DatabaseSync(normalizedPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (!tableExists(db, "session") || !hasColumn(db, "session", "id")) {
      throw new Error("ZCode database schema is incompatible.");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const exists = Boolean(db.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1").get(normalizedId));
      if (!exists) {
        db.exec("COMMIT");
        return false;
      }

      for (const tableName of SESSION_RELATED_TABLES) {
        if (tableExists(db, tableName) && hasColumn(db, tableName, "session_id")) {
          db.prepare(`DELETE FROM ${tableName} WHERE session_id = ?`).run(normalizedId);
        }
      }
      db.prepare("DELETE FROM session WHERE id = ?").run(normalizedId);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
