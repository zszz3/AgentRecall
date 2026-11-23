import type { AgentMcpCatalogService } from "../services/agent-mcp-catalog-service";
import { AGENT_MCP_IPC } from "../../shared/ipc/agent-mcp";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export function registerAgentMcpIpc(ipc: IpcMainRegistrar, service: AgentMcpCatalogService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, AGENT_MCP_IPC.list, () => service.list()),
    registerIpcHandler(ipc, AGENT_MCP_IPC.open, (_event, file) => service.open(file)),
    registerIpcHandler(ipc, AGENT_MCP_IPC.reveal, (_event, file) => service.reveal(file)),
  ]);
}
