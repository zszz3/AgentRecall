import { DEFAULT_MODEL_ID, FALLBACK_MODEL_OPTIONS } from "./models";
import { RUNTIME_DEFINITIONS, RUNTIME_IDS, runtimeDefinition } from "./runtime-catalog";
import type { AgentChannel, AgentId } from "./types";

export const CONFIG_AGENT_ORDER: AgentId[] = [...RUNTIME_IDS];

export const DEFAULT_CONFIG_CHANNEL_IDS = Object.fromEntries(
  RUNTIME_DEFINITIONS.map((definition) => [definition.id, definition.defaultChannel.id]),
) as Record<AgentId, string>;

function isNewConfigChannelId(channel: AgentChannel): boolean {
  return channel.id === `${channel.agentId}-config` || channel.id.startsWith(`${channel.agentId}-config-`);
}

function isLegacyAgentAssemblyChannel(channel: AgentChannel): boolean {
  if (isNewConfigChannelId(channel)) return false;
  if (!/(?:^|-)(?:agent-)?channel(?:-\d+)?$/.test(channel.id)) return false;
  return channel.agentId === "codex";
}

export function isGeneratedConfigChannel(channel: AgentChannel): boolean {
  return channel.id.startsWith("codex-multi-agent-") || isLegacyAgentAssemblyChannel(channel);
}

export function selectConfigChannelsForDisplay(channels: AgentChannel[]): AgentChannel[] {
  return channels;
}

export function hiddenConfigChannels(channels: AgentChannel[]): AgentChannel[] {
  const visibleIds = new Set(selectConfigChannelsForDisplay(channels).map((channel) => channel.id));
  return channels.filter((channel) => !visibleIds.has(channel.id));
}

export function generatedConfigChannels(channels: AgentChannel[]): AgentChannel[] {
  return channels.filter(isGeneratedConfigChannel);
}

export function normalizeConfigChannelsForStorage(channels: AgentChannel[]): AgentChannel[] {
  const generatedIds = new Set(generatedConfigChannels(channels).map((channel) => channel.id));
  const compacted = channels.filter((channel) => !generatedIds.has(channel.id));
  return compacted.length > 0 ? compacted : createFallbackConfigChannels();
}

export function configChannelForSelection(channels: AgentChannel[], selectedChannelId: string): AgentChannel | undefined {
  const selectedDisplayChannel = channels.find((channel) => channel.id === selectedChannelId);
  if (selectedDisplayChannel) return selectedDisplayChannel;

  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  if (selectedChannel) {
    const sameRuntime = channels.find((channel) => channel.agentId === selectedChannel.agentId);
    if (sameRuntime) return sameRuntime;
  }

  return channels[0];
}

function createFallbackConfigChannels(): AgentChannel[] {
  return CONFIG_AGENT_ORDER.map((agentId) => {
    const definition = runtimeDefinition(agentId);
    return {
      ...definition.defaultChannel,
      agentId,
      models: FALLBACK_MODEL_OPTIONS[agentId].some((model) => model.id === DEFAULT_MODEL_ID)
        ? FALLBACK_MODEL_OPTIONS[agentId]
      : [{ id: DEFAULT_MODEL_ID, label: "Default" }, ...FALLBACK_MODEL_OPTIONS[agentId]],
    };
  });
}
