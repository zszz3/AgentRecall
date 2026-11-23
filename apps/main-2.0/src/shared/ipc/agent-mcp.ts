import { z } from "zod";
import { defineIpcRequest } from "./contract";

export type { AgentMcpCatalog, AgentMcpLocation, AgentMcpProblem, AgentMcpServer } from "../../core/agent-mcp-servers";

const file = z.string().min(1).max(4_096);

export const AGENT_MCP_IPC = {
  list: defineIpcRequest("agent-mcp:list", z.tuple([])),
  open: defineIpcRequest("agent-mcp:open", z.tuple([file])),
  reveal: defineIpcRequest("agent-mcp:reveal", z.tuple([file])),
};
