import type { IpcMain } from "electron";
import type { McpServerDefinition } from "../../shared/mcp/types";
import { discoverMcpTools } from "../mcp-client";
import type { McpRegistryStore } from "../mcp-registry-store";
import type { McpInstallRequest } from "../../shared/mcp-config";
import type { McpAgentManagementService } from "./agent-management-service";

export function registerMcpRegistryIpc(ipc: Pick<IpcMain, "handle">, store: McpRegistryStore, agents: McpAgentManagementService): void {
  ipc.handle("mcp:list", () => store.list());
  ipc.handle("mcp:upsert", (_event, server: McpServerDefinition) => store.upsert(server));
  ipc.handle("mcp:delete", (_event, serverId: string) => store.delete(serverId));
  ipc.handle("mcp:test", async (_event, server: McpServerDefinition) => {
    try { return await store.recordTest(server, await discoverMcpTools(server)); }
    catch (error) { return store.recordTest(server, [], error instanceof Error ? error.message : String(error)); }
  });
  ipc.handle("mcp:setup-status", () => agents.status());
  ipc.handle("mcp:installed:list", () => agents.listInstalled());
  ipc.handle("mcp:agent:list", (_event, agentId: string) => agents.listForAgent(agentId));
  ipc.handle("mcp:agent:install", (_event, request: McpInstallRequest) => agents.install(request));
  ipc.handle("mcp:agent:uninstall", (_event, request: McpInstallRequest) => agents.uninstall(request));
}
