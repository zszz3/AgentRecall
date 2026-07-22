import { describe, expect, test } from "vitest";
import {
  developerInstructionsForWorkflowRequest,
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
});
