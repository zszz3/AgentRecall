import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../core/postgres/schema";
import { PGliteTestPool } from "../../../core/postgres/test-pglite";
import { McpRegistryStore } from "./mcp-registry-store";

describe("PostgreSQL MCP registry", () => {
  let database: PostgresDatabase;
  let store: McpRegistryStore;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    store = new McpRegistryStore(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("round-trips server configuration and discovered tools", async () => {
    await store.upsert({
      id: "filesystem",
      name: "Filesystem",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { MODE: "safe" },
      enabled: true,
      tools: [{
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      }],
      status: "connected",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: "filesystem",
        args: ["server.mjs"],
        env: { MODE: "safe" },
        tools: [
          expect.objectContaining({
            name: "read_file",
            inputSchema: expect.objectContaining({ type: "object" }),
          }),
        ],
      }),
    ]);

    expect(await store.delete("filesystem")).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("persists disabled tools and prunes names that are no longer discovered", async () => {
    await store.upsert({
      id: "filesystem",
      name: "Filesystem",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      enabled: true,
      tools: [
        { name: "read_file", inputSchema: {} },
        { name: "write_file", inputSchema: {} },
      ],
      disabledTools: ["write_file", "removed_tool"],
      status: "connected",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const [stored] = await store.list();
    expect(stored?.disabledTools).toEqual(["write_file"]);
  });

  it("round-trips HTTP header references without storing secret values", async () => {
    await store.upsert({
      id: "remote",
      name: "Remote search",
      transport: "http",
      args: [],
      url: "https://example.test/mcp",
      env: {},
      headers: { Authorization: "HOST_HTTP_TOKEN" },
      enabled: true,
      tools: [],
      status: "untested",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const [stored] = await store.list();
    expect(stored?.headers).toEqual({ Authorization: "HOST_HTTP_TOKEN" });
  });
});
