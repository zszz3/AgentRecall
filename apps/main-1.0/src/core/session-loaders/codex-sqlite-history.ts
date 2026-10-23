import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof Database };

/**
 * Resolves a shared SQLite source to this thread's surviving rollout. Raw-file
 * consumers must never interpret the shared database as JSONL or read a
 * different thread just because its path appeared in external metadata.
 */
export function resolveCodexSqliteRolloutPath(filePath: string, rawId: string): string | null {
  const statePath = path.join(path.dirname(filePath), "state_5.sqlite");
  if (!fs.existsSync(statePath)) return null;
  const state = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = state.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(rawId);
    const rolloutPath = text(row?.rollout_path);
    if (!rolloutPath.endsWith(".jsonl")) return null;
    let descriptor: number;
    try { descriptor = fs.openSync(rolloutPath, "r"); }
    catch (error) {
      // Compacted or removed rollouts cannot supply their original context.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(4096);
        const length = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
        if (length === 0) break;
        const newline = chunk.subarray(0, length).indexOf(10);
        chunks.push(chunk.subarray(0, newline < 0 ? length : newline));
        offset += length;
        if (newline >= 0) break;
      }
      const header = parseHistoryJson(Buffer.concat(chunks).toString("utf8"));
      const payload = header && typeof header === "object" && "type" in header && header.type === "session_meta"
        && "payload" in header ? header.payload : null;
      const id = payload && typeof payload === "object"
        ? ("id" in payload ? payload.id : "session_id" in payload ? payload.session_id : null) : null;
      if (id !== rawId) throw new Error("The Codex rollout belongs to a different conversation.");
      return rolloutPath;
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    state.close();
  }
}

export interface CodexSqliteHistory {
  filePath: string;
  rawId: string;
  rolloutPath: string;
  updatedAt: string;
  projectionOffset: number | null;
  skipped?: boolean;
  archived?: boolean;
  rows: unknown[];
  stat: { mtimeMs: number; size: number };
}

function columns(db: Database, table: string): Set<string> {
  return new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => String(row.name)));
}

function requireColumns(db: Database, table: string, names: string[]): void {
  const available = columns(db, table);
  if (names.some((name) => !available.has(name))) {
    throw new Error("Unsupported Codex history schema in " + table + ".");
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseHistoryJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch {
    // JSON parser diagnostics can quote private conversation text.
    throw new Error("Invalid JSON in Codex paginated history.");
  }
}

/**
 * Reads one committed projection per thread. Connections are read-only, and no
 * cursor or transaction survives a yield. The optional ID also scopes exports
 * so a single-session operation never reads or publishes the whole database.
 */
export function* readCodexSqliteHistory(
  codexDir: string, rawId?: string, shouldSkip?: (history: CodexSqliteHistory) => boolean,
): Generator<CodexSqliteHistory> {
  const filePath = path.join(codexDir, "thread_history_1.sqlite");
  if (!fs.existsSync(filePath)) return;
  const statePath = path.join(codexDir, "state_5.sqlite");
  let history: Database | undefined;
  let state: Database | undefined;
  try {
    history = new DatabaseSync(filePath, { readOnly: true });
    state = new DatabaseSync(statePath, { readOnly: true });
    requireColumns(state, "threads", ["id", "history_mode", "cwd", "title", "rollout_path", "created_at", "updated_at", "archived"]);
    requireColumns(history, "thread_turns", ["thread_id", "turn_id", "rollout_ordinal", "status", "started_at", "completed_at"]);
    requireColumns(history, "thread_items", ["thread_id", "turn_id", "item_id", "rollout_ordinal", "created_at_ms", "item_json"]);
    requireColumns(history, "thread_history_projection_state", ["thread_id", "next_rollout_byte_offset"]);
    const stats = [filePath, filePath + "-wal", statePath, statePath + "-wal"].flatMap((filename) => {
      try { return [fs.statSync(filename)]; }
      catch (error) {
        // An idle database has no WAL; a checkpoint can remove it during discovery.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && filename.endsWith("-wal")) return [];
        throw error;
      }
    });
    const stat = {
      mtimeMs: Math.max(...stats.map((value) => value.mtimeMs)),
      size: stats.reduce((sum, value) => sum + value.size, 0),
    };
    const threads = state.prepare(
      "SELECT * FROM threads WHERE history_mode = 'paginated'"
      + (rawId === undefined ? "" : " AND archived = 0 AND id = ?"),
    ).all(...(rawId === undefined ? [] : [rawId]));
    const turnsQuery = history.prepare("SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal");
    const projectionQuery = history.prepare("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ?");
    const itemsQuery = history.prepare(
      "SELECT * FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal, item_id",
    );
    for (const thread of threads) {
      const id = text(thread.id);
      if (!id) throw new Error("A Codex history thread has no ID.");
      const createdAt = number(thread.created_at_ms, number(thread.created_at) * 1000);
      const updatedAt = number(thread.updated_at_ms, number(thread.updated_at) * 1000);
      const source = text(thread.source);
      const sourceValue: unknown = source.startsWith("{") ? parseHistoryJson(source) : source;
      const rows: unknown[] = [{
        type: "session_meta",
        timestamp: timestamp(createdAt),
        payload: {
          id, cwd: text(thread.cwd), title: text(thread.title), history_mode: "paginated",
          originator: text(thread.originator) || (source === "appServer" ? "Codex Desktop" : undefined),
          git: { branch: text(thread.git_branch) || undefined },
          source: sourceValue,
          agent_path: text(thread.agent_path) || undefined,
        },
      }];
      const snapshot = { filePath, rawId: id, rolloutPath: text(thread.rollout_path), updatedAt: timestamp(updatedAt), projectionOffset: null, rows, stat };
      if (number(thread.archived) !== 0) {
        // Suppress surviving rollout files too, without marking this thread as indexed.
        yield { ...snapshot, archived: true };
        continue;
      }
      if (shouldSkip?.(snapshot)) {
        yield { ...snapshot, skipped: true };
        continue;
      }
      history.exec("BEGIN");
      let turns: Record<string, unknown>[];
      let items: Record<string, unknown>[];
      let projectionOffset: number | null;
      try {
        turns = turnsQuery.all(id);
        items = itemsQuery.all(id);
        const projection = projectionQuery.get(id);
        projectionOffset = projection ? number(projection.next_rollout_byte_offset, -1) : null;
        if (projectionOffset !== null && (!Number.isSafeInteger(projectionOffset) || projectionOffset < 0)) {
          throw new Error("Invalid Codex history projection offset.");
        }
      } finally {
        history.exec("ROLLBACK");
      }
      // A not-yet-materialized thread must keep using its durable rollout.
      if (items.length === 0 && projectionOffset === null) continue;
      const events: { ordinal: number; order: number; row: unknown }[] = [];
      const lastOrdinalByTurn = new Map<string, number>();
      for (const item of items) {
        const turnId = text(item.turn_id);
        lastOrdinalByTurn.set(turnId, Math.max(lastOrdinalByTurn.get(turnId) ?? 0, number(item.rollout_ordinal)));
      }
      for (const turn of turns) {
        const turnId = text(turn.turn_id);
        if (!turnId) throw new Error("A Codex history turn has no ID.");
        const startedAt = number(turn.started_at, createdAt / 1000);
        const completedAt = number(turn.completed_at, updatedAt / 1000);
        events.push({
          ordinal: number(turn.rollout_ordinal), order: 0,
          row: { type: "event_msg", timestamp: timestamp(startedAt * 1000),
            payload: { type: "task_started", turn_id: turnId, started_at: startedAt } },
        });
        const status = text(turn.status);
        if (status === "inProgress") continue;
        if (!["completed", "interrupted", "failed"].includes(status)) {
          throw new Error("Unsupported Codex turn status.");
        }
        const lastItemOrdinal = Math.max(lastOrdinalByTurn.get(turnId) ?? 0, number(turn.rollout_ordinal));
        events.push({
          ordinal: number(turn.rollout_end_ordinal, lastItemOrdinal), order: 2,
          row: { type: "event_msg", timestamp: timestamp(completedAt * 1000),
            payload: {
              type: status === "interrupted" ? "turn_aborted" : "task_complete",
              turn_id: turnId, started_at: startedAt, completed_at: completedAt,
              duration_ms: turn.duration_ms,
              error: status === "failed" ? parseHistoryJson(text(turn.error_json) || '{"message":"Turn failed"}') : undefined,
            } },
        });
      }
      for (const item of items) {
        const parsed = parseHistoryJson(text(item.item_json));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || !("type" in parsed) || typeof parsed.type !== "string"
          || !("id" in parsed) || !text(item.item_id) || parsed.id !== item.item_id || !text(item.turn_id)) {
          throw new Error("Invalid Codex history item.");
        }
        const created = number(item.created_at_ms, createdAt);
        events.push({
          ordinal: number(item.rollout_ordinal), order: 1,
          row: { type: "event_msg", timestamp: timestamp(created),
            payload: {
              type: "item_completed", turn_id: text(item.turn_id),
              started_at_ms: item.started_at_ms, completed_at_ms: item.completed_at_ms,
              item: parsed,
            } },
        });
      }
      events.sort((left, right) => left.ordinal - right.ordinal || left.order - right.order);
      for (const event of events) rows.push(event.row);
      yield { filePath, rawId: id, rolloutPath: text(thread.rollout_path), updatedAt: timestamp(updatedAt), projectionOffset, rows, stat };
    }
  } catch (error) {
    throw new Error("Cannot read Codex paginated history at " + filePath + ": "
      + (error instanceof Error ? error.message : String(error)), { cause: error });
  } finally {
    try { state?.close(); }
    finally { history?.close(); }
  }
}
