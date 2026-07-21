import { DEFAULT_MODEL_ID } from "../../../../shared/models";
import type { AgentChannel, AgentModelOption, AgentPluginConfig, ClaudeDefaultConfig, CodexDefaultConfig, ProviderBalanceResult } from "../../../../shared/types";
import { CLAUDE_LOCAL_DEFAULT_PRESET_ID, CODEX_LOCAL_DEFAULT_PRESET_ID, type AgentProviderPreset } from "../../../../shared/provider-presets";
import type { Language } from "../../app/language";
import { missingAppCapabilityMessage } from "../../app/shell";
import type { AgentTestUiState } from "./runtime-types";

export function formatBalanceNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

export function formatBalanceValue(item: ProviderBalanceResult["items"][number]): string {
  if (typeof item.remaining !== "number") return item.invalidMessage ?? "Unavailable";
  return `${formatBalanceNumber(item.remaining)}${item.unit ? ` ${item.unit}` : ""}`;
}

export function formatBalanceDetail(item: ProviderBalanceResult["items"][number], language: Language): string {
  const detailParts: string[] = [];
  if (typeof item.total === "number") detailParts.push(`${language === "zh" ? "总额" : "Total"} ${formatBalanceNumber(item.total)}`);
  if (typeof item.used === "number") detailParts.push(`${language === "zh" ? "已用" : "Used"} ${formatBalanceNumber(item.used)}`);
  if (item.invalidMessage) detailParts.push(item.invalidMessage);
  return detailParts.join(" · ");
}

export function agentTestEventLabel(type: AgentTestUiState["transcript"][number]["type"]): string {
  if (type === "user") return "You";
  if (type === "assistant" || type === "assistant_delta") return "Agent";
  if (type === "tool") return "Tool";
  if (type === "warning") return "warning";
  if (type === "stderr") return "stderr";
  if (type === "error") return "error";
  return "system";
}

export function applyProviderPresetToChannel(channel: AgentChannel, preset: AgentProviderPreset, apiKey = ""): AgentChannel {
  const presetModelIds = new Set(preset.models.map((model) => model.id));
  const customModels = channel.presetId === preset.id
    ? channel.models.filter((model) => model.id !== DEFAULT_MODEL_ID && !presetModelIds.has(model.id))
    : [];
  const next: AgentChannel = {
    ...channel,
    agentId: preset.runtimeAgentId,
    presetId: preset.id,
    models: [...preset.models.map((model) => ({ ...model })), ...customModels.map((model) => ({ ...model }))],
  };
  delete next.providerName;
  delete next.modelProvider;
  delete next.baseUrl;
  delete next.wireApi;
  delete next.apiFormat;
  delete next.apiKeyField;
  delete next.environment;
  delete next.modelReasoningEffort;
  delete next.modelCatalogJson;
  delete next.httpHeaders;
  if (preset.providerName) next.providerName = preset.providerName;
  if (preset.modelProvider) next.modelProvider = preset.modelProvider;
  if (preset.baseUrl) next.baseUrl = preset.baseUrl;
  if (preset.wireApi) next.wireApi = preset.wireApi;
  if (preset.apiFormat) next.apiFormat = preset.apiFormat;
  if (preset.apiKeyField) next.apiKeyField = preset.apiKeyField;
  if (preset.environment) next.environment = { ...preset.environment };
  if (preset.modelReasoningEffort) next.modelReasoningEffort = preset.modelReasoningEffort;
  if (preset.extraHeaders) next.httpHeaders = { ...preset.extraHeaders };
  const normalizedApiKey = apiKey.trim();
  if (preset.usesApiKey && normalizedApiKey) {
    const headerName = preset.apiKeyHeaderName ?? "Authorization";
    const prefix = preset.apiKeyPrefix ?? "Bearer ";
    next.httpHeaders = {
      ...(next.httpHeaders ?? {}),
      [headerName]: `${prefix}${normalizedApiKey}`,
    };
  }
  return next;
}

export function applyClaudeDefaultConfigToChannel(channel: AgentChannel, config: ClaudeDefaultConfig): AgentChannel {
  const next: AgentChannel = {
    ...channel,
    agentId: "claude",
    presetId: CLAUDE_LOCAL_DEFAULT_PRESET_ID,
    models: defaultModelsForCodexConfig(config.modelId),
  };
  delete next.modelProvider;
  delete next.providerName;
  delete next.baseUrl;
  delete next.apiFormat;
  delete next.apiKeyField;
  delete next.environment;
  delete next.requestOverrides;
  delete next.customUserAgent;
  delete next.httpHeaders;
  if (config.baseUrl || config.apiKey) {
    next.modelProvider = "claude-default-anthropic";
    next.providerName = "Claude Code Default";
  }
  if (config.baseUrl) next.baseUrl = config.baseUrl;
  if (config.apiKey) next.httpHeaders = { Authorization: `Bearer ${config.apiKey}` };
  return next;
}

function cloneChannelModels(models: AgentModelOption[]): AgentModelOption[] {
  return models.map((model) => ({ ...model }));
}

function defaultModelsForCodexConfig(modelId: string | null): AgentModelOption[] {
  const models: AgentModelOption[] = [{ id: DEFAULT_MODEL_ID, label: "Default" }];
  const normalizedModelId = modelId?.trim();
  if (normalizedModelId && normalizedModelId !== DEFAULT_MODEL_ID) {
    models.push({ id: normalizedModelId, label: normalizedModelId });
  }
  return models;
}

function cloneOptionalHeaders(headers: Record<string, string> | null): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

function cloneOptionalPlugins(plugins: AgentPluginConfig[] | null): AgentPluginConfig[] | undefined {
  return plugins?.map((plugin) => ({ ...plugin }));
}

export function applyCodexDefaultConfigToChannel(channel: AgentChannel, config: CodexDefaultConfig): AgentChannel {
  const next: AgentChannel = {
    ...channel,
    agentId: "codex",
    presetId: CODEX_LOCAL_DEFAULT_PRESET_ID,
    models: defaultModelsForCodexConfig(config.modelId),
  };

  delete next.modelProvider;
  delete next.providerName;
  delete next.baseUrl;
  delete next.wireApi;
  delete next.apiFormat;
  delete next.apiKeyField;
  delete next.environment;
  delete next.requestOverrides;
  delete next.customUserAgent;
  delete next.httpHeaders;
  delete next.modelCatalogJson;
  delete next.modelReasoningEffort;
  delete next.plugins;

  if (config.modelProvider) next.modelProvider = config.modelProvider;
  if (config.providerName) next.providerName = config.providerName;
  if (config.baseUrl) next.baseUrl = config.baseUrl;
  if (config.wireApi) next.wireApi = config.wireApi;
  if (config.modelCatalogJson) next.modelCatalogJson = config.modelCatalogJson;
  if (config.modelReasoningEffort) next.modelReasoningEffort = config.modelReasoningEffort;

  const headers = cloneOptionalHeaders(config.httpHeaders) ?? {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (Object.keys(headers).length > 0) next.httpHeaders = headers;

  const plugins = cloneOptionalPlugins(config.plugins);
  if (plugins && plugins.length > 0) next.plugins = plugins;

  return next;
}

export function applyProviderApiKeyToChannel(channel: AgentChannel, preset: AgentProviderPreset, apiKey = ""): AgentChannel {
  const next: AgentChannel = {
    ...channel,
    presetId: preset.id,
    models: cloneChannelModels(channel.models),
  };
  const normalizedApiKey = apiKey.trim();
  const headerName = preset.apiKeyHeaderName ?? "Authorization";
  const prefix = preset.apiKeyPrefix ?? "Bearer ";
  const headers = { ...(channel.httpHeaders ?? {}) };

  if (normalizedApiKey) {
    headers[headerName] = `${prefix}${normalizedApiKey}`;
  } else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === headerName.toLowerCase()) delete headers[key];
    }
  }

  if (Object.keys(headers).length > 0) next.httpHeaders = headers;
  else delete next.httpHeaders;
  return next;
}

export function resolveProviderPresetId(channel: AgentChannel | undefined, presets: AgentProviderPreset[]): string | undefined {
  if (!channel) return undefined;
  if (channel.presetId && presets.some((preset) => preset.id === channel.presetId)) return channel.presetId;
  if (presets.some((preset) => preset.id === channel.id)) return channel.id;
  return (
    presets.find(
      (preset) =>
        preset.runtimeAgentId === channel.agentId &&
        (preset.modelProvider ?? "") === (channel.modelProvider ?? "") &&
        (preset.baseUrl ?? "") === (channel.baseUrl ?? ""),
    )?.id ?? (channel.agentId === "codex" ? "custom" : undefined)
  );
}

function headerValue(headers: Record<string, string> | undefined, headerName: string): string {
  if (!headers) return "";
  const target = headerName.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return match?.[1] ?? "";
}

export function apiKeyFromChannelHeaders(channel: AgentChannel | undefined, preset: AgentProviderPreset | undefined): string {
  if (!channel || !preset?.usesApiKey) return "";
  const rawValue = headerValue(channel.httpHeaders, preset.apiKeyHeaderName ?? "Authorization").trim();
  const prefix = preset.apiKeyPrefix ?? "Bearer ";
  if (!rawValue || !prefix) return rawValue;
  return rawValue.toLowerCase().startsWith(prefix.toLowerCase()) ? rawValue.slice(prefix.length).trim() : rawValue;
}

export function providerKeyValue(providerKeys: Record<string, string>, preset: AgentProviderPreset | undefined, channel: AgentChannel | undefined): string {
  if (!preset) return "";
  return apiKeyFromChannelHeaders(channel, preset) || providerKeys[preset.id] || "";
}

export function rememberProviderKeyFromChannel(
  providerKeys: Record<string, string>,
  preset: AgentProviderPreset | undefined,
  channel: AgentChannel | undefined,
): Record<string, string> {
  if (!preset?.usesApiKey) return providerKeys;
  const apiKey = apiKeyFromChannelHeaders(channel, preset);
  if (!apiKey || providerKeys[preset.id] === apiKey) return providerKeys;
  return { ...providerKeys, [preset.id]: apiKey };
}

export async function loadCodexDefaultConfigFromRuntimeApi(
  api: { loadCodexDefaultConfig?: () => Promise<CodexDefaultConfig> },
): Promise<CodexDefaultConfig> {
  if (typeof api.loadCodexDefaultConfig !== "function") {
    throw new Error(missingAppCapabilityMessage("Codex Default import"));
  }
  return api.loadCodexDefaultConfig();
}

export function headersToText(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function headersFromText(value: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const headerValue = trimmed.slice(separator + 1).trim();
    if (key) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function withOptionalString(channel: AgentChannel, key: keyof AgentChannel, value: string): AgentChannel {
  const next: AgentChannel = { ...channel, models: channel.models.map((model) => ({ ...model })) };
  const trimmed = value.trim();
  if (trimmed) {
    (next as unknown as Record<string, unknown>)[key] = trimmed;
  } else {
    delete (next as unknown as Record<string, unknown>)[key];
  }
  return next;
}

export function withOptionalHeaders(channel: AgentChannel, value: string): AgentChannel {
  const next: AgentChannel = { ...channel, models: channel.models.map((model) => ({ ...model })) };
  const headers = headersFromText(value);
  if (headers) next.httpHeaders = headers;
  else delete (next as unknown as Record<string, unknown>).httpHeaders;
  return next;
}

export function updatePluginAt(channel: AgentChannel, index: number, updater: (plugin: AgentPluginConfig) => AgentPluginConfig): AgentChannel {
  const plugins = [...(channel.plugins ?? [])];
  const current = plugins[index];
  if (!current) return channel;
  plugins[index] = updater(current);
  return { ...channel, plugins };
}

export function removePluginAt(channel: AgentChannel, index: number): AgentChannel {
  const plugins = (channel.plugins ?? []).filter((_, itemIndex) => itemIndex !== index);
  const next = { ...channel };
  if (plugins.length > 0) next.plugins = plugins;
  else delete next.plugins;
  return next;
}

export function addPluginToChannel(channel: AgentChannel, pluginId: string): AgentChannel {
  const id = pluginId.trim();
  if (!id) return channel;
  const plugins = [...(channel.plugins ?? [])];
  const existingIndex = plugins.findIndex((plugin) => plugin.id === id);
  if (existingIndex >= 0) {
    const existingPlugin = plugins[existingIndex];
    if (!existingPlugin) return channel;
    plugins[existingIndex] = { ...existingPlugin, enabled: true };
    return { ...channel, plugins };
  }
  return { ...channel, plugins: [...plugins, { id, enabled: true }] };
}
