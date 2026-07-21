import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODEL_ID } from "../../shared/models";
import { runtimeDefinition } from "../../shared/runtime-catalog";
import type { AgentChannel, AgentId, AgentModelOption, CodexDefaultConfig } from "../../shared/types";
import { execCli } from "../platform/cli-launcher";
import { createDefaultChannels, loadCodexDefaultConfig } from "./model-config";

interface RuntimeLocalConfigLoaderDependencies {
  exec: typeof execCli;
  readTextFile: typeof readFile;
  homeDir: string;
  loadCodexConfig: () => Promise<CodexDefaultConfig>;
}

export interface LoadedRuntimeLocalConfig {
  channel: AgentChannel;
  source: string;
}

function modelOptions(modelId: string | undefined): AgentModelOption[] {
  const normalized = modelId?.trim();
  return normalized && normalized !== DEFAULT_MODEL_ID
    ? [{ id: DEFAULT_MODEL_ID, label: "Default" }, { id: normalized, label: normalized }]
    : [{ id: DEFAULT_MODEL_ID, label: "Default" }];
}

function defaultChannel(runtimeId: AgentId, existing: AgentChannel | undefined): AgentChannel {
  const fallback = createDefaultChannels().find((channel) => channel.agentId === runtimeId);
  if (!fallback) throw new Error(`No default channel is registered for ${runtimeDefinition(runtimeId).label}.`);
  return existing ? { ...fallback, ...existing, agentId: runtimeId } : fallback;
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${source} did not return a JSON object.`);
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} returned an invalid configuration object.`);
  }
  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function yamlScalar(raw: string, section: string, key: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^[^\s#][^:]*:\s*/.test(line)) {
      inSection = line.startsWith(`${section}:`);
      continue;
    }
    if (!inSection) continue;
    const match = line.match(new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*$`));
    if (!match?.[1]) continue;
    const value = match[1].replace(/^['"]|['"]$/g, "").trim();
    return value || undefined;
  }
  return undefined;
}

function applyCodexConfig(channel: AgentChannel, config: CodexDefaultConfig): AgentChannel {
  const next: AgentChannel = {
    ...channel,
    presetId: "codex-default",
    models: modelOptions(config.modelId ?? undefined),
  };
  if (config.modelProvider) next.modelProvider = config.modelProvider;
  else delete next.modelProvider;
  if (config.providerName) next.providerName = config.providerName;
  else delete next.providerName;
  if (config.baseUrl) next.baseUrl = config.baseUrl;
  else delete next.baseUrl;
  if (config.wireApi) next.wireApi = config.wireApi;
  else delete next.wireApi;
  if (config.modelCatalogJson) next.modelCatalogJson = config.modelCatalogJson;
  else delete next.modelCatalogJson;
  if (config.modelReasoningEffort) next.modelReasoningEffort = config.modelReasoningEffort;
  else delete next.modelReasoningEffort;
  const headers = config.httpHeaders ? { ...config.httpHeaders } : {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (Object.keys(headers).length > 0) next.httpHeaders = headers;
  else delete next.httpHeaders;
  if (config.plugins) next.plugins = config.plugins.map((plugin) => ({ ...plugin }));
  else delete next.plugins;
  return next;
}

async function loadClaudeConfig(
  channel: AgentChannel,
  dependencies: RuntimeLocalConfigLoaderDependencies,
): Promise<LoadedRuntimeLocalConfig> {
  const sourcePath = path.join(dependencies.homeDir, ".claude", "settings.json");
  let record: Record<string, unknown> = {};
  try {
    record = parseJsonObject(await dependencies.readTextFile(sourcePath, "utf8"), "Claude settings");
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
  const environment = record.env && typeof record.env === "object" && !Array.isArray(record.env)
    ? record.env as Record<string, unknown>
    : {};
  const modelId = optionalString(record.model) ?? optionalString(environment.ANTHROPIC_MODEL);
  const baseUrl = optionalString(environment.ANTHROPIC_BASE_URL);
  const importedEnvironment = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    source: sourcePath,
    channel: {
      ...channel,
      models: modelOptions(modelId),
      ...(baseUrl ? { baseUrl } : {}),
      ...(Object.keys(importedEnvironment).length > 0 ? { environment: importedEnvironment } : {}),
    },
  };
}

async function loadHermesConfig(
  executable: string,
  channel: AgentChannel,
  dependencies: RuntimeLocalConfigLoaderDependencies,
): Promise<LoadedRuntimeLocalConfig> {
  const { stdout } = await dependencies.exec({ executable, args: ["config", "path"], timeout: 5_000, windowsHide: true });
  const sourcePath = stdout.trim();
  if (!sourcePath) throw new Error("Hermes did not report a local config path.");
  const raw = await dependencies.readTextFile(sourcePath, "utf8");
  const modelId = yamlScalar(raw, "model", "default");
  const provider = yamlScalar(raw, "model", "provider");
  const baseUrl = yamlScalar(raw, "model", "base_url");
  const apiKey = yamlScalar(raw, "model", "api_key");
  return {
    source: sourcePath,
    channel: {
      ...channel,
      presetId: "hermes-default",
      models: modelOptions(modelId),
      ...(provider ? { modelProvider: provider, providerName: provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { httpHeaders: { Authorization: `Bearer ${apiKey}` } } : {}),
    },
  };
}

async function loadOpenCodeConfig(
  executable: string,
  channel: AgentChannel,
  dependencies: RuntimeLocalConfigLoaderDependencies,
): Promise<LoadedRuntimeLocalConfig> {
  const { stdout } = await dependencies.exec({ executable, args: ["debug", "config"], timeout: 10_000, windowsHide: true });
  const record = parseJsonObject(stdout, "OpenCode");
  const modelId = optionalString(record.model);
  const providerId = modelId?.split("/")[0];
  const providers = record.provider && typeof record.provider === "object" && !Array.isArray(record.provider)
    ? record.provider as Record<string, unknown>
    : {};
  const provider = providerId && providers[providerId] && typeof providers[providerId] === "object" && !Array.isArray(providers[providerId])
    ? providers[providerId] as Record<string, unknown>
    : {};
  const options = provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)
    ? provider.options as Record<string, unknown>
    : provider;
  const baseUrl = optionalString(options.baseURL) ?? optionalString(options.baseUrl);
  const apiKey = optionalString(options.apiKey) ?? optionalString(options.token);
  return {
    source: "opencode debug config",
    channel: {
      ...channel,
      presetId: "opencode-default",
      models: modelOptions(modelId),
      ...(providerId ? { modelProvider: providerId, providerName: providerId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { httpHeaders: { Authorization: `Bearer ${apiKey}` } } : {}),
    },
  };
}

async function loadOpenClawConfig(
  executable: string,
  channel: AgentChannel,
  dependencies: RuntimeLocalConfigLoaderDependencies,
): Promise<LoadedRuntimeLocalConfig> {
  const [modelResult, tokenResult] = await Promise.all([
    dependencies.exec({
      executable,
      args: ["config", "get", "agents.defaults.model.primary"],
      timeout: 10_000,
      windowsHide: true,
    }),
    dependencies.exec({
      executable,
      args: ["config", "get", "gateway.auth.token"],
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => undefined),
  ]);
  const modelId = modelResult.stdout.trim();
  const token = tokenResult?.stdout.trim();
  return {
    source: "openclaw config get agents.defaults.model.primary",
    channel: {
      ...channel,
      presetId: "openclaw-default",
      models: modelOptions(modelId),
      ...(token ? { environment: { ...(channel.environment ?? {}), OPENCLAW_GATEWAY_TOKEN: token } } : {}),
    },
  };
}

export async function loadRuntimeLocalConfig(input: {
  runtimeId: AgentId;
  executable: string;
  existingChannel?: AgentChannel;
  dependencies?: Partial<RuntimeLocalConfigLoaderDependencies>;
}): Promise<LoadedRuntimeLocalConfig> {
  if (!runtimeDefinition(input.runtimeId).localConfigImport) {
    throw new Error(`${runtimeDefinition(input.runtimeId).label} does not have a local CLI config to import.`);
  }
  const dependencies: RuntimeLocalConfigLoaderDependencies = {
    exec: input.dependencies?.exec ?? execCli,
    readTextFile: input.dependencies?.readTextFile ?? readFile,
    homeDir: input.dependencies?.homeDir ?? os.homedir(),
    loadCodexConfig: input.dependencies?.loadCodexConfig ?? loadCodexDefaultConfig,
  };
  const channel = defaultChannel(input.runtimeId, input.existingChannel);
  switch (input.runtimeId) {
    case "codex": {
      const config = await dependencies.loadCodexConfig();
      return { channel: applyCodexConfig(channel, config), source: path.join(dependencies.homeDir, ".codex", "config.toml") };
    }
    case "claude":
      return loadClaudeConfig(channel, dependencies);
    case "hermes":
      return loadHermesConfig(input.executable, channel, dependencies);
    case "opencode":
      return loadOpenCodeConfig(input.executable, channel, dependencies);
    case "openclaw":
      return loadOpenClawConfig(input.executable, channel, dependencies);
    case "api":
      throw new Error("API does not have a local CLI config to import.");
  }
}
