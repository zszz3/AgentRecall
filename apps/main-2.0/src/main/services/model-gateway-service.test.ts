import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IslandSignalEvent } from "../../core/island-monitor";
import { ModelGatewayService } from "./model-gateway-service";

describe("ModelGatewayService", () => {
  const tempDirs: string[] = [];
  const services: ModelGatewayService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.shutdown()));
    await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
  });

  it("saves providers, runs local gateway, forwards completion to Island, and wires/restores Claude Code", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gw-svc-"));
    tempDirs.push(root);
    const homeDir = path.join(root, "home");
    const userDataPath = path.join(root, "userdata");
    await Promise.all([
      fsp.mkdir(path.join(homeDir, ".claude"), { recursive: true }),
      fsp.mkdir(userDataPath, { recursive: true }),
    ]);

    const settingsMap = new Map<string, unknown>();
    const keyMap = new Map<string, string>();
    const islandEvents: IslandSignalEvent[] = [];

    const service = new ModelGatewayService({
      homeDir,
      userDataPath,
      env: {},
      settings: {
        get: (k) => settingsMap.get(k),
        set: (k, v) => { settingsMap.set(k, v); },
      },
      keys: {
        get: async (id) => keyMap.get(id) ?? "",
        set: async (id, val) => { keyMap.set(id, val); },
      },
      onIslandEvent: (ev) => islandEvents.push(ev),
      fetchImpl: async () => new Response(JSON.stringify({
        id: "chatcmpl_1",
        model: "deepseek-chat",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "网关测试成功" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    services.push(service);

    const afterSave = await service.saveProvider({
      name: "DeepSeek",
      protocol: "openai_chat",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      apiKey: "sk-test-123",
    });
    expect(afterSave.config.providers).toHaveLength(1);
    expect(afterSave.config.primary?.model).toBe("deepseek-chat");

    const testResult = await service.testProvider(afterSave.config.providers[0]!.id);
    expect(testResult.ok).toBe(true);
    expect(testResult.statusCode).toBe(200);

    const started = await service.setEnabled(true, 18425);
    expect(started.status.running).toBe(true);

    // Send a Claude Code Anthropic-format request through the gateway.
    const res = await fetch(`${started.status.baseUrl}/agent/claude-code/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(islandEvents.some((e) => e.source === "claude-cli" && e.status === "completed")).toBe(true);

    // Wire & restore Claude Code in temp HOME.
    const wired = await service.wireAgent("claude-code");
    expect(wired.snapshot.agents.find((a) => a.agentId === "claude-code")?.wired).toBe(true);
    const restored = await service.restoreAgent("claude-code");
    expect(restored.snapshot.agents.find((a) => a.agentId === "claude-code")?.wired).toBe(false);

    // AgentRecall built-in AI features resolve directly from Gateway providers even when gateway server is off.
    await service.setEnabled(false);
    const defaultRoute = await service.resolveAgentRecallRoute();
    expect(defaultRoute).toMatchObject({ providerName: "DeepSeek", model: "deepseek-chat", apiKey: "sk-test-123" });

    const second = await service.saveProvider({
      name: "Anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4-6",
      apiKey: "sk-ant-456",
    });
    const antId = second.config.providers.find((p) => p.name === "Anthropic")!.id;
    await service.setAgentRecallModel({ providerId: antId, model: "claude-sonnet-4-6" });
    const overridden = await service.resolveAgentRecallRoute();
    expect(overridden).toMatchObject({ providerName: "Anthropic", model: "claude-sonnet-4-6", apiKey: "sk-ant-456" });

    await service.removeProvider(antId);
    const fallbackRoute = await service.resolveAgentRecallRoute();
    expect(fallbackRoute).toMatchObject({ providerName: "DeepSeek", model: "deepseek-chat" });
  });
});
