import { describe, expect, test, vi } from "vitest";
import {
  developerInstructionsForWorkflowRequest,
  emitWorkflowAgentApprovalEvent,
  WORKFLOW_DEVELOPER_INSTRUCTIONS,
} from "./agent-executor-workflow-shared";

describe("workflow manager execution-mode policy", () => {
  test("uses script nodes for deterministic typed user input", () => {
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("one-shot only when the node needs no user input");
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("source=user");
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("echoing");
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("must remain a script node");
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("Do not use memory");
    expect(WORKFLOW_DEVELOPER_INSTRUCTIONS).toContain("WorkflowV2Definition");
  });

  test("keeps workflow-manager instructions out of generic Agent execution", () => {
    expect(developerInstructionsForWorkflowRequest({
      instructionScope: "workflow",
      developerInstructions: "Configured policy",
    })).toContain(WORKFLOW_DEVELOPER_INSTRUCTIONS);
    expect(developerInstructionsForWorkflowRequest({
      instructionScope: "agent",
      developerInstructions: "Configured policy",
    })).toBe("Configured policy");
  });

  test("maps runtime approval identity without replacing the workflow request identity", () => {
    const onEvent = vi.fn();
    expect(emitWorkflowAgentApprovalEvent({ requestId: "workflow-request", onEvent }, {
      type: "approval_request",
      requestId: "runtime-approval:1",
      content: "Allow MCP tool?",
      metadata: { provider: "codex" },
    })).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({
      requestId: "workflow-request",
      type: "approval_request",
      approvalRequestId: "runtime-approval:1",
      content: "Allow MCP tool?",
      metadata: { provider: "codex" },
    });
  });
});
