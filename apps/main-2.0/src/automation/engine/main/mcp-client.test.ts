import { describe, expect, it, vi } from "vitest";
import type { McpServerDefinition } from "../shared/mcp/types";
import { discoverMcpTools } from "./mcp-client";

const { stdioArgs } = vi.hoisted(() => ({ stdioArgs: [] as unknown[] }));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      stdioArgs.push(options);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }> {
      return { tools: [{ name: "tool_a", inputSchema: {} }] };
    }
    async close(): Promise<void> {}
  },
}));

function server(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "x",
    name: "X",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: {},
    enabled: true,
    tools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("discoverMcpTools", () => {
  it("uses literal env when provided", async () => {
    stdioArgs.length = 0;
    const tools = await discoverMcpTools(
      server(),
      { AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/tmp/automation-mcp-bridge.json", AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token" },
    );
    expect(stdioArgs[0]).toMatchObject({
      env: { AGENT_RECALL_WORKFLOW_MCP_BRIDGE: "/tmp/automation-mcp-bridge.json", AGENT_RECALL_WORKFLOW_MCP_TOKEN: "secret-token" },
    });
    expect(tools).toEqual([{ name: "tool_a", inputSchema: {} }]);
  });

  it("resolves env values as host variable names by default", async () => {
    stdioArgs.length = 0;
    process.env.HOST_MCP_VAR = "resolved-value";
    try {
      await discoverMcpTools(server({ env: { SOME_KEY: "HOST_MCP_VAR" } }));
      expect(stdioArgs[0]).toMatchObject({ env: { SOME_KEY: "resolved-value" } });
    } finally {
      delete process.env.HOST_MCP_VAR;
    }
  });

  it("falls back to an empty string for unresolvable host variables", async () => {
    stdioArgs.length = 0;
    await discoverMcpTools(server({ env: { SOME_KEY: "DEFINITELY_NOT_SET_HOST_VAR" } }));
    expect(stdioArgs[0]).toMatchObject({ env: { SOME_KEY: "" } });
  });
});
