import { workflowMcpLaunchConfig, type WorkflowMcpBinding } from "../workflow/workflow-mcp-launch";

export interface CodexWorkflowMcpConfig {
  args: string[];
  env: Record<string, string>;
}

export function codexWorkflowMcpConfig(binding: WorkflowMcpBinding): CodexWorkflowMcpConfig {
  const config = workflowMcpLaunchConfig(binding);
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

export function codexWorkflowMcpArgs(binding: WorkflowMcpBinding): string[] {
  return codexWorkflowMcpConfig(binding).args;
}
