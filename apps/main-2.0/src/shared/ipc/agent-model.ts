import { z } from "zod";
import { AGENT_MODEL_APIS, type AgentModelConfig } from "../../core/agent-model-config";
import { defineIpcRequest } from "./contract";

export interface AgentModelTestResult {
  model: string;
  reply: string;
}

const providerId = z.string().trim().min(1).max(100);
const apiKey = z.string().max(8_192);

const config: z.ZodType<AgentModelConfig> = z.object({
  provider: z.string().trim().max(100),
  model: z.string().trim().max(200),
  baseUrl: z.string().trim().max(2_048),
  api: z.enum(AGENT_MODEL_APIS),
}).strict();

export const AGENT_MODEL_IPC = {
  listProviders: defineIpcRequest("agent-model:list-providers", z.tuple([])),
  hasKey: defineIpcRequest("agent-model:has-key", z.tuple([providerId])),
  saveKey: defineIpcRequest("agent-model:save-key", z.tuple([providerId, apiKey])),
  /** An omitted key tests with the key saved for the draft's provider. */
  test: defineIpcRequest("agent-model:test", z.tuple([config, apiKey.nullable()])),
} as const;
