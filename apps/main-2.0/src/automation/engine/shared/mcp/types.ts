export type McpTransport = "stdio" | "http";

export type McpExposureMode = "indexed" | "direct";

export type McpRuntimeStatus = "idle" | "connecting" | "running" | "error";

export interface McpServerRuntimeState {
  state: McpRuntimeStatus;
  transportMode?: "stdio" | "streamable-http" | "sse";
  lastUsedAt?: number;
  lastError?: string;
}

export type McpSecretKind = "env" | "header";

export interface McpOAuthStatus {
  status: "none" | "authorized";
  scope?: string;
  updatedAt?: number;
}

export interface McpServerSecretSummary {
  /** Keys stored encrypted on this machine via safeStorage (values are never returned to the renderer). */
  envKeys: string[];
  headerKeys: string[];
  /** Host environment variable names referenced by this server that are currently unset. */
  missingHostEnvVars?: string[];
  oauth: McpOAuthStatus;
}

export interface McpSecretSetRequest {
  serverId: string;
  kind: McpSecretKind;
  key: string;
  value: string;
}

export interface McpSecretDeleteRequest {
  serverId: string;
  kind: McpSecretKind;
  key: string;
}

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
  /** Human-readable purpose shown for app-managed and user-configured servers. */
  description?: string;
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
  /**
   * Controls how tools from this custom server are exposed to MCP clients:
   * - `indexed` (default): discovered via search_tools / get_tool / call_tool
   * - `direct`: exposed directly in tools/list as `<sourceSlug>__<toolName>`
   */
  exposureMode?: McpExposureMode;
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
   * Transient in-memory connection pool state synthesized by the main process.
   * Never persisted to the database.
   */
  runtimeState?: McpServerRuntimeState;
  /**
   * Transient summary of locally encrypted secrets, OAuth status, and missing
   * host env references. Never contains plaintext secret values.
   */
  secretSummary?: McpServerSecretSummary;
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

export type McpExternalClientId =
  | "codex"
  | "claude"
  | "cursor"
  | "gemini"
  | "opencode"
  | "qwen"
  | "zcode";

export type McpClientTransportPreference = "http" | "stdio";

export interface McpHttpHubStatus {
  running: boolean;
  url: string;
  port: number;
  activeSessions: number;
  error?: string;
}

export interface McpExternalClientConnection {
  clientId: McpExternalClientId;
  label: string;
  detected: boolean;
  enabled: boolean;
  configured: boolean;
  configPath: string;
  transport: McpClientTransportPreference;
  supportsStdio: boolean;
  /** Client-specific Streamable HTTP Hub URL (`/mcp/<clientId>`). */
  hubUrl?: string;
  /** Undefined means all enabled sources are visible; array restricts visibility to listed server IDs. */
  allowedServerIds?: string[];
  error?: string;
}

export interface McpExternalClientConnections {
  clients: McpExternalClientConnection[];
  hub?: McpHttpHubStatus;
}

export interface McpExternalClientUpdate {
  clientId: McpExternalClientId;
  enabled: boolean;
  transport?: McpClientTransportPreference;
  /** Pass `null` to clear per-client source filtering and allow all enabled sources. */
  allowedServerIds?: string[] | null;
}

export interface McpGatewaySearchRequest {
  query?: string;
  sourceId?: string;
  limit?: number;
  cursor?: string;
}

export interface McpGatewayToolSummary {
  toolRef: string;
  sourceId: string;
  sourceName: string;
  name: string;
  description?: string;
}

export interface McpGatewaySearchResult {
  items: McpGatewayToolSummary[];
  nextCursor?: string;
}

export interface McpGatewayToolDetail extends McpGatewayToolSummary {
  inputSchema: Record<string, unknown>;
}

export interface McpGatewayGetRequest {
  toolRef: string;
}

export interface McpGatewayCallRequest extends McpGatewayGetRequest {
  arguments?: Record<string, unknown>;
}
