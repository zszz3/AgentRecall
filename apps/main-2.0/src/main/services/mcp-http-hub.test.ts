import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerDefinition } from "../../automation/contracts";
import { McpAutomationModule } from "./mcp-automation-module";
import { startMcpHttpHub, type McpHttpHubServer } from "./mcp-http-hub";

function server(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "playwright",
    name: "Playwright",
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp"],
    env: {},
    enabled: true,
    exposureMode: "direct",
    tools: [
      { name: "navigate", description: "Open a URL", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
      { name: "click", description: "Click an element", inputSchema: { type: "object" } },
    ],
    disabledTools: [],
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Streamable HTTP MCP Hub", () => {
  const hubs: McpHttpHubServer[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close().catch(() => undefined);
    }
    for (const hub of hubs.splice(0)) {
      await hub.stop().catch(() => undefined);
    }
  });

  function createModule(servers: McpServerDefinition[]) {
    const invokeTool = vi.fn(async (_srv, toolName, args) => ({
      content: [{ type: "text", text: `${toolName}:${JSON.stringify(args)}` }],
    }));
    const module = new McpAutomationModule({
      registry: {
        list: vi.fn(async () => servers),
        upsert: vi.fn(async (value) => value),
        recordTest: vi.fn(async (value) => value),
        delete: vi.fn(async () => true),
      } as never,
      runtime: {
        listConfiguredAgents: vi.fn(() => []),
        setMcpServers: vi.fn(),
        updateConfiguredAgents: vi.fn(() => ({ configuredAgents: [] })),
        flushPersistence: vi.fn(async () => undefined),
      } as never,
      invokeTool,
    });
    return { module, invokeTool };
  }

  async function startTestHub(
    module: McpAutomationModule,
    allowedByClient: Record<string, string[]> = {},
  ) {
    const hub = await startMcpHttpHub({
      port: 0,
      token: "test-hub-secret-token-0123456789abcdef",
      resolveAllowedServerIds: (clientId) => allowedByClient[clientId],
      gateway: {
        listDirectTools: (scope) => module.listDirectHubTools(scope),
        callDirectTool: (name, args, scope) => module.callDirectHubTool(name, args, scope),
        searchTools: (body, scope) => module.searchGatewayTools((body ?? {}) as Record<string, unknown>, scope),
        getTool: (body, scope) => module.getGatewayTool(body as { toolRef: string }, scope),
        callTool: (body, scope) => module.callGatewayTool(body as { toolRef: string; arguments?: Record<string, unknown> }, scope),
        listSkills: async () => ({ skills: [] }),
        getSkill: async () => ({ skill: null }),
        searchResources: async () => ({ items: [] }),
        getResource: async () => ({ content: "" }),
        searchSessions: async () => ({ cards: [], sessions: [] }),
        getSession: async () => ({ messages: [] }),
        isDirectBuiltinEnabled: (sourceId, toolName, scope) =>
          module.isGatewayDirectToolEnabled(sourceId, toolName, scope),
      },
    });
    hubs.push(hub);
    return hub;
  }

  it("rejects unauthorized requests and unknown endpoints", async () => {
    const { module } = createModule([server()]);
    const hub = await startTestHub(module);

    const unauth = await fetch(hub.url, { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);

    const missing = await fetch(`http://127.0.0.1:${hub.port}/mcp/unknown-agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${hub.token}` },
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });

  it("serves direct and indexed tools over Streamable HTTP, enforces per-client routing, and pushes list_changed", async () => {
    const { module, invokeTool } = createModule([
      server({ id: "playwright", name: "Playwright", exposureMode: "direct" }),
      server({
        id: "docs",
        name: "Docs",
        exposureMode: "indexed",
        tools: [{ name: "search_docs", description: "Search documentation", inputSchema: { type: "object" } }],
      }),
    ]);
    const hub = await startTestHub(module, {
      cursor: ["playwright"],
    });

    // 1. Global /mcp client sees both direct tools and indexed search_tools
    const globalClient = new Client({ name: "global-test", version: "1.0.0" });
    clients.push(globalClient);
    await globalClient.connect(new StreamableHTTPClientTransport(new URL(hub.url), {
      requestInit: { headers: { Authorization: `Bearer ${hub.token}` } },
    }));

    const listChangedReceived = new Promise<boolean>((resolve) => {
      globalClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve(true);
      });
    });

    const globalTools = await globalClient.listTools();
    const globalToolNames = globalTools.tools.map((tool) => tool.name);
    expect(globalToolNames).toContain("playwright__navigate");
    expect(globalToolNames).toContain("playwright__click");
    expect(globalToolNames).toContain("search_tools");
    expect(globalToolNames).not.toContain("docs__search_docs");

    const directCall = await globalClient.callTool({
      name: "playwright__navigate",
      arguments: { url: "https://example.com" },
    });
    expect(directCall).toMatchObject({
      content: [{ type: "text", text: 'navigate:{"url":"https://example.com"}' }],
    });
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(module.listCallLogs()[0]).toMatchObject({
      client: "http-hub",
      mode: "direct",
      sourceId: "playwright",
      toolName: "navigate",
      status: "ok",
    });

    // 2. Per-client /mcp/cursor endpoint sees playwright direct tools, NOT docs in search_tools
    const cursorClient = new Client({ name: "cursor-test", version: "1.0.0" });
    clients.push(cursorClient);
    await cursorClient.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/cursor`), {
      requestInit: { headers: { Authorization: `Bearer ${hub.token}` } },
    }));

    const cursorSearch = await cursorClient.callTool({
      name: "search_tools",
      arguments: { query: "docs" },
    });
    const cursorSearchText = (cursorSearch.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(cursorSearchText)).toEqual({ items: [] });

    expect(hub.getStatus()).toMatchObject({
      running: true,
      activeSessions: 2,
    });

    // 3. Push notifications/tools/list_changed to active clients
    hub.notifyToolsChanged();
    await expect(Promise.race([
      listChangedReceived,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ])).resolves.toBe(true);
  });
});
