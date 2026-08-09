import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_API_PROVIDER_PRESETS,
  findClaudeApiProviderPresetByBaseUrl,
  normalizeClaudeApiConfig,
  type ClaudeApiConfig,
} from "./api-config";
import { writeVerifiedConfig } from "./atomic-config-write";
import { probeProviderModels, type ProviderModelProbeResult, type ProviderModelsFetch } from "./provider-models";
import { prepareProviderConfigDirectory, resolveProviderConfigDirectory } from "./provider-config-path";

export interface ApplyClaudeProfileResult {
  profile: string;
  claudeHome: string;
  settingsPath: string;
  backupPaths: string[];
  credentialSource: string | null;
  verified: true;
}

export interface ClaudeConfigSnapshot {
  claudeHome: string;
  settingsPath: string;
  exists: boolean;
  /** Route currently written in settings.json, normalized to ClaudeApiConfig fields. */
  route: Partial<ClaudeApiConfig>;
  credentialSource: string | null;
  hasApiKey: boolean;
}

export interface ClaudeModelProbeInput {
  baseUrl: string;
  apiKey: string;
  apiFormat: ClaudeApiConfig["customApiFormat"];
  apiKeyField: ClaudeApiConfig["customApiKeyField"];
  claudeHome?: string;
  apiKeySource?: string;
}

export interface ClaudeModelProbeResult extends ProviderModelProbeResult {
  credentialSource: string;
}

const CLAUDE_ROUTE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "API_TIMEOUT_MS",
] as const;

export async function loadClaudeApiConfigDefaults(configuredHome?: string): Promise<Partial<ClaudeApiConfig>> {
  const claudeHome = resolveProviderConfigDirectory(configuredHome, ".claude");
  const settings = parseJsonObject(await readOptionalFile(path.join(claudeHome, "settings.json")));
  if (!settings) return {};

  const env = isPlainObject(settings.env) ? settings.env : {};
  const baseUrl = readString(env.ANTHROPIC_BASE_URL);
  const token = readString(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = readString(env.ANTHROPIC_API_KEY);
  const routeModel = readString(env.ANTHROPIC_MODEL);
  const model = routeModel || readString(settings.model);
  const hasRouteEnv = Boolean(baseUrl || token || apiKey || routeModel);
  if (!hasRouteEnv) return { activeProvider: "official" };

  const preset = baseUrl ? findClaudeApiProviderPresetByBaseUrl(baseUrl) : null;
  return normalizeClaudeApiConfig({
    activeProvider: "custom",
    customProviderId: preset?.id ?? "custom",
    customProviderName: preset?.providerName ?? providerNameFromBaseUrl(baseUrl),
    customBaseUrl: baseUrl,
    customApiKey: token || apiKey,
    customModel: model,
    customHaikuModel: readString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    customSonnetModel: readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    customOpusModel: readString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    customApiFormat: preset?.apiFormat ?? "anthropic",
    customApiKeyField: apiKey && !token ? "ANTHROPIC_API_KEY" : (preset?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"),
  });
}

export async function loadClaudeConfigSnapshot(configuredHome?: string): Promise<ClaudeConfigSnapshot> {
  const claudeHome = resolveProviderConfigDirectory(configuredHome, ".claude");
  const settingsPath = path.join(claudeHome, "settings.json");
  const text = await readOptionalFile(settingsPath);
  const route = await loadClaudeApiConfigDefaults(claudeHome);
  const credential = await resolveClaudeCredential({ claudeHome, apiKeyField: route.customApiKeyField });
  return {
    claudeHome,
    settingsPath,
    exists: Boolean(text?.trim()),
    route: Object.keys(route).length > 0 ? { ...route, customApiKey: "" } : route,
    credentialSource: credential.source,
    hasApiKey: Boolean(credential.apiKey),
  };
}

export async function probeClaudeModels(
  input: ClaudeModelProbeInput,
  fetchImpl: ProviderModelsFetch = fetch,
): Promise<ClaudeModelProbeResult> {
  const claudeHome = resolveProviderConfigDirectory(input.claudeHome, ".claude");
  const explicitKey = input.apiKey.trim();
  const credential = await resolveClaudeCredential({
    claudeHome,
    apiKeyField: input.apiKeyField,
    explicitKey,
    explicitSource: input.apiKeySource,
  });
  const result = await probeProviderModels({
    baseUrl: input.baseUrl,
    apiKey: credential.apiKey,
    apiFormat: input.apiFormat,
  }, fetchImpl);
  return { ...result, credentialSource: credential.source || "resolved credential" };
}

export async function applyClaudeApiConfig(options: {
  claudeHome?: string;
  apiConfig: Partial<ClaudeApiConfig>;
  now?: Date;
}): Promise<ApplyClaudeProfileResult> {
  const apiConfig = claudeApiConfigWithPresetDefaults(options.apiConfig);
  const claudeHome = await prepareProviderConfigDirectory(options.claudeHome ?? apiConfig.customConfigDir, ".claude");
  const settingsPath = path.join(claudeHome, "settings.json");
  const backupDir = path.join(claudeHome, "backups");
  const profile = apiConfig.activeProvider === "custom" ? claudeProviderId(apiConfig) : "claude-official";
  const stamp = backupStamp(options.now ?? new Date());

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTarget(settingsPath, path.join(backupDir, `settings.json.before-${profile}-${stamp}`));
  const settings = await loadMutableSettings(settingsPath);

  let credentialSource: string | null = null;
  if (apiConfig.activeProvider === "custom") {
    const credential = await resolveClaudeCredential({
      claudeHome,
      apiKeyField: apiConfig.customApiKeyField,
      explicitKey: apiConfig.customApiKey,
    });
    if (!credential.apiKey) throw new Error(`No API key was found for ${apiConfig.customProviderName}.`);
    credentialSource = credential.source;
    applyCustomClaudeEnv(settings, { ...apiConfig, customApiKey: credential.apiKey });
  } else {
    clearClaudeRouteEnv(settings);
  }

  await writeVerifiedConfig({
    targetPath: settingsPath,
    contents: `${JSON.stringify(settings, null, 2)}\n`,
    verify: async () => {
      const snapshot = await loadClaudeConfigSnapshot(claudeHome);
      if (apiConfig.activeProvider !== "custom") {
        if (snapshot.route.activeProvider !== "official") throw new Error("official Claude route was not restored");
        return;
      }
      if (snapshot.route.activeProvider !== "custom") throw new Error("custom Claude route was not activated");
      if (snapshot.route.customBaseUrl !== apiConfig.customBaseUrl) throw new Error("Claude Base URL was not written");
      if (snapshot.route.customModel !== apiConfig.customModel) throw new Error("Claude model was not written");
      if (!snapshot.hasApiKey) throw new Error("Claude credential was not readable after writing");
    },
  });

  return {
    profile,
    claudeHome,
    settingsPath,
    backupPaths,
    credentialSource,
    verified: true,
  };
}

function claudeApiConfigWithPresetDefaults(config: Partial<ClaudeApiConfig>): ClaudeApiConfig {
  const normalized = normalizeClaudeApiConfig(config);
  const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === normalized.customProviderId);
  const model = config.customModel?.trim() || preset?.model || "";
  return normalizeClaudeApiConfig({
    ...normalized,
    customProviderId: normalized.customProviderId,
    customProviderName: config.customProviderName?.trim() || preset?.providerName || normalized.customProviderId,
    customBaseUrl: config.customBaseUrl?.trim() || preset?.baseUrl || "",
    customModel: model,
    customHaikuModel: config.customHaikuModel?.trim() || preset?.haikuModel || model,
    customSonnetModel: config.customSonnetModel?.trim() || preset?.sonnetModel || model,
    customOpusModel: config.customOpusModel?.trim() || preset?.opusModel || model,
    customApiFormat: config.customApiFormat ?? preset?.apiFormat ?? "anthropic",
    customApiKeyField: config.customApiKeyField ?? preset?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
  });
}

function applyCustomClaudeEnv(settings: Record<string, unknown>, apiConfig: ClaudeApiConfig): void {
  if (!apiConfig.customApiKey) throw new Error(`API key is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to apply ${apiConfig.customProviderName}.`);

  const env = ensureEnv(settings);
  clearClaudeRouteEnv(settings);
  env.ANTHROPIC_BASE_URL = apiConfig.customBaseUrl;
  env[apiConfig.customApiKeyField] = apiConfig.customApiKey;
  // An empty model means "keep whatever the config file already selects", the same thing the
  // Default entry means in every model picker. Pinning the route without pinning the model is a
  // legitimate setup, so the model variables are simply left unset rather than rejected.
  if (apiConfig.customModel) {
    env.ANTHROPIC_MODEL = apiConfig.customModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = apiConfig.customHaikuModel || apiConfig.customModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = apiConfig.customSonnetModel || apiConfig.customModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = apiConfig.customOpusModel || apiConfig.customModel;
  }

  const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === apiConfig.customProviderId);
  for (const [key, value] of Object.entries(preset?.extraEnv ?? {})) {
    env[key] = value;
  }
}

/**
 * Resolves the credential the Claude CLI would use for a config directory, following the same
 * order it does: an explicitly typed key, then `settings.json`'s `env`, then the process
 * environment. Mirrors `resolveCodexProviderCredential` so callers that must work against either
 * agent — the AI summary panel, for one — can treat the two the same way.
 */
export async function resolveClaudeProviderCredential(input: {
  claudeHome?: string;
  apiKeyField?: ClaudeApiConfig["customApiKeyField"];
  apiKey?: string;
  apiKeySource?: string;
}): Promise<{ apiKey: string; source: string | null }> {
  return resolveClaudeCredential({
    claudeHome: resolveProviderConfigDirectory(input.claudeHome, ".claude"),
    apiKeyField: input.apiKeyField,
    explicitKey: input.apiKey,
    explicitSource: input.apiKeySource,
  });
}

async function resolveClaudeCredential(options: {
  claudeHome: string;
  apiKeyField?: ClaudeApiConfig["customApiKeyField"];
  explicitKey?: string;
  explicitSource?: string;
}): Promise<{ apiKey: string; source: string | null }> {
  const explicitKey = options.explicitKey?.trim() ?? "";
  if (explicitKey) return { apiKey: explicitKey, source: options.explicitSource || "API key field" };
  const settings = parseJsonObject(await readOptionalFile(path.join(options.claudeHome, "settings.json")));
  const env = settings && isPlainObject(settings.env) ? settings.env : {};
  const keys = [...new Set([options.apiKeyField, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter(Boolean))] as string[];
  for (const key of keys) {
    const value = readString(env[key]);
    if (value) return { apiKey: value, source: `settings.json env.${key}` };
  }
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return { apiKey: value, source: `environment ${key}` };
  }
  return { apiKey: "", source: null };
}

function clearClaudeRouteEnv(settings: Record<string, unknown>): void {
  if (!isPlainObject(settings.env)) return;
  for (const key of CLAUDE_ROUTE_ENV_KEYS) {
    delete settings.env[key];
  }
}

function ensureEnv(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(settings.env)) settings.env = {};
  return settings.env as Record<string, unknown>;
}

async function loadMutableSettings(settingsPath: string): Promise<Record<string, unknown>> {
  const text = await readOptionalFile(settingsPath);
  if (!text) return {};
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`Claude settings must be a JSON object: ${settingsPath}`);
  return parsed;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath, constants.R_OK);
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function backupExistingTarget(target: string, backup: string): Promise<string[]> {
  try {
    await stat(target);
  } catch {
    return [];
  }
  await copyFile(target, backup);
  return [backup];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerNameFromBaseUrl(baseUrl: string): string {
  if (!baseUrl) return "Custom Claude";
  try {
    return new URL(baseUrl).host || "Custom Claude";
  } catch {
    return baseUrl;
  }
}

function claudeProviderId(apiConfig: ClaudeApiConfig): string {
  if (apiConfig.customProviderId !== "custom") return apiConfig.customProviderId;
  const normalized = apiConfig.customProviderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "custom";
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
