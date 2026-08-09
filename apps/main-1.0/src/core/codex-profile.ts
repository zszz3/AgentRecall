import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_PROVIDER_PRESETS, normalizeApiConfig, type ApiConfig, type ApiProviderPresetId } from "./api-config";
import { writeVerifiedConfig } from "./atomic-config-write";
import { probeProviderModels, type ProviderModelsFetch } from "./provider-models";
import { prepareProviderConfigDirectory, resolveProviderConfigDirectory } from "./provider-config-path";

export type CodexProfileName = "codex" | "codexzh";
export type CodexApplyProfileName = CodexProfileName | "generated";

export interface ApplyCodexProfileOptions {
  codexHome?: string;
  profile: CodexProfileName;
  apiConfig?: Partial<ApiConfig> | null;
  now?: Date;
}

export interface ApplyCodexProfileResult {
  profile: string;
  codexHome: string;
  authSource: string | null;
  configSource: string | null;
  authTarget: string;
  configTarget: string;
  backupPaths: string[];
  credentialSource: string | null;
  verified: true;
}

export interface CodexConfigProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  wireApi: string;
  envKey: string;
  requiresOpenaiAuth: boolean;
  hasApiKey: boolean;
  credentialSource: string | null;
}

export interface CodexConfigSnapshot {
  codexHome: string;
  configPath: string;
  exists: boolean;
  activeProviderId: string;
  activeModel: string;
  availableModels?: string[];
  activeProvider: CodexConfigProviderEntry | null;
  providers: CodexConfigProviderEntry[];
  /**
   * Credential the active route would actually use, resolved the same way `codex` resolves it:
   * inline in `config.toml`, then `auth.json`, `.env`, and the environment. The per-provider
   * entries deliberately refuse to borrow a sibling's key, so an official route — which has no
   * `[model_providers.*]` section at all — has no other way to report that a key exists.
   */
  credentialSource: string | null;
  hasApiKey: boolean;
}

export interface CodexModelProbeInput {
  baseUrl: string;
  apiKey: string;
  providerId?: string;
  codexHome?: string;
  apiKeySource?: string;
}

export interface CodexModelProbeResult {
  models: string[];
  endpoint: string;
  credentialSource: string;
}

export interface CodexSummaryEndpointDefaults {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiFormat: ApiConfig["customApiFormat"];
}

export interface CodexCredentialResolution {
  apiKey: string;
  source: string | null;
}

const OFFICIAL_CODEX_PROVIDER_ID = "openai";
const OFFICIAL_CODEX_AUTH_ENV_KEY = "OPENAI_API_KEY";
/** Extra environment names Codex-compatible setups commonly use for the bearer token. */
const CODEX_FALLBACK_ENV_KEYS = ["CODEX_API_KEY"];

export const DEFAULT_CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function codexProfileForApiConfig(
  config: Pick<ApiConfig, "activeProvider"> & Partial<Pick<ApiConfig, "customProviderId">>,
): CodexApplyProfileName {
  if (config.activeProvider !== "custom") return "codex";
  return "generated";
}

export async function loadCodexProfileDefaults(configuredHome?: string): Promise<Partial<ApiConfig>> {
  const codexHome = resolveProviderConfigDirectory(configuredHome, ".codex");
  const activeConfigText = await readOptionalFile(path.join(codexHome, "config.toml"));
  const defaults: Partial<ApiConfig> = {};
  const activeModelProvider = readTopLevelTomlString(activeConfigText, "model_provider");
  if (!activeModelProvider || activeModelProvider === OFFICIAL_CODEX_PROVIDER_ID) {
    if (activeModelProvider) defaults.activeProvider = "official";
    return defaults;
  }

  defaults.activeProvider = "custom";
  const providerSection = readTomlSection(activeConfigText, modelProviderSection(activeModelProvider));
  const providerName = readTomlString(providerSection, "name");
  const baseUrl = readTomlString(providerSection, "base_url");
  const wireApi = readTomlString(providerSection, "wire_api");
  const model = readTopLevelTomlString(activeConfigText, "model");

  defaults.customProviderId = inferApiProviderPresetId(activeModelProvider, baseUrl);
  defaults.customProviderName = providerName || activeModelProvider;
  if (baseUrl) defaults.customBaseUrl = baseUrl;
  if (model) defaults.customModel = model;
  if (wireApi) defaults.customApiFormat = wireApi === "responses" ? "openai_responses" : "openai_chat";
  return defaults;
}

export async function loadCodexConfigSnapshot(configuredHome?: string): Promise<CodexConfigSnapshot> {
  const codexHome = resolveProviderConfigDirectory(configuredHome, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const [text, modelCacheText] = await Promise.all([
    readOptionalFile(configPath),
    readOptionalFile(path.join(codexHome, "models_cache.json")),
  ]);
  const activeProviderId = readTopLevelTomlString(text, "model_provider") || OFFICIAL_CODEX_PROVIDER_ID;
  const activeModel = readTopLevelTomlString(text, "model") || "";
  const providers = await Promise.all(readCodexModelProviders(text).map(async (provider) => {
    // Per-provider display must not borrow a sibling provider's key.
    const credential = await resolveCodexCredential({ codexHome, configText: text, providerId: provider.id, allowOtherProviders: false });
    return {
      ...provider,
      hasApiKey: Boolean(credential.apiKey),
      credentialSource: credential.source,
    };
  }));
  let cachedModels: string[] = [];
  try {
    const parsed = JSON.parse(modelCacheText) as { models?: Array<{ slug?: unknown }> };
    cachedModels = (parsed.models ?? [])
      .map((model) => model.slug)
      .filter((model): model is string => typeof model === "string" && model.trim().length > 0);
  } catch {
    cachedModels = [];
  }
  const activeCredential = await resolveCodexCredential({ codexHome, configText: text, providerId: activeProviderId });
  return {
    codexHome,
    configPath,
    exists: text.trim().length > 0,
    activeProviderId,
    activeModel,
    availableModels: [...new Set([activeModel, ...cachedModels].filter(Boolean))],
    activeProvider: providers.find((provider) => provider.id === activeProviderId) ?? null,
    providers,
    credentialSource: activeCredential.source,
    hasApiKey: Boolean(activeCredential.apiKey),
  };
}

export async function probeCodexModels(input: CodexModelProbeInput, fetchImpl: ProviderModelsFetch = fetch): Promise<CodexModelProbeResult> {
  const providerId = input.providerId || await readActiveCodexProviderId(input.codexHome);
  // Always consult the Codex config: a manually typed Custom route has no section of
  // its own, and the summary route falls back to whatever Codex is already using.
  const configProvider = await readCodexConfigProviderSecret(providerId, input.codexHome);
  const baseUrl = normalizeBaseUrl(input.baseUrl || configProvider?.baseUrl || "");
  const explicitKey = input.apiKey.trim();
  const apiKey = explicitKey || configProvider?.apiKey || "";
  const result = await probeProviderModels({ baseUrl, apiKey }, fetchImpl);
  return {
    ...result,
    credentialSource: explicitKey ? input.apiKeySource || "API key field" : configProvider?.credentialSource || "resolved credential",
  };
}

export async function resolveCodexProviderCredential(input: {
  codexHome?: string;
  providerId?: string;
  apiKey?: string;
  apiKeySource?: string;
}): Promise<CodexCredentialResolution> {
  const codexHome = resolveProviderConfigDirectory(input.codexHome, ".codex");
  const configText = await readOptionalFile(path.join(codexHome, "config.toml"));
  const providerId = input.providerId || readTopLevelTomlString(configText, "model_provider") || "";
  return resolveCodexCredential({
    codexHome,
    configText,
    providerId,
    explicitKey: input.apiKey,
    explicitSource: input.apiKeySource,
  });
}

export async function loadActiveCodexSummaryEndpointDefaults(codexHome?: string): Promise<CodexSummaryEndpointDefaults | null> {
  const home = resolveProviderConfigDirectory(codexHome, ".codex");
  const text = await readOptionalFile(path.join(home, "config.toml"));
  const providerId = readTopLevelTomlString(text, "model_provider");
  const model = readTopLevelTomlString(text, "model") || "";
  if (!providerId || providerId === OFFICIAL_CODEX_PROVIDER_ID) {
    const credential = await resolveCodexCredential({ codexHome: home, configText: text });
    return credential.apiKey
      ? { baseUrl: "", model, apiKey: credential.apiKey, apiFormat: "openai_responses" }
      : null;
  }
  const section = readTomlSection(text, modelProviderSection(providerId));
  if (!section) return null;
  const baseUrl = readTomlString(section, "base_url") || "";
  const wireApi = readTomlString(section, "wire_api") || "";
  const envKey = readTomlString(section, "env_key") || "";
  const credential = await resolveCodexCredential({ codexHome: home, configText: text, providerId, envKey });
  const apiKey = credential.apiKey;
  if (!baseUrl || !model || !apiKey) return null;
  return {
    baseUrl,
    model,
    apiKey,
    apiFormat: wireApi === "chat" ? "openai_chat" : "openai_responses",
  };
}

async function readActiveCodexProviderId(codexHome?: string): Promise<string> {
  const text = await readOptionalFile(path.join(resolveProviderConfigDirectory(codexHome, ".codex"), "config.toml"));
  return readTopLevelTomlString(text, "model_provider") || "";
}

async function readCodexConfigProviderSecret(providerId: string, codexHome?: string): Promise<{ baseUrl: string; apiKey: string; credentialSource: string | null } | null> {
  const home = resolveProviderConfigDirectory(codexHome, ".codex");
  const text = await readOptionalFile(path.join(home, "config.toml"));
  const section = readTomlSection(text, modelProviderSection(providerId));
  const baseUrl = readTomlString(section, "base_url") || "";
  const envKey = readTomlString(section, "env_key") || "";
  const credential = await resolveCodexCredential({ codexHome: home, configText: text, providerId, envKey });
  return baseUrl || credential.apiKey ? { baseUrl, apiKey: credential.apiKey, credentialSource: credential.source } : null;
}

/** Keys a Codex-compatible config may use to inline a bearer token in a provider section. */
const CODEX_INLINE_KEY_FIELDS = ["experimental_bearer_token", "api_key", "apiKey", "bearer_token"] as const;

async function resolveCodexCredential(options: {
  codexHome: string;
  configText: string;
  providerId?: string;
  envKey?: string;
  explicitKey?: string;
  explicitSource?: string;
  /** Set to false when a caller must not borrow another provider's credential. */
  allowOtherProviders?: boolean;
}): Promise<{ apiKey: string; source: string | null }> {
  const explicitKey = options.explicitKey?.trim() ?? "";
  if (explicitKey) return { apiKey: explicitKey, source: options.explicitSource || "API key field" };

  const section = options.providerId ? readTomlSection(options.configText, modelProviderSection(options.providerId)) : "";
  const inline = readInlineCodexKey(section);
  if (inline) return { apiKey: inline.apiKey, source: `config.toml ${options.providerId}.${inline.field}` };

  const topLevelInline = readInlineCodexKey(topLevelTomlRegion(options.configText));
  if (topLevelInline) return { apiKey: topLevelInline.apiKey, source: `config.toml ${topLevelInline.field}` };

  const configuredEnvKey = options.envKey || readTomlString(section, "env_key") || "";
  const envKeys = [...new Set([configuredEnvKey, OFFICIAL_CODEX_AUTH_ENV_KEY, ...CODEX_FALLBACK_ENV_KEYS].filter(Boolean))];
  const policy = readTomlSection(options.configText, "[shell_environment_policy.set]");
  for (const key of envKeys) {
    const value = readTomlString(policy, key);
    if (value) return { apiKey: value, source: `config.toml shell_environment_policy.set.${key}` };
  }

  const authFile = readCodexAuthKeys(await readOptionalFile(path.join(options.codexHome, "auth.json")));
  for (const key of envKeys) {
    if (authFile[key]) return { apiKey: authFile[key], source: `auth.json ${key}` };
  }

  const dotEnv = parseDotEnv(await readOptionalFile(path.join(options.codexHome, ".env")));
  for (const key of envKeys) {
    if (dotEnv[key]) return { apiKey: dotEnv[key], source: `.env ${key}` };
  }

  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (value) return { apiKey: value, source: `environment ${key}` };
  }

  if (options.allowOtherProviders === false) return { apiKey: "", source: null };
  return borrowCodexCredentialFromOtherProviders(options);
}

/**
 * A manually entered Custom route usually has no `[model_providers.<id>]` section of its
 * own, so fall back to the provider Codex is actually configured with before reporting
 * that no key exists anywhere.
 */
async function borrowCodexCredentialFromOtherProviders(options: {
  codexHome: string;
  configText: string;
  providerId?: string;
}): Promise<{ apiKey: string; source: string | null }> {
  const activeProviderId = readTopLevelTomlString(options.configText, "model_provider") || "";
  const candidates = [
    ...(activeProviderId && activeProviderId !== options.providerId ? [activeProviderId] : []),
    ...readCodexModelProviders(options.configText)
      .map((provider) => provider.id)
      .filter((id) => id !== options.providerId && id !== activeProviderId),
  ];
  for (const candidate of candidates) {
    const credential = await resolveCodexCredential({
      codexHome: options.codexHome,
      configText: options.configText,
      providerId: candidate,
      allowOtherProviders: false,
    });
    if (credential.apiKey) return { apiKey: credential.apiKey, source: `${credential.source} (provider ${candidate})` };
  }
  return { apiKey: "", source: null };
}

function readInlineCodexKey(section: string): { apiKey: string; field: string } | null {
  for (const field of CODEX_INLINE_KEY_FIELDS) {
    const value = readTomlString(section, field);
    if (value) return { apiKey: value, field };
  }
  return null;
}

function readCodexAuthKeys(authText: string): Record<string, string> {
  const keys: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(authText);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keys;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) keys[key] = value.trim();
  }
  return keys;
}

function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).replace(/^export\s+/, "").trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    if (key && value) values[key] = value;
  }
  return values;
}

/**
 * Rewrites auth.json with the resolved bearer token while preserving every other
 * field Codex keeps there (`tokens`, `last_refresh`, …).
 */
function codexAuthJson(previousAuthText: string, apiKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(previousAuthText);
  } catch {
    parsed = null;
  }
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return `${JSON.stringify({ ...base, [OFFICIAL_CODEX_AUTH_ENV_KEY]: apiKey }, null, 2)}\n`;
}

export async function applyCodexApiConfig(options: {
  codexHome?: string;
  apiConfig: Partial<ApiConfig>;
  chatProxyBaseUrl?: string;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const apiConfig = apiConfigWithPresetDefaults(options.apiConfig);
  const codexHome = await prepareProviderConfigDirectory(options.codexHome ?? apiConfig.customConfigDir, ".codex");
  const profile = codexProfileForApiConfig(apiConfig);
  if (profile === "codex") return applyOfficialCodexProvider({ ...options, codexHome });
  return applyGeneratedCodexProvider({
    codexHome,
    apiConfig,
    chatProxyBaseUrl: options.chatProxyBaseUrl,
    now: options.now,
  });
}

export async function applyCodexProfile(options: ApplyCodexProfileOptions): Promise<ApplyCodexProfileResult> {
  if (options.profile === "codex") {
    return applyOfficialCodexProvider({
      codexHome: options.codexHome,
      now: options.now,
    });
  }
  if (!options.apiConfig) throw new Error("API config is required to apply Codex custom providers.");
  return applyGeneratedCodexProvider({
    codexHome: options.codexHome,
    apiConfig: apiConfigWithPresetDefaults({ ...options.apiConfig, activeProvider: "custom", customProviderId: "codexzh" }),
    now: options.now,
  });
}

async function applyOfficialCodexProvider(options: {
  codexHome?: string;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const codexHome = await prepareProviderConfigDirectory(options.codexHome, ".codex");
  const authTarget = path.join(codexHome, "auth.json");
  const configTarget = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups");
  const stamp = backupStamp(options.now ?? new Date());

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTargets([
    { target: authTarget, backup: path.join(backupDir, `auth.json.before-codex-${stamp}`) },
    { target: configTarget, backup: path.join(backupDir, `config.toml.before-codex-${stamp}`) },
  ]);

  const activeConfigText = await readOptionalFile(configTarget);
  await writeVerifiedConfig({
    targetPath: configTarget,
    contents: applyCodexOfficialConfigOverrides(activeConfigText),
    verify: async () => {
      const snapshot = await loadCodexConfigSnapshot(codexHome);
      if (snapshot.activeProviderId !== OFFICIAL_CODEX_PROVIDER_ID) throw new Error("official provider was not activated");
    },
  });
  await chmodIfExists(authTarget, 0o600);
  await chmod(configTarget, 0o600);

  return {
    profile: "codex",
    codexHome,
    authSource: null,
    configSource: null,
    authTarget,
    configTarget,
    backupPaths,
    credentialSource: null,
    verified: true,
  };
}

async function applyGeneratedCodexProvider(options: {
  codexHome?: string;
  apiConfig: ApiConfig;
  chatProxyBaseUrl?: string;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const codexHome = await prepareProviderConfigDirectory(options.codexHome ?? options.apiConfig.customConfigDir, ".codex");
  const apiConfig = options.apiConfig;
  const providerId = codexProviderId(apiConfig);
  const authTarget = path.join(codexHome, "auth.json");
  const configTarget = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups");
  const stamp = backupStamp(options.now ?? new Date());

  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to apply ${apiConfig.customProviderName}.`);

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTargets([
    { target: authTarget, backup: path.join(backupDir, `auth.json.before-${providerId}-${stamp}`) },
    { target: configTarget, backup: path.join(backupDir, `config.toml.before-${providerId}-${stamp}`) },
  ]);

  const activeConfigText = await readOptionalFile(configTarget);
  const credential = await resolveCodexCredential({
    codexHome,
    configText: activeConfigText,
    providerId,
    explicitKey: apiConfig.customApiKey,
  });
  if (!credential.apiKey) throw new Error(`No API key was found for ${apiConfig.customProviderName}.`);
  const effectiveConfig = { ...apiConfig, customApiKey: credential.apiKey };
  const baseConfigText = activeConfigText.trim() ? activeConfigText : generatedCodexConfig(effectiveConfig, providerId);
  const expectedBaseUrl = apiConfig.customApiFormat === "openai_chat" && options.chatProxyBaseUrl
    ? options.chatProxyBaseUrl
    : apiConfig.customBaseUrl;

  // A `requires_openai_auth` provider reads its bearer token from auth.json, so writing
  // config.toml alone leaves Codex itself without a usable credential.
  const previousAuthText = await readOptionalFile(authTarget);
  await writeVerifiedConfig({
    targetPath: authTarget,
    contents: codexAuthJson(previousAuthText, credential.apiKey),
    verify: async () => {
      const written = readCodexAuthKeys(await readOptionalFile(authTarget));
      if (written[OFFICIAL_CODEX_AUTH_ENV_KEY] !== credential.apiKey) throw new Error("auth.json credential was not written");
    },
  });

  try {
    await writeVerifiedConfig({
      targetPath: configTarget,
      contents: applyCodexProviderConfig(baseConfigText, effectiveConfig, providerId, options.chatProxyBaseUrl),
      verify: async () => {
        const snapshot = await loadCodexConfigSnapshot(codexHome);
        const provider = snapshot.providers.find((item) => item.id === providerId);
        if (snapshot.activeProviderId !== providerId) throw new Error(`provider ${providerId} was not activated`);
        // Only a model the user actually chose is verified: an empty one means "keep the config
        // file's own model", so there is nothing to write and nothing to check.
        if (apiConfig.customModel && snapshot.activeModel !== apiConfig.customModel) {
          throw new Error(`model ${apiConfig.customModel} was not written`);
        }
        if (!provider || normalizeBaseUrl(provider.baseUrl) !== normalizeBaseUrl(expectedBaseUrl)) throw new Error("provider Base URL was not written");
        if (!provider.hasApiKey) throw new Error("provider credential was not readable after writing");
      },
    });
  } catch (error) {
    if (previousAuthText) await writeFile(authTarget, previousAuthText, { mode: 0o600 });
    else await rm(authTarget, { force: true });
    throw error;
  }
  await chmodIfExists(authTarget, 0o600);
  await chmod(configTarget, 0o600);

  return {
    profile: providerId,
    codexHome,
    authSource: null,
    configSource: null,
    authTarget,
    configTarget,
    backupPaths,
    credentialSource: credential.source,
    verified: true,
  };
}

async function backupExistingTargets(targets: Array<{ target: string; backup: string }>): Promise<string[]> {
  const backupPaths: string[] = [];
  for (const item of targets) {
    try {
      await stat(item.target);
    } catch {
      continue;
    }
    await copyFile(item.target, item.backup);
    backupPaths.push(item.backup);
  }
  return backupPaths;
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    // A custom Codex route can use config.toml bearer tokens without owning auth.json.
    return;
  }
  await chmod(filePath, mode);
}

function applyCodexOfficialConfigOverrides(text: string): string {
  let next = text;
  for (const key of ["model_provider", "model", "model_reasoning_effort", "base_url", "wire_api", "disable_response_storage", "experimental_bearer_token"]) {
    next = removeTopLevelTomlKey(next, key);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function applyCodexProviderConfig(text: string, apiConfig: ApiConfig, providerId: string, chatProxyBaseUrl?: string): string {
  const baseUrl = apiConfig.customApiFormat === "openai_chat" && chatProxyBaseUrl ? chatProxyBaseUrl : apiConfig.customBaseUrl;
  let next = removeTopLevelTomlKey(text, "experimental_bearer_token");
  next = replaceTopLevelString(next, "model_provider", providerId);
  if (apiConfig.customModel) next = replaceTopLevelString(next, "model", apiConfig.customModel);
  const sectionHeader = modelProviderSection(providerId);
  next = replaceOrInsertSectionString(next, sectionHeader, "name", apiConfig.customProviderName);
  if (baseUrl) next = replaceOrInsertSectionString(next, sectionHeader, "base_url", baseUrl);
  next = replaceOrInsertSectionString(next, sectionHeader, "wire_api", "responses");
  next = replaceOrInsertSectionLiteral(next, sectionHeader, "requires_openai_auth", "true");
  if (apiConfig.customApiKey) {
    next = replaceOrInsertSectionString(next, sectionHeader, "experimental_bearer_token", apiConfig.customApiKey);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function apiConfigWithPresetDefaults(config: Partial<ApiConfig>): ApiConfig {
  const normalized = normalizeApiConfig(config);
  const preset = API_PROVIDER_PRESETS.find((item) => item.id === normalized.customProviderId);
  return normalizeApiConfig({
    ...normalized,
    customProviderId: normalized.customProviderId,
    customProviderName: config.customProviderName?.trim() || preset?.providerName || normalized.customProviderId,
    customBaseUrl: config.customBaseUrl?.trim() || preset?.baseUrl || "",
    customModel: config.customModel?.trim() || preset?.model || "",
    customApiFormat: config.customApiFormat ?? preset?.apiFormat ?? "openai_responses",
  });
}

function inferApiProviderPresetId(providerId: string, baseUrl: string | null): ApiProviderPresetId {
  return providerId || API_PROVIDER_PRESETS.find((preset) => normalizeBaseUrl(preset.baseUrl) === normalizeBaseUrl(baseUrl))?.id || "custom";
}

function normalizeBaseUrl(baseUrl: string | null): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function readCodexModelProviders(text: string): CodexConfigProviderEntry[] {
  const providers: CodexConfigProviderEntry[] = [];
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+|"(?:\\.|[^"\\])+")\]\s*$/;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(sectionPattern);
    if (!match) continue;
    const rawId = match[1];
    const id = rawId.startsWith('"') ? parseTomlString(rawId) || rawId.slice(1, -1) : rawId;
    const sectionLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*\[/.test(lines[cursor])) break;
      sectionLines.push(lines[cursor]);
    }
    const section = sectionLines.join("\n");
    providers.push({
      id,
      name: readTomlString(section, "name") || id,
      baseUrl: readTomlString(section, "base_url") || "",
      wireApi: readTomlString(section, "wire_api") || "",
      envKey: readTomlString(section, "env_key") || "",
      requiresOpenaiAuth: readTomlBoolean(section, "requires_openai_auth"),
      hasApiKey: Boolean(readTomlString(section, "experimental_bearer_token") || readTomlString(section, "env_key")),
      credentialSource: null,
    });
  }
  return providers;
}

function readTomlBoolean(text: string, key: string): boolean {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$`, "m");
  return text.match(pattern)?.[1] === "true";
}

function generatedCodexConfig(apiConfig: ApiConfig, providerId: string): string {
  const modelLine = apiConfig.customModel ? `model = ${tomlString(apiConfig.customModel)}\n` : "";
  return `model_provider = ${tomlString(providerId)}
${modelLine}model_reasoning_effort = "high"
disable_response_storage = true

${modelProviderSection(providerId)}
name = ${tomlString(apiConfig.customProviderName)}
base_url = ${tomlString(apiConfig.customBaseUrl)}
wire_api = "responses"
requires_openai_auth = true
`;
}

function codexProviderId(apiConfig: ApiConfig): string {
  if (apiConfig.customProviderId && apiConfig.customProviderId !== "custom") return apiConfig.customProviderId;
  const normalized = apiConfig.customProviderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "codexzh";
}

function modelProviderSection(providerId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(providerId)
    ? `[model_providers.${providerId}]`
    : `[model_providers.${tomlString(providerId)}]`;
}

function replaceTopLevelString(text: string, key: string, value: string): string {
  const line = `${key} = ${tomlString(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${line}\n${text}`;
}

function removeTopLevelTomlKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let inTopLevel = true;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*\[/.test(line)) inTopLevel = false;
      return !(inTopLevel && pattern.test(line));
    })
    .join("\n");
}

function replaceOrInsertSectionString(text: string, sectionHeader: string, key: string, value: string): string {
  return replaceOrInsertSectionLiteral(text, sectionHeader, key, tomlString(value));
}

function replaceOrInsertSectionLiteral(text: string, sectionHeader: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart < 0) {
    lines.push("", sectionHeader);
    sectionStart = lines.length - 1;
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const line = `${key} = ${value}`;
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.splice(sectionStart + 1, 0, line);
  return lines.join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function readTomlSection(text: string, sectionHeader: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === sectionHeader);
  if (start < 0) return "";
  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join("\n");
}

function readTomlString(text: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, "m");
  const rawValue = text.match(pattern)?.[1];
  if (!rawValue) return null;
  return parseTomlString(rawValue);
}

/** Everything before the first `[section]` header, i.e. the config's top-level table. */
function topLevelTomlRegion(text: string): string {
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  return (firstSection < 0 ? lines : lines.slice(0, firstSection)).join("\n");
}

/** Reads a top-level key without matching a same-named key inside a later section. */
function readTopLevelTomlString(text: string, key: string): string | null {
  return readTomlString(topLevelTomlRegion(text), key);
}

function parseTomlString(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const withoutComment = trimmed.startsWith('"') ? trimmed : trimmed.split("#")[0]?.trim() ?? "";
  if (!withoutComment.startsWith('"')) return withoutComment || null;
  try {
    const parsed = JSON.parse(withoutComment);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return withoutComment.slice(1, withoutComment.lastIndexOf('"'));
  }
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
