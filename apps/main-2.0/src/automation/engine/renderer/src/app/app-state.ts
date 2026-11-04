import type { AgentChannel, AgentId, AgentModelOption, AppSnapshot, ConfiguredAgent } from "../../../shared/types";
import { DEFAULT_MODEL_ID, FALLBACK_MODEL_OPTIONS, defaultChannelForAgent, defaultModelOption } from "../../../shared/models";
import { runtimeDefinition, runtimeLabel } from "../../../shared/runtime-catalog";

export const DEFAULT_SNAPSHOT: AppSnapshot = {
  detectedAt: 0,
  activeChatId: undefined,
  workDir: "",
  runtimes: [],
  channels: [],
  configuredAgents: [],
  chats: [],
};

function uniqueId(base: string, existingIds: string[]): string {
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "channel";
  if (!existingIds.includes(normalized)) return normalized;
  let suffix = 2;
  while (existingIds.includes(`${normalized}-${suffix}`)) suffix += 1;
  return `${normalized}-${suffix}`;
}

export function createChannel(agentId: AgentId, existingIds: string[]): AgentChannel {
  const definition = runtimeDefinition(agentId);
  const useDefaultIdentity = !existingIds.includes(definition.defaultChannel.id);
  const id = useDefaultIdentity
    ? definition.defaultChannel.id
    : uniqueId(`${agentId}-config`, existingIds);
  return {
    ...(useDefaultIdentity ? definition.defaultChannel : {}),
    id,
    agentId,
    label: useDefaultIdentity ? definition.defaultChannel.label : `New ${runtimeLabel(agentId)} Config`,
    models: FALLBACK_MODEL_OPTIONS[agentId].some((model) => model.id === DEFAULT_MODEL_ID)
      ? FALLBACK_MODEL_OPTIONS[agentId]
      : [defaultModelOption(), ...FALLBACK_MODEL_OPTIONS[agentId]],
  };
}

export function createConfiguredAgent(channels: AgentChannel[], existingIds: string[]): ConfiguredAgent {
  const runtimeAgentId: AgentId = "codex";
  const id = uniqueId("agent", existingIds);
  const channelId = defaultChannelForAgent(runtimeAgentId, channels);
  return {
    id,
    name: "New Agent",
    description: "",
    runtimeAgentId,
    channelId,
    modelId: DEFAULT_MODEL_ID,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createModel(existingModels: AgentModelOption[]): AgentModelOption {
  const id = uniqueId("model", existingModels.map((model) => model.id));
  return { id, label: id };
}

export interface BalanceRefreshInput {
  channels: AgentChannel[];
  configDirty: boolean;
  refreshInFlight: boolean;
  lastRefreshAt: number | undefined;
  now: number;
  intervalMs: number;
}

export function shouldRefreshBalances(input: BalanceRefreshInput): boolean {
  if (input.channels.length === 0) return false;
  if (input.configDirty) return false;
  if (input.refreshInFlight) return false;
  return input.lastRefreshAt === undefined || input.now - input.lastRefreshAt >= input.intervalMs;
}
