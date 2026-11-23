import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
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

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

/**
 * Finds the model services other local agents are set up with, so one can
 * become the AgentRecall model without typing its key again. Reading never
 * writes, never runs a credential command and never decrypts a store, so
 * services that sign in, use a key command or speak another API format are
 * left out, and so are services that need request headers or query
 * parameters the AgentRecall model does not send.
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
  "cc-switch": readCcSwitch,
  pi: (context) => readPiFormat(context, "pi", context.env.PI_CODING_AGENT_DIR?.trim() || path.join(context.home, ".pi", "agent"), "Pi"),
  stepcode: (context) => readPiFormat(context, "stepcode", path.join(context.home, ".stepcode"), "StepCode"),
  opencode: readOpenCode,
};

/**
 * OpenCode's provider ids (models.dev's) whose address is the listed
 * provider's. OpenCode keeps only a key per id, so an id whose listed
 * namesake serves another region or plan would send the key elsewhere.
 */
const OPENCODE_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  deepseek: "deepseek",
  "fireworks-ai": "fireworks",
  google: "google",
  groq: "groq",
  mistral: "mistral",
  moonshotai: "moonshotai",
  "moonshotai-cn": "moonshotai-cn",
  nvidia: "nvidia",
  openai: "openai",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  openrouter: "openrouter",
  togetherai: "together",
  xai: "xai",
};

/** Local gateways (magpie and AgentRecall's own gateway) use gateway-scoped keys that must never be imported back as upstreams. */
const LOCAL_GATEWAY_ORIGINS = new Set([
  "http://127.0.0.1:3425",
  "http://localhost:3425",
  "http://127.0.0.1:4325",
  "http://localhost:4325",
]);

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
  if (codexNeedsMoreThanAKey(record(record(config.model_providers)[provider.id]))) {
    problem(extraRequestPartsProblem(name));
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

/** A Codex `[model_providers.*]` section whose requests carry headers or query parameters beyond the key. */
function codexNeedsMoreThanAKey(settings: Record<string, unknown>): boolean {
  const headers = [...Object.keys(record(settings.http_headers)), ...Object.keys(record(settings.env_http_headers))]
    .filter((header) => header.toLowerCase() !== "authorization");
  return headers.length > 0 || Object.keys(record(settings.query_params)).length > 0;
}

function extraRequestPartsProblem(name: string): string {
  return `"${name}" needs custom request headers or query parameters, which AgentRecall does not send, so it was not imported.`;
}

async function readCcSwitch({ home, problem }: ScanContext): Promise<DeclaredService[]> {
  const file = path.join(home, ".cc-switch", "cc-switch.db");
  if (await modifiedTime(file) === null) return [];
  let rows: Array<Record<string, unknown>>;
  let db: DatabaseSyncType | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    rows = db.prepare("select app_type, name, settings_config from providers order by app_type, coalesce(sort_index, 0), created_at").all();
  } catch (error) {
    throw new Error(`Could not read CC Switch cc-switch.db: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }
  const services: DeclaredService[] = [];
  for (const row of rows) {
    const name = str(row.name);
    let settings: Record<string, unknown>;
    try {
      settings = record(JSON.parse(str(row.settings_config)));
    } catch {
      // CC Switch cannot apply such a row either; the other rows are still usable.
      problem(`The CC Switch settings of "${name}" are not valid JSON.`);
      continue;
    }
    const service = ccSwitchService(str(row.app_type), name, settings, problem);
    if (service) services.push(service);
  }
  return services;
}

/** One CC Switch provider; its settings are the configuration CC Switch writes into that app. */
function ccSwitchService(app: string, rowName: string, settings: Record<string, unknown>, problem: (message: string) => void): DeclaredService | null {
  // CC Switch names the live configuration it took over "default", which says nothing about the service.
  const name = rowName === "default" ? "" : rowName;
  const env = record(settings.env);
  switch (app) {
    case "claude":
    case "claude-desktop": {
      const apiKey = str(env.ANTHROPIC_AUTH_TOKEN) || str(env.ANTHROPIC_API_KEY);
      if (!apiKey) return null;
      const models = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].map((variable) => str(env[variable]));
      const baseUrl = str(env.ANTHROPIC_BASE_URL);
      return baseUrl
        ? customService("cc-switch", name, apiKey, "anthropic-messages", baseUrl, models)
        : listedService("cc-switch", name, apiKey, "anthropic", models);
    }
    case "codex": {
      let config: Record<string, unknown>;
      try {
        config = record(parseToml(str(settings.config)));
      } catch {
        problem(`The CC Switch settings of "${rowName}" are not valid TOML.`);
        return null;
      }
      const provider = record(record(config.model_providers)[str(config.model_provider)]);
      const apiKey = str(record(settings.auth).OPENAI_API_KEY) || str(provider.experimental_bearer_token);
      if (!apiKey) return null;
      if (codexNeedsMoreThanAKey(provider)) {
        problem(extraRequestPartsProblem(rowName));
        return null;
      }
      const baseUrl = str(provider.base_url);
      const models = [str(config.model)];
      return baseUrl
        ? customService("cc-switch", name, apiKey, provider.wire_api === "chat" ? "openai-completions" : "openai-responses", baseUrl, models)
        : listedService("cc-switch", name, apiKey, "openai", models);
    }
    case "gemini": {
      const apiKey = str(env.GEMINI_API_KEY) || str(env.GOOGLE_API_KEY);
      // A relay named by GOOGLE_GEMINI_BASE_URL speaks the Gemini API, which a custom endpoint here does not.
      if (!apiKey || str(env.GOOGLE_GEMINI_BASE_URL)) return null;
      return listedService("cc-switch", name, apiKey, "google", [str(env.GEMINI_MODEL)]);
    }
    default: {
      // OpenCode, OpenClaw, Pi and Hermes rows: an address and a key, the API named by an `api`, `npm` or `type` field.
      const options = record(settings.options);
      const baseUrl = firstText(settings.baseUrl, settings.baseURL, settings.base_url, options.baseURL, options.baseUrl, options.base_url);
      const apiKey = literalKey(firstText(settings.apiKey, settings.api_key, options.apiKey, options.api_key));
      if (!baseUrl || !apiKey) return null;
      const kind = firstText(settings.api, settings.npm, settings.type).toLowerCase();
      const api: AgentModelApi = kind.includes("anthropic") ? "anthropic-messages" : kind.includes("responses") ? "openai-responses" : "openai-completions";
      const models = Array.isArray(settings.models)
        ? list(settings.models).map((model) => (typeof model === "string" ? model : str(record(model).id)))
        : Object.keys(record(settings.models));
      // The AI SDK's Anthropic provider takes a base URL ending in `/v1`; pi-ai adds it itself.
      const anthropicBase = api === "anthropic-messages" && str(settings.npm) ? baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "") : baseUrl;
      return customService("cc-switch", name, apiKey, api, anthropicBase, models);
    }
  }
}

/**
 * Pi keeps providers in `models.json` and keys in `auth.json`; StepCode uses
 * the same files. A key is a literal, the name of an environment variable,
 * or a `!command` Pi runs, which AgentRecall never does.
 */
async function readPiFormat({ env, problem }: ScanContext, source: AgentModelImportSource, directory: string, label: string): Promise<DeclaredService[]> {
  const modelsText = await readOptionalText(path.join(directory, "models.json"));
  const authText = await readOptionalText(path.join(directory, "auth.json"));
  if (modelsText === null && authText === null) return [];
  const providers = record(record(modelsText === null ? {} : parse("JSON", modelsText, `${label} models.json`)).providers);
  const auth = record(authText === null ? {} : parse("JSON", authText, `${label} auth.json`));
  const keyOf = (value: string) => {
    if (!value || value.startsWith("!")) return "";
    if (env[value]?.trim()) return env[value]!.trim();
    return /^[A-Z][A-Z0-9_]*$/.test(value) ? "" : value;
  };
  const savedKey = (id: string) => {
    const entry = record(auth[id]);
    return entry.type === "api_key" ? keyOf(str(entry.key)) : "";
  };
  const services: DeclaredService[] = [];
  for (const [id, value] of Object.entries(providers)) {
    const provider = record(value);
    const apiKey = savedKey(id) || keyOf(str(provider.apiKey));
    if (!apiKey) continue;
    const name = str(provider.name) || id;
    const baseUrl = str(provider.baseUrl);
    const api = AGENT_MODEL_APIS.find((item) => item === provider.api);
    const models = modelIds(provider.models);
    if (Object.keys(record(provider.headers)).length > 0) {
      problem(`"${name}" needs custom request headers, which AgentRecall does not send, so it was not imported.`);
    } else if (!baseUrl && catalogProviderOrigin(id)) {
      services.push(listedService(source, str(provider.name), apiKey, id, models));
    } else if (baseUrl && api) {
      services.push(customService(source, name, apiKey, api, baseUrl, models));
    }
  }
  for (const id of Object.keys(auth)) {
    const apiKey = savedKey(id);
    if (!(id in providers) && apiKey && catalogProviderOrigin(id)) services.push(listedService(source, "", apiKey, id, []));
  }
  return services;
}

/** OpenCode keeps keys from `opencode auth login` in its data folder, on Windows too, without the addresses they belong to. */
async function readOpenCode({ home, env }: ScanContext): Promise<DeclaredService[]> {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const text = await readOptionalText(path.join(dataHome, "opencode", "auth.json"));
  if (text === null) return [];
  const services: DeclaredService[] = [];
  for (const [id, value] of Object.entries(record(parse("JSON", text, "OpenCode auth.json")))) {
    const entry = record(value);
    const provider = OPENCODE_PROVIDERS[id];
    const apiKey = entry.type === "api" ? str(entry.key) : "";
    if (provider && apiKey) services.push(listedService("opencode", "", apiKey, provider, []));
  }
  return services;
}

/** A listed provider's service; without a name of its own it takes the provider's. */
function listedService(source: AgentModelImportSource, name: string, apiKey: string, provider: string, models: string[]): DeclaredService {
  const listedName = listAgentModelProviders().find((item) => item.id === provider)?.name ?? provider;
  return { source, name: name || listedName, apiKey, provider, api: defaultAgentModelConfig.api, baseUrl: "", models: unique(models.map((model) => model.trim())) };
}

/** A custom endpoint's service; without a name of its own it takes the endpoint's host. */
function customService(source: AgentModelImportSource, name: string, apiKey: string, api: AgentModelApi, baseUrl: string, models: string[]): DeclaredService {
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
  return { source, name: name || host, apiKey, provider: AGENT_MODEL_CUSTOM_PROVIDER, api, baseUrl, models: unique(models.map((model) => model.trim())) };
}

/** A key written as a reference (`{env:NAME}`, `${NAME}`, `!command`) is resolved by its app at run time, never here. */
function literalKey(value: string): string {
  return /^(?:\{env:|\$\{|!)/.test(value) ? "" : value;
}

function firstText(...values: unknown[]): string {
  return values.map(str).find(Boolean) ?? "";
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
  if (!origin || LOCAL_GATEWAY_ORIGINS.has(origin) || service.apiKey.startsWith("ar-gw-")) return null;
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
