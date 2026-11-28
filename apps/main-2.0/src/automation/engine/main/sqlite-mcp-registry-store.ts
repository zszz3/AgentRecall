import type { McpRegistryRepository } from "../../../core/storage/repositories";
import type { SqliteDatabase, SqliteQueryable } from "../../../core/sqlite/database";
import {
  sqliteOptionalTime,
  sqliteRecord,
  sqliteStringArray,
  sqliteStringRecord,
  sqliteTime,
} from "../../../core/sqlite/values";
import type { McpServerDefinition, McpToolDefinition } from "../shared/mcp/types";

type Row = Record<string, unknown>;

export class SqliteMcpRegistryStore implements McpRegistryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async list(): Promise<McpServerDefinition[]> {
    const servers = this.database.all<Row>(
      "SELECT * FROM mcp_servers ORDER BY lower(name), id",
    );
    return servers.map((row) => this.fromRow(row));
  }

  async upsert(server: McpServerDefinition): Promise<McpServerDefinition> {
    this.database.transactionSync((tx) => {
      tx.run(
        `INSERT INTO mcp_servers (
          id, name, transport, command, args, url, env, headers, enabled, exposure_mode, disabled_tools, status,
          last_error, last_tested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args = excluded.args,
          url = excluded.url,
          env = excluded.env,
          headers = excluded.headers,
          enabled = excluded.enabled,
          exposure_mode = excluded.exposure_mode,
          disabled_tools = excluded.disabled_tools,
          status = excluded.status,
          last_error = excluded.last_error,
          last_tested_at = excluded.last_tested_at,
          updated_at = excluded.updated_at`,
        server.id,
        server.name.trim(),
        server.transport,
        server.command?.trim() || null,
        JSON.stringify(server.args),
        server.url?.trim() || null,
        JSON.stringify(server.env),
        JSON.stringify(server.headers ?? {}),
        server.enabled ? 1 : 0,
        server.exposureMode === "direct" ? "direct" : "indexed",
        JSON.stringify(disabledToolNames(server)),
        server.status,
        server.lastError ?? null,
        server.lastTestedAt === undefined ? null : Math.floor(server.lastTestedAt),
        Math.floor(server.createdAt),
        Math.floor(server.updatedAt),
      );
      this.replaceTools(tx, server.id, server.tools);
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
    return this.database.run("DELETE FROM mcp_servers WHERE id = ?", id).changes > 0;
  }

  close(): void {
    // The application owns the shared SQLite database handle.
  }

  private replaceTools(
    tx: SqliteQueryable,
    serverId: string,
    tools: McpToolDefinition[],
  ): void {
    tx.run("DELETE FROM mcp_tools WHERE server_id = ?", serverId);
    for (const [sequence, tool] of tools.entries()) {
      tx.run(
        `INSERT INTO mcp_tools (
          server_id, name, description, input_schema, read_only, sequence
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        serverId,
        tool.name,
        tool.description ?? null,
        JSON.stringify(tool.inputSchema),
        tool.readOnly === true ? 1 : 0,
        sequence,
      );
    }
  }

  private fromRow(row: Row): McpServerDefinition {
    const tools = this.database.all<Row>(
      `SELECT *
         FROM mcp_tools
        WHERE server_id = ?
        ORDER BY sequence`,
      String(row.id),
    );
    const lastTestedAt = sqliteOptionalTime(row.last_tested_at);
    return {
      id: String(row.id),
      name: String(row.name),
      transport: row.transport === "http" ? "http" : "stdio",
      ...(row.command ? { command: String(row.command) } : {}),
      args: sqliteStringArray(row.args),
      ...(row.url ? { url: String(row.url) } : {}),
      env: sqliteStringRecord(row.env),
      headers: sqliteStringRecord(row.headers),
      enabled: Boolean(row.enabled),
      exposureMode: row.exposure_mode === "direct" ? "direct" : "indexed",
      tools: tools.map((tool) => ({
        name: String(tool.name),
        ...(tool.description ? { description: String(tool.description) } : {}),
        inputSchema: sqliteRecord(tool.input_schema),
        ...(Boolean(tool.read_only) ? { readOnly: true } : {}),
      })),
      disabledTools: sqliteStringArray(row.disabled_tools),
      status: row.status as McpServerDefinition["status"],
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
      ...(lastTestedAt !== null ? { lastTestedAt } : {}),
      createdAt: sqliteTime(row.created_at),
      updatedAt: sqliteTime(row.updated_at),
    };
  }
}

function disabledToolNames(server: McpServerDefinition): string[] {
  const known = new Set(server.tools.map((tool) => tool.name));
  return [...new Set(server.disabledTools ?? [])].filter((name) => known.has(name));
}
