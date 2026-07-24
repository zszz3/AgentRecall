import type { AppSnapshot, ConfiguredAgent, McpServerDefinition } from "../../automation/contracts";
import { discoverMcpTools } from "../../automation/engine/main/mcp-client";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";

interface McpRuntimeState {
  listConfiguredAgents(): ConfiguredAgent[];
  setMcpServers(servers: McpServerDefinition[]): void;
  updateConfiguredAgents(agents: ConfiguredAgent[]): AppSnapshot;
}

interface McpAutomationModuleDependencies {
  registry: Pick<McpRegistryStore, "list" | "upsert" | "recordTest" | "delete">;
  agents: Pick<McpAgentManagementService, "status" | "listInstalled" | "listForAgent" | "install" | "uninstall">;
  runtime: McpRuntimeState;
  discoverTools?: typeof discoverMcpTools;
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
  }

  list(): Promise<McpServerDefinition[]> {
    return this.dependencies.registry.list();
  }

  async save(server: McpServerDefinition): Promise<McpServerDefinition> {
    const saved = await this.dependencies.registry.upsert(server);
    await this.publishRegistry();
    return saved;
  }

  async test(server: McpServerDefinition): Promise<McpServerDefinition> {
    try {
      const tested = await this.dependencies.registry.recordTest(
        server,
        await this.discoverTools(server),
      );
      await this.publishRegistry();
      return tested;
    } catch (error) {
      const tested = await this.dependencies.registry.recordTest(
        server,
        [],
        error instanceof Error ? error.message : String(error),
      );
      await this.publishRegistry();
      return tested;
    }
  }

  async delete(serverId: string): Promise<boolean> {
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

  private async publishRegistry(): Promise<void> {
    this.dependencies.runtime.setMcpServers(await this.dependencies.registry.list());
  }
}
