import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../core/platform";
import { resolveOpenVikingExtractionConfig } from "./openviking-extraction-config";

describe("resolveOpenVikingExtractionConfig", () => {
  it("uses the active Codex Provider model instead of a stale Memory override", () => {
    expect(resolveOpenVikingExtractionConfig({
      settings: {
        ...defaultSettings,
        summarySource: "codex",
        openVikingExtractionModel: "gpt-5.6-sol",
        openVikingExtractionReasoningEffort: "medium",
      },
      codex: { activeModel: "gpt-5.5" },
    })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
      api_base: "https://chatgpt.com/backend-api/codex",
      reasoning_effort: "medium",
    });
  });

  it("uses the active Codex model with the Codex summary Provider", () => {
    expect(resolveOpenVikingExtractionConfig({
      settings: {
        ...defaultSettings,
        summarySource: "codex",
        openVikingExtractionModel: "",
      },
      codex: { activeModel: " gpt-5.5 " },
    }).model).toBe("gpt-5.5");
  });

  it("maps a custom OpenAI Chat Provider", () => {
    expect(resolveOpenVikingExtractionConfig({
      settings: {
        ...defaultSettings,
        summarySource: "custom",
        summaryApiConfig: {
          ...defaultSettings.summaryApiConfig,
          customApiFormat: "openai_chat",
          customBaseUrl: " https://example.com/v1 ",
          customApiKey: " secret ",
          customModel: " custom-model ",
        },
        openVikingExtractionReasoningEffort: "high",
        openVikingExtractionModel: "gpt-5.6-sol",
      },
      codex: { activeModel: "" },
    })).toEqual({
      provider: "openai",
      model: "custom-model",
      api_base: "https://example.com/v1",
      api_key: "secret",
      reasoning_effort: "medium",
    });
  });

  it.each([
    ["URL", { customBaseUrl: "" }],
    ["API key", { customApiKey: "" }],
    ["model", { customModel: "" }],
  ])("rejects a custom Provider without %s", (_field, override) => {
    expect(() => resolveOpenVikingExtractionConfig({
      settings: {
        ...defaultSettings,
        summarySource: "custom",
        summaryApiConfig: {
          ...defaultSettings.summaryApiConfig,
          customApiFormat: "openai_chat",
          customBaseUrl: "https://example.com/v1",
          customApiKey: "secret",
          customModel: "custom-model",
          ...override,
        },
      },
      codex: { activeModel: "" },
    })).toThrow("Complete the summary Provider URL, API key, and model");
  });

  it("rejects Claude CLI as a memory extraction Provider", () => {
    expect(() => resolveOpenVikingExtractionConfig({
      settings: { ...defaultSettings, summarySource: "claude" },
      codex: { activeModel: "" },
    })).toThrow("Claude CLI cannot be used");
  });

  it("rejects custom OpenAI Responses Providers", () => {
    expect(() => resolveOpenVikingExtractionConfig({
      settings: {
        ...defaultSettings,
        summarySource: "custom",
        summaryApiConfig: {
          ...defaultSettings.summaryApiConfig,
          customApiFormat: "openai_responses",
        },
      },
      codex: { activeModel: "" },
    })).toThrow("requires an OpenAI Chat provider");
  });
});
