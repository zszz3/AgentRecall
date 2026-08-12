import { DEFAULT_MODEL_ID, FALLBACK_MODEL_OPTIONS, defaultModelOption } from "./models";
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

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameConfigValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightRecord).length
    && leftEntries.every(([key, value]) => (
      Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameConfigValue(value, rightRecord[key])
    ));
}

export function configChannelsEqual(left: AgentChannel[], right: AgentChannel[]): boolean {
  return sameConfigValue(left, right);
}

function isUntouchedOptionalRuntimeDefault(channel: AgentChannel): boolean {
  const definition = runtimeDefinition(channel.agentId);
  if (definition.autoCreateConfig) return false;
  return sameConfigValue(channel, {
    ...definition.defaultChannel,
    agentId: definition.id,
    models: FALLBACK_MODEL_OPTIONS[definition.id],
  });
}

export function normalizeConfigChannelsForStorage(channels: AgentChannel[]): AgentChannel[] {
  const generatedIds = new Set(generatedConfigChannels(channels).map((channel) => channel.id));
  const compacted = channels.filter(
    (channel) => !generatedIds.has(channel.id) && !isUntouchedOptionalRuntimeDefault(channel),
  );
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
  return RUNTIME_DEFINITIONS
    .filter((definition) => definition.autoCreateConfig)
    .map((definition) => {
      const agentId = definition.id;
      return {
        ...definition.defaultChannel,
        agentId,
        models: FALLBACK_MODEL_OPTIONS[agentId].some((model) => model.id === DEFAULT_MODEL_ID)
          ? FALLBACK_MODEL_OPTIONS[agentId]
          : [defaultModelOption(), ...FALLBACK_MODEL_OPTIONS[agentId]],
      };
    });
}
