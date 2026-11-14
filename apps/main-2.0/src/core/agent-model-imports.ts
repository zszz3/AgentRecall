import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { catalogProviderAt, catalogProviderOrigin, listAgentModelProviders } from "./agent-model";
import {
  AGENT_MODEL_APIS,
  AGENT_MODEL_CUSTOM_PROVIDER,
  AGENT_MODEL_IMPORT_SOURCES,
  defaultAgentModelConfig,
  sameAgentModelEndpoint,
  type AgentModelApi,
  type AgentModelConfig,
  type AgentModelImport,
  type AgentModelImportSource,
  type AgentModelImports,
} from "./agent-model-config";
import { loadClaudeApiConfigDefaults } from "./claude-profile";
import { loadCodexConfigSnapshot, resolveCodexProviderCredential } from "./codex-profile";

/**
 * Finds the model services other local agents are set up with, so one can
 * become the AgentRecall model without typing its key again. Reading never
 * writes, never runs a credential command and never decrypts a store, so
 * services that sign in, use a key command or speak another API format are
 * left out, and so are ZCode and Codex services that need request headers or
 * query parameters the AgentRecall model does not send.
 */

export interface ScannedAgentModelImport {
  service: AgentModelImport;
  apiKey: string;
}

export interface ScannedAgentModelImports {
  imports: ScannedAgentModelImport[];
  problems: AgentModelImports["problems"];
}

/** One service as one agent declares it. A listed provider without models stands for its first catalog model. */
interface DeclaredService {
  source: AgentModelImportSource;
  name: string;
  apiKey: string;
  provider: string;
  api: AgentModelApi;
  baseUrl: string;
  models: string[];
}

interface ScanContext {
  home: string;
  env: NodeJS.ProcessEnv;
  problem(message: string): void;
}

const READERS: Record<AgentModelImportSource, (context: ScanContext) => Promise<DeclaredService[]>> = {
  zcode: readZcode,
  dsh: readDeepSeekHarness,
  codex: readCodex,
  "claude-code": readClaudeCode,
};

const API_NAMES: Record<AgentModelApi, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages",
};

const ZCODE_APIS: Record<string, AgentModelApi> = {
  "anthropic-messages": "anthropic-messages",
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
};

/** Changes on every start, so an import id is never a lasting fingerprint of its key. */
const ID_SALT = randomBytes(16);

export async function scanAgentModelImports(home: string, env: NodeJS.ProcessEnv): Promise<ScannedAgentModelImports> {
  const problems: AgentModelImports["problems"] = [];
  const declared = await Promise.all(AGENT_MODEL_IMPORT_SOURCES.map(async (source) => {
    const problem = (message: string) => { problems.push({ source, message }); };
    try {
      return await READERS[source]({ home, env, problem });
    } catch (error) {
      // One agent's unreadable settings must not hide the services found in the others; the user sees the reason.
      problem(error instanceof Error ? error.message : String(error));
      return [];
    }
  }));
  problems.sort((left, right) => AGENT_MODEL_IMPORT_SOURCES.indexOf(left.source) - AGENT_MODEL_IMPORT_SOURCES.indexOf(right.source));
  return { imports: mergeServices(declared.flat()), problems };
}

async function readZcode({ home, problem }: ScanContext): Promise<DeclaredService[]> {
  const root = path.join(home, ".zcode", "v2");
  const text = await readOptionalText(path.join(root, "provider_config.json"));
  if (text === null) return [];
  const config = record(record(parse("JSON", text, "ZCode provider_config.json")).config);
  const modelRules = record(config.modelConfigRules);
  const disabledModels = new Set(
    [...list(modelRules.providerModelRules), ...list(modelRules.manualProviderModelRules)]
      .map(record)
      .filter((rule) => record(rule.config).enabled === false)
      .map((rule) => `${str(rule.providerId)}\n${str(rule.modelId)}`),
  );
  let templates: Map<string, Record<string, unknown>> | undefined;
  const services: DeclaredService[] = [];
  for (const rule of list(record(config.providerConfigRules).providerRules).map(record)) {
    const settings = record(rule.config);
    const access = record(settings.access);
    const apiKey = str(access.apiKey);
    // A Zhipu account signs in instead of keeping a key.
    if (rule.enabled === false || !apiKey || access.type === "zhipu-account") continue;
    const providerId = str(rule.providerId);
    const templateId = str(rule.templateId);
    let template: Record<string, unknown> = {};
    if (templateId) {
      templates ??= await readZcodeTemplates(root);
      template = templates.get(templateId) ?? {};
    }
    const templateNames = record(template.templateNameMap);
    const name = str(rule.providerName) || str(templateNames["en-US"]) || str(templateNames["zh-CN"]) || providerId;
    const templateSettings = record(template.config);
    if (templateId && !settings.api && !templateSettings.api) {
      problem(`The built-in settings of "${name}" were not found, so it was not imported.`);
      continue;
    }
    const endpoint = { ...record(templateSettings.api), ...record(settings.api) };
    const api = ZCODE_APIS[str(endpoint.type)];
    if (!api) continue;
    if (Object.keys(record(endpoint.headers)).length > 0) {
      problem(`"${name}" needs custom request headers, which AgentRecall does not send, so it was not imported.`);
      continue;
    }
    const ordered = list(settings.modelOrder).map(str);
    const models = (ordered.length > 0 ? ordered : [...list(settings.personalModelIds), ...list(templateSettings.builtinModelIds)].map(str))
      .filter((model) => model && !disabledModels.has(`${providerId}\n${model}`));
    const baseUrl = str(endpoint.baseUrl).replace(/\/+$/, "");
    services.push({
      source: "zcode",
      name,
      apiKey,
      provider: AGENT_MODEL_CUSTOM_PROVIDER,
      api,
      // ZCode adds a missing `/v1` before `/messages`, while pi-ai's Anthropic client always appends `/v1/messages`.
      baseUrl: api === "anthropic-messages" ? baseUrl.replace(/\/v1$/i, "") : baseUrl,
      models: unique(models),
    });
  }
  return services;
}

/** ZCode caches its built-in provider templates per app version; the newest file belongs to the running version. */
async function readZcodeTemplates(root: string): Promise<Map<string, Record<string, unknown>>> {
  const cache = path.join(root, "runtime", "provider");
  let newest: { file: string; modified: number } | null = null;
  for (const platform of await listDirectories(cache)) {
    for (const version of await listDirectories(path.join(cache, platform))) {
      for (const endpoint of await listDirectories(path.join(cache, platform, version))) {
        const file = path.join(cache, platform, version, endpoint, "zcode-builtin.json");
        const modified = await modifiedTime(file);
        if (modified !== null && (!newest || modified > newest.modified)) newest = { file, modified };
      }
    }
  }
  if (!newest) return new Map();
  const text = await readOptionalText(newest.file);
  const templates = list(record(record(record(parse("JSON", text ?? "{}", "ZCode zcode-builtin.json")).config).providerConfigRules).templateRules);
  return new Map(templates.map(record).map((template) => [str(template.templateId), template]));
}

/** Names a key reference the way DeepSeek Harness does when a provider declares none. */
function deepSeekHarnessKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

async function readDeepSeekHarness({ home, env }: ScanContext): Promise<DeclaredService[]> {
  const root = env.DSH_HOME?.trim() || path.join(home, ".dsh");
  const profiles: Record<string, unknown>[][] = [];
  for (const profile of await listDirectories(path.join(root, "profiles"))) {
    const text = await readOptionalText(path.join(root, "profiles", profile, "cordis.patch.yml"));
    if (text === null) continue;
    profiles.push(list(parse("YAML", text, `DeepSeek Harness profiles/${profile}/cordis.patch.yml`)).map(record));
  }
  if (profiles.length === 0) return [];
  const credentials = await readOptionalText(path.join(root, ".credentials.yaml"));
  const refs = record(record(credentials === null ? {} : parse("YAML", credentials, "DeepSeek Harness .credentials.yaml")).refs);
  // DeepSeek Harness reads its own credential file first, then the environment.
  const keyOf = (name: string) => str(refs[name]) || str(env[name]);
  const services: DeclaredService[] = [];

  for (const entries of profiles) {
    // Every profile includes the DeepSeek API-key plugin; a patch that does not mention it keeps its default settings.
    const deepseek = entries.filter((entry) => entry.id === "llm-deepseek");
    const deepseekSettings: Record<string, unknown>[] = deepseek.length > 0
      ? deepseek.filter((entry) => entry.disabled !== true).map((entry) => record(entry.config))
      : [{}];
    for (const settings of deepseekSettings) {
      const apiKey = keyOf(str(settings.apiKeyEnv) || "DEEPSEEK_API_KEY");
      const baseUrl = str(settings.baseURL);
      if (!apiKey) continue;
      services.push({
        source: "dsh",
        name: "DeepSeek",
        apiKey,
        provider: baseUrl ? AGENT_MODEL_CUSTOM_PROVIDER : "deepseek",
        api: "openai-completions",
        baseUrl,
        models: modelIds(settings.models),
      });
    }

    for (const entry of entries.filter((item) => item.id === "llm-pi-ai" && item.disabled !== true)) {
      for (const [id, value] of Object.entries(record(record(entry.config).providers))) {
        const provider = record(value);
        const apiKey = keyOf(str(provider.apiKeyEnv) || deepSeekHarnessKeyRef(id));
        if (!apiKey) continue;
        const name = str(provider.displayName) || id;
        const baseUrl = str(provider.baseURL);
        const api = AGENT_MODEL_APIS.find((item) => item === provider.api);
        if (!baseUrl && catalogProviderOrigin(id)) {
          services.push({ source: "dsh", name, apiKey, provider: id, api: defaultAgentModelConfig.api, baseUrl: "", models: modelIds(provider.models) });
        } else if (baseUrl && api) {
          services.push({ source: "dsh", name, apiKey, provider: AGENT_MODEL_CUSTOM_PROVIDER, api, baseUrl, models: modelIds(provider.models) });
        }
      }
    }
  }
  return services;
}

async function readCodex({ home, env, problem }: ScanContext): Promise<DeclaredService[]> {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const snapshot = await loadCodexConfigSnapshot(codexHome);
  const model = snapshot.activeModel;
  if (!model) return [];
  const provider = snapshot.activeProvider;
  if (!provider) {
    // The official route has no provider section; an API-key login keeps its key in auth.json.
    if (snapshot.activeProviderId !== "openai") return [];
    const auth = await readOptionalText(path.join(codexHome, "auth.json"));
    const apiKey = str(env.OPENAI_API_KEY) || str(record(auth === null ? {} : parse("JSON", auth, "Codex auth.json")).OPENAI_API_KEY);
    return apiKey
      ? [{ source: "codex", name: "OpenAI", apiKey, provider: "openai", api: defaultAgentModelConfig.api, baseUrl: "", models: [model] }]
      : [];
  }
  if (!provider.baseUrl) return [];
  const name = provider.name || provider.id;
  const config = record(parse("TOML", await readOptionalText(snapshot.configPath) ?? "", "Codex config.toml"));
  const settings = record(record(config.model_providers)[provider.id]);
  const headers = [...Object.keys(record(settings.http_headers)), ...Object.keys(record(settings.env_http_headers))]
    .filter((header) => header.toLowerCase() !== "authorization");
  if (headers.length > 0 || Object.keys(record(settings.query_params)).length > 0) {
    problem(`"${name}" needs custom request headers or query parameters, which AgentRecall does not send, so it was not imported.`);
    return [];
  }
  const { apiKey } = await resolveCodexProviderCredential({
    codexHome,
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    executeCredentialHelper: false,
    preferConfiguredHelper: true,
  });
  if (!apiKey) return [];
  return [{
    source: "codex",
    name,
    apiKey,
    provider: AGENT_MODEL_CUSTOM_PROVIDER,
    // Codex speaks the Responses API unless a provider asks for Chat Completions.
    api: provider.wireApi === "chat" ? "openai-completions" : "openai-responses",
    baseUrl: provider.baseUrl,
    models: [model],
  }];
}

async function readClaudeCode({ home, env }: ScanContext): Promise<DeclaredService[]> {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const route = await loadClaudeApiConfigDefaults(claudeHome, env);
  // Without a key in its settings Claude Code signs in or runs a key helper, which AgentRecall never does.
  const apiKey = route.customApiKey?.trim() ?? "";
  if (route.activeProvider !== "custom" || !apiKey) return [];
  const models = unique([route.customModel, route.customOpusModel, route.customSonnetModel, route.customHaikuModel].map(str));
  const baseUrl = route.customBaseUrl?.trim() ?? "";
  // Claude Code always speaks Anthropic Messages, whichever preset AgentRecall matched to its URL.
  return [baseUrl
    ? { source: "claude-code", name: route.customProviderName || baseUrl, apiKey, provider: AGENT_MODEL_CUSTOM_PROVIDER, api: "anthropic-messages", baseUrl, models }
    : { source: "claude-code", name: "Anthropic", apiKey, provider: "anthropic", api: defaultAgentModelConfig.api, baseUrl: "", models }];
}

/**
 * Groups declared services by host and key, because the same key on the same
 * host is one service however many agents use it. Within a service each
 * endpoint and model appears once, and a model a listed provider serves
 * replaces the same model behind a custom endpoint, since the listed one
 * knows its limits.
 */
function mergeServices(declared: DeclaredService[]): ScannedAgentModelImport[] {
  const accounts = new Map<string, { apiKey: string; host: string; name: string; sources: AgentModelImportSource[]; configs: AgentModelConfig[] }>();
  for (const service of declared) {
    const offered = configsOf(service);
    if (!offered) continue;
    const key = `${offered.origin}\n${service.apiKey}`;
    const account = accounts.get(key) ?? { apiKey: service.apiKey, host: new URL(offered.origin).host, name: service.name, sources: [], configs: [] };
    accounts.set(key, account);
    if (!account.sources.includes(service.source)) account.sources.push(service.source);
    for (const config of offered.configs) {
      if (!account.configs.some((known) => sameAgentModelEndpoint(known, config) && known.model === config.model)) account.configs.push(config);
    }
  }
  return [...accounts.entries()]
    .map(([key, account]) => {
      const listedModels = new Set(account.configs.filter((config) => config.provider !== AGENT_MODEL_CUSTOM_PROVIDER).map((config) => config.model));
      const configs = account.configs.filter((config) => config.provider !== AGENT_MODEL_CUSTOM_PROVIDER || !listedModels.has(config.model));
      return {
        apiKey: account.apiKey,
        service: {
          id: createHash("sha256").update(ID_SALT).update(key).digest("hex").slice(0, 16),
          name: account.name,
          host: account.host,
          sources: account.sources,
          choices: configs.map((config) => ({ config, label: choiceLabel(config, configs) })),
        },
      };
    })
    .sort((left, right) => left.service.name.localeCompare(right.service.name) || left.service.host.localeCompare(right.service.host));
}

/** The choices one declared service offers; a model a listed provider serves at the same endpoint moves to that provider. */
function configsOf(service: DeclaredService): { origin: string; configs: AgentModelConfig[] } | null {
  const listed = (provider: string, model: string): AgentModelConfig => ({ ...defaultAgentModelConfig, provider, model });
  if (service.provider !== AGENT_MODEL_CUSTOM_PROVIDER) {
    const origin = catalogProviderOrigin(service.provider);
    const models = service.models.length > 0
      ? service.models
      : listAgentModelProviders().find((provider) => provider.id === service.provider)?.models.slice(0, 1).map((model) => model.id) ?? [];
    return origin ? { origin, configs: models.map((model) => listed(service.provider, model)) } : null;
  }
  const baseUrl = service.baseUrl.trim().replace(/\/+$/, "");
  const origin = httpOrigin(baseUrl);
  if (!origin) return null;
  return {
    origin,
    configs: service.models.map((model) => {
      const provider = catalogProviderAt(service.api, baseUrl, model);
      return provider ? listed(provider, model) : { provider: AGENT_MODEL_CUSTOM_PROVIDER, model, baseUrl, api: service.api };
    }),
  };
}

function choiceLabel(config: AgentModelConfig, all: AgentModelConfig[]): string {
  const twins = all.filter((other) => other.model === config.model);
  if (twins.length === 1) return config.model;
  const variant = (item: AgentModelConfig) => (item.provider === AGENT_MODEL_CUSTOM_PROVIDER ? API_NAMES[item.api] : item.provider);
  const label = `${config.model} · ${variant(config)}`;
  if (twins.filter((other) => variant(other) === variant(config)).length === 1 || !config.baseUrl) return label;
  return `${label} · ${new URL(config.baseUrl).pathname}`;
}

function modelIds(value: unknown): string[] {
  return unique(list(value).map((model) => str(record(model).id)));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function httpOrigin(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const PARSERS = {
  JSON: (text: string): unknown => JSON.parse(text),
  // Profiles carry `!!js` expressions that only DeepSeek Harness evaluates; they read as strings here.
  YAML: (text: string): unknown => parseYaml(text, { logLevel: "error" }),
  TOML: (text: string): unknown => parseToml(text),
};

function parse(format: keyof typeof PARSERS, text: string, name: string): unknown {
  try {
    return PARSERS[format](text);
  } catch {
    throw new Error(`${name} is not valid ${format}.`);
  }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Null when the file does not exist: the agent is not installed or never saved this setting. */
async function readOptionalText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function modifiedTime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
