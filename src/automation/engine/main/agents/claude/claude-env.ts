import type { AgentChannel } from "../../../shared/types";
import { runtimeModelId } from "../../../shared/models";

const DEEPSEEK_PRO_MODEL = "claude-opus-4-8";
const DEEPSEEK_FLASH_MODEL = "claude-haiku-4-5";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export function claudeEnvironmentForChannel(
  channel: AgentChannel | undefined,
  modelId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!channel || channel.agentId !== "claude") {
    return baseEnv;
  }

  const providerChannel = channel.modelProvider?.endsWith("-anthropic") === true;
  const hasOverrides = Boolean(channel.environment || channel.baseUrl || channel.customUserAgent || channel.apiKeyField);
  if (!providerChannel && !hasOverrides) return baseEnv;

  const authToken = authorizationToken(channel.httpHeaders?.Authorization);
  const model = claudeEnvironmentModelForChannel(channel, modelId);
  const env = { ...baseEnv, ...(channel.environment ?? {}) };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (channel.baseUrl) env.ANTHROPIC_BASE_URL = channel.baseUrl;
  if (authToken) {
    env[channel.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"] = authToken;
    if (!channel.apiKeyField && channel.modelProvider === "deepseek-anthropic") env.ANTHROPIC_API_KEY = authToken;
  }
  if (providerChannel) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ??= channel.modelProvider === "deepseek-anthropic" ? DEEPSEEK_PRO_MODEL : model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ??= channel.modelProvider === "deepseek-anthropic" ? DEFAULT_CLAUDE_MODEL : model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= defaultClaudeSubagentModel(channel);
    env.CLAUDE_CODE_SUBAGENT_MODEL ??= defaultClaudeSubagentModel(channel);
    env.CLAUDE_CODE_EFFORT_LEVEL ??= "max";
  }
  if (channel.customUserAgent) env.CLAUDE_AGENT_SDK_CLIENT_APP = channel.customUserAgent;
  return {
    ...env,
  };
}

export function claudeCliModelForChannel(channel: AgentChannel | undefined, modelId: string): string | undefined {
  if (channel?.agentId === "claude" && channel.modelProvider?.endsWith("-anthropic")) return claudeEnvironmentModelForChannel(channel, modelId);
  return runtimeModelId(modelId) ?? undefined;
}

function defaultClaudeModel(channel: AgentChannel): string {
  if (channel.modelProvider === "deepseek-anthropic") return DEEPSEEK_FLASH_MODEL;
  return channel.models.find((item) => item.id !== "default")?.id ?? DEFAULT_CLAUDE_MODEL;
}

function claudeEnvironmentModelForChannel(channel: AgentChannel, modelId: string): string {
  const runtimeModel = runtimeModelId(modelId);
  if (channel.modelProvider !== "deepseek-anthropic") return runtimeModel ?? defaultClaudeModel(channel);
  if (!runtimeModel) return DEEPSEEK_FLASH_MODEL;
  if (runtimeModel === DEEPSEEK_PRO_MODEL || runtimeModel === DEEPSEEK_FLASH_MODEL) return runtimeModel;
  if (runtimeModel === "deepseek-v4-flash") return DEEPSEEK_FLASH_MODEL;
  if (runtimeModel.startsWith("deepseek-v4-pro")) return DEEPSEEK_PRO_MODEL;
  if (runtimeModel.startsWith("claude-haiku")) return DEEPSEEK_FLASH_MODEL;
  if (runtimeModel.startsWith("claude-opus") || runtimeModel.startsWith("claude-sonnet")) return DEEPSEEK_PRO_MODEL;
  return runtimeModel;
}

function defaultClaudeSubagentModel(channel: AgentChannel): string {
  if (channel.modelProvider === "deepseek-anthropic") return DEEPSEEK_FLASH_MODEL;
  return defaultClaudeModel(channel);
}

function authorizationToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice("bearer ".length).trim() : trimmed;
}
