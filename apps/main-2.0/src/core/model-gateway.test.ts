import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestRecord } from "../shared/ipc/model-gateway";
import { LocalModelGateway, type GatewayLiveEvent } from "./model-gateway";

describe("LocalModelGateway", () => {
  const runningGateways: LocalModelGateway[] = [];

  afterEach(async () => {
    await Promise.all(runningGateways.splice(0).map((gw) => gw.stop()));
  });

  it("translates Anthropic /agent/claude-code/v1/messages to an OpenAI Chat upstream, falls back on 429, and emits live completion events", async () => {
    const records: GatewayRequestRecord[] = [];
    const liveEvents: GatewayLiveEvent[] = [];
    let callCount = 0;

    const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
      callCount += 1;
      const url = String(input);
      if (callCount === 1) {
        expect(url).toBe("https://primary.test/v1/chat/completions");
        return new Response("rate limited sk-primary-secret", { status: 429 });
      }
      expect(url).toBe("https://backup.test/v1/chat/completions");
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent.model).toBe("deepseek-chat");
      return new Response(JSON.stringify({
        id: "chatcmpl_ok",
        model: "deepseek-chat",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "修复完成" } }],
        usage: { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 300 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const gateway = new LocalModelGateway({
      port: 0,
      localToken: "ar-gw-local-test",
      resolveRoutes: async () => [
        {
          providerId: "p1",
          providerName: "Primary",
          protocol: "openai_chat",
          baseUrl: "https://primary.test/v1",
          apiKey: "sk-primary-secret",
          model: "gpt-primary",
        },
        {
          providerId: "p2",
          providerName: "DeepSeek Backup",
          protocol: "openai_chat",
          baseUrl: "https://backup.test/v1",
          apiKey: "sk-backup-secret",
          model: "deepseek-chat",
        },
      ],
      listModels: async () => [{ id: "deepseek-chat", ownedBy: "DeepSeek Backup" }],
      onRequestRecord: (record) => records.push(record),
      onLiveEvent: (event) => liveEvents.push(event),
      fetchImpl: fakeFetch,
    });
    runningGateways.push(gateway);

    const status = await gateway.start();
    expect(status.running).toBe(true);

    const response = await fetch(`${status.baseUrl}/agent/claude-code/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "ar-gw-local-test",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        messages: [{ role: "user", content: "Fix it" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).toEqual([{ type: "text", text: "修复完成" }]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentId: "claude-code",
      upstreamProviderName: "DeepSeek Backup",
      upstreamModel: "deepseek-chat",
      fallbackUsed: true,
      statusCode: 200,
      inputTokens: 200,
      cachedInputTokens: 300,
      outputTokens: 40,
    });

    expect(liveEvents.map((e) => e.phase)).toEqual(["start", "complete"]);
    expect(liveEvents[1]).toMatchObject({
      agentId: "claude-code",
      hasToolCall: false,
      summary: "修复完成",
    });
  });

  it("redacts upstream API keys if all routes fail", async () => {
    const gateway = new LocalModelGateway({
      port: 0,
      localToken: "ar-gw-local-test",
      resolveRoutes: async () => [{
        providerId: "p1",
        providerName: "Only",
        protocol: "openai_chat",
        baseUrl: "https://fail.test/v1",
        apiKey: "sk-top-secret-999",
        model: "m1",
      }],
      listModels: async () => [],
      fetchImpl: async () => new Response("Invalid key sk-top-secret-999", { status: 401 }),
    });
    runningGateways.push(gateway);
    const status = await gateway.start();

    const response = await fetch(`${status.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain("sk-top-secret-999");
    expect(text).toContain("[redacted]");
  });
});
