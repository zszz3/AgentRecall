import { describe, expect, test } from "vitest";
import { parseMcpServersJson } from "./mcp-import";

describe("parseMcpServersJson", () => {
  test("imports stdio and http servers from an mcpServers map", () => {
    const { servers, errors } = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { API_TOKEN: "secret-value" },
        },
        remote: { type: "http", url: "http://127.0.0.1:3000/mcp" },
      },
    }));

    expect(errors).toEqual([]);
    expect(servers).toHaveLength(2);
    const filesystem = servers.find((server) => server.name === "filesystem");
    expect(filesystem).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      enabled: true,
    });
    // Secret values are never stored: env maps to same-named host references.
    expect(filesystem?.env).toEqual({ API_TOKEN: "API_TOKEN" });
    expect(servers.find((server) => server.name === "remote")).toMatchObject({
      transport: "http",
      url: "http://127.0.0.1:3000/mcp",
    });
  });

  test("accepts a bare map without the mcpServers wrapper", () => {
    const { servers } = parseMcpServersJson(JSON.stringify({
      think: { command: "node", args: ["think.js"] },
    }));
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "think", transport: "stdio", command: "node" });
  });

  test("collects per-server errors while importing the valid ones", () => {
    const { servers, errors } = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        good: { command: "node" },
        broken: { type: "stdio" },
      },
    }));
    expect(servers.map((server) => server.name)).toEqual(["good"]);
    expect(errors).toEqual([expect.stringContaining("broken")]);
  });

  test("throws on malformed JSON and unusable shapes", () => {
    expect(() => parseMcpServersJson("not json")).toThrow();
    expect(() => parseMcpServersJson("")).toThrow();
    expect(() => parseMcpServersJson(JSON.stringify({ mcpServers: [] }))).toThrow();
  });
});
