export type McpTransport = "stdio" | "http";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** True only when the MCP server explicitly declares readOnlyHint. */
  readOnly?: boolean;
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  /**
   * HTTP request headers sent to `http` transport servers. Values are host
   * environment variable names resolved at launch time, mirroring `env`, so
   * secrets such as Authorization tokens are never stored in the database.
   */
  headers?: Record<string, string>;
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
  /**
   * True for app-managed servers that are synthesized from app settings rather
   * than stored in the user MCP registry (e.g. the session-search MCP that is
   * registered into Claude Code / Codex configs). Managed servers are read-only
   * except for enable state and per-tool toggles.
   */
  managed?: boolean;
  /**
   * False hides this managed server from per-Agent hub bindings. Set when a
   * server's launch config requires literal env values that do not fit the
   * registry env model (values are resolved as host environment variable names).
   */
  hubBindable?: boolean;
}

export interface AgentMcpBinding {
  serverId: string;
  toolAllowlist: string[];
}
