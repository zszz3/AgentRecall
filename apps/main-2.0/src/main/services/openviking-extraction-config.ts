import type { CodexConfigSnapshot } from "../../core/codex-profile";
import type {
  AppSettings,
  OpenVikingExtractionReasoningEffort,
} from "../../core/platform";
import { DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL } from "../../core/openviking-settings";

export interface ResolvedOpenVikingVlmConfig {
  provider: "openai-codex" | "openai";
  model: string;
  api_base?: string;
  api_key?: string;
  reasoning_effort: OpenVikingExtractionReasoningEffort;
}

export function resolveOpenVikingExtractionConfig(input: {
  settings: AppSettings;
  codex: Pick<CodexConfigSnapshot, "activeModel">;
}): ResolvedOpenVikingVlmConfig {
  if (input.settings.summarySource === "claude") {
    throw new Error("Claude CLI cannot be used for OpenViking memory extraction.");
  }

  if (input.settings.summarySource === "codex") {
    const model = input.settings.summaryCodexModel.trim()
      || input.codex.activeModel.trim()
      || DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL;
    return {
      provider: "openai-codex",
      model,
      api_base: "https://chatgpt.com/backend-api/codex",
      reasoning_effort: input.settings.openVikingExtractionReasoningEffort,
    };
  }

  const config = input.settings.summaryApiConfig;
  if (config.customApiFormat !== "openai_chat") {
    throw new Error("OpenViking currently supports custom OpenAI Chat providers only.");
  }
  const model = config.customModel.trim();
  const apiBase = config.customBaseUrl.trim();
  const apiKey = config.customApiKey.trim();
  if (!apiBase || !apiKey || !model) {
    throw new Error("Complete the summary Provider URL, API key, and model before starting Memory.");
  }
  return {
    provider: "openai",
    model,
    api_base: apiBase,
    api_key: apiKey,
    reasoning_effort: "medium",
  };
}
