import { workflowMcpLaunchConfig } from "../workflow/workflow-mcp-launch";

export function codexWorkflowMcpArgs(discoveryPath: string | undefined, workflowId: string | undefined, runId?: string, nodeId?: string): string[] {
  const config = workflowMcpLaunchConfig(discoveryPath, workflowId, { runId, nodeId });
  if (!config) return [];
  return [
    "-c", `mcp_servers.agent_recall.command=${JSON.stringify(config.command)}`,
    "-c", `mcp_servers.agent_recall.args=[${config.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "-c", `mcp_servers.agent_recall.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE=${JSON.stringify(config.env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE)}`,
    "-c", `mcp_servers.agent_recall.env.AGENT_RECALL_WORKFLOW_ID=${JSON.stringify(config.env.AGENT_RECALL_WORKFLOW_ID)}`,
    "-c", `mcp_servers.agent_recall.env.ELECTRON_RUN_AS_NODE=${JSON.stringify(config.env.ELECTRON_RUN_AS_NODE)}`,
  ];
}
