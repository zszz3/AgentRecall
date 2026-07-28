import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SessionSearchResult } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

export interface SessionSourceArtifact {
  kind: "session-file" | "cursor-state" | "codewiz-state";
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
}

export class SessionSourceUnavailableError extends Error {
  override readonly name = "SessionSourceUnavailableError";
}

interface EncodedDatabaseValue {
  type: "null" | "number" | "bigint" | "text" | "blob";
  value?: number | string;
}

interface SessionDatabaseSlice {
  schemaVersion: 1;
  source: "cursor" | "codewiz";
  sourceSessionId: string;
  tables: Record<string, Array<Record<string, EncodedDatabaseValue>>>;
}

export function readSessionSourceArtifacts(session: SessionSearchResult): SessionSourceArtifact[] {
  if (session.source === "cursor-agent") return readCursorSourceArtifacts(session);
  if (session.source === "codewiz-cli") return readCodewizSourceArtifacts(session);
  return [{
    kind: "session-file",
    fileName: path.basename(session.filePath) || `${safeFileSegment(session.rawId)}.jsonl`,
    bytes: readRequiredFile(session.filePath),
    mimeType: sourceFileMimeType(session.filePath),
  }];
}

function readCursorSourceArtifacts(session: SessionSearchResult): SessionSourceArtifact[] {
  const databasePath = cursorStateDatabasePath(session.filePath);
  const transcriptPath = path.extname(session.filePath).toLowerCase() === ".jsonl"
    ? session.filePath
    : null;
  const artifacts: SessionSourceArtifact[] = [];

  if (transcriptPath) {
    artifacts.push({
      kind: "session-file",
      fileName: path.basename(transcriptPath),
      bytes: readRequiredFile(transcriptPath),
      mimeType: "application/x-ndjson",
    });
  }

  if (databasePath && fs.existsSync(databasePath)) {
    const slice = readCursorDatabaseSlice(databasePath, session.rawId);
    if (slice) {
      artifacts.push({
        kind: "cursor-state",
        fileName: `${safeFileSegment(session.rawId)}.cursor-state.json`,
        bytes: Buffer.from(JSON.stringify(slice)),
        mimeType: "application/json",
      });
    }
  }

  if (artifacts.length === 0) {
    throw new SessionSourceUnavailableError(`The original Cursor session data is unavailable for ${session.rawId}.`);
  }
  return artifacts;
}

function readCodewizSourceArtifacts(session: SessionSearchResult): SessionSourceArtifact[] {
  const db = openReadOnlyDatabase(session.filePath);
  if (!db) throw new SessionSourceUnavailableError(`The original CodeWiz session data is unavailable for ${session.rawId}.`);
  try {
    const tables: SessionDatabaseSlice["tables"] = {};
    if (tableHasColumns(db, "session", ["id"])) {
      tables.session = encodeRows(
        db.prepare("SELECT * FROM session WHERE id = ?").all(session.rawId) as Array<Record<string, unknown>>,
      );
    }
    if (tableHasColumns(db, "message", ["id", "session_id"])) {
      tables.message = encodeRows(
        db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY id").all(session.rawId) as Array<Record<string, unknown>>,
      );
    }
    if (tableHasColumns(db, "part", ["id", "message_id"]) && tableHasColumns(db, "message", ["id", "session_id"])) {
      tables.part = encodeRows(
        db.prepare(`
          SELECT part.*
          FROM part
          INNER JOIN message ON message.id = part.message_id
          WHERE message.session_id = ?
          ORDER BY part.id
        `).all(session.rawId) as Array<Record<string, unknown>>,
      );
    }
    if ((tables.session?.length ?? 0) === 0 && (tables.message?.length ?? 0) === 0) {
      throw new SessionSourceUnavailableError(`The original CodeWiz session data is unavailable for ${session.rawId}.`);
    }
    const slice: SessionDatabaseSlice = {
      schemaVersion: 1,
      source: "codewiz",
      sourceSessionId: session.rawId,
      tables,
    };
    return [{
      kind: "codewiz-state",
      fileName: `${safeFileSegment(session.rawId)}.codewiz-state.json`,
      bytes: Buffer.from(JSON.stringify(slice)),
      mimeType: "application/json",
    }];
  } finally {
    db.close();
  }
}

function readCursorDatabaseSlice(databasePath: string, composerId: string): SessionDatabaseSlice | null {
  const db = openReadOnlyDatabase(databasePath);
  if (!db) return null;
  try {
    const tables: SessionDatabaseSlice["tables"] = {};
    if (tableHasColumns(db, "composerHeaders", ["composerId"])) {
      tables.composerHeaders = encodeRows(
        db.prepare("SELECT * FROM composerHeaders WHERE composerId = ?").all(composerId) as Array<Record<string, unknown>>,
      );
    }
    if (tableHasColumns(db, "cursorDiskKV", ["key", "value"])) {
      const composerDataKey = `composerData:${composerId}`;
      const virtualRowsKey = `composerVirtualRowHeights:${composerId}`;
      const bubblePrefix = `bubbleId:${composerId}:`;
      const checkpointPrefix = `checkpointId:${composerId}:`;
      const fileSnapshotPrefix = `ofsContent:${composerId}:`;
      tables.cursorDiskKV = encodeRows(
        db.prepare(`
          SELECT *
          FROM cursorDiskKV
          WHERE key IN (?, ?)
            OR (key >= ? AND key < ?)
            OR (key >= ? AND key < ?)
            OR (key >= ? AND key < ?)
          ORDER BY key
        `).all(
          composerDataKey,
          virtualRowsKey,
          bubblePrefix,
          `${bubblePrefix}\uffff`,
          checkpointPrefix,
          `${checkpointPrefix}\uffff`,
          fileSnapshotPrefix,
          `${fileSnapshotPrefix}\uffff`,
        ) as Array<Record<string, unknown>>,
      );
    }
    if ((tables.composerHeaders?.length ?? 0) === 0 && (tables.cursorDiskKV?.length ?? 0) === 0) return null;
    return {
      schemaVersion: 1,
      source: "cursor",
      sourceSessionId: composerId,
      tables,
    };
  } finally {
    db.close();
  }
}

function cursorStateDatabasePath(filePath: string): string | null {
  if (path.basename(filePath).toLowerCase() === "state.vscdb") return filePath;
  const marker = `${path.sep}projects${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex < 0) return null;
  const cursorDir = filePath.slice(0, markerIndex);
  if (path.basename(cursorDir) !== ".cursor") return null;
  const homeDir = path.dirname(cursorDir);
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function openReadOnlyDatabase(filePath: string): DatabaseSyncType | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
}

function tableHasColumns(db: DatabaseSyncType, table: string, columns: string[]): boolean {
  const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return false;
  const available = new Set(
    (db.prepare(`PRAGMA table_info("${table.replace(/"/g, "\"\"")}")`).all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => Boolean(name)),
  );
  return columns.every((column) => available.has(column));
}

function encodeRows(rows: Array<Record<string, unknown>>): Array<Record<string, EncodedDatabaseValue>> {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, encodeDatabaseValue(value)]),
  ));
}

function encodeDatabaseValue(value: unknown): EncodedDatabaseValue {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Uint8Array) return { type: "blob", value: Buffer.from(value).toString("base64") };
  return { type: "text", value: String(value) };
}

function readRequiredFile(filePath: string): Uint8Array {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    return fs.readFileSync(filePath);
  } catch {
    throw new SessionSourceUnavailableError(`The original session file is unavailable: ${filePath || "(empty path)"}`);
  }
}

function sourceFileMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jsonl") return "application/x-ndjson";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "session";
}
