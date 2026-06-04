export type ApiFormat = "openai_chat" | "openai_responses";
export type ClaudeApiFormat = "anthropic" | "openai_chat" | "openai_responses" | "gemini_native";
export type ApiProviderChoice = "official" | "custom";
export type ApiProviderPresetId = "codexzh" | "deepseek" | "zhipu_glm" | "longcat" | "kimi" | "xiaomi_mimo";
export type ClaudeApiProviderPresetId = "custom" | "deepseek" | "zhipu_glm" | "longcat" | "kimi" | "xiaomi_mimo";
export type ClaudeApiKeyField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

export interface ApiProviderPreset {
  id: ApiProviderPresetId;
  label: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiFormat: ApiFormat;
}

export interface ApiConfig {
  activeProvider: ApiProviderChoice;
  customProviderId: ApiProviderPresetId;
  customProviderName: string;
  customBaseUrl: string;
  customApiKey: string;
  customModel: string;
  customApiFormat: ApiFormat;
}

export interface ClaudeApiProviderPreset {
  id: ClaudeApiProviderPresetId;
  label: string;
  providerName: string;
  baseUrl: string;
  model: string;
  haikuModel: string;
  sonnetModel: string;
  opusModel: string;
  apiFormat: ClaudeApiFormat;
  apiKeyField: ClaudeApiKeyField;
  extraEnv?: Record<string, string | number>;
}

export interface ClaudeApiConfig {
  activeProvider: ApiProviderChoice;
  customProviderId: ClaudeApiProviderPresetId;
  customProviderName: string;
  customBaseUrl: string;
  customApiKey: string;
  customModel: string;
  customHaikuModel: string;
  customSonnetModel: string;
  customOpusModel: string;
  customApiFormat: ClaudeApiFormat;
  customApiKeyField: ClaudeApiKeyField;
}

type ApiConfigInput = Partial<Omit<ApiConfig, "customProviderId">> & { customProviderId?: string };
type ClaudeApiConfigInput = Partial<Omit<ClaudeApiConfig, "customProviderId">> & { customProviderId?: string };

export const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
  {
    id: "codexzh",
    label: "CodexZH",
    providerName: "codexzh",
    baseUrl: "https://api.codexzh.com/v1",
    model: "gpt-5.5",
    apiFormat: "openai_responses",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    providerName: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiFormat: "openai_chat",
  },
  {
    id: "zhipu_glm",
    label: "GLM",
    providerName: "zhipu_glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.1",
    apiFormat: "openai_chat",
  },
  {
    id: "longcat",
    label: "LongCat",
    providerName: "longcat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    model: "LongCat-Flash-Chat",
    apiFormat: "openai_chat",
  },
  {
    id: "kimi",
    label: "Kimi",
    providerName: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    apiFormat: "openai_chat",
  },
  {
    id: "xiaomi_mimo",
    label: "MiMo",
    providerName: "xiaomi_mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    apiFormat: "openai_chat",
  },
];

export const CLAUDE_API_PROVIDER_PRESETS: ClaudeApiProviderPreset[] = [
  {
    id: "custom",
    label: "Custom",
    providerName: "Custom Claude",
    baseUrl: "",
    model: "",
    haikuModel: "",
    sonnetModel: "",
    opusModel: "",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    providerName: "deepseek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro",
    haikuModel: "deepseek-v4-flash",
    sonnetModel: "deepseek-v4-pro",
    opusModel: "deepseek-v4-pro",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
  },
  {
    id: "zhipu_glm",
    label: "GLM",
    providerName: "zhipu_glm",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-5.1",
    haikuModel: "glm-5.1",
    sonnetModel: "glm-5.1",
    opusModel: "glm-5.1",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
  },
  {
    id: "longcat",
    label: "LongCat",
    providerName: "longcat",
    baseUrl: "https://api.longcat.chat/anthropic",
    model: "LongCat-Flash-Chat",
    haikuModel: "LongCat-Flash-Chat",
    sonnetModel: "LongCat-Flash-Chat",
    opusModel: "LongCat-Flash-Chat",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    extraEnv: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "6000",
    },
  },
  {
    id: "kimi",
    label: "Kimi",
    providerName: "kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    model: "kimi-k2.6",
    haikuModel: "kimi-k2.6",
    sonnetModel: "kimi-k2.6",
    opusModel: "kimi-k2.6",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
  },
  {
    id: "xiaomi_mimo",
    label: "MiMo",
    providerName: "xiaomi_mimo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    model: "mimo-v2.5-pro",
    haikuModel: "mimo-v2.5-pro",
    sonnetModel: "mimo-v2.5-pro",
    opusModel: "mimo-v2.5-pro",
    apiFormat: "anthropic",
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
  },
];

export const defaultApiConfig: ApiConfig = {
  activeProvider: "official",
  customProviderId: "codexzh",
  customProviderName: "CodexZH",
  customBaseUrl: "",
  customApiKey: "",
  customModel: "",
  customApiFormat: "openai_chat",
};

export const defaultClaudeApiConfig: ClaudeApiConfig = {
  activeProvider: "official",
  customProviderId: "custom",
  customProviderName: "Custom Claude",
  customBaseUrl: "",
  customApiKey: "",
  customModel: "",
  customHaikuModel: "",
  customSonnetModel: "",
  customOpusModel: "",
  customApiFormat: "anthropic",
  customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
};

export function normalizeApiConfig(config: ApiConfigInput | null | undefined): ApiConfig {
  const source = config ?? {};
  return {
    activeProvider: source.activeProvider === "custom" ? "custom" : "official",
    customProviderId: normalizeProviderPresetId(source.customProviderId),
    customProviderName: normalizeNonEmptyString(source.customProviderName, defaultApiConfig.customProviderName),
    customBaseUrl: (source.customBaseUrl ?? "").trim(),
    customApiKey: (source.customApiKey ?? "").trim(),
    customModel: (source.customModel ?? "").trim(),
    customApiFormat: source.customApiFormat === "openai_responses" ? "openai_responses" : "openai_chat",
  };
}

export function normalizeClaudeApiConfig(config: ClaudeApiConfigInput | null | undefined): ClaudeApiConfig {
  const source = config ?? {};
  const model = (source.customModel ?? "").trim();
  return {
    activeProvider: source.activeProvider === "custom" ? "custom" : "official",
    customProviderId: normalizeClaudeProviderPresetId(source.customProviderId),
    customProviderName: normalizeNonEmptyString(source.customProviderName, defaultClaudeApiConfig.customProviderName),
    customBaseUrl: (source.customBaseUrl ?? "").trim(),
    customApiKey: (source.customApiKey ?? "").trim(),
    customModel: model,
    customHaikuModel: (source.customHaikuModel ?? "").trim(),
    customSonnetModel: (source.customSonnetModel ?? "").trim(),
    customOpusModel: (source.customOpusModel ?? "").trim(),
    customApiFormat: normalizeClaudeApiFormat(source.customApiFormat),
    customApiKeyField: source.customApiKeyField === "ANTHROPIC_API_KEY" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
  };
}

export function mergeApiConfigWithProfileDefaults(
  current: ApiConfig,
  saved: Partial<ApiConfig> | null | undefined,
  profileDefaults: Partial<ApiConfig> | null | undefined,
): ApiConfig {
  const savedSource = saved ?? {};
  const defaults = profileDefaults ?? {};
  return normalizeApiConfig({
    activeProvider: savedSource.activeProvider ?? defaults.activeProvider ?? current.activeProvider,
    customProviderId: savedSource.customProviderId ?? defaults.customProviderId ?? current.customProviderId,
    customProviderName: fieldWasSaved(savedSource.customProviderName) ? current.customProviderName : defaults.customProviderName ?? current.customProviderName,
    customBaseUrl: fieldWasSaved(savedSource.customBaseUrl) ? current.customBaseUrl : defaults.customBaseUrl ?? current.customBaseUrl,
    customApiKey: current.customApiKey,
    customModel: fieldWasSaved(savedSource.customModel) ? current.customModel : defaults.customModel ?? current.customModel,
    customApiFormat: savedSource.customApiFormat ?? defaults.customApiFormat ?? current.customApiFormat,
  });
}

export function mergeClaudeApiConfigWithProfileDefaults(
  current: ClaudeApiConfig,
  saved: Partial<ClaudeApiConfig> | null | undefined,
  profileDefaults: Partial<ClaudeApiConfig> | null | undefined,
): ClaudeApiConfig {
  const savedSource = saved ?? {};
  const defaults = profileDefaults ?? {};
  return normalizeClaudeApiConfig({
    activeProvider: savedSource.activeProvider ?? defaults.activeProvider ?? current.activeProvider,
    customProviderId: savedSource.customProviderId ?? defaults.customProviderId ?? current.customProviderId,
    customProviderName: fieldWasSaved(savedSource.customProviderName)
      ? current.customProviderName
      : defaults.customProviderName ?? current.customProviderName,
    customBaseUrl: fieldWasSaved(savedSource.customBaseUrl) ? current.customBaseUrl : defaults.customBaseUrl ?? current.customBaseUrl,
    customApiKey: current.customApiKey,
    customModel: fieldWasSaved(savedSource.customModel) ? current.customModel : defaults.customModel ?? current.customModel,
    customHaikuModel: fieldWasSaved(savedSource.customHaikuModel)
      ? current.customHaikuModel
      : defaults.customHaikuModel ?? current.customHaikuModel,
    customSonnetModel: fieldWasSaved(savedSource.customSonnetModel)
      ? current.customSonnetModel
      : defaults.customSonnetModel ?? current.customSonnetModel,
    customOpusModel: fieldWasSaved(savedSource.customOpusModel)
      ? current.customOpusModel
      : defaults.customOpusModel ?? current.customOpusModel,
    customApiFormat: savedSource.customApiFormat ?? defaults.customApiFormat ?? current.customApiFormat,
    customApiKeyField: savedSource.customApiKeyField ?? defaults.customApiKeyField ?? current.customApiKeyField,
  });
}

export function apiProviderPreset(id: ApiProviderPresetId): ApiProviderPreset {
  return API_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? API_PROVIDER_PRESETS[0];
}

export function claudeApiProviderPreset(id: ClaudeApiProviderPresetId): ClaudeApiProviderPreset {
  return CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? CLAUDE_API_PROVIDER_PRESETS[0];
}

export function findClaudeApiProviderPresetByBaseUrl(baseUrl: string): ClaudeApiProviderPreset | null {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return null;
  return CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.baseUrl.replace(/\/+$/, "") === normalized) ?? null;
}

function fieldWasSaved(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeProviderPresetId(value: string | undefined): ApiProviderPresetId {
  return API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ApiProviderPresetId) : "codexzh";
}

function normalizeClaudeProviderPresetId(value: string | undefined): ClaudeApiProviderPresetId {
  return CLAUDE_API_PROVIDER_PRESETS.some((preset) => preset.id === value) ? (value as ClaudeApiProviderPresetId) : "custom";
}

function normalizeClaudeApiFormat(value: string | undefined): ClaudeApiFormat {
  if (value === "openai_chat" || value === "openai_responses" || value === "gemini_native") return value;
  return "anthropic";
}

function normalizeNonEmptyString(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}
