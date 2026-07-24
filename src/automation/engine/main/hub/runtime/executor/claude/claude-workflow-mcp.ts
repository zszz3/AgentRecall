import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import { workflowMcpLaunchConfig, type WorkflowMcpBinding } from "../workflow/workflow-mcp-launch";

export function claudeWorkflowMcpServers(
  binding: WorkflowMcpBinding,
): ClaudeAgentSdkRunInput["mcpServers"] | undefined {
  const config = workflowMcpLaunchConfig(binding);
  if (!config) return undefined;
  return { agent_recall: { type: "stdio", ...config } };
}
