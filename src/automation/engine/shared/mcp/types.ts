export type McpTransport = "stdio" | "http";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  enabled: boolean;
  tools: McpToolDefinition[];
  status: "untested" | "connected" | "error";
  lastError?: string;
  lastTestedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMcpBinding {
  serverId: string;
  toolAllowlist: string[];
}
