import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { builtinProviders, getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";

import {
  AGENT_MODEL_CUSTOM_PROVIDER,
  AgentModelNotReadyError,
  agentModelConfigured,
  type AgentModelApi,
  type AgentModelConfig,
  type AgentModelProviderOption,
} from "./agent-model-config";

export interface AgentModelReply {
  text: string;
  model: string;
  /** Prompt tokens including cache reads and writes; absent when the provider reports no usage. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Built-in providers that need more than one API key (cloud credentials,
 * account ids, resource URLs or a sign-in flow). AgentRecall stores a single
 * key per provider, so it does not offer them.
 */
const NOT_KEY_ONLY = new Set([
  "amazon-bedrock",
  "azure",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "github-copilot",
  "google-vertex",
  "openai-codex",
  "radius",
]);

/** Limits for a model id pi-ai does not list. */
const CUSTOM_CONTEXT_WINDOW = 128_000;
const CUSTOM_MAX_TOKENS = 8_192;
/**
 * AgentRecall asks for short JSON answers. Catalog limits reach hundreds of
 * thousands of tokens, which some endpoints reject as a request parameter.
 */
const MAX_OUTPUT_TOKENS = 32_768;

let providerOptions: AgentModelProviderOption[] | null = null;
let catalogEndpoints: Map<string, string[]> | null = null;

/** Key-only pi-ai providers with chat models, sorted by display name. */
export function listAgentModelProviders(): AgentModelProviderOption[] {
  providerOptions ??= builtinProviders()
    .filter((provider) => !NOT_KEY_ONLY.has(provider.id) && provider.auth.apiKey !== undefined)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      keyLabel: provider.auth.apiKey?.name ?? `${provider.name} API key`,
      models: builtinChatModels(provider.id).map((model) => ({ id: model.id, name: model.name })),
    }))
    .filter((provider) => provider.models.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  return providerOptions;
}

/** The listed provider that serves `model` at exactly this endpoint; null when none or several do. */
export function catalogProviderAt(api: AgentModelApi, baseUrl: string, model: string): string | null {
  if (!catalogEndpoints) {
    catalogEndpoints = new Map();
    for (const provider of listAgentModelProviders()) {
      for (const item of builtinChatModels(provider.id)) {
        const key = endpointKey(item.api, item.baseUrl, item.id);
        catalogEndpoints.set(key, [...(catalogEndpoints.get(key) ?? []), provider.id]);
      }
    }
  }
  const providers = catalogEndpoints.get(endpointKey(api, baseUrl, model)) ?? [];
  return providers.length === 1 ? providers[0] : null;
}

/** Origin a listed provider is reached at, such as `https://api.deepseek.com`; null for an unlisted provider. */
export function catalogProviderOrigin(provider: string): string | null {
  if (!listAgentModelProviders().some((item) => item.id === provider)) return null;
  const baseUrl = builtinChatModels(provider)[0]?.baseUrl ?? "";
  return URL.canParse(baseUrl) ? new URL(baseUrl).origin : null;
}

/** Resolves the saved choice to a pi-ai model; a model id the catalog does not list reuses the provider's endpoint. */
export function resolveAgentModel(config: AgentModelConfig): Model<Api> {
  if (!agentModelConfigured(config)) {
    throw new AgentModelNotReadyError("Set up the AgentRecall model in Provider → AgentRecall model.");
  }
  if (config.provider === AGENT_MODEL_CUSTOM_PROVIDER) {
    const model: Model<Api> = {
      id: config.model,
      name: config.model,
      api: config.api,
      provider: AGENT_MODEL_CUSTOM_PROVIDER,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CUSTOM_CONTEXT_WINDOW,
      maxTokens: CUSTOM_MAX_TOKENS,
    };
    if (config.api !== "openai-completions") return model;
    // Gateways that copy the Chat Completions API widely accept `max_tokens`
    // but not always the newer `max_completion_tokens` or `store` fields.
    const compat: Model<"openai-completions">["compat"] = { maxTokensField: "max_tokens", supportsStore: false };
    return { ...model, compat };
  }
  if (!listAgentModelProviders().some((provider) => provider.id === config.provider)) {
    throw new AgentModelNotReadyError(`AgentRecall does not support the provider "${config.provider}". Choose another one in Provider → AgentRecall model.`);
  }
  const models = builtinChatModels(config.provider);
  const known = models.find((model) => model.id === config.model);
  if (known) return known;
  const base = models[0];
  if (!base) throw new AgentModelNotReadyError(`The provider "${config.provider}" lists no chat models.`);
  return { ...base, id: config.model, name: config.model, reasoning: false, thinkingLevelMap: undefined };
}

/**
 * Sends one prompt as a single user message and returns the text answer.
 * Rejects when the provider reports an error, the call is aborted, or the
 * answer is cut off or empty, because every caller parses a complete answer.
 */
export async function completeWithAgentModel(
  config: AgentModelConfig,
  apiKey: string,
  prompt: string,
  signal: AbortSignal,
): Promise<AgentModelReply> {
  const model = resolveAgentModel(config);
  const reply = await completeSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    // pi-ai requires a key; a local custom endpoint without one accepts any value.
    { apiKey: apiKey || "none", signal, maxTokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS) },
  );
  if (reply.stopReason === "aborted" || signal.aborted) {
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    throw new Error(timedOut ? "The model did not answer in time." : "The model call was cancelled.");
  }
  if (reply.stopReason === "error") throw new Error(`The model call failed: ${reply.errorMessage || "unknown error"}`);
  if (reply.stopReason === "length") throw new Error("The model reached its output limit before finishing the answer.");
  const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
  if (!text) throw new Error("The model returned an empty answer.");
  const { usage } = reply;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // A provider that leaves usage out of the stream reports every count as 0, which no real call produces.
  return inputTokens > 0 ? { text, model: model.id, inputTokens, outputTokens: usage.output } : { text, model: model.id };
}

/** `provider` must be a listed id; the catalog getter is typed for literal provider ids only. */
function builtinChatModels(provider: string): Model<Api>[] {
  return getBuiltinModels(provider as BuiltinProvider);
}

/** Compares endpoints the way a request reaches them: host case and trailing slashes do not matter. */
function endpointKey(api: string, baseUrl: string, model: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  return `${api} ${url ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : trimmed} ${model}`;
}
