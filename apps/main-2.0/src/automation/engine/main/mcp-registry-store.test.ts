import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteDatabase } from "../../../core/sqlite/database";
import { SQLITE_MIGRATIONS } from "../../../core/sqlite/schema";
import { SqliteMcpRegistryStore } from "./sqlite-mcp-registry-store";

describe("SQLite MCP registry", () => {
  let database: SqliteDatabase;
  let store: SqliteMcpRegistryStore;

  beforeEach(async () => {
    database = SqliteDatabase.open(":memory:", {
      migrations: SQLITE_MIGRATIONS,
    });
    await database.initialize();
    store = new SqliteMcpRegistryStore(database);
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
        readOnly: true,
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
            readOnly: true,
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
    expect(stored?.exposureMode).toBe("indexed");
  });

  it("persists direct exposure mode across round-trips", async () => {
    await store.upsert({
      id: "playwright",
      name: "Playwright",
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp"],
      env: {},
      enabled: true,
      exposureMode: "direct",
      tools: [],
      status: "untested",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const [stored] = await store.list();
    expect(stored?.exposureMode).toBe("direct");
  });
});
