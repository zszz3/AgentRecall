import { describe, expect, it } from "vitest";
import { PostgresDatabase } from "./database";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

describe("AgentRecall PostgreSQL schema", () => {
  it("uses one stable record per migration version", () => {
    const versions = POSTGRES_MIGRATIONS.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
  });

  it("creates the complete internal domain schema", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();

    const tables = await database.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'agent_recall'
      order by table_name
    `);
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining([
      "sessions",
      "session_turns",
      "turn_messages",
      "session_raw_events",
      "session_message_events",
      "session_attachments",
      "saved_searches",
      "search_history",
      "trace_spans",
      "token_events",
      "skill_usage_events",
      "environments",
      "app_settings",
      "workflows",
      "workflow_runs",
      "mcp_servers",
      "evaluation_datasets",
      "evaluation_runs",
      "evaluation_subjects",
      "evaluation_results",
      "chat_rooms",
      "chat_messages",
      "chat_message_mentions",
      "chat_tasks",
      "chat_dispatch_attempts",
      "chat_attempt_events",
      "chat_workspace_reservations",
      "openviking_workspaces",
      "openviking_import_jobs",
      "openviking_imported_turns",
    ]));
    expect(names).toHaveLength(59);
    const sessionColumns = await database.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'agent_recall'
        and table_name = 'sessions'
        and column_name = 'source_available'
    `);
    expect(sessionColumns.rows).toEqual([{
      column_name: "source_available",
      is_nullable: "NO",
      column_default: "true",
    }]);
    const workflowOriginColumns = await database.query<{ column_name: string; data_type: string; is_nullable: string }>(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'agent_recall'
        and table_name = 'workflows'
        and column_name in ('origin', 'confirmed_revision', 'reviewer_configured_agent_id', 'reviewer_model_id', 'generation_review')
      order by column_name
    `);
    expect(workflowOriginColumns.rows).toEqual([
      { column_name: "confirmed_revision", data_type: "integer", is_nullable: "YES" },
      { column_name: "generation_review", data_type: "jsonb", is_nullable: "YES" },
      { column_name: "origin", data_type: "jsonb", is_nullable: "YES" },
      { column_name: "reviewer_configured_agent_id", data_type: "text", is_nullable: "YES" },
      { column_name: "reviewer_model_id", data_type: "text", is_nullable: "YES" },
    ]);
    await database.close();
  });

  it("upgrades Team Chat rooms to employee instances and directed messages", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();

    const memberColumns = await database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'chat_room_agents'
    `);
    expect(memberColumns.rows.map((row) => row.column_name)).toContain("configured_agent_id");

    const messageColumns = await database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'chat_messages'
    `);
    expect(messageColumns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "recipient_member_id",
      "delivery_type",
      "sequence",
      "based_on_sequence",
    ]));

    const sessionColumns = await database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'chat_agent_sessions'
    `);
    expect(sessionColumns.rows.map((row) => row.column_name))
      .toContain("room_context_sequence");

    await database.close();
  });

  it("reconciles databases created by the previously diverged migration histories", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 3),
    });
    await legacyDatabase.initialize();

    const openVikingMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 5)!;
    for (const statement of openVikingMigration.statements) {
      await legacyDatabase.query(statement);
    }
    await legacyDatabase.query(
      "insert into agent_recall.schema_migrations (version, name) values (4, 'add directory-scoped OpenViking memory state'), (5, 'add studio employees and directed collaboration')",
    );

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const workflowColumns = await upgradedDatabase.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'workflow_draft_messages'
    `);
    expect(workflowColumns.rows.map((row) => row.column_name)).toContain("events");

    const memberColumns = await upgradedDatabase.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'chat_room_agents'
    `);
    expect(memberColumns.rows.map((row) => row.column_name)).toContain("configured_agent_id");

    const migrations = await upgradedDatabase.query<{ version: number }>(
      "select version from agent_recall.schema_migrations order by version",
    );
    expect(migrations.rows.map((row) => Number(row.version))).toEqual(
      POSTGRES_MIGRATIONS.map((migration) => migration.version),
    );
    await upgradedDatabase.close();
  });

  it("stores Turn search and trace hierarchy as first-class PostgreSQL structures", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();

    const columns = await database.query<{
      column_name: string;
      udt_name: string;
      is_generated: string;
    }>(`
      select column_name, udt_name, is_generated
      from information_schema.columns
      where table_schema = 'agent_recall' and table_name = 'session_turns'
    `);
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ column_name: "search_vector", udt_name: "tsvector", is_generated: "ALWAYS" }),
      expect.objectContaining({ column_name: "tool_names", udt_name: "_text" }),
      expect.objectContaining({ column_name: "derivation_version", udt_name: "int4" }),
    ]));

    const indexes = await database.query<{ indexname: string }>(`
      select indexname
      from pg_indexes
      where schemaname = 'agent_recall'
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "session_turns_search_vector_idx",
      "session_turns_search_text_trgm_idx",
      "trace_spans_parent_idx",
      "evaluation_results_subject_idx",
    ]));

    const extension = await database.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'pg_trgm'",
    );
    expect(extension.rows).toEqual([{ extname: "pg_trgm" }]);
    await database.close();
  });

  it("removes tool output from existing Turn search text during upgrade", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version < 3),
    });
    await legacyDatabase.initialize();
    await legacyDatabase.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size,
        message_count, turn_count, input_tokens, output_tokens,
        cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
        is_subagent
      )
      values (
        'codex:legacy-search', 'legacy-search', 'codex-cli', 'local', '/repo', '/fixture.jsonl',
        'Legacy search', 'Find the bug', now(), 1, 1,
        2, 1, 0, 0, 0, 0, 0, now(), false
      );

      insert into agent_recall.session_turns (
        id, session_key, turn_index, synthetic, status,
        user_text, assistant_text, tool_text, search_text,
        input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
        total_tokens, error_count, tool_names, derivation_version
      )
      values (
        'turn:legacy-search', 'codex:legacy-search', 0, false, 'completed',
        'Find the bug', 'The fix is ready', 'secret tool output',
        E'Find the bug\\n\\nThe fix is ready\\n\\nsecret tool output',
        0, 0, 0, 0, 0, 0, array['shell'], 1
      );
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const result = await upgradedDatabase.query<{
      search_text: string;
      tool_text: string;
      derivation_version: number;
    }>(
      "select search_text, tool_text, derivation_version from agent_recall.session_turns where id = 'turn:legacy-search'",
    );
    expect(result.rows).toEqual([{
      search_text: "Find the bug\n\nThe fix is ready",
      tool_text: "secret tool output",
      derivation_version: 2,
    }]);
    await upgradedDatabase.close();
  });
});
