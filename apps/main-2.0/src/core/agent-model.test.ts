import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { completeWithAgentModel, listAgentModelProviders, resolveAgentModel } from "./agent-model";
import { AgentModelNotReadyError, defaultAgentModelConfig, type AgentModelConfig } from "./agent-model-config";

type Reply = (response: ServerResponse) => void;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

/** A Chat Completions endpoint on a random local port that answers every request with `reply`. */
async function endpoint(reply: Reply): Promise<{ config: AgentModelConfig; requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> }> {
  const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      reply(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return {
    config: { provider: "custom", model: "local-model", baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions" },
    requests,
  };
}

function streamed(text: string[], finishReason: "stop" | "length", usage: Record<string, unknown> | null = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }): Reply {
  return (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
      response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "local-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    for (const part of text) chunk({ content: part }, null);
    chunk({}, finishReason, usage ? { usage } : {});
    response.end("data: [DONE]\n\n");
  };
}

describe("AgentRecall model", () => {
  it("offers only providers that work with one API key", () => {
    const providers = listAgentModelProviders();
    const deepseek = providers.find((provider) => provider.id === "deepseek");

    expect(deepseek?.keyLabel).toBeTruthy();
    expect(deepseek?.models.map((model) => model.id)).toContain("deepseek-v4-pro");
    expect(providers.map((provider) => provider.id)).not.toContain("amazon-bedrock");
    expect(providers.map((provider) => provider.id)).not.toContain("openai-codex");
  });

  it("resolves catalog, unlisted and custom models and refuses an unfinished choice", () => {
    expect(resolveAgentModel({ ...defaultAgentModelConfig, provider: "deepseek", model: "deepseek-v4-pro" }))
      .toMatchObject({ id: "deepseek-v4-pro", api: "openai-completions", baseUrl: "https://api.deepseek.com" });
    expect(resolveAgentModel({ ...defaultAgentModelConfig, provider: "deepseek", model: "deepseek-next" }))
      .toMatchObject({ id: "deepseek-next", baseUrl: "https://api.deepseek.com", reasoning: false });
    expect(resolveAgentModel({ provider: "custom", model: "claude", baseUrl: "https://gateway.test", api: "anthropic-messages" }))
      .toMatchObject({ id: "claude", api: "anthropic-messages", baseUrl: "https://gateway.test" });

    expect(() => resolveAgentModel(defaultAgentModelConfig)).toThrow(AgentModelNotReadyError);
    expect(() => resolveAgentModel({ ...defaultAgentModelConfig, provider: "custom", model: "m" })).toThrow(AgentModelNotReadyError);
    expect(() => resolveAgentModel({ ...defaultAgentModelConfig, provider: "amazon-bedrock", model: "m" })).toThrow(AgentModelNotReadyError);
  });

  it("sends the prompt as one user message and returns the answer with token usage", async () => {
    const { config, requests } = await endpoint(streamed(["O", "K"], "stop"));

    const reply = await completeWithAgentModel(config, "", "hi", AbortSignal.timeout(10_000));

    expect(reply).toEqual({ text: "OK", model: "local-model", inputTokens: 5, outputTokens: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer none");
    expect(requests[0]?.body).toMatchObject({ model: "local-model", messages: [{ role: "user", content: "hi" }], max_tokens: 8_192 });
    expect(requests[0]?.body).not.toHaveProperty("store");
    expect(requests[0]?.body).not.toHaveProperty("max_completion_tokens");

    const cached = await endpoint(streamed(["OK"], "stop", { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }));
    expect(await completeWithAgentModel(cached.config, "", "hi", AbortSignal.timeout(10_000))).toMatchObject({ inputTokens: 9, outputTokens: 2 });
    const unreported = await endpoint(streamed(["OK"], "stop", null));
    expect(await completeWithAgentModel(unreported.config, "", "hi", AbortSignal.timeout(10_000))).toEqual({ text: "OK", model: "local-model" });
  });

  it("rejects provider errors, cut-off or empty answers, timeouts and cancellation", async () => {
    const rejected = await endpoint((response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    await expect(completeWithAgentModel(rejected.config, "bad", "hi", AbortSignal.timeout(10_000)))
      .rejects.toThrow(/^The model call failed: 401.*Invalid API key/);
    expect(rejected.requests[0]?.authorization).toBe("Bearer bad");

    const cutOff = await endpoint(streamed(["{\"cards\":"], "length"));
    await expect(completeWithAgentModel(cutOff.config, "", "hi", AbortSignal.timeout(10_000)))
      .rejects.toThrow("The model reached its output limit before finishing the answer.");

    const empty = await endpoint(streamed([], "stop"));
    await expect(completeWithAgentModel(empty.config, "", "hi", AbortSignal.timeout(10_000)))
      .rejects.toThrow("The model returned an empty answer.");

    const silent = await endpoint(() => undefined);
    await expect(completeWithAgentModel(silent.config, "", "hi", AbortSignal.timeout(50)))
      .rejects.toThrow("The model did not answer in time.");
    const controller = new AbortController();
    const cancelled = completeWithAgentModel(silent.config, "", "hi", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(cancelled).rejects.toThrow("The model call was cancelled.");
  });
});
