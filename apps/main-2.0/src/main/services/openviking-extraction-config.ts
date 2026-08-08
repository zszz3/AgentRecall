import {
  DEFAULT_CODEX_API_BASE_URL,
  type CodexConfigSnapshot,
  type CodexSummaryEndpointDefaults,
} from "../../core/codex-profile";
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
  codexEndpoint?: CodexSummaryEndpointDefaults | null;
}): ResolvedOpenVikingVlmConfig {
  if (input.settings.summarySource === "claude") {
    throw new Error("Claude CLI cannot be used for OpenViking memory extraction.");
  }

  if (
    input.settings.summarySource === "codex"
    || (input.settings.summarySource === "custom" && input.settings.summaryApiConfigMode === "inherit_codex")
  ) {
    const model = input.settings.summaryCodexModel.trim()
      || input.codexEndpoint?.model.trim()
      || input.codex.activeModel.trim()
      || DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL;
    if (input.codexEndpoint) {
      const baseUrl = input.codexEndpoint.baseUrl.trim();
      return {
        provider: input.codexEndpoint.apiFormat === "openai_responses"
          ? "openai-codex"
          : "openai",
        model,
        ...(baseUrl ? { api_base: baseUrl } : {}),
        api_key: input.codexEndpoint.apiKey,
        reasoning_effort: input.settings.openVikingExtractionReasoningEffort,
      };
    }
    return {
      provider: "openai-codex",
      model,
      api_base: DEFAULT_CODEX_API_BASE_URL,
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
