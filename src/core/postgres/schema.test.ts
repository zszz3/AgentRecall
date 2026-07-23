import { describe, expect, it } from "vitest";
import { PostgresDatabase } from "./database";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

describe("AgentRecall PostgreSQL schema", () => {
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
    ]));
    expect(names).toHaveLength(48);
    await database.close();
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
});
