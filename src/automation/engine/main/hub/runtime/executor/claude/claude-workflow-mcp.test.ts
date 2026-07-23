import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeWorkflowMcpServers } from "./claude-workflow-mcp";

describe("claudeWorkflowMcpServers", () => {
  test("projects the complete workflow binding into the Claude stdio server", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "workflow-claude-mcp-"));
    const serverScriptPath = path.join(dir, "server.js");
    await writeFile(serverScriptPath, "", "utf8");

    const previousServer = process.env.AGENT_RECALL_WORKFLOW_MCP_SERVER;
    process.env.AGENT_RECALL_WORKFLOW_MCP_SERVER = serverScriptPath;
    const servers = claudeWorkflowMcpServers({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-1",
      runId: "run-1",
      nodeId: "node-1",
      managedToken: "managed-token",
    });
    if (previousServer === undefined) delete process.env.AGENT_RECALL_WORKFLOW_MCP_SERVER;
    else process.env.AGENT_RECALL_WORKFLOW_MCP_SERVER = previousServer;

    expect(servers).toMatchObject({
      agent_recall: {
        type: "stdio",
        env: {
          AGENT_RECALL_WORKFLOW_ID: "wf-1",
          AGENT_RECALL_WORKFLOW_RUN_ID: "run-1",
          AGENT_RECALL_WORKFLOW_NODE_ID: "node-1",
          AGENT_RECALL_WORKFLOW_MCP_TOKEN: "managed-token",
        },
      },
    });
  });
});
