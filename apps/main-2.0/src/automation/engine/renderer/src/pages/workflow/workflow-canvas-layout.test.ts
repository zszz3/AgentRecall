import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../../../../shared/workflow-v2/definition";
import { workflowCanvasLayout } from "./workflow-canvas-layout";

describe("workflowCanvasLayout Review Gate attachment", () => {
  test("reserves stable height for an attached Gate without adding a graph node", () => {
    const definition: WorkflowV2Definition = {
      workflowId: "wf-layout",
      graphVersion: 1,
      objective: "Review",
      nodes: [{ id: "answer", kind: "agent", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: "executor", prompt: "Answer", outputFields: [{ key: "answer" }] }],
      edges: [],
      reviewGates: [{ id: "review-answer", targetNodeId: "answer", configuredAgentId: "reviewer", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Check quality." }], maxQualityRetries: 2 }],
    };
    const layout = workflowCanvasLayout(definition, "expanded");
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]).toMatchObject({ node: { id: "answer" }, height: 160 });
  });
});
