import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import { workflowMcpLaunchConfig } from "../workflow/workflow-mcp-launch";

export function claudeWorkflowMcpServers(
  discoveryPath: string | undefined,
  workflowId: string | undefined,
  runId?: string,
  nodeId?: string,
): ClaudeAgentSdkRunInput["mcpServers"] | undefined {
  const config = workflowMcpLaunchConfig(discoveryPath, workflowId, { runId, nodeId });
  if (!config) return undefined;
  return { agent_recall: { type: "stdio", ...config } };
}
