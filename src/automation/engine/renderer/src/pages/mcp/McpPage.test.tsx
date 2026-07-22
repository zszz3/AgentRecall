import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { McpPage } from "./McpPage";
import { McpAgentBindings } from "./McpAgentBindings";

vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined, sessionSearch: { automation: { listMcpServers: async () => [], listAgentMcps: async () => [] } } });

describe("McpPage", () => {
  test("exposes one workbench with server registry and agent bindings", () => {
    const html = renderToStaticMarkup(<McpPage language="zh" agents={[{ id: "agent", name: "Agent", description: "", runtimeAgentId: "codex", channelId: "codex-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1 }]} />);
    expect(html).toContain("服务器");
    expect(html).toContain("Agent 绑定");
    expect(html).toContain("mcp-workbench");
    expect(html).toContain("管理 Agent 可装配的本地与远程工具服务");
  });

  test("shows registry servers as per-Agent bindings", () => {
    const html = renderToStaticMarkup(<McpAgentBindings
      agents={[{ id: "agent", name: "Agent", description: "", runtimeAgentId: "claude", channelId: "claude-code", modelId: "default", tags: [], mcpBindings: [{ serverId: "filesystem", toolAllowlist: [] }], createdAt: 1, updatedAt: 1 }]}
      servers={[{ id: "filesystem", name: "Filesystem", transport: "stdio", command: "node", args: ["server.js"], env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1 }]}
      onSaveAgents={async () => undefined}
    />);

    expect(html).toContain("Custom servers");
    expect(html).toContain("Filesystem");
    expect(html).toContain("checked");
  });

  test("does not offer inactive MCP bindings to API-only Agents", () => {
    const html = renderToStaticMarkup(<McpAgentBindings
      agents={[{ id: "agent", name: "API Agent", description: "", runtimeAgentId: "api", channelId: "api-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1 }]}
      servers={[{ id: "filesystem", name: "Filesystem", transport: "stdio", command: "node", args: ["server.js"], env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1 }]}
      onSaveAgents={async () => undefined}
    />);

    expect(html).toContain("API runtime does not support MCP servers");
    expect(html).not.toContain('type="checkbox"');
  });
});
