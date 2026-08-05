import { describe, expect, test } from "vitest";
import type { McpServerDefinition } from "../../../../shared/mcp/types";
import { applyServerConfigJson, parseMcpServersJson, serverConfigToJson } from "./mcp-import";

function server(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "server-1",
    name: "Example",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { API_TOKEN: "HOST_API_TOKEN" },
    enabled: true,
    tools: [{ name: "read_file", inputSchema: {} }],
    disabledTools: ["read_file"],
    status: "connected",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe("MCP JSON editing", () => {
  test("round-trips a stdio server preserving env references verbatim", () => {
    const original = server();
    const next = applyServerConfigJson(original, serverConfigToJson(original));
    expect(next).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { API_TOKEN: "HOST_API_TOKEN" },
      disabledTools: ["read_file"],
    });
    expect(next.url).toBeUndefined();
    expect(next.id).toBe("server-1");
    expect(next.tools).toEqual(original.tools);
  });

  test("round-trips an http server preserving header references verbatim", () => {
    const original = server({
      transport: "http",
      args: [],
      env: {},
      url: "https://example.test/mcp",
      headers: { Authorization: "HOST_HTTP_TOKEN" },
    });
    delete original.command;
    const next = applyServerConfigJson(original, serverConfigToJson(original));
    expect(next).toMatchObject({
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "HOST_HTTP_TOKEN" },
    });
    expect(next.command).toBeUndefined();
  });

  test("switching transport through JSON clears fields of the other transport", () => {
    const next = applyServerConfigJson(
      server(),
      JSON.stringify({ type: "http", url: "https://example.test/mcp", headers: { "X-Key": "HOST_KEY" } }),
    );
    expect(next.transport).toBe("http");
    expect(next.command).toBeUndefined();
    expect(next.args).toEqual([]);
    expect(next.env).toEqual({});
    expect(next.headers).toEqual({ "X-Key": "HOST_KEY" });
  });

  test("keeps existing disabled tools when the JSON omits them", () => {
    const next = applyServerConfigJson(server(), JSON.stringify({ command: "node", args: [] }));
    expect(next.disabledTools).toEqual(["read_file"]);
  });

  test("rejects disabledTools entries that would be pruned on save", () => {
    expect(() =>
      applyServerConfigJson(server(), JSON.stringify({ command: "node", disabledTools: ["missing"] })),
    ).toThrow(/not discovered/);
    const untested = server({ tools: [], disabledTools: [] });
    expect(() =>
      applyServerConfigJson(untested, JSON.stringify({ command: "node", disabledTools: ["read_file"] })),
    ).toThrow(/connection test/);
  });

  test("accepts clearing disabledTools or a valid subset", () => {
    expect(
      applyServerConfigJson(server(), JSON.stringify({ command: "node", disabledTools: [] })).disabledTools,
    ).toEqual([]);
    expect(
      applyServerConfigJson(server(), JSON.stringify({ command: "node", disabledTools: ["read_file"] })).disabledTools,
    ).toEqual(["read_file"]);
  });

  test("rejects invalid input with actionable errors", () => {
    expect(() => applyServerConfigJson(server(), "   ")).toThrow(/JSON to apply/);
    expect(() => applyServerConfigJson(server(), "not json")).toThrow(SyntaxError);
    expect(() => applyServerConfigJson(server(), "[1]")).toThrow(/single configuration object/);
    expect(() => applyServerConfigJson(server(), JSON.stringify({ mcpServers: {} }))).toThrow(/Import from JSON/);
    expect(() => applyServerConfigJson(server(), JSON.stringify({ args: [] }))).toThrow(/requires "command"/);
    expect(() => applyServerConfigJson(server(), JSON.stringify({ type: "http" }))).toThrow(/requires "url"/);
  });
});

describe("MCP JSON import", () => {
  test("imports env as same-named references and headers as empty references", () => {
    const { servers, errors } = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["-y", "srv"], env: { API_KEY: "literal-secret" } },
        remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer literal" } },
      },
    }));
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ transport: "stdio", env: { API_KEY: "API_KEY" } });
    expect(servers[1]).toMatchObject({ transport: "http", env: {}, headers: { Authorization: "" } });
  });
});
