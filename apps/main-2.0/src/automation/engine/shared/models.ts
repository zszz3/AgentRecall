import type { AgentChannel, AgentId, AgentModelOption } from "./types";

export const DEFAULT_MODEL_ID = "default";

/**
 * `Default` is not a model name — it means "send no model and let the agent's own config
 * file decide". Saying so in the label stops it reading as a peer of `GPT-5.6-Sol` in the
 * pickers, which is the source of the "what is Default?" confusion.
 */
export const DEFAULT_MODEL_LABEL = "Default (use config file)";

/** Fresh object per call: model lists are mutated in place in a few normalization paths. */
export function defaultModelOption(): AgentModelOption {
  return { id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL };
}

/**
 * The single way to turn a stored model id into something a user should read. Falls back to
 * the raw id so an unknown model is still identifiable rather than blank.
 */
export function modelDisplayLabel(modelId: string | null | undefined, models?: AgentModelOption[]): string {
  if (!modelId || modelId === DEFAULT_MODEL_ID) return DEFAULT_MODEL_LABEL;
  return models?.find((model) => model.id === modelId)?.label || modelId;
}

export const CURRENT_CODEX_MODELS: AgentModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
];

export const FALLBACK_MODEL_OPTIONS: Record<AgentId, AgentModelOption[]> = {
  codex: [
    defaultModelOption(),
    ...CURRENT_CODEX_MODELS,
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
  claude: [
    defaultModelOption(),
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  api: [
    defaultModelOption(),
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "glm-5.1", label: "GLM-5.1" },
    { id: "kimi-k2.6", label: "Kimi K2.6" },
  ],
  hermes: [
    defaultModelOption(),
  ],
  opencode: [
    defaultModelOption(),
  ],
  openclaw: [
    defaultModelOption(),
  ],
};

export function defaultModelForAgent(_agentId: AgentId): string {
  return DEFAULT_MODEL_ID;
}

export function defaultChannelForAgent(agentId: AgentId, channels: AgentChannel[]): string {
  return channels.find((channel) => channel.agentId === agentId)?.id ?? `${agentId}-default`;
}

export function modelsForChannel(agentId: AgentId, channelId: string, channels: AgentChannel[]): AgentModelOption[] {
  return channels.find((channel) => channel.agentId === agentId && channel.id === channelId)?.models ?? FALLBACK_MODEL_OPTIONS[agentId];
}

export function isModelForChannel(agentId: AgentId, channelId: string, modelId: string, channels: AgentChannel[]): boolean {
  return modelsForChannel(agentId, channelId, channels).some((model) => model.id === modelId);
}

export function runtimeModelId(modelId: string): string | null {
  return modelId === DEFAULT_MODEL_ID ? null : modelId;
}
