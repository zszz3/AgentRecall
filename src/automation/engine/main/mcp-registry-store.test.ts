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
});
