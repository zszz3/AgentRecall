import * as fs from "node:fs";
import { isCodexSqliteSession } from "./session-environment";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SessionSource } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

const CLAUDE_SESSION_FILE_SOURCES = new Set<SessionSource>(["claude-cli", "claude-app"]);

export interface SessionSourceDeleteTarget {
  source: SessionSource;
  rawId: string;
  filePath: string;
  isSubagent: boolean;
  orphanedParentSessionId?: string | null;
}

export interface SessionSourceDeletionPaths {
  files: string[];
  directories: string[];
  emptyDirectories: string[];
  requiredAbsentFiles: string[];
}

type PathOperations = Pick<typeof path.posix, "basename" | "dirname" | "extname" | "isAbsolute" | "join">;

export function sessionSourceDeletionPaths(
  targets: readonly SessionSourceDeleteTarget[],
  pathOperations: PathOperations = path,
): SessionSourceDeletionPaths {
  const files = new Set<string>();
  const directories = new Set<string>();
  const emptyDirectories = new Set<string>();
  const requiredAbsentFiles = new Set<string>();

  for (const target of targets) {
    if (isCodexSqliteSession(target)) throw new Error("Codex paginated history is read-only.");
    const filePath = target.filePath.trim();
    if (!filePath) throw new Error("Session source file path is missing.");
    if (!pathOperations.isAbsolute(filePath)) throw new Error("Session source file path must be absolute.");
    files.add(filePath);
    if (!CLAUDE_SESSION_FILE_SOURCES.has(target.source)) continue;

    const extension = pathOperations.extname(filePath);
    if (extension.toLowerCase() !== ".jsonl") continue;
    if (target.isSubagent) {
      files.add(`${filePath.slice(0, -extension.length)}.meta.json`);
      const subagentsDirectory = pathOperations.dirname(filePath);
      const sessionDirectory = pathOperations.dirname(subagentsDirectory);
      if (
        target.orphanedParentSessionId
        && pathOperations.basename(subagentsDirectory) === "subagents"
        && pathOperations.basename(sessionDirectory) === target.orphanedParentSessionId
      ) {
        requiredAbsentFiles.add(pathOperations.join(
          pathOperations.dirname(sessionDirectory),
          `${target.orphanedParentSessionId}.jsonl`,
        ));
        directories.add(subagentsDirectory);
        directories.add(pathOperations.join(sessionDirectory, "tool-results"));
        emptyDirectories.add(sessionDirectory);
      }
      continue;
    }
    if (!target.rawId || pathOperations.basename(filePath, extension) !== target.rawId) continue;

    const sessionDirectory = pathOperations.join(pathOperations.dirname(filePath), target.rawId);
    directories.add(pathOperations.join(sessionDirectory, "subagents"));
    directories.add(pathOperations.join(sessionDirectory, "tool-results"));
    emptyDirectories.add(sessionDirectory);
  }

  return {
    files: [...files],
    directories: [...directories],
    emptyDirectories: [...emptyDirectories],
    requiredAbsentFiles: [...requiredAbsentFiles],
  };
}

export function deleteLocalSessionSources(
  targets: readonly SessionSourceDeleteTarget[],
  options: { requireCodexStateCleanup?: boolean } = {},
): void {
  const deletionPaths = sessionSourceDeletionPaths(targets);
  validateDeletionPaths(deletionPaths);
  if (options.requireCodexStateCleanup) deleteCodexAppStateRows(targets, true);
  for (const filePath of deletionPaths.files) deleteRegularFile(filePath);
  for (const directoryPath of deletionPaths.directories) deleteOwnedDirectory(directoryPath);
  for (const directoryPath of deletionPaths.emptyDirectories) removeEmptyDirectory(directoryPath);
  if (!options.requireCodexStateCleanup) deleteCodexAppStateRows(targets, false);
}

function deleteCodexAppStateRows(
  targets: readonly SessionSourceDeleteTarget[],
  required: boolean,
): void {
  const idsByCodexHome = new Map<string, Set<string>>();
  for (const target of targets) {
    if ((target.source !== "codex-app" && target.source !== "codex-cli") || !target.rawId) continue;
    const codexHome = codexHomeForRollout(target.filePath);
    if (!codexHome) continue;
    const ids = idsByCodexHome.get(codexHome) ?? new Set<string>();
    ids.add(target.rawId);
    idsByCodexHome.set(codexHome, ids);
  }

  for (const [codexHome, ids] of idsByCodexHome) {
    const familyIds = new Set(ids);
    let databasePaths: string[] = [];
    try { databasePaths = listCodexStateDatabases(codexHome); } catch (error) {
      if (required) throw error;
      // Codex state is auxiliary; an unavailable home must not block deletion.
    }
    for (const databasePath of databasePaths) {
      let database: DatabaseSyncType | null = null;
      try {
        database = openCodexStateDatabase(databasePath);
        if (!database) continue;
        for (const id of deleteCodexThreadRows(database, [...familyIds])) familyIds.add(id);
      } catch (error) {
        if (required) throw error;
        // Codex may hold a write lock while the app is running. State cleanup is best-effort.
      } finally {
        try { database?.close(); } catch { /* preserve the best-effort boundary */ }
      }
    }
    try { deleteCodexSessionIndexRows(codexHome, [...familyIds]); } catch (error) {
      if (required) throw error;
      // A stale native index must never turn a successful source deletion into a failure.
    }
  }
}

function codexHomeForRollout(filePath: string): string | null {
  let current = path.dirname(filePath);
  for (;;) {
    if (path.basename(current).toLowerCase() === "sessions") {
      const codexHome = path.dirname(current);
      return path.basename(codexHome).toLowerCase() === ".codex" ? codexHome : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function listCodexStateDatabases(codexHome: string): string[] {
  try {
    return fs.readdirSync(codexHome, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/iu.test(entry.name))
      .map((entry) => path.join(codexHome, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function openCodexStateDatabase(databasePath: string): DatabaseSyncType | null {
  try {
    return new DatabaseSync(databasePath, { timeout: 5_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function deleteCodexThreadRows(database: DatabaseSyncType, sessionIds: string[]): string[] {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0 || !sqliteTableHasColumns(database, "threads", ["id"])) return ids;
  const familyIds = expandCodexThreadIds(database, ids);
  const placeholders = familyIds.map(() => "?").join(", ");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (sqliteTableHasColumns(database, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"])) {
      database.prepare(
        `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) OR child_thread_id IN (${placeholders})`,
      ).run(...familyIds, ...familyIds);
    }
    if (sqliteTableHasColumns(database, "thread_dynamic_tools", ["thread_id"])) {
      database.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`).run(...familyIds);
    }
    database.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...familyIds);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  }
  return familyIds;
}

function expandCodexThreadIds(database: DatabaseSyncType, sessionIds: string[]): string[] {
  if (!sqliteTableHasColumns(database, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"])) {
    return sessionIds;
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    WITH RECURSIVE family(id) AS (
      SELECT id FROM threads WHERE id IN (${placeholders})
      UNION
      SELECT edge.child_thread_id
      FROM family
      INNER JOIN thread_spawn_edges edge ON edge.parent_thread_id = family.id
    )
    SELECT DISTINCT id FROM family
  `).all(...sessionIds) as Array<{ id?: unknown }>;
  return [...new Set([
    ...sessionIds,
    ...rows.map((row) => typeof row.id === "string" ? row.id : "").filter(Boolean),
  ])];
}

function deleteCodexSessionIndexRows(codexHome: string, sessionIds: string[]): void {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let content: string;
  try {
    content = fs.readFileSync(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const ids = new Set(sessionIds);
  const lines = content.split(/\r?\n/u);
  let changed = false;
  const kept = lines.filter((line) => {
    if (!line.trim()) return true;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string" && ids.has(parsed.id)) {
        changed = true;
        return false;
      }
    } catch {
      // Preserve unrelated malformed rows; the normal Codex indexer will report them.
    }
    return true;
  });
  if (!changed) return;
  const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, kept.join("\n"), "utf8");
    fs.renameSync(tempPath, indexPath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
}

function sqliteTableHasColumns(database: DatabaseSyncType, table: string, columns: string[]): boolean {
  const present = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!present) return false;
  const available = new Set(
    (database.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name?: unknown }>)
      .map((column) => typeof column.name === "string" ? column.name : ""),
  );
  return columns.every((column) => available.has(column));
}

function validateDeletionPaths(deletionPaths: SessionSourceDeletionPaths): void {
  for (const filePath of deletionPaths.requiredAbsentFiles) {
    if (lstatIfPresent(filePath)) {
      throw new Error("Refusing to clean orphaned subagents while the parent session source still exists.");
    }
  }
  for (const filePath of deletionPaths.files) {
    const stat = lstatIfPresent(filePath);
    if (stat?.isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  }
  for (const directoryPath of [...deletionPaths.directories, ...deletionPaths.emptyDirectories]) {
    const stat = lstatIfPresent(directoryPath);
    if (stat && !stat.isDirectory()) throw new Error("Refusing to recursively delete a non-directory session artifact.");
  }
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function deleteRegularFile(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(filePath, { force: true });
}

function deleteOwnedDirectory(directoryPath: string): void {
  try {
    if (!fs.lstatSync(directoryPath).isDirectory()) {
      throw new Error("Refusing to recursively delete a non-directory session artifact.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

function removeEmptyDirectory(directoryPath: string): void {
  try {
    fs.rmdirSync(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}
