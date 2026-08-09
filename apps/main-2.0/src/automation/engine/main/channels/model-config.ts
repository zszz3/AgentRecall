import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { normalizeConfigChannelsForStorage } from "../../shared/config-channels";
import { CURRENT_CODEX_MODELS, DEFAULT_MODEL_ID, FALLBACK_MODEL_OPTIONS, defaultModelOption, runtimeModelId } from "../../shared/models";
import { isRuntimeId, RUNTIME_DEFINITIONS } from "../../shared/runtime-catalog";
import type {
  AgentChannel,
  AgentId,
  AgentModelOption,
  AgentPluginConfig,
  ClaudeDefaultConfig,
  CodexDefaultConfig,
  GeneratedConfigFile,
  ImportedCodexConfig,
} from "../../shared/types";
import { codexChannelNeedsChatRouting, codexChatRouterUrlForChannel } from "../bridges/codex-chat-router";
import { execCli } from "../platform/cli-launcher";
const CONFIG_VERSION = 1;
const BUILT_IN_CODEX_PROVIDER_IDS = new Set(["openai"]);
interface ModelChannelsFile {
  version: typeof CONFIG_VERSION;
  channels: AgentChannel[];
}

interface CodexAuthFile {
  OPENAI_API_KEY?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = [...new Set(value.map(asString).filter((item): item is string => Boolean(item)))];
  return strings.length > 0 ? strings : undefined;
}

/** Short digest used to keep sanitized profile parts distinct from one another. */
function profilePartDigest(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/**
 * Profile names are Codex TOML section names, so they may only hold `[a-z0-9-]`. The fallback
 * is deliberately not `DEFAULT_MODEL_ID`: a part that sanitizes away must not collide with the
 * profile generated for the Default model.
 *
 * Sanitizing on its own is lossy — `codewiz:gpt-5.6-sol`, `codewiz-gpt-5.6-sol`, and
 * `CodeWiz:GPT-5.6-Sol` all collapse to the same string. Each model writes its own
 * `<profile>.config.toml`, so colliding parts made the last model written silently replace the
 * others, and `profileNameFor` then resolved runs to whichever one survived. Appending a digest
 * of the original keeps distinct inputs distinct; a value that was already a legal part is left
 * alone so the common case keeps its readable name.
 */
function sanitizeProfilePart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) return `unnamed-${profilePartDigest(value)}`;
  return sanitized === value ? sanitized : `${sanitized}-${profilePartDigest(value)}`;
}

function profileNameFromPath(filePath: string): string {
  const basename = path.basename(filePath);
  if (basename.endsWith(".config.toml")) return basename.slice(0, -".config.toml".length);
  if (basename.endsWith(".toml")) return basename.slice(0, -".toml".length);
  return basename;
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

function quoteInlineTableKey(value: string): string {
  return JSON.stringify(value);
}

function stripInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = line[index - 1];
    if ((char === '"' || char === "'") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) return line.slice(0, index).trim();
  }
  return line.trim();
}

function unquoteTomlKey(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') !== trimmed.endsWith('"')) throw new Error(`Invalid TOML string: ${trimmed}`);
  if (trimmed.startsWith("'") !== trimmed.endsWith("'")) throw new Error(`Invalid TOML string: ${trimmed}`);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function parseTomlScalar(value: string): string | boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return parseTomlString(value);
}

function splitTomlCommaList(value: string): string[] {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if ((char === '"' || char === "'") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "," && !quote) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseTomlInlineTable(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") !== trimmed.endsWith("}")) throw new Error(`Invalid TOML inline table: ${trimmed}`);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return undefined;

  const table: Record<string, string> = {};
  for (const entry of splitTomlCommaList(body)) {
    const separator = entry.indexOf("=");
    if (separator < 0) throw new Error(`Invalid TOML inline table entry: ${entry}`);
    const key = unquoteTomlKey(entry.slice(0, separator));
    const parsedValue = parseTomlString(entry.slice(separator + 1));
    if (key && parsedValue !== undefined) table[key] = parsedValue;
  }
  return Object.keys(table).length > 0 ? table : undefined;
}

function readKnownToml(raw: string): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = { root: {} };
  let activeSection = "root";

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;

    if (line.startsWith("[")) {
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (!sectionMatch?.[1]) continue;
      activeSection = sectionMatch[1].trim();
      sections[activeSection] ??= {};
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = unquoteTomlKey(line.slice(0, separator));
    if (!key) continue;
    const value = line.slice(separator + 1).trim();
    try {
      const inlineTable = parseTomlInlineTable(value);
      const section = sections[activeSection] ?? {};
      section[key] = inlineTable ?? parseTomlScalar(value);
      sections[activeSection] = section;
    } catch {
      // Unknown TOML values must not hide otherwise valid runtime defaults.
    }
  }

  return sections;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function pluginIdFromSection(section: string): string | undefined {
  if (!section.startsWith("plugins.")) return undefined;
  const id = unquoteTomlKey(section.slice("plugins.".length));
  return id.trim() || undefined;
}

function pluginConfigKey(pluginId: string): string {
  return `plugins.${quoteInlineTableKey(pluginId)}.enabled`;
}

function normalizeModels(models: unknown, fallback: AgentModelOption[]): AgentModelOption[] {
  const normalized: AgentModelOption[] = [];
  if (Array.isArray(models)) {
    for (const item of models) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = asString(record.id);
      if (!id || normalized.some((model) => model.id === id)) continue;
      const reasoningEfforts = asStringArray(record.reasoningEfforts);
      const defaultReasoningEffort = asString(record.defaultReasoningEffort);
      normalized.push({
        id,
        label: asString(record.label) ?? id,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      });
    }
  }

  const source = normalized.length > 0 ? normalized : fallback;
  if (source.some((model) => model.id === DEFAULT_MODEL_ID)) return source;
  return [defaultModelOption(), ...source];
}

/**
 * The routable tail of a model id. Gateways prefix the same model in their own way
 * (`codewiz:gpt-5.6-sol`, `gh/gpt-5.6-sol`), and only the tail names the model itself.
 * Different prefixes stay distinct entries — they are different routes — but they are enough
 * to recognize that the built-in catalog has nothing new to add.
 */
function bareModelKey(id: string): string {
  const tail = id.split(/[:/]/).pop() ?? id;
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Tops up the official Codex channel with the current models — without stacking a bare
 * `gpt-5.6-sol` next to the `codewiz:gpt-5.6-sol` the channel already routes. A channel entry
 * always keeps its own id and label, because that is the name the gateway accepts; the catalog
 * only fills in reasoning levels the channel did not specify.
 */
function addCurrentCodexModels(models: AgentModelOption[]): AgentModelOption[] {
  const defaultModel = models.find((model) => model.id === DEFAULT_MODEL_ID);
  const listed = models.filter((model) => model.id !== DEFAULT_MODEL_ID);
  const listedKeys = new Set(listed.map((model) => bareModelKey(model.id)));
  const enriched = listed.map((model) => {
    const catalog = CURRENT_CODEX_MODELS.find((entry) => bareModelKey(entry.id) === bareModelKey(model.id));
    if (!catalog) return model;
    return {
      ...model,
      reasoningEfforts: [...(model.reasoningEfforts ?? catalog.reasoningEfforts ?? [])],
      ...(model.defaultReasoningEffort || !catalog.defaultReasoningEffort
        ? {}
        : { defaultReasoningEffort: catalog.defaultReasoningEffort }),
    };
  });
  const missing = CURRENT_CODEX_MODELS
    .filter((model) => !listedKeys.has(bareModelKey(model.id)))
    .map((model) => ({ ...model, reasoningEfforts: [...(model.reasoningEfforts ?? [])] }));
  return [...(defaultModel ? [defaultModel] : []), ...missing, ...enriched];
}

function primaryClaudeProviderModels(models: AgentModelOption[], environment: Record<string, string> | undefined): AgentModelOption[] {
  const primaryModelId = environment?.ANTHROPIC_MODEL;
  if (!primaryModelId) return models;
  const primary = models.find((model) => model.id === primaryModelId) ?? { id: primaryModelId, label: primaryModelId };
  return [defaultModelOption(), primary];
}

function isCodexOfficialChannel(channel: AgentChannel): boolean {
  return channel.agentId === "codex" && (
    channel.modelProvider === "openai" ||
    channel.id === "codex-openai" ||
    channel.id === "codex-official" ||
    channel.presetId === "codex-default"
  );
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  try {
    const value = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    return Object.keys(value).length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizePlugins(raw: unknown): AgentPluginConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const plugins: AgentPluginConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asString(record.id);
    if (!id || plugins.some((plugin) => plugin.id === id)) continue;
    plugins.push({
      id,
      enabled: asBoolean(record.enabled) ?? true,
    });
  }
  return plugins.length > 0 ? plugins : undefined;
}

function normalizeChannel(raw: unknown): AgentChannel | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asString(record.id);
  if (!id || !isRuntimeId(record.agentId)) return null;

  const channel: AgentChannel = {
    id,
    agentId: record.agentId,
    label: asString(record.label) ?? id,
    models: normalizeModels(record.models, FALLBACK_MODEL_OPTIONS[record.agentId]),
  };

  const profileName = asString(record.profileName);
  if (profileName) channel.profileName = profileName;
  const presetId = asString(record.presetId);
  if (presetId) channel.presetId = presetId;
  const modelProvider = asString(record.modelProvider);
  if (modelProvider) channel.modelProvider = modelProvider;
  const providerName = asString(record.providerName);
  if (providerName) channel.providerName = providerName;
  const baseUrl = asString(record.baseUrl);
  if (baseUrl) channel.baseUrl = baseUrl;
  const wireApi = asString(record.wireApi);
  if (wireApi) channel.wireApi = wireApi;
  const modelCatalogJson = asString(record.modelCatalogJson);
  if (modelCatalogJson) channel.modelCatalogJson = modelCatalogJson;
  const modelReasoningEffort = asString(record.modelReasoningEffort);
  if (modelReasoningEffort) channel.modelReasoningEffort = modelReasoningEffort;
  const httpHeaders = normalizeHeaders(record.httpHeaders);
  if (httpHeaders) channel.httpHeaders = httpHeaders;
  if (
    record.apiFormat === "anthropic" ||
    record.apiFormat === "openai_chat" ||
    record.apiFormat === "openai_responses" ||
    record.apiFormat === "gemini_native"
  ) {
    channel.apiFormat = record.apiFormat;
  }
  if (record.apiKeyField === "ANTHROPIC_AUTH_TOKEN" || record.apiKeyField === "ANTHROPIC_API_KEY") {
    channel.apiKeyField = record.apiKeyField;
  }
  if (typeof record.isFullUrl === "boolean") channel.isFullUrl = record.isFullUrl;
  const customUserAgent = asString(record.customUserAgent);
  if (customUserAgent) channel.customUserAgent = customUserAgent;
  const environment = normalizeHeaders(record.environment);
  if (environment) channel.environment = environment;
  if (isCodexOfficialChannel(channel)) channel.models = addCurrentCodexModels(channel.models);
  if (channel.agentId === "claude") channel.models = primaryClaudeProviderModels(channel.models, environment);
  if (record.requestOverrides && typeof record.requestOverrides === "object" && !Array.isArray(record.requestOverrides)) {
    const requestOverrides = record.requestOverrides as Record<string, unknown>;
    const headers = normalizeHeaders(requestOverrides.headers);
    const body = normalizeJsonObject(requestOverrides.body);
    if (headers || body) channel.requestOverrides = { ...(headers ? { headers } : {}), ...(body ? { body } : {}) };
  }
  const plugins = normalizePlugins(record.plugins);
  if (plugins) channel.plugins = plugins;

  return channel;
}

export function normalizeChannels(channels: unknown): AgentChannel[] {
  const normalized = Array.isArray(channels)
    ? channels.map((channel) => normalizeChannel(channel)).filter((channel): channel is AgentChannel => Boolean(channel))
    : [];

  const unique: AgentChannel[] = [];
  for (const channel of normalized) {
    if (!unique.some((item) => item.id === channel.id)) unique.push(channel);
  }

  return unique.length > 0 ? unique : createDefaultChannels();
}

export function parseCodexModelCatalog(raw: string): AgentModelOption[] {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return models
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = asString(record.slug) ?? asString(record.id);
      if (!id || record.visibility === "hidden") return null;
      const priority = typeof record.priority === "number" && Number.isFinite(record.priority) ? record.priority : 9999;
      const reasoningEfforts = Array.isArray(record.supported_reasoning_levels)
        ? record.supported_reasoning_levels
            .map((level) => asString(level && typeof level === "object" ? (level as Record<string, unknown>).effort : undefined))
            .filter((effort): effort is string => Boolean(effort))
        : undefined;
      const defaultReasoningEffort = asString(record.default_reasoning_level);
      return {
        id,
        label: asString(record.display_name) ?? asString(record.label) ?? id,
        priority,
        ...(reasoningEfforts && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      };
    })
    .filter((item): item is AgentModelOption & { priority: number } => Boolean(item))
    .sort((left, right) => left.priority - right.priority)
    .map(({ id, label, reasoningEfforts, defaultReasoningEffort }) => ({
      id,
      label,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    }));
}

export async function detectCodexModels(command = "codex"): Promise<AgentModelOption[]> {
  const { stdout } = await execCli({
    executable: command,
    args: ["debug", "models"],
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return parseCodexModelCatalog(stdout);
}

export function createDefaultChannels(codexModels = FALLBACK_MODEL_OPTIONS.codex.filter((model) => model.id !== DEFAULT_MODEL_ID)): AgentChannel[] {
  return RUNTIME_DEFINITIONS
    .filter((definition) => definition.autoCreateConfig)
    .map((definition) => ({
      ...definition.defaultChannel,
      agentId: definition.id,
      models: definition.id === "codex"
        ? normalizeModels(codexModels, FALLBACK_MODEL_OPTIONS.codex)
        : FALLBACK_MODEL_OPTIONS[definition.id],
    }));
}

export function appendMissingRuntimeDefaultChannels(channels: AgentChannel[]): AgentChannel[] {
  const configuredRuntimeIds = new Set(channels.map((channel) => channel.agentId));
  const missingDefaults = createDefaultChannels().filter((channel) => !configuredRuntimeIds.has(channel.agentId));
  return missingDefaults.length > 0 ? [...channels, ...missingDefaults] : channels;
}

export async function loadModelChannels(configPath: string, codexCommand = "codex"): Promise<AgentChannel[]> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelChannelsFile>;
    return normalizeConfigChannelsForStorage(normalizeChannels(parsed.channels));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") console.warn(`Failed to load model channel config from ${configPath}:`, error);
  }

  try {
    const detected = await detectCodexModels(codexCommand);
    return createDefaultChannels(detected);
  } catch {
    return createDefaultChannels();
  }
}

export async function saveModelChannels(configPath: string, channels: AgentChannel[]): Promise<AgentChannel[]> {
  const normalized = normalizeConfigChannelsForStorage(normalizeChannels(channels));
  const payload: ModelChannelsFile = {
    version: CONFIG_VERSION,
    channels: normalized,
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return normalized;
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function normalizeCodexDefaultConfig(config: Partial<CodexDefaultConfig>): CodexDefaultConfig {
  return {
    modelProvider: config.modelProvider ?? null,
    providerName: config.providerName ?? null,
    baseUrl: config.baseUrl ?? null,
    wireApi: config.wireApi ?? null,
    httpHeaders: config.httpHeaders ?? null,
    apiKey: config.apiKey ?? null,
    modelId: config.modelId ?? null,
    modelCatalogJson: config.modelCatalogJson ?? null,
    modelReasoningEffort: config.modelReasoningEffort ?? null,
    plugins: config.plugins ?? null,
  };
}

function generatedProfileNameFor(channel: AgentChannel, modelId: string): string {
  return `multi-agent-${sanitizeProfilePart(channel.id)}-${sanitizeProfilePart(modelId)}`;
}

export function profileNameFor(channel: AgentChannel, modelId: string): string {
  if (channel.profileName && modelId === DEFAULT_MODEL_ID) return channel.profileName;
  return generatedProfileNameFor(channel, modelId);
}

export function codexProfileArgs(channel: AgentChannel | undefined, modelId: string): string[] {
  if (!channel || channel.agentId !== "codex") return [];
  return ["--profile", profileNameFor(channel, modelId)];
}

function pushConfigOverride(args: string[], key: string, value: string): void {
  args.push("-c", `${key}=${quoteToml(value)}`);
}

function pushBooleanConfigOverride(args: string[], key: string, value: boolean): void {
  args.push("-c", `${key}=${value ? "true" : "false"}`);
}

export function codexAppServerConfigArgs(channel: AgentChannel | undefined, modelId: string, reasoningEffort?: string): string[] {
  if (!channel || channel.agentId !== "codex") return [];

  const args: string[] = [];
  if (channel.modelProvider) pushConfigOverride(args, "model_provider", channel.modelProvider);

  const model = runtimeModelId(modelId);
  if (model) pushConfigOverride(args, "model", model);

  const effectiveReasoningEffort = reasoningEffort?.trim() || channel.modelReasoningEffort;
  if (effectiveReasoningEffort) pushConfigOverride(args, "model_reasoning_effort", effectiveReasoningEffort);
  if (channel.modelCatalogJson) pushConfigOverride(args, "model_catalog_json", channel.modelCatalogJson);
  for (const plugin of channel.plugins ?? []) {
    pushBooleanConfigOverride(args, pluginConfigKey(plugin.id), plugin.enabled);
  }

  if (channel.modelProvider && !BUILT_IN_CODEX_PROVIDER_IDS.has(channel.modelProvider)) {
    const prefix = `model_providers.${channel.modelProvider}`;
    const routedBaseUrl = codexChatRouterUrlForChannel(channel);
    const baseUrl = routedBaseUrl ?? channel.baseUrl;
    if (channel.providerName) pushConfigOverride(args, `${prefix}.name`, channel.providerName);
    if (baseUrl) pushConfigOverride(args, `${prefix}.base_url`, baseUrl);
    if (channel.wireApi) pushConfigOverride(args, `${prefix}.wire_api`, channel.wireApi);
    if (channel.httpHeaders?.Authorization || codexChannelNeedsChatRouting(channel)) {
      pushBooleanConfigOverride(args, `${prefix}.requires_openai_auth`, true);
      pushConfigOverride(args, `${prefix}.env_key`, "OPENAI_API_KEY");
    }
    if (!routedBaseUrl && channel.httpHeaders && Object.keys(channel.httpHeaders).length > 0) {
      const headers = Object.entries(channel.httpHeaders)
        .map(([key, value]) => `${quoteInlineTableKey(key)} = ${quoteToml(value)}`)
        .join(", ");
      args.push("-c", `${prefix}.http_headers={ ${headers} }`);
    }
  }

  return args;
}

export function parseCodexProfileConfig(sourcePath: string, raw: string): ImportedCodexConfig | null {
  let sections: Record<string, Record<string, unknown>>;
  try {
    sections = readKnownToml(raw);
  } catch {
    return null;
  }
  const root = sections.root ?? {};
  const profileName = profileNameFromPath(sourcePath);
  const modelProvider = asString(root.model_provider);
  const providerSectionName = modelProvider
    ? `model_providers.${modelProvider}`
    : Object.keys(sections).find((section) => section.startsWith("model_providers."));
  const providerSection = providerSectionName ? sections[providerSectionName] ?? {} : {};
  const model = asString(root.model);

  const models: AgentModelOption[] = [defaultModelOption()];
  if (model) models.push({ id: model, label: model });

  const channel: AgentChannel = {
    id: `codex-${sanitizeProfilePart(profileName)}`,
    agentId: "codex",
    label: `Codex ${profileName}`,
    profileName,
    models,
  };

  if (modelProvider) channel.modelProvider = modelProvider;
  const providerName = asString(providerSection.name);
  if (providerName) channel.providerName = providerName;
  const baseUrl = asString(providerSection.base_url);
  if (baseUrl) channel.baseUrl = baseUrl;
  const wireApi = asString(providerSection.wire_api);
  if (wireApi) channel.wireApi = wireApi;
  const modelCatalogJson = asString(root.model_catalog_json);
  if (modelCatalogJson) channel.modelCatalogJson = modelCatalogJson;
  const modelReasoningEffort = asString(root.model_reasoning_effort);
  if (modelReasoningEffort) channel.modelReasoningEffort = modelReasoningEffort;
  const headers = normalizeHeaders(providerSection.http_headers);
  if (headers) channel.httpHeaders = headers;
  const plugins: AgentPluginConfig[] = [];
  for (const [sectionName, section] of Object.entries(sections)) {
    const id = pluginIdFromSection(sectionName);
    if (!id) continue;
    plugins.push({ id, enabled: asBoolean(section.enabled) ?? true });
  }
  if (plugins.length > 0) channel.plugins = plugins;

  return {
    sourcePath,
    channel,
  };
}

export function parseCodexDefaultConfig(rawConfigToml: string, rawAuthJson: string | undefined): CodexDefaultConfig {
  const config = normalizeCodexDefaultConfig({});

  try {
    const sections = readKnownToml(rawConfigToml);
    const root = sections.root ?? {};
    const modelProvider = asString(root.model_provider);
    config.modelProvider = modelProvider ?? null;
    config.modelId = asString(root.model) ?? null;
    config.modelCatalogJson = asString(root.model_catalog_json) ?? null;
    config.modelReasoningEffort = asString(root.model_reasoning_effort) ?? null;

    const providerSectionName = modelProvider ? `model_providers.${modelProvider}` : undefined;
    const providerSection = providerSectionName ? sections[providerSectionName] ?? {} : {};
    config.providerName = asString(providerSection.name) ?? null;
    config.baseUrl = asString(providerSection.base_url) ?? null;
    config.wireApi = asString(providerSection.wire_api) ?? null;
    config.httpHeaders = normalizeHeaders(providerSection.http_headers) ?? null;

    const plugins: AgentPluginConfig[] = [];
    for (const [sectionName, section] of Object.entries(sections)) {
      const id = pluginIdFromSection(sectionName);
      if (!id) continue;
      plugins.push({ id, enabled: asBoolean(section.enabled) ?? true });
    }
    config.plugins = plugins.length > 0 ? plugins : null;
  } catch {
    // Return null-filled config if TOML parsing fails.
  }

  if (rawAuthJson !== undefined) {
    try {
      const parsed = JSON.parse(rawAuthJson) as CodexAuthFile;
      config.apiKey = asString(parsed.OPENAI_API_KEY) ?? null;
    } catch {
      config.apiKey = null;
    }
  }

  return normalizeCodexDefaultConfig(config);
}

export async function loadCodexDefaultConfig(home = codexHome()): Promise<CodexDefaultConfig> {
  let rawConfigToml = "";
  try {
    rawConfigToml = await readFile(path.join(home, "config.toml"), "utf8");
  } catch {
    rawConfigToml = "";
  }

  let rawAuthJson: string | undefined;
  try {
    rawAuthJson = await readFile(path.join(home, "auth.json"), "utf8");
  } catch {
    rawAuthJson = undefined;
  }

  return parseCodexDefaultConfig(rawConfigToml, rawAuthJson);
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function parseClaudeDefaultConfig(rawSettingsJson: string | undefined, env: NodeJS.ProcessEnv = process.env): ClaudeDefaultConfig {
  let settings: Record<string, unknown> = {};
  if (rawSettingsJson) {
    try {
      const parsed = JSON.parse(rawSettingsJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const settingsEnv = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  const value = (key: string): string | null => asString(env[key]) ?? asString(settingsEnv[key]) ?? null;
  return {
    baseUrl: value("ANTHROPIC_BASE_URL"),
    apiKey: value("ANTHROPIC_AUTH_TOKEN") ?? value("ANTHROPIC_API_KEY"),
    modelId: value("ANTHROPIC_MODEL") ?? asString(settings.model) ?? null,
  };
}

export async function loadClaudeDefaultConfig(home = claudeHome(), env: NodeJS.ProcessEnv = process.env): Promise<ClaudeDefaultConfig> {
  let rawSettingsJson: string | undefined;
  try {
    rawSettingsJson = await readFile(path.join(home, "settings.json"), "utf8");
  } catch {
    rawSettingsJson = undefined;
  }
  return parseClaudeDefaultConfig(rawSettingsJson, env);
}

export async function importCodexConfigs(home = codexHome()): Promise<ImportedCodexConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  const imported: ImportedCodexConfig[] = [];
  for (const entry of entries.sort()) {
    if (entry !== "config.toml" && !entry.startsWith("config_") && !entry.endsWith(".config.toml")) continue;
    if (!entry.endsWith(".toml")) continue;
    const sourcePath = path.join(home, entry);
    const raw = await readFile(sourcePath, "utf8");
    const parsed = parseCodexProfileConfig(sourcePath, raw);
    if (parsed) imported.push(parsed);
  }
  return imported;
}

function renderProviderConfig(channel: AgentChannel): string[] {
  if (!channel.modelProvider) return [];
  if (BUILT_IN_CODEX_PROVIDER_IDS.has(channel.modelProvider)) return [];
  if (!channel.providerName && !channel.baseUrl && !channel.wireApi && !channel.httpHeaders) return [];

  const lines = ["", `[model_providers.${channel.modelProvider}]`];
  if (channel.providerName) lines.push(`name = ${quoteToml(channel.providerName)}`);
  if (channel.baseUrl) lines.push(`base_url = ${quoteToml(channel.baseUrl)}`);
  if (channel.wireApi) lines.push(`wire_api = ${quoteToml(channel.wireApi)}`);
  if (channel.httpHeaders && Object.keys(channel.httpHeaders).length > 0) {
    const entries = Object.entries(channel.httpHeaders).map(([key, value]) => `${quoteInlineTableKey(key)} = ${quoteToml(value)}`);
    lines.push(`http_headers = { ${entries.join(", ")} }`);
  }
  return lines;
}

function renderPluginConfig(channel: AgentChannel): string[] {
  if (!channel.plugins || channel.plugins.length === 0) return [];
  const lines: string[] = [];
  for (const plugin of channel.plugins) {
    lines.push("", `[plugins.${quoteInlineTableKey(plugin.id)}]`, `enabled = ${plugin.enabled ? "true" : "false"}`);
  }
  return lines;
}

const GENERATED_PROFILE_HEADER = "# Generated by AgentRecall. Edit runtime-channels.json and regenerate instead of editing this file.";

function renderCodexProfile(channel: AgentChannel, modelId: string): string {
  const lines: string[] = [
    GENERATED_PROFILE_HEADER,
  ];
  if (channel.modelProvider) lines.push(`model_provider = ${quoteToml(channel.modelProvider)}`);

  const model = runtimeModelId(modelId);
  if (model) lines.push(`model = ${quoteToml(model)}`);
  if (channel.modelReasoningEffort) lines.push(`model_reasoning_effort = ${quoteToml(channel.modelReasoningEffort)}`);
  if (channel.modelCatalogJson) lines.push(`model_catalog_json = ${quoteToml(channel.modelCatalogJson)}`);

  lines.push(...renderProviderConfig(channel));
  lines.push(...renderPluginConfig(channel));
  return `${lines.join("\n")}\n`;
}

/**
 * Profile file names embed the channel and model ids, so renaming or removing either leaves the
 * old file behind in the user's Codex home, where `--profile` can still resolve it.
 *
 * Only files this app wrote are removed: the generated header is the proof of authorship, so a
 * hand-written `multi-agent-*.config.toml` — or one we cannot read — is left alone.
 */
async function pruneStaleGeneratedProfiles(home: string, keep: Set<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("multi-agent-") || !entry.endsWith(".config.toml")) continue;
    if (keep.has(entry)) continue;
    const filePath = path.join(home, entry);
    try {
      const contents = await readFile(filePath, "utf8");
      if (!contents.startsWith(GENERATED_PROFILE_HEADER)) continue;
      await rm(filePath);
    } catch {
      // Unreadable or already gone: never delete a profile we could not confirm we wrote.
    }
  }
}

export async function generateCodexConfigs(channels: AgentChannel[], home = codexHome()): Promise<GeneratedConfigFile[]> {
  const generated: GeneratedConfigFile[] = [];
  const written = new Set<string>();
  await mkdir(home, { recursive: true });

  for (const channel of normalizeChannels(channels)) {
    if (channel.agentId !== "codex") continue;
    for (const model of channel.models) {
      const profileName = generatedProfileNameFor(channel, model.id);
      const fileName = `${profileName}.config.toml`;
      const filePath = path.join(home, fileName);
      await writeFile(filePath, renderCodexProfile(channel, model.id), "utf8");
      written.add(fileName);
      generated.push({
        channelId: channel.id,
        modelId: model.id,
        profileName,
        path: filePath,
      });
    }
  }

  await pruneStaleGeneratedProfiles(home, written);

  return generated;
}
