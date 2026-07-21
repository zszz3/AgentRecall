import { describe, expect, test, vi } from "vitest";
import type { AgentChannel } from "../../shared/types";
import { discoverChannelModels, mergeModelCatalog } from "./model-catalog";

const codexOfficial: AgentChannel = {
  id: "codex-official",
  agentId: "codex",
  label: "Codex Official",
  modelProvider: "openai",
  models: [{ id: "default", label: "Default" }],
};

describe("model catalog discovery", () => {
  test("discovers Codex models and reasoning capabilities from the local CLI", async () => {
    const result = await discoverChannelModels(codexOfficial, {
      runCodexModels: async () => JSON.stringify({
        models: [{
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 1,
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, { effort: "ultra" }],
        }],
      }),
    });

    expect(result).toMatchObject({ source: "codex_cli", models: [{
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      reasoningEfforts: ["low", "xhigh", "ultra"],
      defaultReasoningEffort: "low",
    }] });
  });

  test("discovers OpenAI-compatible models without discarding provider authentication", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const channel: AgentChannel = {
      id: "deepseek-api",
      agentId: "api",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiFormat: "openai_chat",
      httpHeaders: { Authorization: "Bearer secret" },
      models: [{ id: "default", label: "Default" }],
    };

    const result = await discoverChannelModels(channel, { fetchImpl });

    expect(result.source).toBe("openai_models");
    expect(result.models.map((model) => model.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  test("merges discovered capabilities while preserving cached and user models", () => {
    const merged = mergeModelCatalog(
      [
        { id: "default", label: "Default" },
        { id: "gpt-5.6-sol", label: "My Sol" },
        { id: "private-model", label: "Private" },
      ],
      [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        reasoningEfforts: ["low", "xhigh"],
        defaultReasoningEffort: "low",
      }],
    );

    expect(merged).toEqual([
      { id: "default", label: "Default" },
      {
        id: "gpt-5.6-sol",
        label: "My Sol",
        reasoningEfforts: ["low", "xhigh"],
        defaultReasoningEffort: "low",
      },
      { id: "private-model", label: "Private" },
    ]);
  });

  test("does not probe OpenAI model endpoints for Claude Code providers", async () => {
    const fetchImpl = vi.fn();
    await expect(discoverChannelModels({
      id: "claude-code-deepseek",
      agentId: "claude",
      label: "Claude DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      models: [{ id: "default", label: "Default" }],
    }, { fetchImpl })).rejects.toThrow("does not expose an OpenAI-compatible model catalog");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
