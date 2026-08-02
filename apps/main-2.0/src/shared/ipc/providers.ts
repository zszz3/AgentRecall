import { z } from "zod";
import { defineIpcRequest } from "./contract";

const boundedString = (max: number) => z.string().max(max);
const providerId = z.enum(["custom", "codexzh", "deepseek", "zhipu_glm", "longcat", "kimi", "xiaomi_mimo"]);
const claudeProviderId = z.enum(["custom", "deepseek", "zhipu_glm", "longcat", "kimi", "xiaomi_mimo"]);

export const apiConfigInput = z.object({
  activeProvider: z.enum(["official", "custom"]),
  customProviderId: providerId,
  customProviderName: boundedString(256),
  customBaseUrl: boundedString(8_192),
  customApiKey: boundedString(65_536),
  customModel: boundedString(512),
  customApiFormat: z.enum(["openai_chat", "openai_responses"]),
}).partial().strict();

export const claudeApiConfigInput = z.object({
  activeProvider: z.enum(["official", "custom"]),
  customProviderId: claudeProviderId,
  customProviderName: boundedString(256),
  customBaseUrl: boundedString(8_192),
  customApiKey: boundedString(65_536),
  customModel: boundedString(512),
  customHaikuModel: boundedString(512),
  customSonnetModel: boundedString(512),
  customOpusModel: boundedString(512),
  customApiFormat: z.enum(["anthropic", "openai_chat", "openai_responses", "gemini_native"]),
  customApiKeyField: z.enum(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]),
}).partial().strict();

export const codexModelProbeInput = z.object({
  baseUrl: boundedString(8_192),
  apiKey: boundedString(65_536),
  providerId: boundedString(128).trim().min(1).optional(),
  keyTarget: z.enum(["codex", "summary"]).optional(),
}).strict();

export const summaryProviderConnectionInput = z.object({
  baseUrl: boundedString(8_192).trim().min(1),
  apiKey: boundedString(65_536),
  providerId: boundedString(128).trim().min(1),
  model: boundedString(512).trim().min(1),
  apiFormat: z.enum(["openai_chat", "openai_responses"]),
}).strict();

export const providerKeyTarget = z.enum(["codex", "claude", "summary"]);
export type ProviderKeyTarget = z.infer<typeof providerKeyTarget>;
export type CodexModelProbeRequest = z.infer<typeof codexModelProbeInput>;
export type SummaryProviderConnectionRequest = z.infer<typeof summaryProviderConnectionInput>;

export interface SummaryProviderConnectionResult {
  elapsedMs: number;
}

export const PROVIDERS_IPC = {
  getCodexConfig: defineIpcRequest("codex-config:get", z.tuple([])),
  probeCodexModels: defineIpcRequest("codex-config:probe-models", z.tuple([codexModelProbeInput])),
  testSummaryProviderConnection: defineIpcRequest(
    "summary-provider:test-connection",
    z.tuple([summaryProviderConnectionInput]),
  ),
  applyCodexProfile: defineIpcRequest("codex-profile:apply", z.tuple([apiConfigInput])),
  applyClaudeProfile: defineIpcRequest("claude-profile:apply", z.tuple([claudeApiConfigInput])),
  getCodexChatProxyStatus: defineIpcRequest("codex-chat-proxy:status", z.tuple([])),
  stopCodexChatProxy: defineIpcRequest("codex-chat-proxy:stop", z.tuple([])),
  getApiProviderKey: defineIpcRequest(
    "api-provider-key:get",
    z.tuple([providerKeyTarget, boundedString(128).trim().min(1)]),
  ),
} as const;
