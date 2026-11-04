import type {
  AgentChannel,
  AgentEvent,
  AgentId,
  AgentRuntime,
  RuntimeRequest,
  AgentOneShotResponse,
} from "../../../../shared/types";
import type {
  RuntimeChannelTestContext,
  RuntimeSessionCleanupContext,
  RuntimeOneShotRequest,
} from "../../../agents/runtime/runtime-driver";
import type { RuntimeApprovalRequester } from "../../../approvals/runtime-approval-broker";
import type { BoundMcpServer } from "./runtime-mcp";

export interface AgentExecutionContext extends RuntimeRequest {
  runId: string;
  configuredAgentId?: string;
  runtime: AgentRuntime;
  channelId: string;
  prompt: string;
  workDir: string;
  developerInstructions: string;
  emit: (event: AgentEvent) => void;
  onExit: (code?: number | null) => void;
}

export interface AgentExecutor {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentExecutorFactory {
  create(context: AgentExecutionContext): AgentExecutor;
}

export interface RuntimeAgentExecutorFactoryOptions {
  executables: Record<AgentId, string>;
  channelById: (channelId: string) => AgentChannel | undefined;
  mcpServersForAgent?: (configuredAgentId: string) => BoundMcpServer[];
  requestApproval?: RuntimeApprovalRequester;
  askOneShotByRuntime?: Partial<Record<AgentId, (input: RuntimeOneShotRequest) => Promise<AgentOneShotResponse>>>;
  testChannelByRuntime?: Partial<Record<AgentId, (input: RuntimeChannelTestContext) => Promise<string>>>;
  deleteSessionArtifactsByRuntime?: Partial<Record<AgentId, (input: RuntimeSessionCleanupContext) => Promise<void>>>;
}

export function modelFromRuntimeConfig(runtimeConfig: RuntimeRequest["runtimeConfig"]): string {
  return runtimeConfig.model;
}

export function reasoningEffortFromRuntimeConfig(
  runtimeConfig: RuntimeRequest["runtimeConfig"],
): string | undefined {
  return typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : undefined;
}
