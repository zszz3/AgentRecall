export interface SqliteSchemaDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

const SCHEMA_VERSION = 8;

export function createNormalizedSchema(db: SqliteSchemaDatabase): void {
  db.exec(`create table if not exists schema_migrations (version integer primary key, applied_at integer not null);`);
  const hasLegacyWorkflowSchema = hasColumn(db, "workflows", "graph_ready")
    || hasColumn(db, "workflow_runs", "graph_id");
  if (hasLegacyWorkflowSchema) {
    db.exec(`
      drop table if exists workflow_event_artifacts;
      drop table if exists workflow_events;
      drop table if exists workflow_run_nodes;
      drop table if exists workflow_run_order;
      drop table if exists workflow_runs;
      drop table if exists workflow_run_progress;
      drop table if exists workflow_draft_messages;
      drop table if exists workflow_edges;
      drop table if exists workflow_nodes;
      drop table if exists workflow_graphs;
      drop table if exists workflows;
    `);
  }
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at integer not null
    );
    create table if not exists app_settings (
      key text primary key,
      value_text text,
      updated_at integer not null
    );
    create table if not exists app_aux_state (
      id integer primary key check (id = 1),
      payload text not null,
      updated_at integer not null
    );
    create table if not exists chats (
      id text primary key,
      title text not null,
      configured_agent_id text not null,
      model_id text,
      channel_id text,
      last_error text,
      created_at integer not null,
      updated_at integer not null
    );
    create table if not exists chat_messages (
      id text primary key,
      chat_id text not null references chats(id) on delete cascade,
      role text not null,
      content text not null,
      is_local integer not null default 0,
      sequence integer not null,
      created_at integer not null
    );
    create index if not exists chat_messages_chat_sequence on chat_messages(chat_id, sequence);
    create table if not exists chat_events (
      id text primary key,
      chat_id text not null references chats(id) on delete cascade,
      message_id text not null references chat_messages(id) on delete cascade,
      type text not null,
      content text not null,
      agent_id text,
      name text,
      from_agent_id text,
      to_agent_id text,
      request_id text,
      request_state text,
      decision text,
      metadata_json text,
      sequence integer not null,
      created_at integer not null
    );
    create index if not exists chat_events_message_sequence on chat_events(message_id, sequence);
    create table if not exists runtime_sessions (
      id text primary key,
      chat_id text not null references chats(id) on delete cascade,
      runtime_id text,
      state text,
      provider_session_id text,
      runtime_state_json text,
      conversation_json text,
      created_at integer not null,
      updated_at integer not null
    );
    create index if not exists runtime_sessions_chat on runtime_sessions(chat_id);
    create table if not exists workflows (
      id text primary key,
      title text not null,
      status text not null,
      revision integer not null,
      configured_agent_id text not null,
      model_id text not null,
      objective text not null,
      work_dir text,
      reply text not null,
      error text,
      run_context_document text not null,
      context_document text not null,
      final_report text,
      runtime_conversation_json text,
      definition_json text,
      workflow_v2_plan_json text,
      created_at integer not null,
      updated_at integer not null
    );
    create table if not exists workflow_draft_messages (
      id text primary key,
      workflow_id text not null references workflows(id) on delete cascade,
      role text not null,
      content text not null,
      sequence integer not null
    );
    create table if not exists workflow_run_progress (
      workflow_id text not null references workflows(id) on delete cascade,
      node_id text not null,
      title text not null,
      status text not null,
      detail text,
      task_id text,
      input_request_json text,
      intervention_json text,
      sequence integer not null,
      primary key (workflow_id, node_id)
    );
    create table if not exists workflow_runs (
      id text primary key,
      workflow_id text not null references workflows(id) on delete cascade,
      workflow_v2_plan_json text,
      status text not null,
      context_document text not null,
      final_report text,
      started_at integer not null,
      finished_at integer,
      last_error text
    );
    create table if not exists workflow_run_order (
      workflow_id text not null references workflows(id) on delete cascade,
      run_id text not null references workflow_runs(id) on delete cascade,
      sequence integer not null,
      primary key (workflow_id, run_id)
    );
    create table if not exists workflow_run_nodes (
      run_id text not null references workflow_runs(id) on delete cascade,
      node_id text not null,
      title text not null,
      status text not null,
      detail text,
      task_id text,
      input_request_json text,
      intervention_json text,
      sequence integer not null,
      primary key (run_id, node_id)
    );
    create table if not exists workflow_events (
      id text primary key,
      run_id text not null references workflow_runs(id) on delete cascade,
      node_id text not null,
      type text not null,
      at integer not null,
      attempt integer,
      task_id text,
      detail text,
      pass integer,
      summary text,
      error text,
      question text,
      answer text,
      sequence integer not null
    );
    create table if not exists workflow_event_artifacts (
      event_id text not null references workflow_events(id) on delete cascade,
      sequence integer not null,
      kind text not null,
      title text not null,
      content text,
      path text,
      url text,
      primary key (event_id, sequence)
    );
  `);
  db.prepare("insert or ignore into schema_migrations (version, applied_at) values (?, ?)").run(SCHEMA_VERSION, Date.now());
  ensureColumn(db, "workflows", "source_type", "text not null default 'user'");
  ensureColumn(db, "workflows", "topology_locked", "integer not null default 0");
  ensureColumn(db, "workflows", "definition_json", "text");
  ensureColumn(db, "workflows", "workflow_v2_plan_json", "text");
  ensureColumn(db, "workflow_runs", "workflow_v2_plan_json", "text");
  ensureColumn(db, "workflow_run_progress", "input_request_json", "text");
  ensureColumn(db, "workflow_run_progress", "intervention_json", "text");
  ensureColumn(db, "workflow_run_nodes", "input_request_json", "text");
  ensureColumn(db, "workflow_run_nodes", "intervention_json", "text");
}

function ensureColumn(db: SqliteSchemaDatabase, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function hasColumn(db: SqliteSchemaDatabase, table: string, column: string): boolean {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;
  return columns.some((item) => item.name === column);
}
