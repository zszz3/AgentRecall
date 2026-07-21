import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { McpPage } from "./McpPage";

vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined, sessionSearch: { automation: { listMcpServers: async () => [], listAgentMcps: async () => [] } } });

describe("McpPage", () => {
  test("exposes one workbench with server registry and agent bindings", () => {
    const html = renderToStaticMarkup(<McpPage language="zh" agents={[{ id: "agent", name: "Agent", description: "", runtimeAgentId: "codex", channelId: "codex-openai", modelId: "default", tags: [], createdAt: 1, updatedAt: 1 }]} />);
    expect(html).toContain("服务器");
    expect(html).toContain("Agent 绑定");
    expect(html).toContain("mcp-workbench");
    expect(html).toContain("管理 Agent 可装配的本地与远程工具服务");
  });
});
