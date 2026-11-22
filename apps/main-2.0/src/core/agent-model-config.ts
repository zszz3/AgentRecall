/**
 * The model AgentRecall calls for its own tasks (experience cards, AI Skill
 * exploration). Browser-safe: the renderer edits this shape, while the main
 * process resolves it to a model in `agent-model.ts`. The API key is never part
 * of it; keys stay in the main process key store, one per provider.
 */

/** Provider id for an endpoint pi-ai does not list, reached through `baseUrl` and `api`. */
export const AGENT_MODEL_CUSTOM_PROVIDER = "custom";

export const AGENT_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type AgentModelApi = (typeof AGENT_MODEL_APIS)[number];

export interface AgentModelConfig {
  /** A pi-ai built-in provider id, `custom`, or empty while nothing is chosen. */
  provider: string;
  model: string;
  /** Used only by the custom provider. */
  baseUrl: string;
  /** Used only by the custom provider. */
  api: AgentModelApi;
}

/** A pi-ai provider the user can choose, with the chat models it lists. */
export interface AgentModelProviderOption {
  id: string;
  name: string;
  /** What the provider calls its key, such as "DeepSeek API key". */
  keyLabel: string;
  models: { id: string; name: string }[];
}

/** Local agents whose model settings AgentRecall can import. */
export const AGENT_MODEL_IMPORT_SOURCES = ["zcode", "dsh", "codex", "claude-code", "cc-switch", "pi", "stepcode", "opencode"] as const;
export type AgentModelImportSource = (typeof AGENT_MODEL_IMPORT_SOURCES)[number];

/**
 * A model service another local agent is set up with: one host and one API
 * key, found in one or more agents. The key stays in the main process.
 */
export interface AgentModelImport {
  /** Names this service and its key until the app quits. */
  id: string;
  name: string;
  host: string;
  sources: AgentModelImportSource[];
  choices: AgentModelImportChoice[];
}

export interface AgentModelImportChoice {
  config: AgentModelConfig;
  /** The model id, followed by the API format or path when two choices would otherwise read the same. */
  label: string;
}

export interface AgentModelImports {
  imports: AgentModelImport[];
  /** Settings that exist but could not be read. */
  problems: { source: AgentModelImportSource; message: string }[];
}

/** The API key of a test or save: typed in, or taken from an imported service. */
export type AgentModelKeyInput = { apiKey: string } | { importId: string };

export const defaultAgentModelConfig: AgentModelConfig = {
  provider: "",
  model: "",
  baseUrl: "",
  api: "openai-completions",
};

export function normalizeAgentModelConfig(value: Partial<AgentModelConfig> | null | undefined): AgentModelConfig {
  const api = AGENT_MODEL_APIS.find((item) => item === value?.api) ?? defaultAgentModelConfig.api;
  return {
    provider: String(value?.provider ?? "").trim(),
    model: String(value?.model ?? "").trim(),
    baseUrl: String(value?.baseUrl ?? "").trim().replace(/\/+$/, ""),
    api,
  };
}

/** Whether every field the chosen provider needs is filled in. A missing API key is reported when the model is called. */
export function agentModelConfigured(config: AgentModelConfig): boolean {
  if (!config.provider || !config.model) return false;
  return config.provider !== AGENT_MODEL_CUSTOM_PROVIDER || Boolean(config.baseUrl);
}

/** Whether both choices reach the same endpoint, so one API key serves both; the model may differ. */
export function sameAgentModelEndpoint(left: AgentModelConfig, right: AgentModelConfig): boolean {
  if (left.provider !== right.provider) return false;
  return left.provider !== AGENT_MODEL_CUSTOM_PROVIDER || (left.baseUrl === right.baseUrl && left.api === right.api);
}

/** Short name of the chosen model, such as "deepseek · deepseek-v4-pro"; null while nothing is chosen. */
export function agentModelLabel(config: AgentModelConfig | undefined): string | null {
  if (!config || !agentModelConfigured(config)) return null;
  if (config.provider !== AGENT_MODEL_CUSTOM_PROVIDER) return `${config.provider} · ${config.model}`;
  const host = URL.canParse(config.baseUrl) ? new URL(config.baseUrl).host : config.baseUrl;
  return `${host} · ${config.model}`;
}

/**
 * The AgentRecall model cannot be called until the user finishes its setup. It
 * is not a failure of the work that needed the model, so callers stop instead
 * of recording that work as failed. It keeps the plain `Error` name because
 * Electron shows the name in front of the message when the error crosses IPC.
 */
export class AgentModelNotReadyError extends Error {}
