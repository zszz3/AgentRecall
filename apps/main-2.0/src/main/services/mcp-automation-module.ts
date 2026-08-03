import type { AppSnapshot, ConfiguredAgent, McpServerDefinition } from "../../automation/contracts";
import type { ManagedMcp } from "../../automation/engine/main/mcp-builtin-server";
import { discoverMcpTools } from "../../automation/engine/main/mcp-client";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";
import type { McpToolDefinition } from "../../automation/engine/shared/mcp/types";

interface McpRuntimeState {
  listConfiguredAgents(): ConfiguredAgent[];
  setMcpServers(servers: McpServerDefinition[]): void;
  updateConfiguredAgents(agents: ConfiguredAgent[]): AppSnapshot;
}

interface McpAutomationModuleDependencies {
  registry: Pick<McpRegistryStore, "list" | "upsert" | "recordTest" | "delete">;
  agents: Pick<McpAgentManagementService, "status" | "listInstalled" | "listForAgent" | "install" | "uninstall">;
  runtime: McpRuntimeState;
  builtins?: ManagedMcp[];
  discoverTools?: typeof discoverMcpTools;
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
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
    const saved = await this.dependencies.registry.upsert(server);
    await this.publishRegistry();
    return saved;
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
      const tested = await record([], error instanceof Error ? error.message : String(error));
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
    return true;
  }

  setupStatus(): ReturnType<McpAgentManagementService["status"]> {
    return this.dependencies.agents.status();
  }

  listInstalled(): ReturnType<McpAgentManagementService["listInstalled"]> {
    return this.dependencies.agents.listInstalled();
  }

  listForAgent(agentId: string): ReturnType<McpAgentManagementService["listForAgent"]> {
    return this.dependencies.agents.listForAgent(agentId);
  }

  install(request: McpInstallRequest): ReturnType<McpAgentManagementService["install"]> {
    return this.dependencies.agents.install(request);
  }

  uninstall(request: McpInstallRequest): ReturnType<McpAgentManagementService["uninstall"]> {
    return this.dependencies.agents.uninstall(request);
  }

  /**
   * Enables or disables the built-in workflow MCP through its Settings-backed
   * toggle. Used by the Settings dialog IPC; the MCP page drives the same
   * toggle through save().
   */
  async setWorkflowEnabled(next: boolean): Promise<boolean> {
    const workflow = this.dependencies.builtins?.find(
      (builtin) => builtin.isBuiltinId("agent-recall-workflow"),
    );
    if (!workflow) return next;
    const saved = await workflow.saveDraft({
      ...(await workflow.resolve()),
      enabled: next,
    });
    await this.publishRegistry();
    return saved.enabled;
  }

  private async publishRegistry(): Promise<void> {
    this.dependencies.runtime.setMcpServers(await this.listWithBuiltin());
  }
}
