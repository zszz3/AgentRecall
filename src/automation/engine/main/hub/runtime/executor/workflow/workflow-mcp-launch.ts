import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkflowMcpLaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function workflowMcpLaunchConfig(
  discoveryPath: string | undefined,
  workflowId: string | undefined,
  options: { mainBundlePath?: string; cwd?: string; serverScriptPath?: string; runId?: string; nodeId?: string } = {},
): WorkflowMcpLaunchConfig | undefined {
  if (!discoveryPath || !workflowId) return undefined;
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
        AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
        AGENT_RECALL_WORKFLOW_ID: workflowId,
        ...(options.runId ? { AGENT_RECALL_WORKFLOW_RUN_ID: options.runId } : {}),
        ...(options.nodeId ? { AGENT_RECALL_WORKFLOW_NODE_ID: options.nodeId } : {}),
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
    ?? path.join(cwd, "src", "automation", "engine", "mcp", "server.ts");
  if (!tsxCli || !existsSync(serverScript)) return undefined;
  return {
    command: process.execPath,
    args: [tsxCli, serverScript],
    env: {
      AGENT_RECALL_WORKFLOW_MCP_BRIDGE: discoveryPath,
      AGENT_RECALL_WORKFLOW_ID: workflowId,
      ...(options.runId ? { AGENT_RECALL_WORKFLOW_RUN_ID: options.runId } : {}),
      ...(options.nodeId ? { AGENT_RECALL_WORKFLOW_NODE_ID: options.nodeId } : {}),
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
