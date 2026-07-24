import { workflowMcpLaunchConfig, type WorkflowMcpBinding } from "../workflow/workflow-mcp-launch";
import {
  workflowMcpToolDecision,
  workflowMcpToolsForScope,
  type WorkflowMcpScope,
} from "../../../../../shared/workflow-mcp-policy";

export interface CodexWorkflowMcpConfig {
  args: string[];
  env: Record<string, string>;
  requiredMcpTools?: Record<string, string[]>;
}

export function codexWorkflowMcpConfig(binding: WorkflowMcpBinding): CodexWorkflowMcpConfig {
  const config = workflowMcpLaunchConfig(binding);
  if (!config) return { args: [], env: {} };
  const envNames = Object.keys(config.env);
  const scope: WorkflowMcpScope = binding.scope
    ?? (binding.runId && binding.nodeId ? "node_execution" : "planning");
  const completionEnabled = Boolean(binding.runId && binding.nodeId && binding.executionId);
  const exposedTools = workflowMcpToolsForScope(scope)
    .filter((toolName) => toolName !== "workflow_node_complete" || completionEnabled);
  const approvedTools = exposedTools.filter((toolName) => workflowMcpToolDecision(scope, toolName) === "allow");
  return {
    args: [
      "-c", `mcp_servers.agent_recall.command=${JSON.stringify(config.command)}`,
      "-c", `mcp_servers.agent_recall.args=[${config.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      "-c", `mcp_servers.agent_recall.env_vars=[${envNames.map((name) => JSON.stringify(name)).join(", ")}]`,
      "-c", `mcp_servers.agent_recall.enabled_tools=[${exposedTools.map((name) => JSON.stringify(name)).join(", ")}]`,
      "-c", `mcp_servers.agent_recall.default_tools_approval_mode=${JSON.stringify("prompt")}`,
      ...approvedTools.flatMap((toolName) => [
        "-c",
        `mcp_servers.agent_recall.tools.${toolName}.approval_mode=${JSON.stringify("approve")}`,
      ]),
    ],
    env: config.env,
    ...((completionEnabled || scope === "planning") ? {
      requiredMcpTools: { agent_recall: [completionEnabled ? "workflow_node_complete" : "workflow_create"] },
    } : {}),
  };
}

export function codexWorkflowMcpArgs(binding: WorkflowMcpBinding): string[] {
  return codexWorkflowMcpConfig(binding).args;
}
