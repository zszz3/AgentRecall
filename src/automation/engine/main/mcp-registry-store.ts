import type { PostgresDatabase, PostgresQueryable } from "../../../core/postgres/database";
import type { McpServerDefinition, McpToolDefinition } from "../shared/mcp/types";

type Row = Record<string, unknown>;

export class McpRegistryStore {
  constructor(private readonly database: PostgresDatabase) {}

  async list(): Promise<McpServerDefinition[]> {
    const servers = await this.database.query(
      "select * from agent_recall.mcp_servers order by lower(name), id",
    );
    return Promise.all(servers.rows.map((row) => this.fromRow(row)));
  }

  async upsert(server: McpServerDefinition): Promise<McpServerDefinition> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.mcp_servers (
          id, name, transport, command, args, url, env, enabled, status,
          last_error, last_tested_at, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13
        )
        on conflict (id) do update set
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args = excluded.args,
          url = excluded.url,
          env = excluded.env,
          enabled = excluded.enabled,
          status = excluded.status,
          last_error = excluded.last_error,
          last_tested_at = excluded.last_tested_at,
          updated_at = excluded.updated_at`,
        [
          server.id,
          server.name.trim(),
          server.transport,
          server.command?.trim() || null,
          JSON.stringify(server.args),
          server.url?.trim() || null,
          JSON.stringify(server.env),
          server.enabled,
          server.status,
          server.lastError ?? null,
          optionalDate(server.lastTestedAt),
          new Date(server.createdAt),
          new Date(server.updatedAt),
        ],
      );
      await this.replaceTools(transaction, server.id, server.tools);
    });
    return server;
  }

  async recordTest(
    server: McpServerDefinition,
    tools: McpToolDefinition[],
    error?: string,
  ): Promise<McpServerDefinition> {
    const tested: McpServerDefinition = {
      ...server,
      tools,
      status: error ? "error" : "connected",
      ...(error ? { lastError: error } : {}),
      lastTestedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!error) delete tested.lastError;
    await this.upsert(tested);
    return tested;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.database.query(
      "delete from agent_recall.mcp_servers where id = $1",
      [id],
    )).rowCount > 0;
  }

  close(): void {
    // The application owns the shared PostgreSQL connection pool.
  }

  private async replaceTools(
    transaction: PostgresQueryable,
    serverId: string,
    tools: McpToolDefinition[],
  ): Promise<void> {
    await transaction.query(
      "delete from agent_recall.mcp_tools where server_id = $1",
      [serverId],
    );
    for (const [sequence, tool] of tools.entries()) {
      await transaction.query(
        `insert into agent_recall.mcp_tools (
          server_id, name, description, input_schema, sequence
        ) values ($1, $2, $3, $4::jsonb, $5)`,
        [
          serverId,
          tool.name,
          tool.description ?? null,
          JSON.stringify(tool.inputSchema),
          sequence,
        ],
      );
    }
  }

  private async fromRow(row: Row): Promise<McpServerDefinition> {
    const tools = await this.database.query(
      `select *
         from agent_recall.mcp_tools
        where server_id = $1
        order by sequence`,
      [row.id],
    );
    return {
      id: String(row.id),
      name: String(row.name),
      transport: row.transport === "http" ? "http" : "stdio",
      ...(row.command ? { command: String(row.command) } : {}),
      args: jsonArray(row.args),
      ...(row.url ? { url: String(row.url) } : {}),
      env: jsonStringRecord(row.env),
      enabled: Boolean(row.enabled),
      tools: tools.rows.map((tool) => ({
        name: String(tool.name),
        ...(tool.description ? { description: String(tool.description) } : {}),
        inputSchema: jsonRecord(tool.input_schema),
      })),
      status: row.status as McpServerDefinition["status"],
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
      ...(row.last_tested_at ? { lastTestedAt: timestamp(row.last_tested_at) } : {}),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    };
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function jsonArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return structuredClone(parsed as Record<string, unknown>);
}

function jsonStringRecord(value: unknown): Record<string, string> {
  const parsed = jsonRecord(value);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, entry]) => [key, String(entry)]),
  );
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value));
}

function optionalDate(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}
