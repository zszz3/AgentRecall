import { describe, expect, test } from "vitest";
import { codexWorkflowMcpArgs, codexWorkflowMcpConfig } from "./codex-workflow-mcp";

describe("codexWorkflowMcpArgs", () => {
  test("injects a workflow-scoped MCP server for planning", () => {
    const config = codexWorkflowMcpConfig({ discoveryPath: "C:/app/mcp-bridge.json", workflowId: "wf-1" });
    expect(config.args.join("\n")).toContain("mcp_servers.agent_recall.command");
    expect(config.args.join("\n")).toContain("AGENT_RECALL_WORKFLOW_MCP_BRIDGE");
    expect(config.args.join("\n")).toContain('mcp_servers.agent_recall.default_tools_approval_mode="prompt"');
    expect(config.args.join("\n")).toContain('mcp_servers.agent_recall.tools.workflow_create.approval_mode="approve"');
    expect(config.args.join("\n")).toContain('mcp_servers.agent_recall.tools.workflow_get.approval_mode="approve"');
    expect(config.args.join("\n")).not.toContain("mcp_servers.agent_recall.tools.workflow_run.approval_mode");
    expect(config.env.AGENT_RECALL_WORKFLOW_ID).toBe("wf-1");
    expect(config.requiredMcpTools).toEqual({ agent_recall: ["workflow_create"] });
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
      executionId: "execution-1",
      managedToken: "managed-token",
    });
    const args = config.args.join("\n");

    expect(args).toContain("AGENT_RECALL_WORKFLOW_RUN_ID");
    expect(args).toContain("AGENT_RECALL_WORKFLOW_NODE_ID");
    expect(args).toContain("AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID");
    expect(args).toContain("AGENT_RECALL_WORKFLOW_MCP_TOKEN");
    expect(args).toContain('mcp_servers.agent_recall.tools.workflow_node_complete.approval_mode="approve"');
    expect(args).not.toContain("mcp_servers.agent_recall.tools.workflow_create.approval_mode");
    expect(args).not.toContain("mcp_servers.agent_recall.tools.workflow_run.approval_mode");
    expect(args).not.toContain("managed-token");
    expect(config.env).toMatchObject({
      AGENT_RECALL_WORKFLOW_ID: "wf-1",
      AGENT_RECALL_WORKFLOW_RUN_ID: "run-1",
      AGENT_RECALL_WORKFLOW_NODE_ID: "node-1",
      AGENT_RECALL_WORKFLOW_NODE_EXECUTION_ID: "execution-1",
      AGENT_RECALL_WORKFLOW_MCP_TOKEN: "managed-token",
    });
    expect(config.requiredMcpTools).toEqual({ agent_recall: ["workflow_node_complete"] });
  });

  test("requires the bound Review submission tool in Review scope", () => {
    const config = codexWorkflowMcpConfig({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-review",
      reviewRevision: 2,
      managedToken: "managed-token",
    });
    const args = config.args.join("\n");

    expect(args).toContain('mcp_servers.agent_recall.tools.workflow_review_submit.approval_mode="approve"');
    expect(args).not.toContain("workflow_create.approval_mode");
    expect(config.env).toMatchObject({
      AGENT_RECALL_WORKFLOW_ID: "wf-review",
      AGENT_RECALL_WORKFLOW_REVIEW_REVISION: "2",
      AGENT_RECALL_WORKFLOW_MCP_SCOPE: "review",
    });
    expect(config.requiredMcpTools).toEqual({ agent_recall: ["workflow_review_submit"] });
  });

  test("requires only the bound Runtime Review Gate submission tool", () => {
    const config = codexWorkflowMcpConfig({ discoveryPath: "C:/app/mcp-bridge.json", workflowId: "wf-review", runId: "run-1", nodeId: "node-1", executionId: "review-1", reviewRevision: 2, managedToken: "managed-token" });
    const args = config.args.join("\n");
    expect(args).toContain('mcp_servers.agent_recall.tools.workflow_review_gate_submit.approval_mode="approve"');
    expect(args).not.toContain("workflow_node_complete.approval_mode");
    expect(config.env.AGENT_RECALL_WORKFLOW_MCP_SCOPE).toBe("runtime_review");
    expect(config.requiredMcpTools).toEqual({ agent_recall: ["workflow_review_gate_submit"] });
  });

  test("injects Workflow and Studio through one AgentRecall MCP server", () => {
    const args = codexWorkflowMcpArgs({
      discoveryPath: "C:/app/mcp-bridge.json",
      workflowId: "wf-1",
      studioToken: "studio-scope",
    });
    const text = args.join("\n");

    expect(text.match(/mcp_servers\.agent_recall\.command/g)).toHaveLength(1);
    expect(text).toContain("AGENT_RECALL_WORKFLOW_ID");
    expect(text).toContain("AGENT_RECALL_STUDIO_TOKEN");
    expect(text).toContain("studio_task_finish");
    expect(text).not.toContain("studio_send_message");
    expect(text).toContain("workspace_reserve");
  });
});
