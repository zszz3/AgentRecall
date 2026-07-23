import { workflowMcpLaunchConfig } from "../workflow/workflow-mcp-launch";

export interface CodexWorkflowMcpConfig {
  args: string[];
  env: Record<string, string>;
}

export function codexWorkflowMcpConfig(discoveryPath: string | undefined, workflowId: string | undefined, runId?: string, nodeId?: string, managedToken?: string): CodexWorkflowMcpConfig {
  const config = workflowMcpLaunchConfig(discoveryPath, workflowId, { runId, nodeId, managedToken });
  if (!config) return { args: [], env: {} };
  const envNames = Object.keys(config.env);
  return {
    args: [
    "-c", `mcp_servers.agent_recall.command=${JSON.stringify(config.command)}`,
    "-c", `mcp_servers.agent_recall.args=[${config.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      "-c", `mcp_servers.agent_recall.env_vars=[${envNames.map((name) => JSON.stringify(name)).join(", ")}]`,
    ],
    env: config.env,
  };
}

export function codexWorkflowMcpArgs(discoveryPath: string | undefined, workflowId: string | undefined, runId?: string, nodeId?: string, managedToken?: string): string[] {
  return codexWorkflowMcpConfig(discoveryPath, workflowId, runId, nodeId, managedToken).args;
}
