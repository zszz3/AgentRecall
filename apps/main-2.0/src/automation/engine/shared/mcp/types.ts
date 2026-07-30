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
  /**
   * Names of tools that are disabled on this server. Disabled tools are hidden
   * from Agents at runtime. Absent or empty means every discovered tool is enabled.
   */
  disabledTools?: string[];
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
