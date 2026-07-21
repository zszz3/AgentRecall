import { randomUUID } from "node:crypto";
import { runtimeLabel } from "../../../shared/runtime-catalog";
import type { AgentChannel, AgentId, ChatMessage } from "../../../shared/types";

export function createAssistantMessage(content = "", local = false): ChatMessage {
  return {
    id: randomUUID(),
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...(local ? { local: true } : {}),
  };
}

export function createUserMessage(content: string, local = false): ChatMessage {
  return {
    id: randomUUID(),
    role: "user",
    content,
    timestamp: Date.now(),
    ...(local ? { local: true } : {}),
  };
}

export function createErrorMessage(content: string): ChatMessage {
  return {
    id: randomUUID(),
    role: "error",
    content,
    timestamp: Date.now(),
  };
}

export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  return oneLine.length > 56 ? `${oneLine.slice(0, 56)}...` : oneLine;
}

export function hasAgentConversationMessages(messages: ChatMessage[]): boolean {
  return messages.some((message) => !message.local);
}

export function cloneAgentChannel(channel: AgentChannel): AgentChannel {
  const cloned: AgentChannel = {
    id: channel.id,
    agentId: channel.agentId,
    label: channel.label,
    models: channel.models.map((model) => ({
      ...model,
      ...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
    })),
  };
  if (channel.profileName !== undefined) cloned.profileName = channel.profileName;
  if (channel.presetId !== undefined) cloned.presetId = channel.presetId;
  if (channel.modelProvider !== undefined) cloned.modelProvider = channel.modelProvider;
  if (channel.providerName !== undefined) cloned.providerName = channel.providerName;
  if (channel.baseUrl !== undefined) cloned.baseUrl = channel.baseUrl;
  if (channel.wireApi !== undefined) cloned.wireApi = channel.wireApi;
  if (channel.apiFormat !== undefined) cloned.apiFormat = channel.apiFormat;
  if (channel.apiKeyField !== undefined) cloned.apiKeyField = channel.apiKeyField;
  if (channel.isFullUrl !== undefined) cloned.isFullUrl = channel.isFullUrl;
  if (channel.customUserAgent !== undefined) cloned.customUserAgent = channel.customUserAgent;
  if (channel.environment !== undefined) cloned.environment = { ...channel.environment };
  if (channel.requestOverrides !== undefined) {
    cloned.requestOverrides = {
      ...(channel.requestOverrides.headers ? { headers: { ...channel.requestOverrides.headers } } : {}),
      ...(channel.requestOverrides.body ? { body: structuredClone(channel.requestOverrides.body) } : {}),
    };
  }
  if (channel.modelCatalogJson !== undefined) cloned.modelCatalogJson = channel.modelCatalogJson;
  if (channel.modelReasoningEffort !== undefined) cloned.modelReasoningEffort = channel.modelReasoningEffort;
  if (channel.httpHeaders !== undefined) cloned.httpHeaders = { ...channel.httpHeaders };
  if (channel.plugins !== undefined) cloned.plugins = channel.plugins.map((plugin) => ({ ...plugin }));
  return cloned;
}

export function agentLabel(agentId: AgentId): string {
  return runtimeLabel(agentId);
}
