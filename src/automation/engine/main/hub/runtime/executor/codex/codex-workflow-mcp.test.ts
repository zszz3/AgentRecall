import { describe, expect, test } from "vitest";
import { codexWorkflowMcpArgs, codexWorkflowMcpConfig } from "./codex-workflow-mcp";

describe("codexWorkflowMcpArgs", () => {
  test("injects a workflow-scoped MCP server for planning", () => {
    const config = codexWorkflowMcpConfig({ discoveryPath: "C:/app/mcp-bridge.json", workflowId: "wf-1" });
    expect(config.args.join("\n")).toContain("mcp_servers.agent_recall.command");
    expect(config.args.join("\n")).toContain("AGENT_RECALL_WORKFLOW_MCP_BRIDGE");
    expect(config.env.AGENT_RECALL_WORKFLOW_ID).toBe("wf-1");
  });

  test("does not inject workflow tools without a planning id", () => {
    expect(codexWorkflowMcpArgs({ discoveryPath: "C:/app/mcp-bridge.json" })).toEqual([]);
  });

  test("injects the complete managed workflow node identity", () => {
    const config = codexWorkflowMcpConfig({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-1",
      runId: "run-1",
      nodeId: "node-1",
      managedToken: "managed-token",
    });
    const args = config.args.join("\n");

    expect(args).toContain("AGENT_RECALL_WORKFLOW_RUN_ID");
    expect(args).toContain("AGENT_RECALL_WORKFLOW_NODE_ID");
    expect(args).toContain("AGENT_RECALL_WORKFLOW_MCP_TOKEN");
    expect(args).not.toContain("managed-token");
    expect(config.env).toMatchObject({
      AGENT_RECALL_WORKFLOW_ID: "wf-1",
      AGENT_RECALL_WORKFLOW_RUN_ID: "run-1",
      AGENT_RECALL_WORKFLOW_NODE_ID: "node-1",
      AGENT_RECALL_WORKFLOW_MCP_TOKEN: "managed-token",
    });
  });
});
