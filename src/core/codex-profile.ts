import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { API_PROVIDER_PRESETS, apiProviderPreset, normalizeApiConfig, type ApiConfig, type ApiProviderPresetId } from "./api-config";

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
}

const OFFICIAL_CODEX_PROVIDER_ID = "openai";

export function codexProfileForApiConfig(
  config: Pick<ApiConfig, "activeProvider"> & Partial<Pick<ApiConfig, "customProviderId">>,
): CodexApplyProfileName {
  if (config.activeProvider !== "custom") return "codex";
  return "generated";
}

export async function loadCodexProfileDefaults(codexHome = path.join(os.homedir(), ".codex")): Promise<Partial<ApiConfig>> {
  const activeConfigText = await readOptionalFile(path.join(codexHome, "config.toml"));
  const defaults: Partial<ApiConfig> = {};
  const activeModelProvider = readTomlString(activeConfigText, "model_provider");
  if (!activeModelProvider || activeModelProvider === OFFICIAL_CODEX_PROVIDER_ID) {
    if (activeModelProvider) defaults.activeProvider = "official";
    return defaults;
  }

  defaults.activeProvider = "custom";
  const providerSection = readTomlSection(activeConfigText, `[model_providers.${activeModelProvider}]`);
  const providerName = readTomlString(providerSection, "name");
  const baseUrl = readTomlString(providerSection, "base_url");
  const wireApi = readTomlString(providerSection, "wire_api");
  const model = readTomlString(activeConfigText, "model");

  defaults.customProviderId = inferApiProviderPresetId(activeModelProvider, baseUrl);
  defaults.customProviderName = providerName || activeModelProvider;
  if (baseUrl) defaults.customBaseUrl = baseUrl;
  if (model) defaults.customModel = model;
  if (wireApi) defaults.customApiFormat = wireApi === "responses" ? "openai_responses" : "openai_chat";
  return defaults;
}

export async function applyCodexApiConfig(options: {
  codexHome?: string;
  apiConfig: Partial<ApiConfig>;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const apiConfig = apiConfigWithPresetDefaults(options.apiConfig);
  const profile = codexProfileForApiConfig(apiConfig);
  if (profile === "codex") return applyOfficialCodexProvider(options);
  return applyGeneratedCodexProvider({
    codexHome: options.codexHome,
    apiConfig,
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
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
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
  await writeFile(configTarget, applyCodexOfficialConfigOverrides(activeConfigText), { mode: 0o600 });
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
  };
}

async function applyGeneratedCodexProvider(options: {
  codexHome?: string;
  apiConfig: ApiConfig;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const apiConfig = options.apiConfig;
  const providerId = codexProviderId(apiConfig.customProviderName);
  const authTarget = path.join(codexHome, "auth.json");
  const configTarget = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups");
  const stamp = backupStamp(options.now ?? new Date());

  if (!apiConfig.customApiKey) throw new Error(`API key is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customModel) throw new Error(`Model is required to apply ${apiConfig.customProviderName}.`);

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTargets([
    { target: authTarget, backup: path.join(backupDir, `auth.json.before-${providerId}-${stamp}`) },
    { target: configTarget, backup: path.join(backupDir, `config.toml.before-${providerId}-${stamp}`) },
  ]);

  const activeConfigText = await readOptionalFile(configTarget);
  const baseConfigText = activeConfigText.trim() ? activeConfigText : generatedCodexConfig(apiConfig, providerId);
  await writeFile(configTarget, applyCodexProviderConfig(baseConfigText, apiConfig, providerId), { mode: 0o600 });
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
  next = removeTomlKeyEverywhere(next, "experimental_bearer_token");
  return next.endsWith("\n") ? next : `${next}\n`;
}

function applyCodexProviderConfig(text: string, apiConfig: ApiConfig, providerId: string): string {
  let next = removeTopLevelTomlKey(text, "experimental_bearer_token");
  next = replaceTopLevelString(next, "model_provider", providerId);
  if (apiConfig.customModel) next = replaceTopLevelString(next, "model", apiConfig.customModel);
  next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "name", apiConfig.customProviderName);
  if (apiConfig.customBaseUrl) next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "base_url", apiConfig.customBaseUrl);
  next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "wire_api", "responses");
  next = replaceOrInsertSectionLiteral(next, `[model_providers.${providerId}]`, "requires_openai_auth", "true");
  if (apiConfig.customApiKey) {
    next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "experimental_bearer_token", apiConfig.customApiKey);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function apiConfigWithPresetDefaults(config: Partial<ApiConfig>): ApiConfig {
  const normalized = normalizeApiConfig(config);
  const preset = apiProviderPreset(normalized.customProviderId);
  return normalizeApiConfig({
    ...normalized,
    customProviderId: preset.id,
    customProviderName: config.customProviderName?.trim() || preset.providerName,
    customBaseUrl: config.customBaseUrl?.trim() || preset.baseUrl,
    customModel: config.customModel?.trim() || preset.model,
    customApiFormat: config.customApiFormat ?? preset.apiFormat,
  });
}

function inferApiProviderPresetId(providerId: string, baseUrl: string | null): ApiProviderPresetId {
  const presetById = API_PROVIDER_PRESETS.find((preset) => preset.id === providerId);
  if (presetById) return presetById.id;

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const presetByBaseUrl = API_PROVIDER_PRESETS.find((preset) => normalizeBaseUrl(preset.baseUrl) === normalizedBaseUrl);
  return presetByBaseUrl?.id ?? "codexzh";
}

function normalizeBaseUrl(baseUrl: string | null): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function generatedCodexConfig(apiConfig: ApiConfig, providerId: string): string {
  return `model_provider = ${tomlString(providerId)}
model = ${tomlString(apiConfig.customModel)}
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.${providerId}]
name = ${tomlString(apiConfig.customProviderName)}
base_url = ${tomlString(apiConfig.customBaseUrl)}
wire_api = "responses"
requires_openai_auth = true
`;
}

function codexProviderId(providerName: string): string {
  const normalized = providerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "codexzh";
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

function removeTomlKeyEverywhere(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return text
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line))
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
