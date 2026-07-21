import type { AgentChannel, AgentId, AgentModelOption } from "./types";

export const DEFAULT_MODEL_ID = "default";
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
    { id: DEFAULT_MODEL_ID, label: "Default" },
    ...CURRENT_CODEX_MODELS,
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
  claude: [
    { id: DEFAULT_MODEL_ID, label: "Default" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  api: [
    { id: DEFAULT_MODEL_ID, label: "Default" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "glm-5.1", label: "GLM-5.1" },
    { id: "kimi-k2.6", label: "Kimi K2.6" },
  ],
  hermes: [
    { id: DEFAULT_MODEL_ID, label: "Default" },
  ],
  opencode: [
    { id: DEFAULT_MODEL_ID, label: "Default" },
  ],
  openclaw: [
    { id: DEFAULT_MODEL_ID, label: "Default" },
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
