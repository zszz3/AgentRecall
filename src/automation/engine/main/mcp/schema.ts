interface McpSchemaDatabase { exec(sql: string): void }

export function ensureMcpRegistrySchema(db: McpSchemaDatabase): void {
  db.exec(`
    create table if not exists mcp_servers (
      id text primary key, name text not null, transport text not null, command text,
      args_json text not null, url text, env_json text not null, enabled integer not null default 1,
      status text not null default 'untested', last_error text, last_tested_at integer,
      created_at integer not null, updated_at integer not null
    );
    create table if not exists mcp_tools (
      server_id text not null references mcp_servers(id) on delete cascade,
      name text not null, description text, input_schema_json text not null, sequence integer not null,
      primary key (server_id, name)
    );
  `);
}
