import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG_CHANNEL_IDS } from "./config-channels";
import { FALLBACK_MODEL_OPTIONS } from "./models";
import { AGENT_PROVIDER_PRESETS } from "./provider-presets";
import { isRuntimeId, RUNTIME_DEFINITIONS, RUNTIME_IDS, runtimeDefinition } from "./runtime-catalog";

describe("runtime catalog", () => {
  test("provides one canonical definition for every runtime", () => {
    expect(new Set(RUNTIME_IDS).size).toBe(RUNTIME_IDS.length);
    expect(RUNTIME_DEFINITIONS.map((definition) => definition.id)).toEqual(RUNTIME_IDS);
    for (const runtimeId of RUNTIME_IDS) {
      expect(isRuntimeId(runtimeId)).toBe(true);
      expect(runtimeDefinition(runtimeId)).toMatchObject({
        id: runtimeId,
        label: expect.any(String),
        executable: expect.any(String),
        defaultChannel: { id: DEFAULT_CONFIG_CHANNEL_IDS[runtimeId] },
      });
    }
    expect(isRuntimeId("unknown-runtime")).toBe(false);
  });

  test("includes Hermes fallback models, default channel, and provider preset", () => {
    expect(FALLBACK_MODEL_OPTIONS.hermes.map((model) => model.id)).toContain("default");
    expect(DEFAULT_CONFIG_CHANNEL_IDS.hermes).toBe("hermes-default");
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "hermes-default")).toMatchObject({
      runtimeAgentId: "hermes",
      label: "Default",
      configurableModelId: true,
    });
  });

  test("includes OpenCode fallback models, default channel, and provider preset", () => {
    expect(FALLBACK_MODEL_OPTIONS.opencode.map((model) => model.id)).toContain("default");
    expect(DEFAULT_CONFIG_CHANNEL_IDS.opencode).toBe("opencode-default");
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "opencode-default")).toMatchObject({
      runtimeAgentId: "opencode",
      label: "Default",
      configurableModelId: true,
    });
  });

  test("includes OpenClaw fallback models, default channel, and provider preset", () => {
    expect(FALLBACK_MODEL_OPTIONS.openclaw.map((model) => model.id)).toContain("default");
    expect(DEFAULT_CONFIG_CHANNEL_IDS.openclaw).toBe("openclaw-default");
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "openclaw-default")).toMatchObject({
      runtimeAgentId: "openclaw",
      label: "Default",
      configurableModelId: true,
    });
  });

  test("includes the curated CC Switch provider catalog", () => {
    const codex = AGENT_PROVIDER_PRESETS.filter((preset) => preset.runtimeAgentId === "codex");
    const claude = AGENT_PROVIDER_PRESETS.filter((preset) => preset.runtimeAgentId === "claude");

    expect(codex).toHaveLength(29);
    expect(claude).toHaveLength(27);
    expect(codex.map((preset) => preset.label)).toEqual(expect.arrayContaining([
      "OpenAI Official", "火山Agentplan", "DeepSeek", "Zhipu GLM", "Bailian", "Kimi", "MiniMax", "OpenRouter",
    ]));
    expect(claude.map((preset) => preset.label)).toEqual(expect.arrayContaining([
      "Claude Official", "DeepSeek", "Zhipu GLM", "Bailian For Coding", "Kimi", "AWS Bedrock (API Key)",
    ]));
    expect(claude.every((preset) => preset.apiFormat === "anthropic")).toBe(true);
  });

  test("keeps provider model choices focused on the primary runtime model", () => {
    const codexOfficial = AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "codex-default");
    const claude = AGENT_PROVIDER_PRESETS.filter((preset) => preset.runtimeAgentId === "claude");

    expect(codexOfficial?.models).toEqual(expect.arrayContaining([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "low",
      },
      expect.objectContaining({ id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }),
      expect.objectContaining({ id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }),
    ]));
    expect(codexOfficial).toMatchObject({ usesApiKey: false, requiresOAuth: true, modelProvider: "openai" });
    expect(claude.every((preset) => preset.models.length <= 2)).toBe(true);
  });

  test("separates local CLI defaults from official providers", () => {
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "codex-local-default")).toMatchObject({
      runtimeAgentId: "codex",
      category: "local",
      label: "Default",
      usesApiKey: true,
    });
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "claude-local-default")).toMatchObject({
      runtimeAgentId: "claude",
      category: "local",
      label: "Default",
      usesApiKey: true,
    });
    expect(AGENT_PROVIDER_PRESETS.find((preset) => preset.id === "codex-default")).toMatchObject({
      runtimeAgentId: "codex",
      category: "official",
      requiresOAuth: true,
    });
  });
});
