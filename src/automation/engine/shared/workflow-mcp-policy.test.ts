import { describe, expect, test } from "vitest";
import {
  workflowMcpToolDecision,
  workflowMcpToolsForScope,
  workflowMcpToolNameFromIdentifier,
} from "./workflow-mcp-policy";

describe("workflow MCP policy", () => {
  test("allows draft authoring while requiring approval for lifecycle mutations", () => {
    expect(workflowMcpToolDecision("planning", "workflow_get")).toBe("allow");
    expect(workflowMcpToolDecision("planning", "workflow_update")).toBe("allow");
    expect(workflowMcpToolDecision("planning", "workflow_run")).toBe("approval_required");
    expect(workflowMcpToolDecision("planning", "agents_delete")).toBe("approval_required");
    expect(workflowMcpToolDecision("planning", "workflow_node_complete")).toBe("deny");
  });

  test("limits node execution to node-scoped reads and completion tools", () => {
    expect(workflowMcpToolDecision("node_execution", "workflow_get")).toBe("allow");
    expect(workflowMcpToolDecision("node_execution", "workflow_run_get")).toBe("allow");
    expect(workflowMcpToolDecision("node_execution", "workflow_node_complete")).toBe("allow");
    expect(workflowMcpToolDecision("node_execution", "workflow_update")).toBe("deny");
    expect(workflowMcpToolDecision("node_execution", "workflow_stop")).toBe("deny");
  });

  test("projects only callable tools and parses exact runtime identifiers", () => {
    expect(workflowMcpToolsForScope("planning")).toEqual(expect.arrayContaining(["workflow_create", "workflow_update", "workflow_run"]));
    expect(workflowMcpToolsForScope("node_execution")).toEqual(expect.arrayContaining(["workflow_node_complete"]));
    expect(workflowMcpToolsForScope("node_execution")).not.toContain("workflow_update");
    expect(workflowMcpToolNameFromIdentifier("mcp__agent_recall__workflow_update")).toBe("workflow_update");
    expect(workflowMcpToolNameFromIdentifier("agent_recall_workflow/workflow_node_complete")).toBe("workflow_node_complete");
    expect(workflowMcpToolNameFromIdentifier("Run workflow_update later")).toBeUndefined();
  });
});
