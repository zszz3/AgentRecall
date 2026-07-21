import { describe, expect, test } from "vitest";

import {
  defaultWorkflowWorkDirSuffix,
  projectNodeStates,
  truncateWorkflowContext,
  workflowProgressAfterFailure,
  workflowStoragePlanDocument,
  workflowStoragePlanFor,
} from "./runtime-utils";

describe("workflow-v2 runtime-utils", () => {
  test("projects gate and revision events into run progress states", () => {
    const projected = projectNodeStates(
      [
        { type: "node_started", nodeId: "draft", at: 1, taskId: "task-1" },
        { type: "gate_opened", nodeId: "draft", at: 2, question: "Continue?" },
        { type: "graph_revised", nodeId: "draft", at: 3 },
      ],
      [{ nodeId: "draft", title: "Draft" }],
    );

    expect(projected).toEqual([
      { nodeId: "draft", title: "Draft", status: "paused", detail: "Paused", taskId: "task-1" },
    ]);
  });

  test("keeps gate question as awaiting-input detail", () => {
    const projected = projectNodeStates(
      [{ type: "gate_opened", nodeId: "review", at: 1, question: "Need approval?" }],
      [{ nodeId: "review", title: "Review" }],
    );

    expect(projected).toEqual([
      { nodeId: "review", title: "Review", status: "awaiting_input", detail: "Need approval?" },
    ]);
  });

  test("builds deterministic storage plan paths", () => {
    const plan = workflowStoragePlanFor("wf/demo", "run:1");

    expect(plan).toEqual({
      memoryPath: "memory.md",
      outputDir: "outputs/wf_demo/run_1",
    });
    expect(defaultWorkflowWorkDirSuffix("wf/demo")).toBe(".multi-agent-chat/workflows/wf_demo");
    expect(workflowStoragePlanDocument(plan)).toContain("outputs/wf_demo/run_1");
  });

  test("marks the active item as failed when no node has failed yet", () => {
    const next = workflowProgressAfterFailure(
      [
        { nodeId: "a", title: "A", status: "completed" },
        { nodeId: "b", title: "B", status: "running" },
      ],
      "boom",
    );

    expect(next).toEqual([
      { nodeId: "a", title: "A", status: "completed" },
      { nodeId: "b", title: "B", status: "failed", detail: "boom" },
    ]);
  });

  test("truncates long context with a marker", () => {
    const truncated = truncateWorkflowContext("a".repeat(30), 10);
    expect(truncated).toContain("[truncated]");
  });
});
