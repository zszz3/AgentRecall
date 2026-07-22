import { describe, expect, test } from "vitest";
import type { BoundMcpServer } from "./runtime-mcp";
import {
  acpMcpServers,
  claudeMcpServers,
  codexMcpLaunchConfig,
} from "./runtime-mcp";

const servers: BoundMcpServer[] = [
  {
    server: {
      id: "filesystem.local",
      name: "Filesystem",
      transport: "stdio",
      command: "node",
      args: ["server.js", "C:\\workspace"],
      env: { API_TOKEN: "HOST_API_TOKEN" },
      enabled: true,
      tools: [
        { name: "read_file", inputSchema: {} },
        { name: "write_file", inputSchema: {} },
      ],
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    },
    toolAllowlist: ["read_file"],
  },
  {
    server: {
      id: "remote",
      name: "Remote search",
      transport: "http",
      args: [],
      url: "https://example.test/mcp",
      env: {},
      enabled: true,
      tools: [],
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    },
    toolAllowlist: [],
  },
];

describe("runtime MCP configuration", () => {
  test("builds Codex overrides without exposing secret values in argv", () => {
    const config = codexMcpLaunchConfig(servers, { HOST_API_TOKEN: "secret-value" });
    const argv = config.args.join("\n");

    expect(argv).toContain("mcp_servers.agent_recall_");
    expect(argv).toContain('command="node"');
    expect(argv).toContain('env_vars=["API_TOKEN"]');
    expect(argv).toContain('enabled_tools=["read_file"]');
    expect(argv).toContain('url="https://example.test/mcp"');
    expect(argv).not.toContain("secret-value");
    expect(config.env).toMatchObject({ API_TOKEN: "secret-value" });
  });

  test("builds Claude and ACP server definitions for both transports", () => {
    const claude = claudeMcpServers(servers, { HOST_API_TOKEN: "secret-value" });
    expect(Object.values(claude ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "node", args: ["server.js", "C:\\workspace"], env: { API_TOKEN: "secret-value" } }),
      expect.objectContaining({ type: "http", url: "https://example.test/mcp" }),
    ]));

    expect(acpMcpServers(servers, { HOST_API_TOKEN: "secret-value" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/^agent_recall_/), command: "node", env: [{ name: "API_TOKEN", value: "secret-value" }] }),
      expect.objectContaining({ type: "http", name: expect.stringMatching(/^agent_recall_/), url: "https://example.test/mcp", headers: [] }),
    ]));
  });

  test("gives ACP servers stable unique names even when display names collide", () => {
    const duplicateNames = servers.map((binding) => ({
      ...binding,
      server: { ...binding.server, name: "Shared name" },
    }));

    const names = acpMcpServers(duplicateNames).map((server) => server.name);

    expect(new Set(names).size).toBe(duplicateNames.length);
    expect(names.every((name) => name.startsWith("agent_recall_"))).toBe(true);
  });
});
