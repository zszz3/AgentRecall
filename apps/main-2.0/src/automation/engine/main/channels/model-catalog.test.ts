import { describe, expect, test } from "vitest";
import type { AgentChannel } from "../../shared/types";
import { discoverChannelModels, ModelCatalogUnsupportedError } from "./model-catalog";

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "provider-channel",
    agentId: "api",
    label: "Provider channel",
    models: [{ id: "default", label: "Default" }],
    ...overrides,
  };
}

function catalogFetch(requests: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("discoverChannelModels", () => {
  test("uses the selected DeepSeek Provider catalog for Claude Code", async () => {
    const requests: string[] = [];

    const result = await discoverChannelModels(channel({
      id: "claude-deepseek",
      agentId: "claude",
      label: "Claude Code + DeepSeek",
      presetId: "claude-code-deepseek",
      providerName: "DeepSeek",
      modelProvider: "deepseek-anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiFormat: "anthropic",
      httpHeaders: { Authorization: "Bearer secret" },
    }), { fetchImpl: catalogFetch(requests) });

    expect(requests).toEqual(["https://api.deepseek.com/models"]);
    expect(result).toEqual({
      source: "openai_models",
      models: [
        { id: "deepseek-chat", label: "deepseek-chat" },
        { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
      ],
    });
  });

  test("recovers the DeepSeek catalog from Provider identity for migrated channels", async () => {
    const requests: string[] = [];

    await discoverChannelModels(channel({
      agentId: "claude",
      modelProvider: "deepseek-anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiFormat: "anthropic",
    }), { fetchImpl: catalogFetch(requests) });

    expect(requests).toEqual(["https://api.deepseek.com/models"]);
  });

  test("derives models from an OpenAI-compatible Provider used by Claude Code", async () => {
    const requests: string[] = [];

    await discoverChannelModels(channel({
      agentId: "claude",
      providerName: "OpenRouter",
      modelProvider: "openrouter-anthropic",
      baseUrl: "https://openrouter.ai/api/v1/",
      apiFormat: "openai_chat",
    }), { fetchImpl: catalogFetch(requests) });

    expect(requests).toEqual(["https://openrouter.ai/api/v1/models"]);
  });

  test("does not guess a catalog for Claude Providers without catalog metadata", async () => {
    const requests: string[] = [];

    await expect(discoverChannelModels(channel({
      id: "claude-local-default",
      agentId: "claude",
      presetId: "claude-local-default",
      baseUrl: "https://api.anthropic.com",
    }), { fetchImpl: catalogFetch(requests) })).rejects.toBeInstanceOf(ModelCatalogUnsupportedError);

    expect(requests).toEqual([]);
  });

  test("keeps generic custom OpenAI-compatible catalog discovery", async () => {
    const requests: string[] = [];

    await discoverChannelModels(channel({
      baseUrl: "https://models.example.test/v1/",
    }), { fetchImpl: catalogFetch(requests) });

    expect(requests).toEqual(["https://models.example.test/v1/models"]);
  });
});
