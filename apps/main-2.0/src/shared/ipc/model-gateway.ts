import { z } from "zod";
import { defineIpcRequest } from "./contract";

export const GATEWAY_PROVIDER_PROTOCOLS = ["openai_chat", "openai_responses", "anthropic"] as const;
export type GatewayProviderProtocol = (typeof GATEWAY_PROVIDER_PROTOCOLS)[number];

export const GATEWAY_AGENT_IDS = ["claude-code", "codex", "deepseek-harness", "pi", "opencode"] as const;
export type GatewayAgentId = (typeof GATEWAY_AGENT_IDS)[number];

export const DEFAULT_GATEWAY_PORT = 4325;

export interface GatewayProviderEntry {
  id: string;
  name: string;
  protocol: GatewayProviderProtocol;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  enabled: boolean;
  hasApiKey: boolean;
}

export interface GatewayRouteTarget {
  providerId: string;
  model: string;
}

export interface GatewayConfig {
  enabled: boolean;
  port: number;
  primary: GatewayRouteTarget | null;
  fallbacks: GatewayRouteTarget[];
  agentModels: Partial<Record<GatewayAgentId, GatewayRouteTarget>>;
  providers: GatewayProviderEntry[];
}

export interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  baseUrl: string;
  localToken: string;
  error: string | null;
  startedAt: number | null;
  totalRequests: number;
  activeRequests: number;
}

export interface GatewayAgentWiringStatus {
  agentId: GatewayAgentId;
  label: string;
  detected: boolean;
  wired: boolean;
  hasBackup: boolean;
  configPath: string;
  currentSummary: string;
  routeOverride: GatewayRouteTarget | null;
  snippet: string;
}

export interface GatewayRequestRecord {
  id: string;
  timestamp: number;
  agentId: GatewayAgentId | "external";
  sessionId: string | null;
  incomingFormat: GatewayProviderProtocol;
  requestedModel: string;
  upstreamProviderName: string;
  upstreamModel: string;
  fallbackUsed: boolean;
  statusCode: number;
  ttftMs: number | null;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  error: string | null;
}

export interface GatewaySnapshot {
  config: GatewayConfig;
  status: GatewayStatus;
  agents: GatewayAgentWiringStatus[];
  requests: GatewayRequestRecord[];
}

export interface GatewayWiringActionResult {
  snapshot: GatewaySnapshot;
  message: string;
}

export const GATEWAY_SNAPSHOT_CHANNEL = "gateway:snapshot";

const protocolSchema = z.enum(GATEWAY_PROVIDER_PROTOCOLS);
const agentIdSchema = z.enum(GATEWAY_AGENT_IDS);
const bounded = (max: number) => z.string().max(max);

export const gatewayRouteTargetInput = z.object({
  providerId: bounded(128).trim().min(1),
  model: bounded(256).trim().min(1),
}).strict();

export const gatewaySaveProviderInput = z.object({
  id: bounded(128).trim().optional(),
  name: bounded(100).trim().min(1),
  protocol: protocolSchema,
  baseUrl: bounded(2048).trim().min(1),
  defaultModel: bounded(256).trim().min(1),
  models: z.array(bounded(256).trim().min(1)).max(128).optional(),
  enabled: z.boolean().optional(),
  /** Blank means keep the currently saved key when editing an existing provider. */
  apiKey: bounded(65_536).optional(),
  /** Optional import id returned by listAgentModelImports so keys never cross IPC. */
  importId: bounded(256).optional(),
}).strict();
export type GatewaySaveProviderInput = z.infer<typeof gatewaySaveProviderInput>;

export const gatewaySetEnabledInput = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535).optional(),
}).strict();

export const gatewaySetRoutingInput = z.object({
  primary: gatewayRouteTargetInput.nullable(),
  fallbacks: z.array(gatewayRouteTargetInput).max(8),
}).strict();

export const gatewaySetAgentModelInput = z.object({
  agentId: agentIdSchema,
  target: gatewayRouteTargetInput.nullable(),
}).strict();

export const MODEL_GATEWAY_IPC = {
  getSnapshot: defineIpcRequest("gateway:get-snapshot", z.tuple([])),
  setEnabled: defineIpcRequest("gateway:set-enabled", z.tuple([gatewaySetEnabledInput])),
  saveProvider: defineIpcRequest("gateway:save-provider", z.tuple([gatewaySaveProviderInput])),
  removeProvider: defineIpcRequest("gateway:remove-provider", z.tuple([bounded(128).trim().min(1)])),
  setRouting: defineIpcRequest("gateway:set-routing", z.tuple([gatewaySetRoutingInput])),
  setAgentModel: defineIpcRequest("gateway:set-agent-model", z.tuple([gatewaySetAgentModelInput])),
  wireAgent: defineIpcRequest("gateway:wire-agent", z.tuple([agentIdSchema])),
  restoreAgent: defineIpcRequest("gateway:restore-agent", z.tuple([agentIdSchema])),
  clearRequests: defineIpcRequest("gateway:clear-requests", z.tuple([])),
} as const;
