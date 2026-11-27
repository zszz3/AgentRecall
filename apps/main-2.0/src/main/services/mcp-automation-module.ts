import type { AppSnapshot, ConfiguredAgent, McpServerDefinition } from "../../automation/contracts";
import type { ManagedMcp } from "../../automation/engine/main/mcp-builtin-server";
import { discoverMcpTools, invokeMcpTool, McpConnectionPool } from "../../automation/engine/main/mcp-client";
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
  clients?: {
    snapshot(): McpExternalClientConnections;
    setEnabled(request: McpExternalClientUpdate): McpExternalClientConnections;
  };
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;
  private readonly invokeToolOverride?: typeof invokeMcpTool;
  private readonly pool: McpConnectionPool;

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
    this.invokeToolOverride = dependencies.invokeTool;
    this.pool = dependencies.pool ?? new McpConnectionPool();
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
    if (runtimeState.state === "idle") return server;
    return { ...server, runtimeState };
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
        result = await this.dependencies.registry.recordTest(saved, await this.discoverTools(saved));
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
    const literalEnv = builtin?.testEnv();
    const record = builtin
      ? (tools: McpToolDefinition[], error?: string) => builtin.recordTest(server, tools, error)
      : (tools: McpToolDefinition[], error?: string) => this.dependencies.registry.recordTest(target, tools, error);
    try {
      const tested = await record(await this.discoverTools(target, literalEnv));
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

  async delete(serverId: string): Promise<boolean> {
    if (this.matchingBuiltin(serverId)) {
      throw new Error("The built-in MCP server cannot be deleted. Disable it instead.");
    }
    await this.pool.evict(serverId);
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
    await this.pool.closeAll();
  }

  clientConnections(): McpExternalClientConnections {
    return this.dependencies.clients?.snapshot() ?? { clients: [] };
  }

  setClientConnection(request: McpExternalClientUpdate): McpExternalClientConnections {
    if (!this.dependencies.clients) throw new Error("MCP client connection management is unavailable.");
    return this.dependencies.clients.setEnabled(request);
  }

  async searchGatewayTools(request: McpGatewaySearchRequest): Promise<McpGatewaySearchResult> {
    const entries = await this.gatewayEntries();
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

  async getGatewayTool(request: McpGatewayGetRequest): Promise<McpGatewayToolDetail> {
    const entry = (await this.gatewayEntries()).find(
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

  async callGatewayTool(request: McpGatewayCallRequest): Promise<unknown> {
    const entry = (await this.gatewayEntries()).find(
      ({ server, tool }) => toolRefFor(server.id, tool.name) === request.toolRef,
    );
    if (!entry) throw new Error(`MCP tool is unavailable or disabled: ${request.toolRef}`);
    const builtin = this.matchingBuiltin(entry.server.id);
    if (this.invokeToolOverride) {
      return this.invokeToolOverride(entry.server, entry.tool.name, request.arguments ?? {}, builtin?.testEnv());
    }
    return this.pool.invokeTool(entry.server, entry.tool.name, request.arguments ?? {}, builtin?.testEnv());
  }

  async assertGatewayDirectToolEnabled(sourceId: string, toolName: string): Promise<void> {
    const source = (await this.listWithBuiltin()).find((server) => server.id === sourceId);
    if (!source?.enabled || source.disabledTools?.includes(toolName)) {
      throw new Error(`MCP tool is unavailable or disabled: ${toolRefFor(sourceId, toolName)}`);
    }
  }

  private async publishRegistry(): Promise<void> {
    this.dependencies.runtime.setMcpServers(await this.listWithBuiltin());
  }

  private async gatewayEntries(): Promise<Array<{ server: SharedMcpServerDefinition; tool: McpToolDefinition }>> {
    const servers = await this.listWithBuiltin();
    return servers.flatMap((server) => {
      if (!server.enabled) return [];
      const disabled = new Set(server.disabledTools ?? []);
      return server.tools
        .filter((tool) => !disabled.has(tool.name) && !isDirectGatewayTool(server.id, tool.name))
        .map((tool) => ({ server, tool }));
    });
  }
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
