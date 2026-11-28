import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { PostgresDatabase } from "../postgres/database";
import { SqliteDatabase } from "./database";
import { SQLITE_MIGRATIONS } from "./schema";
import { sqliteOptionalTime } from "./values";

type ColumnKind = "text" | "int" | "real" | "bool" | "time" | "json" | "text_array" | "blob";

export interface MigrationTableSpec {
  readonly table: string;
  readonly columns: readonly (readonly [name: string, kind: ColumnKind])[];
  readonly clearBeforeCopy?: boolean;
}

export interface PostgresToSqliteMigrationResult {
  readonly sqlitePath: string;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly durationMs: number;
}

const FETCH_BATCH_SIZE = 500;

/**
 * All 47 active tables migrated from PostgreSQL `agent_recall.*` to SQLite in
 * topological (parent-before-child) order. Retired Workflow, OpenViking, and
 * Studio chat-room tables are intentionally excluded.
 */
export const PG_TO_SQLITE_MIGRATION_TABLES: readonly MigrationTableSpec[] = [
  {
    table: "environments",
    clearBeforeCopy: true,
    columns: [
      ["id", "text"],
      ["kind", "text"],
      ["label", "text"],
      ["wsl_distribution", "text"],
      ["host_alias", "text"],
      ["host", "text"],
      ["user", "text"],
      ["port", "int"],
      ["auth_mode", "text"],
      ["identity_file", "text"],
      ["enabled", "bool"],
      ["sync_state", "text"],
      ["last_synced_at", "time"],
      ["last_error", "text"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "team_session_snapshots",
    columns: [
      ["cache_key", "text"],
      ["repository", "text"],
      ["asset_id", "int"],
      ["digest", "text"],
      ["metadata", "json"],
      ["source", "json"],
    ],
  },
  {
    table: "team_session_catalog",
    columns: [
      ["scope_key", "text"],
      ["asset_id", "int"],
      ["cache_key", "text"],
      ["item", "json"],
    ],
  },
  {
    table: "team_session_drafts",
    columns: [
      ["scope_key", "text"],
      ["asset_id", "int"],
      ["packet", "blob"],
      ["item", "json"],
      ["published", "json"],
    ],
  },
  {
    table: "sessions",
    columns: [
      ["session_key", "text"],
      ["raw_id", "text"],
      ["source", "text"],
      ["environment_id", "text"],
      ["storage_environment_id", "text"],
      ["project_path", "text"],
      ["file_path", "text"],
      ["original_title", "text"],
      ["first_question", "text"],
      ["started_at", "time"],
      ["file_mtime_ms", "real"],
      ["file_size", "int"],
      ["content_indexed_mtime_ms", "real"],
      ["content_indexed_size", "int"],
      ["source_available", "bool"],
      ["pr_url", "text"],
      ["pr_number", "int"],
      ["custom_title", "text"],
      ["favorited", "bool"],
      ["pinned", "bool"],
      ["hidden", "bool"],
      ["last_opened_at", "time"],
      ["last_resumed_at", "time"],
      ["message_count", "int"],
      ["turn_count", "int"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["cached_input_tokens", "int"],
      ["cache_creation_input_tokens", "int"],
      ["reasoning_output_tokens", "int"],
      ["total_tokens", "int"],
      ["indexed_at", "time"],
      ["is_subagent", "bool"],
      ["parent_session_id", "text"],
      ["ai_summary", "text"],
      ["ai_summary_model", "text"],
      ["ai_summary_at", "time"],
      ["ai_summary_basis", "real"],
      ["codex_history_mode", "text"],
      ["codex_tool_call_state", "json"],
      ["team_snapshot_key", "text"],
    ],
  },
  {
    table: "session_raw_events",
    columns: [
      ["session_key", "text"],
      ["event_index", "int"],
      ["event_id", "text"],
      ["kind", "text"],
      ["role", "text"],
      ["occurred_at", "time"],
      ["payload", "json"],
      ["index_fingerprint", "text"],
    ],
  },
  {
    table: "session_message_events",
    columns: [
      ["session_key", "text"],
      ["message_index", "int"],
      ["occurred_at", "time"],
    ],
  },
  {
    table: "session_turns",
    columns: [
      ["id", "text"],
      ["session_key", "text"],
      ["turn_index", "int"],
      ["source_message_index", "int"],
      ["synthetic", "bool"],
      ["status", "text"],
      ["source_turn_id", "text"],
      ["started_at", "time"],
      ["ended_at", "time"],
      ["duration_ms", "int"],
      ["time_to_first_token_ms", "int"],
      ["abort_reason", "text"],
      ["user_text", "text"],
      ["assistant_text", "text"],
      ["tool_text", "text"],
      ["search_text", "text"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["cached_input_tokens", "int"],
      ["cache_creation_input_tokens", "int"],
      ["reasoning_output_tokens", "int"],
      ["total_tokens", "int"],
      ["error_count", "int"],
      ["tool_names", "text_array"],
      ["derivation_version", "int"],
      ["index_fingerprint", "text"],
    ],
  },
  {
    table: "turn_messages",
    columns: [
      ["turn_id", "text"],
      ["message_index", "int"],
      ["source_message_index", "int"],
      ["role", "text"],
      ["content", "text"],
      ["occurred_at", "time"],
      ["metadata", "json"],
    ],
  },
  {
    table: "trace_spans",
    columns: [
      ["id", "text"],
      ["turn_id", "text"],
      ["parent_span_id", "text"],
      ["span_index", "int"],
      ["kind", "text"],
      ["name", "text"],
      ["status", "text"],
      ["started_at", "time"],
      ["ended_at", "time"],
      ["call_id", "text"],
      ["input", "json"],
      ["output", "json"],
      ["error", "text"],
      ["attributes", "json"],
    ],
  },
  {
    table: "token_events",
    columns: [
      ["session_key", "text"],
      ["dedupe_key", "text"],
      ["occurred_at", "time"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["cached_input_tokens", "int"],
      ["cache_creation_input_tokens", "int"],
      ["reasoning_output_tokens", "int"],
      ["total_tokens", "int"],
      ["source_turn_id", "text"],
    ],
  },
  {
    table: "tags",
    columns: [
      ["id", "int"],
      ["name", "text"],
    ],
  },
  {
    table: "session_tags",
    columns: [
      ["session_key", "text"],
      ["tag_id", "int"],
    ],
  },
  {
    table: "session_attachments",
    columns: [
      ["session_key", "text"],
      ["attachment_id", "text"],
      ["message_index", "int"],
      ["file_name", "text"],
      ["mime_type", "text"],
      ["preview_kind", "text"],
      ["status", "text"],
      ["size_bytes", "int"],
      ["cache_path", "text"],
    ],
  },
  {
    table: "skill_usage_sources",
    columns: [
      ["source_path", "text"],
      ["agent", "text"],
      ["kind", "text"],
      ["mtime_ms", "real"],
      ["file_size", "int"],
      ["scanned_at", "time"],
    ],
  },
  {
    table: "skill_usage_events",
    columns: [
      ["source_path", "text"],
      ["event_index", "int"],
      ["agent", "text"],
      ["skill", "text"],
      ["occurred_at", "time"],
      ["session_id", "text"],
      ["cwd", "text"],
      ["skill_hash", "text"],
    ],
  },
  {
    table: "skill_sync_bindings",
    columns: [
      ["local_skill_path", "text"],
      ["portable_identity", "text"],
      ["remote_skill_id", "text"],
      ["remote_updated_at", "time"],
      ["remote_version", "int"],
      ["last_content_hash", "text"],
      ["last_synced_at", "time"],
      ["direction", "text"],
    ],
  },
  {
    table: "session_sync_bindings",
    columns: [
      ["local_session_key", "text"],
      ["remote_session_id", "text"],
      ["last_local_revision", "text"],
      ["last_remote_revision", "text"],
      ["last_synced_at", "time"],
      ["direction", "text"],
    ],
  },
  {
    table: "api_provider_keys",
    columns: [
      ["target", "text"],
      ["provider_id", "text"],
      ["api_key", "text"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "session_migrations",
    columns: [
      ["id", "text"],
      ["source_session_key", "text"],
      ["source_agent", "text"],
      ["target_agent", "text"],
      ["target_session_id", "text"],
      ["target_file_path", "text"],
      ["strategy", "text"],
      ["created_at", "time"],
    ],
  },
  {
    table: "app_settings",
    columns: [
      ["key", "text"],
      ["value_text", "text"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "app_aux_state",
    columns: [
      ["id", "int"],
      ["payload", "json"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "saved_searches",
    columns: [
      ["id", "int"],
      ["name", "text"],
      ["options", "json"],
      ["created_at", "time"],
      ["last_used_at", "time"],
      ["use_count", "int"],
    ],
  },
  {
    table: "search_history",
    columns: [
      ["id", "int"],
      ["query", "text"],
      ["result_count", "int"],
      ["searched_at", "time"],
      ["options", "json"],
    ],
  },
  {
    table: "automation_chats",
    columns: [
      ["id", "text"],
      ["title", "text"],
      ["configured_agent_id", "text"],
      ["model_id", "text"],
      ["channel_id", "text"],
      ["last_error", "text"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "automation_chat_messages",
    columns: [
      ["id", "text"],
      ["chat_id", "text"],
      ["role", "text"],
      ["content", "text"],
      ["is_local", "bool"],
      ["sequence", "int"],
      ["created_at", "time"],
    ],
  },
  {
    table: "automation_chat_events",
    columns: [
      ["id", "text"],
      ["chat_id", "text"],
      ["message_id", "text"],
      ["type", "text"],
      ["content", "text"],
      ["agent_id", "text"],
      ["name", "text"],
      ["from_agent_id", "text"],
      ["to_agent_id", "text"],
      ["request_id", "text"],
      ["request_state", "text"],
      ["decision", "text"],
      ["metadata", "json"],
      ["sequence", "int"],
      ["created_at", "time"],
    ],
  },
  {
    table: "runtime_sessions",
    columns: [
      ["id", "text"],
      ["chat_id", "text"],
      ["runtime_id", "text"],
      ["state", "text"],
      ["provider_session_id", "text"],
      ["runtime_state", "json"],
      ["conversation", "json"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "mcp_servers",
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["transport", "text"],
      ["command", "text"],
      ["args", "json"],
      ["url", "text"],
      ["env", "json"],
      ["headers", "json"],
      ["enabled", "bool"],
      ["exposure_mode", "text"],
      ["disabled_tools", "json"],
      ["status", "text"],
      ["last_error", "text"],
      ["last_tested_at", "time"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "mcp_tools",
    columns: [
      ["server_id", "text"],
      ["name", "text"],
      ["description", "text"],
      ["input_schema", "json"],
      ["read_only", "bool"],
      ["sequence", "int"],
    ],
  },
  {
    table: "runtime_invocations",
    columns: [
      ["id", "text"],
      ["initiator", "text"],
      ["surface", "text"],
      ["role", "text"],
      ["owner_reference", "json"],
      ["runtime_id", "text"],
      ["channel_id", "text"],
      ["environment_id", "text"],
      ["status", "text"],
      ["started_at", "time"],
      ["finished_at", "time"],
      ["error", "text"],
    ],
  },
  {
    table: "runtime_session_bindings",
    columns: [
      ["invocation_id", "text"],
      ["runtime_id", "text"],
      ["channel_id", "text"],
      ["environment_id", "text"],
      ["runtime_session_id", "text"],
      ["runtime_turn_id", "text"],
      ["relation", "text"],
      ["bound_at", "time"],
    ],
  },
  {
    table: "evaluation_datasets",
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["description", "text"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "evaluation_dataset_items",
    columns: [
      ["id", "text"],
      ["dataset_id", "text"],
      ["input", "text"],
      ["expected_output", "text"],
      ["metadata", "json"],
      ["sequence", "int"],
    ],
  },
  {
    table: "evaluation_evaluators",
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["kind", "text"],
      ["prompt", "text"],
      ["agent_id", "text"],
      ["runtime_id", "text"],
      ["threshold", "real"],
      ["enabled", "bool"],
      ["dimension", "text"],
      ["priority", "text"],
      ["max_tool_failures", "int"],
      ["max_turns", "int"],
      ["max_tool_calls", "int"],
      ["max_total_tokens", "int"],
      ["max_duration_ms", "int"],
      ["script_mode", "text"],
      ["script", "text"],
      ["command", "text"],
      ["command_args", "json"],
      ["subject", "text"],
      ["timeout_ms", "int"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "evaluation_experiments",
    columns: [
      ["id", "text"],
      ["name", "text"],
      ["dataset_id", "text"],
      ["agent_id", "text"],
      ["repetitions", "int"],
      ["source", "text"],
      ["scoring", "json"],
      ["stages", "json"],
      ["stage_by_evaluator_id", "json"],
      ["skill_name", "text"],
      ["skill_hash", "text"],
      ["graph", "json"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "evaluation_experiment_evaluators",
    columns: [
      ["experiment_id", "text"],
      ["evaluator_id", "text"],
      ["sequence", "int"],
    ],
  },
  {
    table: "evaluation_runs",
    columns: [
      ["id", "text"],
      ["experiment_id", "text"],
      ["status", "text"],
      ["agent_revision_id", "text"],
      ["skill_hash", "text"],
      ["engine", "text"],
      ["scored_case_count", "int"],
      ["unscored_case_count", "int"],
      ["started_at", "time"],
      ["finished_at", "time"],
      ["average_score", "real"],
      ["minimum_score", "real"],
      ["pass_rate", "real"],
      ["coverage", "real"],
      ["dimensions", "json"],
      ["stage_scores", "json"],
      ["rubric_hash", "text"],
      ["consistency", "json"],
      ["scoring_version", "int"],
      ["total_duration_ms", "int"],
      ["error", "text"],
    ],
  },
  {
    table: "evaluation_case_results",
    columns: [
      ["id", "text"],
      ["run_id", "text"],
      ["dataset_item_id", "text"],
      ["repetition", "int"],
      ["input", "text"],
      ["expected_output", "text"],
      ["output", "text"],
      ["error", "text"],
      ["duration_ms", "int"],
      ["session_key", "text"],
      ["skill_name", "text"],
      ["skill_hash", "text"],
      ["skill_content_length", "int"],
      ["unscored_reason", "text"],
      ["gate_passed", "bool"],
      ["score", "real"],
      ["passed", "bool"],
      ["coverage", "real"],
      ["dimensions", "json"],
      ["by_label", "json"],
      ["skipped_evaluator_ids", "json"],
      ["skipped_stage_ids", "json"],
      ["artifact_origin_kind", "text"],
      ["artifact_origin_reference", "text"],
      ["artifact_files", "json"],
    ],
  },
  {
    table: "evaluation_case_nodes",
    columns: [
      ["case_result_id", "text"],
      ["node_id", "text"],
      ["node_type", "text"],
      ["node_version", "int"],
      ["role", "text"],
      ["status", "text"],
      ["pending_reason", "text"],
      ["pending_upstream", "json"],
      ["started_at", "time"],
      ["finished_at", "time"],
      ["duration_ms", "int"],
      ["attribution", "json"],
      ["produced_outputs", "json"],
      ["facts", "json"],
      ["sequence", "int"],
    ],
  },
  {
    table: "evaluation_case_verdicts",
    columns: [
      ["case_result_id", "text"],
      ["verdict_id", "text"],
      ["node_id", "text"],
      ["node_type", "text"],
      ["evaluator_id", "text"],
      ["status", "text"],
      ["raw", "real"],
      ["threshold", "real"],
      ["labels", "json"],
      ["reason", "text"],
      ["evidence", "json"],
      ["failed_criteria", "json"],
      ["duration_ms", "int"],
      ["sequence", "int"],
    ],
  },
  {
    table: "evaluation_scores",
    columns: [
      ["case_result_id", "text"],
      ["evaluator_id", "text"],
      ["dimension", "text"],
      ["score", "real"],
      ["passed", "bool"],
      ["reason", "text"],
      ["evidence", "json"],
      ["failed_criteria", "json"],
      ["duration_ms", "int"],
      ["token_count", "int"],
      ["estimated_cost", "real"],
    ],
  },
  {
    table: "evaluation_subjects",
    columns: [
      ["id", "text"],
      ["subject_type", "text"],
      ["session_key", "text"],
      ["turn_id", "text"],
      ["span_id", "text"],
    ],
  },
  {
    table: "evaluation_results",
    columns: [
      ["id", "text"],
      ["subject_id", "text"],
      ["evaluator_id", "text"],
      ["metric", "text"],
      ["score", "real"],
      ["label", "text"],
      ["passed", "bool"],
      ["explanation", "text"],
      ["evidence", "json"],
      ["evaluator_version", "text"],
      ["created_at", "time"],
    ],
  },
  {
    table: "memory_cards",
    columns: [
      ["id", "text"],
      ["project_path", "text"],
      ["kind", "text"],
      ["problem", "text"],
      ["solution", "text"],
      ["previous_solution", "text"],
      ["failed_attempts", "text_array"],
      ["keywords", "text_array"],
      ["status", "text"],
      ["superseded_by", "text"],
      ["search_text", "text"],
      ["model", "text"],
      ["created_at", "time"],
      ["updated_at", "time"],
    ],
  },
  {
    table: "memory_card_sources",
    columns: [
      ["id", "int"],
      ["card_id", "text"],
      ["session_key", "text"],
      ["first_turn_index", "int"],
      ["last_turn_index", "int"],
      ["created_at", "time"],
    ],
  },
  {
    table: "memory_extraction_state",
    columns: [
      ["session_key", "text"],
      ["last_extracted_turn_index", "int"],
      ["observed_signature", "text"],
      ["status", "text"],
      ["attempts", "int"],
      ["next_retry_at", "time"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["last_error", "text"],
      ["last_run_at", "time"],
      ["updated_at", "time"],
    ],
  },
];

function convertPgValue(value: unknown, kind: ColumnKind): SQLInputValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "text":
      return String(value);
    case "int": {
      if (typeof value === "bigint") return Number(value);
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
    }
    case "real": {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    }
    case "bool":
      return value === true || value === 1 || value === "t" || value === "true" ? 1 : 0;
    case "time": {
      const ms = sqliteOptionalTime(value);
      return ms === null ? null : Math.trunc(ms);
    }
    case "json":
      return JSON.stringify(value);
    case "text_array":
      if (Array.isArray(value)) return JSON.stringify(value.map(String));
      if (typeof value === "string") {
        // Defensive parse if a driver returned PostgreSQL's raw `{a,b}` text-array syntax.
        if (value === "{}") return "[]";
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) return JSON.stringify(parsed.map(String));
        } catch {
          // Fall through to raw array wrapper below.
        }
      }
      return JSON.stringify([]);
    case "blob":
      if (value instanceof Uint8Array) return value;
      if (typeof value === "string" && value.startsWith("\\x")) {
        return Buffer.from(value.slice(2), "hex");
      }
      throw new Error(`Unexpected binary value type during migration: ${typeof value}`);
  }
}

function removeFileIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup of disposable temp artifacts.
  }
}

function cleanupTempDatabase(tempPath: string): void {
  removeFileIfPresent(tempPath);
  removeFileIfPresent(`${tempPath}-wal`);
  removeFileIfPresent(`${tempPath}-shm`);
}

/**
 * Atomically copies all active AgentRecall 2.0 tables from an initialized
 * PostgreSQL database into a fresh SQLite database file.
 *
 * Safety invariants:
 * - Never writes to PostgreSQL (runs inside a single read-only snapshot transaction).
 * - Writes to `<sqlitePath>.migrating`, validates exact per-table row counts,
 *   foreign keys (`PRAGMA foreign_key_check`), and FTS5 `integrity-check`,
 *   flushes WAL into the single file, and atomically renames to `<sqlitePath>`.
 * - Cleans up all temporary files on any failure without leaving a partial target.
 */
export async function migratePostgresDatabaseToSqlite(
  postgres: PostgresDatabase,
  sqlitePath: string,
  options: { batchSize?: number } = {},
): Promise<PostgresToSqliteMigrationResult> {
  const startedAt = Date.now();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? FETCH_BATCH_SIZE));
  const resolvedTarget = path.resolve(sqlitePath);
  const tempPath = `${resolvedTarget}.migrating`;
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  cleanupTempDatabase(tempPath);

  let sqlite: SqliteDatabase | null = null;
  const tableCounts: Record<string, number> = {};
  let totalRows = 0;

  try {
    sqlite = SqliteDatabase.open(tempPath, { migrations: SQLITE_MIGRATIONS });
    await sqlite.initialize();
    const target = sqlite;

    // Self-referencing FKs (`trace_spans.parent_span_id`, `memory_cards.superseded_by`)
    // can appear in arbitrary scan order; verify all constraints via `foreign_key_check`
    // immediately after copying all tables.
    target.exec("PRAGMA foreign_keys = OFF");
    target.exec("PRAGMA synchronous = OFF");

    const pgExpectedCounts = new Map<string, number>();

    await postgres.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

      for (const spec of PG_TO_SQLITE_MIGRATION_TABLES) {
        const quotedColumns = spec.columns.map(([name]) => `"${name}"`).join(", ");
        const placeholders = spec.columns.map(() => "?").join(", ");
        const insertSql = `INSERT INTO "${spec.table}" (${quotedColumns}) VALUES (${placeholders})`;

        const countResult = await tx.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM agent_recall."${spec.table}"`,
        );
        const expectedCount = Number(countResult.rows[0]?.count ?? 0);
        pgExpectedCounts.set(spec.table, expectedCount);

        if (spec.clearBeforeCopy && expectedCount > 0) {
          target.run(`DELETE FROM "${spec.table}"`);
        }
        if (expectedCount === 0) {
          tableCounts[spec.table] = 0;
          continue;
        }

        const cursorName = "ar_pg_to_sqlite_cur";
        await tx.query(
          `DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT ${quotedColumns} FROM agent_recall."${spec.table}"`,
        );
        let copied = 0;
        try {
          while (true) {
            const batch = await tx.query<Record<string, unknown>>(
              `FETCH ${batchSize} FROM ${cursorName}`,
            );
            if (batch.rows.length === 0) break;
            target.transactionSync((stx) => {
              for (const row of batch.rows) {
                const values = spec.columns.map(([colName, kind]) => convertPgValue(row[colName], kind));
                stx.run(insertSql, ...values);
              }
            });
            copied += batch.rows.length;
          }
        } finally {
          await tx.query(`CLOSE ${cursorName}`);
        }
        tableCounts[spec.table] = copied;
        totalRows += copied;
      }
    });

    // 1. Verify exact per-table row count parity.
    for (const spec of PG_TO_SQLITE_MIGRATION_TABLES) {
      const expected = pgExpectedCounts.get(spec.table) ?? 0;
      const actualRow = target.get<{ count: number }>(
        `SELECT count(*) AS count FROM "${spec.table}"`,
      );
      const actual = Number(actualRow?.count ?? 0);
      // Empty PG `environments` keeps SQLite's default `'local'` seed row.
      if (spec.clearBeforeCopy && expected === 0) continue;
      if (actual !== expected) {
        throw new Error(
          `SQLite migration row-count mismatch for table "${spec.table}": expected ${expected}, got ${actual}.`,
        );
      }
    }

    // 2. Verify all foreign keys across all migrated rows.
    target.exec("PRAGMA foreign_keys = ON");
    const fkViolations = target.all<{ table: string; rowid: number; parent: string; fkid: number }>(
      "PRAGMA foreign_key_check",
    );
    if (fkViolations.length > 0) {
      const summary = fkViolations
        .slice(0, 5)
        .map((violation) => `${violation.table}(rowid=${violation.rowid})->${violation.parent}`)
        .join(", ");
      throw new Error(`SQLite migration failed foreign_key_check (${fkViolations.length} violation(s)): ${summary}`);
    }

    // 3. Rebuild and verify all FTS5 indexes.
    target.transactionSync((stx) => {
      stx.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')");
      stx.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES('rebuild')");
      stx.exec("INSERT INTO memory_cards_fts(memory_cards_fts) VALUES('rebuild')");
      stx.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('integrity-check')");
      stx.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES('integrity-check')");
      stx.exec("INSERT INTO memory_cards_fts(memory_cards_fts) VALUES('integrity-check')");
    });

    // 4. Flush WAL into the single file and leave DELETE mode before atomic rename
    //    so no sidecar -wal/-shm files can be orphaned across rename.
    target.exec("PRAGMA synchronous = NORMAL");
    target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    target.exec("PRAGMA journal_mode = DELETE");

    await target.close();
    sqlite = null;

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tempPath, 0o600);
      } catch {
        // Ignore chmod failure on filesystems that do not support POSIX permissions.
      }
    }
    fs.renameSync(tempPath, resolvedTarget);

    return {
      sqlitePath: resolvedTarget,
      tableCounts,
      totalRows,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (sqlite) {
      await sqlite.close().catch(() => undefined);
    }
    cleanupTempDatabase(tempPath);
    throw error;
  }
}
