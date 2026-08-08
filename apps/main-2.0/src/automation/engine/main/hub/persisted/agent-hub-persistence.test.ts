import { describe, expect, test } from "vitest";
import { isWorkflowRunNodeStatus } from "./agent-hub-persistence";

describe("AgentHub Workflow persistence", () => {
  test("accepts the durable status for a human-approved review result", () => {
    expect(isWorkflowRunNodeStatus("completed_with_override")).toBe(true);
  });
});
