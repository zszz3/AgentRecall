import type { IpcRenderer } from "electron";
import { AGENT_MCP_IPC, type AgentMcpCatalog } from "../shared/ipc/agent-mcp";

export function createAgentMcpApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    listAgentMcpServers: (): Promise<AgentMcpCatalog> => ipc.invoke(AGENT_MCP_IPC.list.channel),
    openAgentMcpFile: (file: string): Promise<void> => ipc.invoke(AGENT_MCP_IPC.open.channel, file),
    revealAgentMcpFile: (file: string): Promise<void> => ipc.invoke(AGENT_MCP_IPC.reveal.channel, file),
  };
}
