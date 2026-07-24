import type {
  AgentChannel,
  AgentEvent,
  AgentId,
  AgentRuntime,
  RuntimeRequest,
  WorkflowAgentResponse,
} from "../../../../shared/types";
import type {
  RuntimeChannelTestContext,
  RuntimeSessionCleanupContext,
  RuntimeWorkflowRequestContext,
} from "../../../agents/runtime/runtime-driver";
import type { RuntimeApprovalRequester } from "../../../approvals/runtime-approval-broker";
import type { BoundMcpServer } from "./runtime-mcp";

export interface AgentExecutionContext extends RuntimeRequest {
  runId: string;
  runKind: "chat" | "task";
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
  workflowMcpDiscoveryPath?: () => string | undefined;
  workflowMcpManagedToken?: () => string | undefined;
  mcpServersForAgent?: (configuredAgentId: string) => BoundMcpServer[];
  requestApproval?: RuntimeApprovalRequester;
  askWorkflowByRuntime?: Partial<Record<AgentId, (input: RuntimeWorkflowRequestContext) => Promise<WorkflowAgentResponse>>>;
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
