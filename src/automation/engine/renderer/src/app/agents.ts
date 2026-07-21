import { DEFAULT_MODEL_ID } from "../../../shared/models";
import { runtimeDefinition, runtimeLabel } from "../../../shared/runtime-catalog";
import type { AgentChannel, AgentId, AgentModelOption, AgentRuntime, ConfiguredAgent } from "../../../shared/types";

export function agentLabel(agentId: AgentId): string {
  return runtimeLabel(agentId);
}

export function agentAccent(agentId: AgentId): string {
  return `agent-${agentId}`;
}

export function fallbackRuntime(agentId: AgentId): AgentRuntime {
  return {
    id: agentId,
    label: agentLabel(agentId),
    command: runtimeDefinition(agentId).executable,
    version: null,
    available: false,
    error: "Detecting",
  };
}

export function runtimeStatus(runtime: AgentRuntime): string {
  if (runtime.available) return runtime.version ?? "available";
  return runtime.error ?? "missing";
}

export function resolveConfiguredAgentChannel(agent: ConfiguredAgent | undefined, channels: AgentChannel[]): AgentChannel | undefined {
  if (!agent) return undefined;
  return channels.find((channel) => channel.id === agent.channelId) ?? channels.find((channel) => channel.agentId === agent.runtimeAgentId) ?? channels[0];
}

export function configuredAgentById(configuredAgentId: string | undefined, configuredAgents: ConfiguredAgent[]): ConfiguredAgent | undefined {
  return configuredAgents.find((agent) => agent.id === configuredAgentId) ?? configuredAgents[0];
}

export function defaultConfiguredAgentId(configuredAgents: ConfiguredAgent[]): string {
  return configuredAgents[0]?.id ?? "";
}

export function resolveFindSkillConfiguredAgentId(configuredAgentId: string | undefined, configuredAgents: ConfiguredAgent[]): string {
  if (configuredAgentId && configuredAgents.some((agent) => agent.id === configuredAgentId)) return configuredAgentId;
  return defaultConfiguredAgentId(configuredAgents);
}

export function configuredAgentModel(
  agent: ConfiguredAgent | undefined,
  channel: AgentChannel | undefined,
  modelId?: string,
): AgentModelOption | undefined {
  if (!agent || !channel) return undefined;
  const selectedModelId = modelId || agent.modelId;
  return channel.models.find((model) => model.id === selectedModelId) ?? channel.models.find((model) => model.id === DEFAULT_MODEL_ID) ?? channel.models[0];
}

export function configuredAgentRuntimeId(agent: ConfiguredAgent | undefined, channel: AgentChannel | undefined): AgentId {
  return channel?.agentId ?? agent?.runtimeAgentId ?? "codex";
}

export function configuredAgentModelId(configuredAgentId: string | undefined, modelId: string | undefined, configuredAgents: ConfiguredAgent[], channels: AgentChannel[]): string {
  const agent = configuredAgentById(configuredAgentId, configuredAgents);
  const channel = resolveConfiguredAgentChannel(agent, channels);
  return configuredAgentModel(agent, channel, modelId)?.id ?? DEFAULT_MODEL_ID;
}
