import { z } from "zod";
import { isProviderId, PROVIDER_ID_MAX_LENGTH } from "../../core/api-config";
import { defineIpcRequest } from "./contract";

const boundedString = (max: number) => z.string().max(max);
// Codex config providers may be declared with a quoted section name, so ids such as
// `My Proxy` are legal and must survive the trip to the main process.
const providerId = boundedString(PROVIDER_ID_MAX_LENGTH).trim().refine(isProviderId, "Invalid provider id.");
const configSnapshotInput = z.object({ configDir: boundedString(8_192).optional() }).strict();

export const apiConfigInput = z.object({
  activeProvider: z.enum(["official", "custom"]),
  customProviderId: providerId,
  customConfigDir: boundedString(8_192),
  customProviderName: boundedString(256),
  customBaseUrl: boundedString(8_192),
  customApiKey: boundedString(65_536),
  customModel: boundedString(512),
  customApiFormat: z.enum(["openai_chat", "openai_responses"]),
}).partial().strict();

export const claudeApiConfigInput = z.object({
  activeProvider: z.enum(["official", "custom"]),
  customProviderId: providerId,
  customConfigDir: boundedString(8_192),
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
  providerId: providerId.optional(),
  codexHome: boundedString(8_192).optional(),
  keyTarget: z.enum(["codex", "summary"]).optional(),
}).strict();

export const claudeModelProbeInput = z.object({
  baseUrl: boundedString(8_192),
  apiKey: boundedString(65_536),
  providerId: providerId.optional(),
  claudeHome: boundedString(8_192).optional(),
  apiFormat: z.enum(["anthropic", "openai_chat", "openai_responses", "gemini_native"]),
  apiKeyField: z.enum(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]),
}).strict();

export const providerKeyTarget = z.enum(["codex", "claude", "summary"]);

export const summaryProviderConnectionInput = z.object({
  baseUrl: boundedString(8_192).trim().min(1),
  apiKey: boundedString(65_536),
  providerId,
  model: boundedString(512).trim().min(1),
  apiFormat: z.enum(["openai_chat", "openai_responses"]),
  codexHome: boundedString(8_192).optional(),
  inheritCodex: z.boolean().optional(),
}).strict();

export type ProviderKeyTarget = z.infer<typeof providerKeyTarget>;
export type ConfigSnapshotRequest = z.infer<typeof configSnapshotInput>;
export type CodexModelProbeRequest = z.infer<typeof codexModelProbeInput>;
export type ClaudeModelProbeRequest = z.infer<typeof claudeModelProbeInput>;
export type SummaryProviderConnectionRequest = z.infer<typeof summaryProviderConnectionInput>;

export interface SummaryProviderConnectionResult {
  elapsedMs: number;
  credentialSource: string;
}

export const PROVIDERS_IPC = {
  getCodexConfig: defineIpcRequest("codex-config:get", z.tuple([configSnapshotInput])),
  getClaudeConfig: defineIpcRequest("claude-config:get", z.tuple([configSnapshotInput])),
  probeCodexModels: defineIpcRequest("codex-config:probe-models", z.tuple([codexModelProbeInput])),
  probeClaudeModels: defineIpcRequest("claude-config:probe-models", z.tuple([claudeModelProbeInput])),
  pickConfigDirectory: defineIpcRequest(
    "provider-config:pick-directory",
    z.tuple([providerKeyTarget, z.union([boundedString(8_192), z.undefined()])]),
  ),
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
    z.tuple([providerKeyTarget, providerId]),
  ),
} as const;
