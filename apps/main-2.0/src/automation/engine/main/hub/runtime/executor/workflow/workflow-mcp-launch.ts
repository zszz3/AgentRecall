import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowMcpScope } from "../../../../../shared/workflow-mcp-policy";

export interface WorkflowMcpLaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentRecallMcpLaunchContext {
  workflowId?: string;
  runId?: string;
  nodeId?: string;
  studioToken?: string;
}

export interface WorkflowMcpBinding {
  discoveryPath?: string;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
  executionId?: string;
  reviewRevision?: number;
  managedToken?: string;
  scope?: WorkflowMcpScope;
  studioToken?: string;
}

interface WorkflowMcpLaunchOptions {
  mainBundlePath?: string;
  cwd?: string;
  serverScriptPath?: string;
}

export function agentRecallMcpLaunchConfig(
  discoveryPath: string | undefined,
  context: AgentRecallMcpLaunchContext,
  options: WorkflowMcpLaunchOptions = {},
): WorkflowMcpLaunchConfig | undefined {
  return workflowMcpLaunchConfig({ discoveryPath, ...context }, options);
}

export function workflowMcpLaunchConfig(
  binding: WorkflowMcpBinding,
  options: WorkflowMcpLaunchOptions = {},
): WorkflowMcpLaunchConfig | undefined {
  const { discoveryPath, workflowId } = binding;
  if (!discoveryPath || (!workflowId && !binding.studioToken)) return undefined;
  const scope: WorkflowMcpScope = binding.scope
    ?? (binding.runId && binding.nodeId && binding.reviewRevision
      ? "runtime_review"
      : binding.runId && binding.nodeId ? "node_execution" : binding.reviewRevision ? "review" : "planning");
  const mainBundlePath = options.mainBundlePath ?? fileURLToPath(import.meta.url);
  const compiledServer = [
    process.env.AGENT_RECALL_WORKFLOW_MCP_SERVER,
    path.join(path.dirname(mainBundlePath), "mcp-server.js"),
    path.resolve(path.dirname(mainBundlePath), "..", "mcp", "workflow-entry.js"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (compiledServer) {
    return {
      command: process.execPath,
      args: [compiledServer],
      env: {
        AGENT_RECALL_MCP_BRIDGE: discoveryPath,
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
        ...(workflowId ? {
          AGENT_RECALL_WORKFLOW_ID: workflowId,
          AGENT_RECALL_WORKFLOW_MCP_SCOPE: scope,
        } : {}),
        ...(binding.runId ? { AGENT_RECALL_WORKFLOW_RUN_ID: binding.runId } : {}),
        ...(binding.nodeId ? { AGENT_RECALL_WORKFLOW_NODE_ID: binding.nodeId } : {}),
        ...(binding.executionId ? { AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID: binding.executionId } : {}),
        ...(binding.reviewRevision ? { AGENT_RECALL_WORKFLOW_REVIEW_REVISION: String(binding.reviewRevision) } : {}),
        ...(binding.managedToken ? { AGENT_RECALL_WORKFLOW_MCP_TOKEN: binding.managedToken } : {}),
        ...(binding.studioToken ? { AGENT_RECALL_STUDIO_TOKEN: binding.studioToken } : {}),
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }
  const cwd = options.cwd ?? process.cwd();
  const tsxCli = [
    path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
  ].find(existsSync);
  const serverScript = options.serverScriptPath
    ?? path.join(cwd, "src", "mcp", "workflow-entry.ts");
  if (!tsxCli || !existsSync(serverScript)) return undefined;
  return {
    command: process.execPath,
    args: [tsxCli, serverScript],
    env: {
      AGENT_RECALL_MCP_BRIDGE: discoveryPath,
      AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
      ...(workflowId ? {
        AGENT_RECALL_WORKFLOW_ID: workflowId,
        AGENT_RECALL_WORKFLOW_MCP_SCOPE: scope,
      } : {}),
      ...(binding.runId ? { AGENT_RECALL_WORKFLOW_RUN_ID: binding.runId } : {}),
      ...(binding.nodeId ? { AGENT_RECALL_WORKFLOW_NODE_ID: binding.nodeId } : {}),
      ...(binding.executionId ? { AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID: binding.executionId } : {}),
      ...(binding.reviewRevision ? { AGENT_RECALL_WORKFLOW_REVIEW_REVISION: String(binding.reviewRevision) } : {}),
      ...(binding.managedToken ? { AGENT_RECALL_WORKFLOW_MCP_TOKEN: binding.managedToken } : {}),
      ...(binding.studioToken ? { AGENT_RECALL_STUDIO_TOKEN: binding.studioToken } : {}),
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
