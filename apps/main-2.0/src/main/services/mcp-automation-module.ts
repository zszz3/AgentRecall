import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  ConfiguredAgent,
  McpCallLogEntry,
  McpCallMode,
  McpHttpHubStatus,
  McpSecretDeleteRequest,
  McpSecretSetRequest,
  McpServerDefinition,
} from "../../automation/contracts";
import { redactSecrets } from "../../core/experience-extraction";
import type { ManagedMcp } from "../../automation/engine/main/mcp-builtin-server";
import {
  discoverMcpTools,
  findMissingHostEnvVars,
  invokeMcpTool,
  McpConnectionPool,
  type McpClientConnectOptions,
} from "../../automation/engine/main/mcp-client";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type {
  McpExternalClientConnections,
  McpExternalClientUpdate,
  McpGatewayCallRequest,
  McpGatewayGetRequest,
  McpGatewaySearchRequest,
  McpGatewaySearchResult,
  McpGatewayToolDetail,
  McpServerDefinition as SharedMcpServerDefinition,
  McpToolDefinition,
} from "../../automation/engine/shared/mcp/types";
import type { McpCredentialService } from "./mcp-credential-service";
import type { McpOAuthService } from "./mcp-oauth-service";

export interface McpDirectHubTool {
  exposedName: string;
  sourceId: string;
  sourceName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
}

export interface McpGatewayScopeOptions {
  allowedServerIds?: readonly string[];
  /** Calling client label recorded in MCP call logs (e.g. "claude", "cursor", "http-hub", "stdio-gateway"). */
  clientLabel?: string;
}

const MAX_MCP_CALL_LOGS = 200;
const MAX_ARGS_SUMMARY_CHARS = 512;
const MAX_ERROR_SUMMARY_CHARS = 512;
const SECRET_ARG_KEY_RE = /key|token|secret|passw(?:or)?d|auth|credential|cookie/i;

interface McpRuntimeState {
  listConfiguredAgents(): ConfiguredAgent[];
  setMcpServers(servers: McpServerDefinition[]): void;
  updateConfiguredAgents(agents: ConfiguredAgent[]): AppSnapshot;
  flushPersistence(): Promise<void>;
}

interface McpAutomationModuleDependencies {
  registry: Pick<McpRegistryStore, "list" | "upsert" | "recordTest" | "delete">;
  runtime: McpRuntimeState;
  builtins?: ManagedMcp[];
  discoverTools?: typeof discoverMcpTools;
  invokeTool?: typeof invokeMcpTool;
  pool?: McpConnectionPool;
  credentials?: McpCredentialService;
  oauth?: McpOAuthService;
  hubStatus?: () => McpHttpHubStatus | undefined;
  clients?: {
    snapshot(): McpExternalClientConnections;
    setEnabled(request: McpExternalClientUpdate): McpExternalClientConnections;
  };
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;
  private readonly invokeToolOverride?: typeof invokeMcpTool;
  private readonly pool: McpConnectionPool;
  private readonly toolsChangedListeners = new Set<() => void>();
  private readonly callLogs: McpCallLogEntry[] = [];
  private readonly callLogsListeners = new Set<(logs: McpCallLogEntry[]) => void>();

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
    this.invokeToolOverride = dependencies.invokeTool;
    this.pool = dependencies.pool ?? new McpConnectionPool();
  }

  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => this.toolsChangedListeners.delete(listener);
  }

  listCallLogs(): McpCallLogEntry[] {
    return this.callLogs.map((entry) => ({ ...entry }));
  }

  clearCallLogs(): McpCallLogEntry[] {
    this.callLogs.length = 0;
    this.emitCallLogsChanged();
    return [];
  }

  onCallLogsChanged(listener: (logs: McpCallLogEntry[]) => void): () => void {
    this.callLogsListeners.add(listener);
    return () => this.callLogsListeners.delete(listener);
  }

  async traceBuiltinToolCall<T>(
    meta: {
      sourceId: string;
      sourceName: string;
      toolName: string;
      args: unknown;
      clientLabel?: string;
    },
    execute: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await execute();
      this.appendCallLog(meta.sourceId, meta.sourceName, meta.toolName, "builtin", meta.clientLabel ?? "stdio-gateway", meta.args, startedAt, result);
      return result;
    } catch (error) {
      this.appendCallErrorLog(meta.sourceId, meta.sourceName, meta.toolName, "builtin", meta.clientLabel ?? "stdio-gateway", meta.args, startedAt, error);
      throw error;
    }
  }

  list(): Promise<McpServerDefinition[]> {
    return this.listWithBuiltin();
  }

  private async listWithBuiltin(): Promise<McpServerDefinition[]> {
    const servers = await this.dependencies.registry.list();
    const builtins = await Promise.all(
      (this.dependencies.builtins ?? []).map((builtin) => builtin.resolve()),
    );
    const merged = [...builtins, ...servers.filter((server) => !builtins.some((builtin) => builtin.id === server.id))];
    return merged.map((server) => this.withRuntimeState(server));
  }

  private withRuntimeState(server: McpServerDefinition): McpServerDefinition {
    if (!server) return server;
    const runtimeState = this.pool.getRuntimeState(server.id);
    const secretSummary = this.buildSecretSummary(server);
    if (runtimeState.state === "idle" && !secretSummary) return server;
    return {
      ...server,
      ...(runtimeState.state !== "idle" ? { runtimeState } : {}),
      ...(secretSummary ? { secretSummary } : {}),
    };
  }

  private buildSecretSummary(server: McpServerDefinition) {
    if (server.managed) return undefined;
    const stored = this.dependencies.credentials?.listSecretKeys(server.id);
    const oauth = this.dependencies.credentials?.getOAuthStatus(server.id) ?? { status: "none" as const };
    const missingHostEnvVars = findMissingHostEnvVars(server, stored);
    if (!stored && missingHostEnvVars.length === 0 && oauth.status === "none") return undefined;
    return {
      envKeys: stored?.envKeys ?? [],
      headerKeys: stored?.headerKeys ?? [],
      ...(missingHostEnvVars.length > 0 ? { missingHostEnvVars } : {}),
      oauth,
    };
  }

  private buildConnectOptions(
    server: SharedMcpServerDefinition,
    builtin?: ManagedMcp,
  ): Record<string, string> | McpClientConnectOptions | undefined {
    const literalEnv = builtin?.testEnv();
    if (literalEnv) return literalEnv;
    const storedSecrets = this.dependencies.credentials?.resolveSecrets(server.id);
    const hasStored = Boolean(
      storedSecrets
      && (Object.keys(storedSecrets.env).length > 0 || Object.keys(storedSecrets.headers).length > 0),
    );
    const oauthStatus = server.transport === "http"
      ? this.dependencies.credentials?.getOAuthStatus(server.id)
      : undefined;
    const authProvider = server.transport === "http" && oauthStatus?.status === "authorized" && this.dependencies.oauth
      ? this.dependencies.oauth.createRuntimeProvider(server.id)
      : undefined;
    if (!hasStored && !authProvider) return undefined;
    return {
      ...(hasStored ? { storedSecrets } : {}),
      ...(authProvider ? { authProvider, authRevision: String(oauthStatus?.updatedAt ?? 1) } : {}),
    };
  }

  private matchingBuiltin(serverId: string): ManagedMcp | undefined {
    return this.dependencies.builtins?.find((builtin) => builtin.isBuiltinId(serverId));
  }

  async save(server: McpServerDefinition): Promise<McpServerDefinition> {
    const builtin = this.matchingBuiltin(server.id);
    if (builtin) {
      const saved = await builtin.saveDraft(server);
      if (!saved.enabled) await this.pool.evict(saved.id);
      await this.publishRegistry();
      return this.withRuntimeState(saved);
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === server.id);
    const saved = await this.dependencies.registry.upsert(server);
    const connectionChanged = !existing || connectionSignature(existing) !== connectionSignature(saved);
    if (!saved.enabled || connectionChanged) {
      await this.pool.evict(saved.id);
    }
    let result = saved;
    if (connectionChanged) {
      try {
        const connectOptions = this.buildConnectOptions(saved);
        const tools = connectOptions
          ? await this.discoverTools(saved, connectOptions)
          : await this.discoverTools(saved);
        result = await this.dependencies.registry.recordTest(saved, tools);
      } catch (error) {
        result = await this.dependencies.registry.recordTest(
          saved,
          existing?.tools ?? saved.tools,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.publishRegistry();
    return this.withRuntimeState(result);
  }

  async test(server: McpServerDefinition): Promise<McpServerDefinition> {
    const builtin = this.matchingBuiltin(server.id);
    // Test against the fixed launch config for a built-in server, never
    // against client-supplied connection fields.
    const target = builtin ? await builtin.resolve() : server;
    const connectOptions = this.buildConnectOptions(target, builtin);
    const record = builtin
      ? (tools: McpToolDefinition[], error?: string) => builtin.recordTest(server, tools, error)
      : (tools: McpToolDefinition[], error?: string) => this.dependencies.registry.recordTest(target, tools, error);
    try {
      const tested = await record(await this.discoverTools(target, connectOptions));
      await this.publishRegistry();
      return this.withRuntimeState(tested);
    } catch (error) {
      await this.pool.evict(target.id);
      const tested = await record(target.tools, error instanceof Error ? error.message : String(error));
      await this.publishRegistry();
      return this.withRuntimeState(tested);
    }
  }

  async restart(serverId: string): Promise<McpServerDefinition> {
    await this.pool.evict(serverId);
    const server = (await this.listWithBuiltin()).find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`MCP server was not found: ${serverId}`);
    }
    return this.test(server);
  }

  async setSecret(request: McpSecretSetRequest): Promise<McpServerDefinition> {
    if (!this.dependencies.credentials) {
      throw new Error("MCP encrypted secret storage is unavailable.");
    }
    if (this.matchingBuiltin(request.serverId)) {
      throw new Error("Built-in MCP servers do not accept custom secrets.");
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === request.serverId);
    if (!existing) throw new Error(`MCP server was not found: ${request.serverId}`);
    this.dependencies.credentials.setSecret(request.serverId, request.kind, request.key, request.value);
    await this.pool.evict(request.serverId);
    await this.publishRegistry();
    return this.withRuntimeState(existing);
  }

  async deleteSecret(request: McpSecretDeleteRequest): Promise<McpServerDefinition> {
    if (!this.dependencies.credentials) {
      throw new Error("MCP encrypted secret storage is unavailable.");
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === request.serverId);
    if (!existing) throw new Error(`MCP server was not found: ${request.serverId}`);
    this.dependencies.credentials.deleteSecret(request.serverId, request.kind, request.key);
    await this.pool.evict(request.serverId);
    await this.publishRegistry();
    return this.withRuntimeState(existing);
  }

  async authorizeOAuth(serverId: string): Promise<McpServerDefinition> {
    if (!this.dependencies.oauth) {
      throw new Error("MCP OAuth authorization is unavailable.");
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === serverId);
    if (!existing) throw new Error(`MCP server was not found: ${serverId}`);
    if (existing.transport !== "http" || !existing.url?.trim()) {
      throw new Error("OAuth authorization is only supported for HTTP MCP servers with a configured URL.");
    }
    await this.dependencies.oauth.authorizeServer(serverId, existing.url);
    await this.pool.evict(serverId);
    return this.test(existing);
  }

  async revokeOAuth(serverId: string): Promise<McpServerDefinition> {
    if (!this.dependencies.oauth) {
      throw new Error("MCP OAuth authorization is unavailable.");
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === serverId);
    if (!existing) throw new Error(`MCP server was not found: ${serverId}`);
    this.dependencies.oauth.revokeServer(serverId);
    await this.pool.evict(serverId);
    await this.publishRegistry();
    return this.withRuntimeState(existing);
  }

  async delete(serverId: string): Promise<boolean> {
    if (this.matchingBuiltin(serverId)) {
      throw new Error("The built-in MCP server cannot be deleted. Disable it instead.");
    }
    await this.pool.evict(serverId);
    this.dependencies.oauth?.revokeServer(serverId);
    this.dependencies.credentials?.deleteAllForServer(serverId);
    const deleted = await this.dependencies.registry.delete(serverId);
    if (!deleted) return false;

    await this.publishRegistry();
    const agents = this.dependencies.runtime.listConfiguredAgents().map((agent) => ({
      ...agent,
      ...(agent.mcpBindings
        ? {
            mcpBindings: agent.mcpBindings.filter(
              (binding) => binding.serverId !== serverId,
            ),
          }
        : {}),
    }));
    this.dependencies.runtime.updateConfiguredAgents(agents);
    await this.dependencies.runtime.flushPersistence();
    return true;
  }

  async close(): Promise<void> {
    this.toolsChangedListeners.clear();
    this.callLogsListeners.clear();
    this.dependencies.oauth?.shutdown();
    await this.pool.closeAll();
  }

  clientConnections(): McpExternalClientConnections {
    const base = this.dependencies.clients?.snapshot() ?? { clients: [] };
    const hub = this.dependencies.hubStatus?.();
    return hub ? { ...base, hub } : base;
  }

  setClientConnection(request: McpExternalClientUpdate): McpExternalClientConnections {
    if (!this.dependencies.clients) throw new Error("MCP client connection management is unavailable.");
    const next = this.dependencies.clients.setEnabled(request);
    if (request.allowedServerIds !== undefined) {
      this.emitToolsChanged();
    }
    const hub = this.dependencies.hubStatus?.();
    return hub ? { ...next, hub } : next;
  }

  async searchGatewayTools(
    request: McpGatewaySearchRequest,
    scope?: McpGatewayScopeOptions,
  ): Promise<McpGatewaySearchResult> {
    const entries = await this.gatewayEntries(scope);
    const scoped = request.sourceId
      ? entries.filter((entry) => entry.server.id === request.sourceId)
      : entries;
    const query = request.query?.trim();
    const filtered = query ? rankGatewayToolsByQuery(scoped, query) : scoped;
    const offset = parseCursor(request.cursor);
    const limit = Math.max(1, Math.min(50, Math.floor(request.limit ?? 20)));
    const page = filtered.slice(offset, offset + limit);
    return {
      items: page.map(({ server, tool }) => ({
        toolRef: toolRefFor(server.id, tool.name),
        sourceId: server.id,
        sourceName: server.name,
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      })),
      ...(offset + page.length < filtered.length ? { nextCursor: String(offset + page.length) } : {}),
    };
  }

  async getGatewayTool(
    request: McpGatewayGetRequest,
    scope?: McpGatewayScopeOptions,
  ): Promise<McpGatewayToolDetail> {
    const entry = (await this.gatewayEntries(scope)).find(
      ({ server, tool }) => toolRefFor(server.id, tool.name) === request.toolRef,
    );
    if (!entry) throw new Error(`MCP tool is unavailable or disabled: ${request.toolRef}`);
    return {
      toolRef: request.toolRef,
      sourceId: entry.server.id,
      sourceName: entry.server.name,
      name: entry.tool.name,
      ...(entry.tool.description ? { description: entry.tool.description } : {}),
      inputSchema: entry.tool.inputSchema,
    };
  }

  async callGatewayTool(
    request: McpGatewayCallRequest,
    scope?: McpGatewayScopeOptions,
  ): Promise<unknown> {
    const entry = (await this.gatewayEntries(scope)).find(
      ({ server, tool }) => toolRefFor(server.id, tool.name) === request.toolRef,
    );
    if (!entry) throw new Error(`MCP tool is unavailable or disabled: ${request.toolRef}`);
    return this.invokeServerTool(
      entry.server,
      entry.tool.name,
      request.arguments ?? {},
      "indexed",
      scope?.clientLabel ?? "stdio-gateway",
    );
  }

  async listDirectHubTools(scope?: McpGatewayScopeOptions): Promise<McpDirectHubTool[]> {
    const directEntries = await this.directHubEntries(scope);
    return directEntries.map(({ exposedName, server, tool }) => ({
      exposedName,
      sourceId: server.id,
      sourceName: server.name,
      toolName: tool.name,
      description: tool.description ? `[${server.name}] ${tool.description}` : `[${server.name}] ${tool.name}`,
      inputSchema: tool.inputSchema,
      ...(tool.readOnly ? { readOnly: true } : {}),
    }));
  }

  async callDirectHubTool(
    exposedName: string,
    args: Record<string, unknown>,
    scope?: McpGatewayScopeOptions,
  ): Promise<unknown> {
    const match = (await this.directHubEntries(scope)).find((entry) => entry.exposedName === exposedName);
    if (!match) {
      throw new Error(`MCP direct tool is unavailable or disabled: ${exposedName}`);
    }
    return this.invokeServerTool(
      match.server,
      match.tool.name,
      args,
      "direct",
      scope?.clientLabel ?? "http-hub",
    );
  }

  async assertGatewayDirectToolEnabled(
    sourceId: string,
    toolName: string,
    scope?: McpGatewayScopeOptions,
  ): Promise<void> {
    if (scope?.allowedServerIds && !scope.allowedServerIds.includes(sourceId)) {
      throw new Error(`MCP tool is unavailable or disabled: ${toolRefFor(sourceId, toolName)}`);
    }
    const source = (await this.listWithBuiltin()).find((server) => server.id === sourceId);
    if (!source?.enabled || source.disabledTools?.includes(toolName)) {
      throw new Error(`MCP tool is unavailable or disabled: ${toolRefFor(sourceId, toolName)}`);
    }
  }

  async isGatewayDirectToolEnabled(
    sourceId: string,
    toolName: string,
    scope?: McpGatewayScopeOptions,
  ): Promise<boolean> {
    try {
      await this.assertGatewayDirectToolEnabled(sourceId, toolName, scope);
      return true;
    } catch {
      return false;
    }
  }

  private async invokeServerTool(
    server: SharedMcpServerDefinition,
    toolName: string,
    args: Record<string, unknown>,
    mode: McpCallMode,
    clientLabel: string,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const builtin = this.matchingBuiltin(server.id);
    const connectOptions = this.buildConnectOptions(server, builtin);
    try {
      const result = this.invokeToolOverride
        ? await this.invokeToolOverride(server, toolName, args, connectOptions)
        : await this.pool.invokeTool(server, toolName, args, connectOptions);
      this.appendCallLog(server.id, server.name, toolName, mode, clientLabel, args, startedAt, result);
      return result;
    } catch (error) {
      this.appendCallErrorLog(server.id, server.name, toolName, mode, clientLabel, args, startedAt, error);
      throw error;
    }
  }

  private appendCallLog(
    sourceId: string,
    sourceName: string,
    toolName: string,
    mode: McpCallMode,
    client: string,
    args: unknown,
    startedAt: number,
    result: unknown,
  ): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const { isError, errorText, responseBytes } = inspectToolResult(result);
    this.pushCallLog({
      id: randomUUID(),
      startedAt,
      durationMs,
      client,
      mode,
      sourceId,
      sourceName,
      toolName,
      argsSummary: summarizeCallArgs(args),
      status: isError ? "error" : "ok",
      ...(responseBytes !== undefined ? { responseBytes } : {}),
      ...(errorText ? { error: errorText } : {}),
    });
  }

  private appendCallErrorLog(
    sourceId: string,
    sourceName: string,
    toolName: string,
    mode: McpCallMode,
    client: string,
    args: unknown,
    startedAt: number,
    error: unknown,
  ): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const raw = error instanceof Error ? error.message : String(error);
    this.pushCallLog({
      id: randomUUID(),
      startedAt,
      durationMs,
      client,
      mode,
      sourceId,
      sourceName,
      toolName,
      argsSummary: summarizeCallArgs(args),
      status: "error",
      error: redactSecrets(raw).slice(0, MAX_ERROR_SUMMARY_CHARS),
    });
  }

  private pushCallLog(entry: McpCallLogEntry): void {
    this.callLogs.unshift(entry);
    if (this.callLogs.length > MAX_MCP_CALL_LOGS) {
      this.callLogs.length = MAX_MCP_CALL_LOGS;
    }
    this.emitCallLogsChanged();
  }

  private emitCallLogsChanged(): void {
    if (this.callLogsListeners.size === 0) return;
    const snapshot = this.listCallLogs();
    for (const listener of this.callLogsListeners) {
      try {
        listener(snapshot);
      } catch {
        // Observability listeners must never fail tool execution.
      }
    }
  }

  private async publishRegistry(): Promise<void> {
    this.dependencies.runtime.setMcpServers(await this.listWithBuiltin());
    this.emitToolsChanged();
  }

  private emitToolsChanged(): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener();
      } catch {
        // Notification listeners are best-effort; registry updates still succeed.
      }
    }
  }

  private async gatewayEntries(
    scope?: McpGatewayScopeOptions,
  ): Promise<Array<{ server: SharedMcpServerDefinition; tool: McpToolDefinition }>> {
    const allowed = scope?.allowedServerIds ? new Set(scope.allowedServerIds) : null;
    const servers = await this.listWithBuiltin();
    return servers.flatMap((server) => {
      if (!server.enabled) return [];
      if (allowed && !allowed.has(server.id)) return [];
      if (server.exposureMode === "direct") return [];
      const disabled = new Set(server.disabledTools ?? []);
      return server.tools
        .filter((tool) => !disabled.has(tool.name) && !isDirectGatewayTool(server.id, tool.name))
        .map((tool) => ({ server, tool }));
    });
  }

  private async directHubEntries(
    scope?: McpGatewayScopeOptions,
  ): Promise<Array<{ exposedName: string; server: SharedMcpServerDefinition; tool: McpToolDefinition }>> {
    const allowed = scope?.allowedServerIds ? new Set(scope.allowedServerIds) : null;
    const servers = await this.listWithBuiltin();
    const usedSlugs = new Set<string>();
    const results: Array<{ exposedName: string; server: SharedMcpServerDefinition; tool: McpToolDefinition }> = [];

    for (const server of servers) {
      if (!server.enabled || server.managed || server.exposureMode !== "direct") continue;
      if (allowed && !allowed.has(server.id)) continue;
      const slug = uniqueServerSlug(server, usedSlugs);
      const disabled = new Set(server.disabledTools ?? []);
      for (const tool of server.tools) {
        if (disabled.has(tool.name)) continue;
        const safeTool = sanitizeIdentifier(tool.name, "tool");
        results.push({
          exposedName: `${slug}__${safeTool}`,
          server,
          tool,
        });
      }
    }
    return results;
  }
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function uniqueServerSlug(server: SharedMcpServerDefinition, used: Set<string>): string {
  const base = sanitizeIdentifier(server.name || server.id, sanitizeIdentifier(server.id, "mcp")).slice(0, 32);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function redactArgValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactArgValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = SECRET_ARG_KEY_RE.test(key) ? "[redacted]" : redactArgValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function summarizeCallArgs(args: unknown): string {
  if (!args || (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0)) {
    return "{}";
  }
  try {
    const serialized = JSON.stringify(redactArgValue(args));
    return serialized.length > MAX_ARGS_SUMMARY_CHARS
      ? `${serialized.slice(0, MAX_ARGS_SUMMARY_CHARS - 1)}…`
      : serialized;
  } catch {
    return "{}";
  }
}

function inspectToolResult(result: unknown): {
  isError: boolean;
  errorText?: string;
  responseBytes?: number;
} {
  let responseBytes: number | undefined;
  try {
    responseBytes = Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
  } catch {
    responseBytes = undefined;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as { isError?: unknown; content?: unknown; ok?: unknown; error?: unknown };
    if (record.isError === true) {
      const firstText = Array.isArray(record.content)
        ? record.content
            .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
              ? (item as { text: string }).text
              : ""))
            .filter(Boolean)
            .join(" ")
        : "";
      return {
        isError: true,
        errorText: redactSecrets(firstText || "Tool returned isError=true").slice(0, MAX_ERROR_SUMMARY_CHARS),
        responseBytes,
      };
    }
    if (record.ok === false && typeof record.error === "string") {
      return {
        isError: true,
        errorText: redactSecrets(record.error).slice(0, MAX_ERROR_SUMMARY_CHARS),
        responseBytes,
      };
    }
  }
  return { isError: false, responseBytes };
}

function rankGatewayToolsByQuery(
  entries: Array<{ server: SharedMcpServerDefinition; tool: McpToolDefinition }>,
  rawQuery: string,
): Array<{ server: SharedMcpServerDefinition; tool: McpToolDefinition }> {
  const normalizedQuery = rawQuery.toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return entries;

  const scored: Array<{
    entry: { server: SharedMcpServerDefinition; tool: McpToolDefinition };
    score: number;
    index: number;
  }> = [];

  for (const [index, entry] of entries.entries()) {
    const toolName = entry.tool.name.toLowerCase();
    const toolSegments = toolName.split(/[_\-./]+/).filter(Boolean);
    const sourceName = entry.server.name.toLowerCase();
    const sourceId = entry.server.id.toLowerCase();
    const description = (entry.tool.description ?? "").toLowerCase();

    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let tokenScore = 0;
      if (toolName === token) tokenScore = Math.max(tokenScore, 40);
      else if (toolSegments.some((segment) => segment === token)) tokenScore = Math.max(tokenScore, 30);
      else if (toolSegments.some((segment) => segment.startsWith(token))) tokenScore = Math.max(tokenScore, 24);
      else if (toolName.includes(token)) tokenScore = Math.max(tokenScore, 20);

      if (sourceName.includes(token) || sourceId.includes(token)) {
        tokenScore = Math.max(tokenScore, 10);
      }
      if (description.includes(token)) {
        tokenScore = Math.max(tokenScore, 5);
      }

      if (tokenScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokenScore;
    }

    if (!matchedAll) continue;
    if (toolName === normalizedQuery) score += 100;
    else if (toolName.startsWith(normalizedQuery)) score += 60;
    else if (toolName.includes(normalizedQuery)) score += 40;
    scored.push({ entry, score, index });
  }

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.map((item) => item.entry);
}

function isDirectGatewayTool(serverId: string, toolName: string): boolean {
  return (serverId === "agent-recall-session-search" && (toolName === "search_sessions" || toolName === "get_session"))
    || (serverId === "agent-recall-skills" && (toolName === "list_skills" || toolName === "get_skill"));
}

function toolRefFor(serverId: string, toolName: string): string {
  return `${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}`;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("MCP tool cursor is invalid.");
  return value;
}

function connectionSignature(server: McpServerDefinition): string {
  return JSON.stringify({
    transport: server.transport,
    command: server.command ?? "",
    args: server.args,
    url: server.url ?? "",
    env: sortedRecord(server.env),
    headers: sortedRecord(server.headers ?? {}),
  });
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
