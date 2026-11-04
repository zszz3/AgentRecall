import type { AppSnapshot, ConfiguredAgent, McpServerDefinition } from "../../automation/contracts";
import type { ManagedMcp } from "../../automation/engine/main/mcp-builtin-server";
import { discoverMcpTools, invokeMcpTool } from "../../automation/engine/main/mcp-client";
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
  clients?: {
    snapshot(): McpExternalClientConnections;
    setEnabled(request: McpExternalClientUpdate): McpExternalClientConnections;
  };
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;
  private readonly invokeTool: typeof invokeMcpTool;

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
    this.invokeTool = dependencies.invokeTool ?? invokeMcpTool;
  }

  list(): Promise<McpServerDefinition[]> {
    return this.listWithBuiltin();
  }

  private async listWithBuiltin(): Promise<McpServerDefinition[]> {
    const servers = await this.dependencies.registry.list();
    const builtins = await Promise.all(
      (this.dependencies.builtins ?? []).map((builtin) => builtin.resolve()),
    );
    return [...builtins, ...servers.filter((server) => !builtins.some((builtin) => builtin.id === server.id))];
  }

  private matchingBuiltin(serverId: string): ManagedMcp | undefined {
    return this.dependencies.builtins?.find((builtin) => builtin.isBuiltinId(serverId));
  }

  async save(server: McpServerDefinition): Promise<McpServerDefinition> {
    const builtin = this.matchingBuiltin(server.id);
    if (builtin) {
      const saved = await builtin.saveDraft(server);
      await this.publishRegistry();
      return saved;
    }
    const existing = (await this.dependencies.registry.list()).find((item) => item.id === server.id);
    const saved = await this.dependencies.registry.upsert(server);
    let result = saved;
    if (!existing || connectionSignature(existing) !== connectionSignature(saved)) {
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
    return result;
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
      return tested;
    } catch (error) {
      const tested = await record(target.tools, error instanceof Error ? error.message : String(error));
      await this.publishRegistry();
      return tested;
    }
  }

  async delete(serverId: string): Promise<boolean> {
    if (this.matchingBuiltin(serverId)) {
      throw new Error("The built-in MCP server cannot be deleted. Disable it instead.");
    }
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

  clientConnections(): McpExternalClientConnections {
    return this.dependencies.clients?.snapshot() ?? { clients: [] };
  }

  setClientConnection(request: McpExternalClientUpdate): McpExternalClientConnections {
    if (!this.dependencies.clients) throw new Error("MCP client connection management is unavailable.");
    return this.dependencies.clients.setEnabled(request);
  }

  async searchGatewayTools(request: McpGatewaySearchRequest): Promise<McpGatewaySearchResult> {
    const entries = await this.gatewayEntries();
    const filtered = request.sourceId
      ? entries.filter((entry) => entry.server.id === request.sourceId)
      : entries;
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
    return this.invokeTool(entry.server, entry.tool.name, request.arguments ?? {}, builtin?.testEnv());
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
