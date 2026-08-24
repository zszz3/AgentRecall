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
      "workflow_node_runs",
      "workflow_artifacts",
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
      "openviking_import_tasks",
      "openviking_imported_sessions",
      "openviking_imported_turns",
      "openviking_memories",
      "openviking_memory_evidence",
      "openviking_memory_feedback",
      "openviking_commit_runs",
      "openviking_operation_events",
      "openviking_recall_traces",
    ]));
    expect(names).toHaveLength(63);
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
    for (const tableName of ["sessions", "session_turns", "token_events"]) {
      const cacheCreationColumns = await database.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'agent_recall'
          and table_name = $1
          and column_name = 'cache_creation_input_tokens'
      `, [tableName]);
      expect(cacheCreationColumns.rows).toEqual([{ column_name: "cache_creation_input_tokens" }]);
    }
    const workflowColumns = await database.query<{ column_name: string; data_type: string; is_nullable: string }>(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'agent_recall'
        and table_name = 'workflows'
        and column_name in ('name', 'description', 'definition')
      order by column_name
    `);
    expect(workflowColumns.rows).toEqual([
      { column_name: "definition", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "description", data_type: "text", is_nullable: "NO" },
      { column_name: "name", data_type: "text", is_nullable: "NO" },
    ]);
    await database.close();
  });

  it("adds Codex tool-call state storage and invalidates affected sessions exactly once", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 40),
    });
    await legacyDatabase.initialize();
    await legacyDatabase.query("alter table agent_recall.sessions drop column codex_tool_call_state");
    await legacyDatabase.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at,
        content_indexed_mtime_ms, content_indexed_size
      ) values
        ('codex:tool-state', 'tool-state', 'codex-cli', 'local', '/repo', '/tmp/codex.jsonl',
          'Title', 'Question', now(), 123, 456, now(), 123, 456),
        ('claude:unchanged', 'unchanged', 'claude-cli', 'local', '/repo', '/tmp/claude.jsonl',
          'Title', 'Question', now(), 123, 456, now(), 123, 456)
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const column = await upgradedDatabase.query<{ data_type: string }>(`
      select data_type
      from information_schema.columns
      where table_schema = 'agent_recall'
        and table_name = 'sessions'
        and column_name = 'codex_tool_call_state'
    `);
    expect(column.rows).toEqual([{ data_type: "jsonb" }]);
    const freshness = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number;
      content_indexed_mtime_ms: number;
      content_indexed_size: number;
    }>(`
      select session_key, file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key in ('codex:tool-state', 'claude:unchanged')
      order by session_key
    `);
    expect(freshness.rows).toEqual([
      {
        session_key: "claude:unchanged",
        file_mtime_ms: 123,
        content_indexed_mtime_ms: 123,
        content_indexed_size: 456,
      },
      {
        session_key: "codex:tool-state",
        file_mtime_ms: 0,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
      },
    ]);

    await upgradedDatabase.query(`
      update agent_recall.sessions
      set file_mtime_ms = 789, content_indexed_mtime_ms = 789, content_indexed_size = 987
      where session_key = 'codex:tool-state'
    `);
    const reopenedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await reopenedDatabase.initialize();
    const preserved = await reopenedDatabase.query<{
      file_mtime_ms: number;
      content_indexed_mtime_ms: number;
      content_indexed_size: number;
    }>(`
      select file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key = 'codex:tool-state'
    `);
    expect(preserved.rows).toEqual([{
      file_mtime_ms: 789,
      content_indexed_mtime_ms: 789,
      content_indexed_size: 987,
    }]);

    await reopenedDatabase.close();
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
      where table_schema = 'agent_recall' and table_name = 'workflow_node_runs'
    `);
    expect(workflowColumns.rows.map((row) => row.column_name)).toContain("outputs");

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

  it("reconciles the OpenViking branch migration versions with Codex metadata", async () => {
    const pool = new PGliteTestPool();
    const branchDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 15),
    });
    await branchDatabase.initialize();
    await branchDatabase.query(`
      DROP INDEX IF EXISTS agent_recall.session_turns_source_turn_idx;
      ALTER TABLE agent_recall.sessions DROP COLUMN IF EXISTS codex_history_mode;
      ALTER TABLE agent_recall.session_turns
        DROP COLUMN IF EXISTS source_turn_id,
        DROP COLUMN IF EXISTS duration_ms,
        DROP COLUMN IF EXISTS time_to_first_token_ms,
        DROP COLUMN IF EXISTS abort_reason;
      ALTER TABLE agent_recall.token_events DROP COLUMN IF EXISTS source_turn_id;
    `);

    for (const version of [19, 20, 21, 22]) {
      const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === version)!;
      for (const statement of migration.statements) await branchDatabase.query(statement);
    }
    await branchDatabase.query(`
      insert into agent_recall.schema_migrations (version, name) values
        (16, 'track incremental OpenViking Session imports'),
        (17, 'persist resumable OpenViking import tasks'),
        (18, 'preserve planned OpenViking import order'),
        (19, 'persist selected OpenViking import sessions');
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const columns = await upgradedDatabase.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'agent_recall'
        and (table_name, column_name) in (
          ('sessions', 'codex_history_mode'),
          ('session_turns', 'source_turn_id'),
          ('session_turns', 'duration_ms'),
          ('session_turns', 'time_to_first_token_ms'),
          ('session_turns', 'abort_reason'),
          ('token_events', 'source_turn_id')
        )
      order by table_name, column_name
    `);
    expect(columns.rows).toEqual([
      { table_name: "session_turns", column_name: "abort_reason" },
      { table_name: "session_turns", column_name: "duration_ms" },
      { table_name: "session_turns", column_name: "source_turn_id" },
      { table_name: "session_turns", column_name: "time_to_first_token_ms" },
      { table_name: "sessions", column_name: "codex_history_mode" },
      { table_name: "token_events", column_name: "source_turn_id" },
    ]);
    await upgradedDatabase.close();
  });

  it("reconciles the directory memory migration previously recorded as version 27", async () => {
    const pool = new PGliteTestPool();
    const branchDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 26),
    });
    await branchDatabase.initialize();

    const directoryMemoryMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 28)!;
    for (const statement of directoryMemoryMigration.statements) {
      await branchDatabase.query(statement);
    }
    await branchDatabase.query(`
      ALTER TABLE agent_recall.evaluation_runs DROP COLUMN IF EXISTS skill_hash;
      INSERT INTO agent_recall.schema_migrations (version, name)
      VALUES (27, 'add directory memory control plane');
      INSERT INTO agent_recall.openviking_workspaces (
        id, user_id, root_path, identity, display_name, managed, created_at, updated_at
      ) VALUES (
        'legacy-workspace', 'legacy-user', '/legacy', 'legacy-identity', 'Legacy', true, now(), now()
      );
      INSERT INTO agent_recall.openviking_memories (
        workspace_id, uri, memory_type, created_at, updated_at
      ) VALUES (
        'legacy-workspace', 'viking://legacy/memory', 'profile', now(), now()
      );
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const evaluationColumns = await upgradedDatabase.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_recall'
        AND table_name = 'evaluation_runs'
        AND column_name = 'skill_hash'
    `);
    expect(evaluationColumns.rows).toEqual([{ column_name: "skill_hash" }]);

    const memory = await upgradedDatabase.query<{ uri: string }>(`
      SELECT uri FROM agent_recall.openviking_memories WHERE workspace_id = 'legacy-workspace'
    `);
    expect(memory.rows).toEqual([{ uri: "viking://legacy/memory" }]);

    const migrations = await upgradedDatabase.query<{ version: number; name: string }>(`
      SELECT version, name
      FROM agent_recall.schema_migrations
      WHERE version IN (27, 28, 29)
      ORDER BY version
    `);
    expect(migrations.rows).toEqual([
      { version: 27, name: "add directory memory control plane" },
      { version: 28, name: "add directory memory control plane" },
      { version: 29, name: "reconcile directory memory and evaluation migration histories" },
    ]);
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
      expect.objectContaining({ column_name: "source_turn_id", udt_name: "text" }),
      expect.objectContaining({ column_name: "duration_ms", udt_name: "int8" }),
      expect.objectContaining({ column_name: "time_to_first_token_ms", udt_name: "int8" }),
      expect.objectContaining({ column_name: "abort_reason", udt_name: "text" }),
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
      "session_turns_source_turn_idx",
      "evaluation_results_subject_idx",
    ]));

    const extension = await database.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'pg_trgm'",
    );
    expect(extension.rows).toEqual([{ extname: "pg_trgm" }]);
    await database.close();
  });

  it("invalidates Codex and Claude content freshness once while preserving user state", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 16),
    });
    await legacyDatabase.initialize();
    const sessionSources = [
      "claude-app",
      "claude-cli",
      "codex-app",
      "codex-cli",
      "tclaude-cli",
      "tcodex-cli",
    ];
    for (const source of sessionSources) {
      await legacyDatabase.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            custom_title, favorited, hidden, indexed_at,
            content_indexed_mtime_ms, content_indexed_size
          )
          values (
            $1, $2, $3, 'local', '/repo', $4,
            'Title', 'Question', now(), 123, 456,
            $5, true, true, now(), 123, 456
          )
        `,
        [`${source}:session`, source, source, `/tmp/${source}.jsonl`, `Custom ${source}`],
      );
    }
    await legacyDatabase.query("insert into agent_recall.tags (name) values ('keep-me')");
    await legacyDatabase.query(`
      insert into agent_recall.session_tags (session_key, tag_id)
      select 'codex-cli:session', id from agent_recall.tags where name = 'keep-me'
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const rows = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number | string;
      file_size: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      custom_title: string;
      favorited: boolean;
      hidden: boolean;
    }>(`
      select session_key, file_mtime_ms, file_size,
        content_indexed_mtime_ms, content_indexed_size,
        custom_title, favorited, hidden
      from agent_recall.sessions
      order by session_key
    `);
    expect(rows.rows.map((row) => ({
      ...row,
      file_mtime_ms: Number(row.file_mtime_ms),
      file_size: Number(row.file_size),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual(
      [...sessionSources].sort().map((source) => ({
        session_key: `${source}:session`,
        file_mtime_ms: 0,
        file_size: 456,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
        custom_title: `Custom ${source}`,
        favorited: true,
        hidden: true,
      })),
    );
    const tags = await upgradedDatabase.query<{ name: string }>(`
      select tags.name
      from agent_recall.tags tags
      join agent_recall.session_tags session_tags on session_tags.tag_id = tags.id
      where session_tags.session_key = 'codex-cli:session'
    `);
    expect(tags.rows).toEqual([{ name: "keep-me" }]);

    await upgradedDatabase.query(`
      update agent_recall.sessions
      set file_mtime_ms = 789,
          content_indexed_mtime_ms = 789,
          content_indexed_size = 456
      where session_key = 'codex-cli:session'
    `);
    const repeatedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await repeatedDatabase.initialize();
    const repeated = await repeatedDatabase.query<{
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key = 'codex-cli:session'
    `);
    expect(repeated.rows.map((row) => ({
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([{
      file_mtime_ms: 789,
      content_indexed_mtime_ms: 789,
      content_indexed_size: 456,
    }]);
    await repeatedDatabase.close();
  });

  it("invalidates Codex sessions once so nested tool trace details are reparsed", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 17),
    });
    await legacyDatabase.initialize();
    const sessionSources = ["claude-cli", "codex-app", "codex-cli", "tcodex-cli"];
    for (const source of sessionSources) {
      await legacyDatabase.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            custom_title, favorited, hidden, indexed_at,
            content_indexed_mtime_ms, content_indexed_size
          )
          values (
            $1, $2, $3, 'local', '/repo', $4,
            'Title', 'Question', now(), 123, 456,
            $5, true, true, now(), 123, 456
          )
        `,
        [`${source}:session`, source, source, `/tmp/${source}.jsonl`, `Custom ${source}`],
      );
    }

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const rows = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      custom_title: string;
      favorited: boolean;
    }>(`
      select session_key, file_mtime_ms, content_indexed_mtime_ms, content_indexed_size,
        custom_title, favorited
      from agent_recall.sessions
      order by session_key
    `);
    expect(rows.rows.map((row) => ({
      ...row,
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual(
      [...sessionSources].sort().map((source) => ({
        session_key: `${source}:session`,
        file_mtime_ms: 0,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
        custom_title: `Custom ${source}`,
        favorited: true,
      })),
    );

    await upgradedDatabase.query(`
      update agent_recall.sessions
      set file_mtime_ms = 789,
          content_indexed_mtime_ms = 789,
          content_indexed_size = 456
      where session_key = 'codex-cli:session'
    `);
    const repeatedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await repeatedDatabase.initialize();
    const repeated = await repeatedDatabase.query<{
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
    }>(`
      select file_mtime_ms, content_indexed_mtime_ms
      from agent_recall.sessions
      where session_key = 'codex-cli:session'
    `);
    expect(repeated.rows.map((row) => ({
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
    }))).toEqual([{ file_mtime_ms: 789, content_indexed_mtime_ms: 789 }]);
    await repeatedDatabase.close();
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

  it("invalidates sessions whose stored user turns contain injected collaboration noise", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 27),
    });
    await legacyDatabase.initialize();
    await legacyDatabase.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size,
        message_count, turn_count, input_tokens, output_tokens,
        cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
        content_indexed_mtime_ms, content_indexed_size, is_subagent
      ) values
        ('codex:dirty', 'dirty', 'codex-cli', 'local', '/repo', '/dirty.jsonl',
          'Dirty', 'Question', now(), 123, 456, 1, 1, 0, 0, 0, 0, 0, now(), 123, 456, false),
        ('codex:clean', 'clean', 'codex-cli', 'local', '/repo', '/clean.jsonl',
          'Clean', 'Question', now(), 123, 456, 1, 1, 0, 0, 0, 0, 0, now(), 123, 456, false);

      insert into agent_recall.session_turns (
        id, session_key, turn_index, synthetic, status,
        user_text, assistant_text, tool_text, search_text,
        input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
        total_tokens, error_count, tool_names, derivation_version
      ) values
        ('turn:dirty', 'codex:dirty', 0, false, 'completed', 'noise', '', '', 'noise',
          0, 0, 0, 0, 0, 0, '{}', 4),
        ('turn:clean', 'codex:clean', 0, false, 'completed', 'real prompt', '', '', 'real prompt',
          0, 0, 0, 0, 0, 0, '{}', 4);

      insert into agent_recall.turn_messages (
        turn_id, message_index, source_message_index, role, content, metadata
      ) values
        ('turn:dirty', 0, 0, 'user',
          '<task-notification source="worker">done</task-notification>', '{}'::jsonb),
        ('turn:clean', 0, 0, 'user', 'real prompt', '{}'::jsonb);
    `);
    await legacyDatabase.query(
      "insert into agent_recall.schema_migrations (version, name) values ($1, $2)",
      [41, "covered separately: persist incremental Codex tool-call reconciliation state"],
    );

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const result = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select session_key, file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      order by session_key
    `);
    expect(result.rows.map((row) => ({
      session_key: row.session_key,
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([
      { session_key: "codex:clean", file_mtime_ms: 123, content_indexed_mtime_ms: 123, content_indexed_size: 456 },
      { session_key: "codex:dirty", file_mtime_ms: 0, content_indexed_mtime_ms: 0, content_indexed_size: 0 },
    ]);
    await upgradedDatabase.close();
  });

  it("invalidates existing Codex subagent indexes when lifecycle fallback boundaries change", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 38),
    });
    await legacyDatabase.initialize();
    await legacyDatabase.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size,
        indexed_at, content_indexed_mtime_ms, content_indexed_size,
        is_subagent, parent_session_id
      ) values
        (
          'codex:parent', 'parent', 'codex-cli', 'local', '/repo', '/parent.jsonl',
          'Parent', 'Parent', now(), 111, 222, now(), 111, 222, false, null
        ),
        (
          'codex:child', 'child', 'codex-cli', 'local', '/repo', '/child.jsonl',
          'Child', 'Child', now(), 333, 444, now(), 333, 444, true, 'parent'
        );
    `);
    await legacyDatabase.query(
      "insert into agent_recall.schema_migrations (version, name) values ($1, $2)",
      [41, "covered separately: persist incremental Codex tool-call reconciliation state"],
    );

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const result = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select session_key, file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key in ('codex:parent', 'codex:child')
      order by session_key
    `);
    expect(result.rows.map((row) => ({
      ...row,
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([
      {
        session_key: "codex:child",
        file_mtime_ms: 0,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
      },
      {
        session_key: "codex:parent",
        file_mtime_ms: 111,
        content_indexed_mtime_ms: 111,
        content_indexed_size: 222,
      },
    ]);

    await upgradedDatabase.query(`
      update agent_recall.sessions
      set file_mtime_ms = 555,
          content_indexed_mtime_ms = 555,
          content_indexed_size = 666
      where session_key = 'codex:child'
    `);
    const repeatedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await repeatedDatabase.initialize();
    const repeated = await repeatedDatabase.query<{
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key = 'codex:child'
    `);
    expect(repeated.rows.map((row) => ({
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([{
      file_mtime_ms: 555,
      content_indexed_mtime_ms: 555,
      content_indexed_size: 666,
    }]);
    await repeatedDatabase.close();
  });

  it("invalidates existing DeepSeek token accounting exactly once", async () => {
    const pool = new PGliteTestPool();
    const legacyDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 39),
    });
    await legacyDatabase.initialize();
    await legacyDatabase.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size,
        indexed_at, content_indexed_mtime_ms, content_indexed_size, is_subagent
      ) values
        (
          'deepseek:legacy', 'legacy', 'deepseek-cli', 'local', '/repo', '/deepseek.jsonl.zstd',
          'DeepSeek', 'Question', now(), 123, 456, now(), 123, 456, false
        ),
        (
          'claude:unchanged', 'unchanged', 'claude-cli', 'local', '/repo', '/claude.jsonl',
          'Claude', 'Question', now(), 123, 456, now(), 123, 456, false
        );
    `);

    const upgradedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await upgradedDatabase.initialize();

    const result = await upgradedDatabase.query<{
      session_key: string;
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select session_key, file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key in ('deepseek:legacy', 'claude:unchanged')
      order by session_key
    `);
    expect(result.rows.map((row) => ({
      ...row,
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([
      {
        session_key: "claude:unchanged",
        file_mtime_ms: 123,
        content_indexed_mtime_ms: 123,
        content_indexed_size: 456,
      },
      {
        session_key: "deepseek:legacy",
        file_mtime_ms: 0,
        content_indexed_mtime_ms: 0,
        content_indexed_size: 0,
      },
    ]);

    await upgradedDatabase.query(`
      update agent_recall.sessions
      set file_mtime_ms = 789,
          content_indexed_mtime_ms = 789,
          content_indexed_size = 456
      where session_key = 'deepseek:legacy'
    `);
    const repeatedDatabase = new PostgresDatabase(pool, {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await repeatedDatabase.initialize();
    const repeated = await repeatedDatabase.query<{
      file_mtime_ms: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(`
      select file_mtime_ms, content_indexed_mtime_ms, content_indexed_size
      from agent_recall.sessions
      where session_key = 'deepseek:legacy'
    `);
    expect(repeated.rows.map((row) => ({
      file_mtime_ms: Number(row.file_mtime_ms),
      content_indexed_mtime_ms: Number(row.content_indexed_mtime_ms),
      content_indexed_size: Number(row.content_indexed_size),
    }))).toEqual([{
      file_mtime_ms: 789,
      content_indexed_mtime_ms: 789,
      content_indexed_size: 456,
    }]);
    await repeatedDatabase.close();
  });
});
