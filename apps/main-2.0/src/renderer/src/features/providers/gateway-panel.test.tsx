// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySnapshot } from "../../../../shared/ipc/model-gateway";
import { GatewayPanel } from "./gateway-panel";

function makeSnapshot(): GatewaySnapshot {
  return {
    config: {
      enabled: true,
      port: 4325,
      primary: { providerId: "gwp-1", model: "deepseek-chat" },
      fallbacks: [],
      agentModels: {},
      providers: [{
        id: "gwp-1",
        name: "DeepSeek",
        protocol: "openai_chat",
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        models: ["deepseek-chat"],
        enabled: true,
        hasApiKey: true,
      }],
    },
    status: {
      running: true,
      host: "127.0.0.1",
      port: 4325,
      baseUrl: "http://127.0.0.1:4325",
      localToken: "ar-gw-synthetic",
      error: null,
      startedAt: 1000,
      totalRequests: 2,
      activeRequests: 0,
    },
    agents: [{
      agentId: "deepseek-harness",
      label: "DeepSeek Harness",
      detected: true,
      wired: false,
      hasBackup: false,
      configPath: "/tmp/.dsh/profiles/default/cordis.patch.yml",
      currentSummary: "默认 DeepSeek 配置",
      routeOverride: null,
      snippet: "export OPENAI_BASE_URL=http://127.0.0.1:4325/agent/deepseek-harness/v1",
    }],
    requests: [],
  };
}

describe("GatewayPanel", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders detected local agents and triggers one-click config wiring", async () => {
    const onWireAgent = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <GatewayPanel
          view="gateway-agents"
          snapshot={makeSnapshot()}
          imports={null}
          language="zh"
          busy={false}
          feedback={null}
          onSetEnabled={vi.fn(async () => undefined)}
          onSaveProvider={vi.fn(async () => undefined)}
          onRemoveProvider={vi.fn(async () => undefined)}
          onSetRouting={vi.fn(async () => undefined)}
          onSetAgentModel={vi.fn(async () => undefined)}
          onWireAgent={onWireAgent}
          onRestoreAgent={vi.fn(async () => undefined)}
          onClearRequests={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(host.textContent).toContain("DeepSeek Harness");
    const wireBtn = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("写入配置"));
    expect(wireBtn).toBeTruthy();
    await act(async () => wireBtn!.click());
    expect(onWireAgent).toHaveBeenCalledWith("deepseek-harness");
  });
});
