import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

const SESSION_ID_PATTERN = /^[^\x00]+$/;

/** Session relation tables that reference sessions through columns other than session_id. */
const SPECIAL_SESSION_RELATIONS = [
  { table: "session_task_link", columns: ["parent_session_id", "child_session_id"] },
  { table: "workflow_run", columns: ["parent_session_id"] },
  { table: "workflow_activity", columns: ["child_session_id"] },
] as const;

/** Workflow tables that reference workflow_run.id instead of sessions directly. */
const WORKFLOW_RUN_RELATIONS = [
  { table: "workflow_activity", column: "run_id" },
  { table: "workflow_event", column: "run_id" },
] as const;

type DatabaseSchema = "main" | "zcode_tasks";

function tableExists(db: DatabaseSyncType, tableName: string, schema: DatabaseSchema = "main"): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .get(tableName),
  );
}

function hasColumn(
  db: DatabaseSyncType,
  tableName: string,
  columnName: string,
  schema: DatabaseSchema = "main",
): boolean {
  return (db.prepare(`PRAGMA ${schema}.table_info(${tableName})`).all() as Array<{ name?: unknown }>).some(
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

/** Resolves the ZCode database location for a home directory, mirroring the ZCode client layout. */
export function zcodeDatabasePathFromHome(homeDir: string): string {
  return assertZcodeDatabasePath(path.join(path.resolve(homeDir.trim()), ".zcode", "cli", "db", "db.sqlite"));
}

/**
 * Permanently removes one ZCode session and its sub-agent descendants while keeping the shared
 * database and all other sessions intact. A pre-deletion backup is written next to the database.
 */
export function deleteZcodeSession(dbPath: string, sessionId: string): boolean {
  return deleteZcodeSessions(dbPath, [sessionId]).length > 0;
}

/**
 * Permanently removes the requested ZCode sessions plus every descendant sub-agent session
 * (linked through session.parent_id or session_task_link), along with their rows in every
 * table that references sessions. Matching task index entries are soft-deleted to match the
 * ZCode client's own deletion behavior. Returns the requested ids that were found; descendants
 * removed alongside them are not included.
 */
export function deleteZcodeSessions(dbPath: string, sessionIds: readonly string[]): string[] {
  const normalizedPath = assertZcodeDatabasePath(dbPath);
  const normalizedIds = [...new Set(sessionIds.map((sessionId) => sessionId.trim()))];
  if (normalizedIds.some((sessionId) => !SESSION_ID_PATTERN.test(sessionId))) {
    throw new Error("ZCode session id is invalid.");
  }
  if (normalizedIds.length === 0) return [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
    const taskIndexAttached = attachZcodeTaskIndex(db, normalizedPath);

    if (selectExistingSessionIds(db, normalizedIds).length > 0 || (taskIndexAttached && taskIndexHasTasks(db, normalizedIds))) {
      backupMainDatabase(db, normalizedPath);
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingIds = selectExistingSessionIds(db, normalizedIds);
      const deleteIds = expandSessionDescendants(db, existingIds);
      if (deleteIds.size > 0) {
        deleteWorkflowArtifacts(db, deleteIds);
        deleteSessionRelatedRows(db, deleteIds);
        for (const ids of chunks([...deleteIds], 500)) {
          db.prepare(`DELETE FROM session WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
        }
      }
      if (taskIndexAttached) {
        softDeleteTaskIndexEntries(db, [...new Set([...normalizedIds, ...deleteIds])]);
      }
      db.exec("COMMIT");
      return existingIds;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Attaches the ZCode client's task index as the `zcode_tasks` schema. The index drives the
 * client's session list, so writers that add or remove sessions must keep it in step.
 * Returns false when the index file or its tasks table does not exist yet.
 */
export function attachZcodeTaskIndex(db: DatabaseSyncType, dbPath: string): boolean {
  const zcodeRoot = path.dirname(path.dirname(path.dirname(dbPath)));
  const taskIndexPath = path.join(zcodeRoot, "v2", "tasks-index.sqlite");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(taskIndexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) throw new Error("ZCode task index path is not a regular file.");
  db.prepare("ATTACH DATABASE ? AS zcode_tasks").run(taskIndexPath);
  return tableExists(db, "tasks", "zcode_tasks") && hasColumn(db, "tasks", "task_id", "zcode_tasks");
}

function taskIndexHasTasks(db: DatabaseSyncType, taskIds: readonly string[]): boolean {
  for (const ids of chunks(taskIds, 500)) {
    const row = db
      .prepare(`SELECT 1 FROM zcode_tasks.tasks WHERE task_id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`)
      .get(...ids);
    if (row) return true;
  }
  return false;
}

/** Writes a consistent pre-deletion snapshot of the shared database to db.sqlite.bak. */
function backupMainDatabase(db: DatabaseSyncType, dbPath: string): void {
  const backupPath = `${dbPath}.bak`;
  const stagingPath = `${backupPath}.tmp`;
  fs.rmSync(stagingPath, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(stagingPath);
    fs.renameSync(stagingPath, backupPath);
  } catch (error) {
    fs.rmSync(stagingPath, { force: true });
    throw new Error(`ZCode database backup failed before deletion: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Collects the requested sessions plus every descendant reachable through parent_id or session_task_link. */
function expandSessionDescendants(db: DatabaseSyncType, rootIds: readonly string[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  const addChild = (parentId: unknown, childId: unknown): void => {
    if (typeof parentId !== "string" || typeof childId !== "string" || parentId === childId) return;
    const children = childrenByParent.get(parentId) ?? [];
    if (!children.includes(childId)) children.push(childId);
    childrenByParent.set(parentId, children);
  };
  if (hasColumn(db, "session", "parent_id")) {
    const rows = db.prepare("SELECT id, parent_id FROM session").all() as Array<Record<string, unknown>>;
    for (const row of rows) addChild(row.parent_id, row.id);
  }
  if (tableExists(db, "session_task_link") && hasColumn(db, "session_task_link", "parent_session_id") && hasColumn(db, "session_task_link", "child_session_id")) {
    const rows = db
      .prepare("SELECT parent_session_id, child_session_id FROM session_task_link")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) addChild(row.parent_session_id, row.child_session_id);
  }

  const closure = new Set<string>();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const sessionId = queue.pop() as string;
    if (closure.has(sessionId)) continue;
    closure.add(sessionId);
    for (const childId of childrenByParent.get(sessionId) ?? []) {
      if (!closure.has(childId)) queue.push(childId);
    }
  }
  return closure;
}

/** Removes workflow runs owned by the deleted sessions plus every table row referencing those runs. */
function deleteWorkflowArtifacts(db: DatabaseSyncType, sessionIds: ReadonlySet<string>): void {
  if (!tableExists(db, "workflow_run") || !hasColumn(db, "workflow_run", "id") || !hasColumn(db, "workflow_run", "parent_session_id")) {
    return;
  }
  const runIds = new Set<string>();
  for (const ids of chunks([...sessionIds], 500)) {
    const rows = db
      .prepare(`SELECT id FROM workflow_run WHERE parent_session_id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Array<{ id?: unknown }>;
    for (const row of rows) {
      if (typeof row.id === "string") runIds.add(row.id);
    }
  }
  if (runIds.size === 0) return;
  for (const { table, column } of WORKFLOW_RUN_RELATIONS) {
    if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
    for (const ids of chunks([...runIds], 500)) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(", ")})`).run(...ids);
    }
  }
  for (const ids of chunks([...runIds], 500)) {
    db.prepare(`DELETE FROM workflow_run WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
  }
}

/** Deletes rows referencing the deleted sessions from every table, discovered from the live schema. */
function deleteSessionRelatedRows(db: DatabaseSyncType, sessionIds: ReadonlySet<string>): void {
  const tables = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name <> 'session'")
    .all() as Array<{ name?: unknown }>;
  for (const { name } of tables) {
    if (typeof name !== "string" || !hasColumn(db, name, "session_id")) continue;
    deleteByColumn(db, name, "session_id", sessionIds);
  }
  for (const { table, columns } of SPECIAL_SESSION_RELATIONS) {
    if (!tableExists(db, table)) continue;
    const matchColumns = columns.filter((column) => hasColumn(db, table, column));
    if (matchColumns.length === 0) continue;
    for (const ids of chunks([...sessionIds], 500)) {
      const placeholders = ids.map(() => "?").join(", ");
      const predicate = matchColumns.map((column) => `"${column}" IN (${placeholders})`).join(" OR ");
      const parameters = matchColumns.flatMap(() => ids);
      db.prepare(`DELETE FROM "${table}" WHERE ${predicate}`).run(...parameters);
    }
  }
}

function deleteByColumn(
  db: DatabaseSyncType,
  tableName: string,
  columnName: string,
  sessionIds: ReadonlySet<string>,
): void {
  for (const ids of chunks([...sessionIds], 500)) {
    db.prepare(`DELETE FROM "${tableName}" WHERE "${columnName}" IN (${ids.map(() => "?").join(", ")})`).run(...ids);
  }
}

/** Soft-deletes task index entries like the ZCode client and clears group membership residue. */
function softDeleteTaskIndexEntries(db: DatabaseSyncType, taskIds: readonly string[]): void {
  const supportsSoftDelete = hasColumn(db, "tasks", "deleted", "zcode_tasks");
  const hasUpdatedAt = hasColumn(db, "tasks", "updated_at", "zcode_tasks");
  for (const ids of chunks(taskIds, 500)) {
    const placeholders = ids.map(() => "?").join(", ");
    if (supportsSoftDelete) {
      const assignments = hasUpdatedAt ? "deleted = 1, updated_at = ?" : "deleted = 1";
      const parameters = hasUpdatedAt ? [Date.now(), ...ids] : ids;
      db
        .prepare(`UPDATE zcode_tasks.tasks SET ${assignments} WHERE task_id IN (${placeholders}) AND deleted = 0`)
        .run(...parameters);
    } else {
      db.prepare(`DELETE FROM zcode_tasks.tasks WHERE task_id IN (${placeholders})`).run(...ids);
    }
  }
  if (tableExists(db, "task_group_members", "zcode_tasks") && hasColumn(db, "task_group_members", "task_id", "zcode_tasks")) {
    for (const ids of chunks(taskIds, 500)) {
      db.prepare(`DELETE FROM zcode_tasks.task_group_members WHERE task_id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
    }
  }
  if (
    tableExists(db, "task_group_view_node_orders", "zcode_tasks")
    && hasColumn(db, "task_group_view_node_orders", "node_type", "zcode_tasks")
    && hasColumn(db, "task_group_view_node_orders", "node_key", "zcode_tasks")
  ) {
    for (const ids of chunks(taskIds, 500)) {
      db
        .prepare(`DELETE FROM zcode_tasks.task_group_view_node_orders WHERE node_type = 'task' AND node_key IN (${ids.map(() => "?").join(", ")})`)
        .run(...ids);
    }
  }
}

function selectExistingSessionIds(db: DatabaseSyncType, sessionIds: readonly string[]): string[] {
  const existing = new Set<string>();
  for (const ids of chunks(sessionIds, 500)) {
    const rows = db.prepare(`SELECT id FROM session WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Array<{ id: string }>;
    for (const row of rows) existing.add(row.id);
  }
  return sessionIds.filter((sessionId) => existing.has(sessionId));
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
