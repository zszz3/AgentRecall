import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { McpServerDefinition, McpToolDefinition } from "../shared/mcp/types";
import { ensureMcpRegistrySchema } from "./mcp/schema";

const require = createRequire(import.meta.url);

interface StatementSync {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number };
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

type Row = Record<string, unknown>;

export class McpRegistryStore {
  private db: DatabaseSync | undefined;

  constructor(private readonly dbPath: string) {}

  async list(): Promise<McpServerDefinition[]> {
    const db = await this.open();
    return db.prepare("select * from mcp_servers order by name collate nocase, id").all().map((value) => this.fromRow(db, value as Row));
  }

  async upsert(server: McpServerDefinition): Promise<McpServerDefinition> {
    const db = await this.open();
    db.exec("begin immediate");
    try {
      db.prepare(`insert into mcp_servers
        (id, name, transport, command, args_json, url, env_json, enabled, status, last_error, last_tested_at, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set name=excluded.name, transport=excluded.transport, command=excluded.command,
          args_json=excluded.args_json, url=excluded.url, env_json=excluded.env_json, enabled=excluded.enabled,
          status=excluded.status, last_error=excluded.last_error, last_tested_at=excluded.last_tested_at, updated_at=excluded.updated_at`).run(
        server.id, server.name.trim(), server.transport, server.command?.trim() || null, JSON.stringify(server.args),
        server.url?.trim() || null, JSON.stringify(server.env), server.enabled ? 1 : 0, server.status,
        server.lastError ?? null, server.lastTestedAt ?? null, server.createdAt, server.updatedAt,
      );
      this.replaceTools(db, server.id, server.tools);
      db.exec("commit");
      return server;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  async recordTest(server: McpServerDefinition, tools: McpToolDefinition[], error?: string): Promise<McpServerDefinition> {
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
    const db = await this.open();
    return Number(db.prepare("delete from mcp_servers where id = ?").run(id).changes ?? 0) > 0;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private replaceTools(db: DatabaseSync, serverId: string, tools: McpToolDefinition[]): void {
    db.prepare("delete from mcp_tools where server_id = ?").run(serverId);
    tools.forEach((tool, sequence) => db.prepare(
      "insert into mcp_tools (server_id, name, description, input_schema_json, sequence) values (?, ?, ?, ?, ?)",
    ).run(serverId, tool.name, tool.description ?? null, JSON.stringify(tool.inputSchema), sequence));
  }

  private fromRow(db: DatabaseSync, row: Row): McpServerDefinition {
    const tools = db.prepare("select * from mcp_tools where server_id = ? order by sequence").all(row.id).map((value) => {
      const tool = value as Row;
      return {
        name: String(tool.name),
        ...(tool.description ? { description: String(tool.description) } : {}),
        inputSchema: JSON.parse(String(tool.input_schema_json)) as Record<string, unknown>,
      };
    });
    return {
      id: String(row.id), name: String(row.name), transport: row.transport === "http" ? "http" : "stdio",
      ...(row.command ? { command: String(row.command) } : {}), args: JSON.parse(String(row.args_json)) as string[],
      ...(row.url ? { url: String(row.url) } : {}), env: JSON.parse(String(row.env_json)) as Record<string, string>,
      enabled: Number(row.enabled) === 1, tools, status: row.status as McpServerDefinition["status"],
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
      ...(row.last_tested_at ? { lastTestedAt: Number(row.last_tested_at) } : {}),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as SqliteModule;
    const db = new DatabaseSync(this.dbPath);
    db.exec("pragma journal_mode = WAL");
    db.exec("pragma foreign_keys = ON");
    db.exec("pragma busy_timeout = 5000");
    ensureMcpRegistrySchema(db);
    this.db = db;
    return db;
  }
}
