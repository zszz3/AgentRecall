import type { RuntimeId } from "../runtime-catalog";
import type { AgentMcpBinding } from "../mcp/types";

export type AgentType = "execution" | "composed";

export interface ConfiguredAgent {
  id: string;
  agentType?: AgentType;
  name: string;
  description: string;
  instructions?: string;
  baseAgentId?: string;
  mcpBindings?: AgentMcpBinding[];
  runtimeAgentId: RuntimeId;
  channelId: string;
  modelId: string;
  reasoningEffort?: string;
  tags: string[];
  currentRevisionId?: string;
  revision?: number;
  managed?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRevision {
  id: string;
  agentId: string;
  agentType: AgentType;
  revision: number;
  baseAgentId?: string;
  runtimeAgentId: RuntimeId;
  channelId: string;
  modelId: string;
  reasoningEffort?: string;
  instructions: string;
  mcpBindings: AgentMcpBinding[];
  configHash: string;
  createdAt: number;
}
