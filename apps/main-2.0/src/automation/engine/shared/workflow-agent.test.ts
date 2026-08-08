import { describe, expect, test } from "vitest";
import { buildWorkflowAgentPrompt, buildWorkflowRevisionPrompt } from "./workflow-agent";

describe("Workflow Manager Review Gate contract", () => {
  test("assigns Review Gate criticality only to LLM/Agent nodes", () => {
    const prompt = buildWorkflowAgentPrompt({ workflowId: "workflow-1", objective: "Create a deterministic workflow" });

    expect(prompt).toContain("Assess every LLM/Agent node's criticality");
    expect(prompt).toContain("Review Gates may target only LLM/Agent nodes, never script nodes");
    expect(prompt).toContain("routes permission-requiring operations through the Approval Broker");
  });

  test("does not add Review Gates to script nodes while revising a workflow", () => {
    const prompt = buildWorkflowRevisionPrompt({
      workflowId: "workflow-1",
      revision: 2,
      definition: { workflowId: "workflow-1", nodes: [], edges: [] },
      request: "Revise the workflow",
    });

    expect(prompt).toContain("Only LLM/Agent nodes have Review Gate criticality");
    expect(prompt).toContain("script nodes are deterministic and must never receive a Gate");
    expect(prompt).toContain("Any changed critical LLM/Agent node");
  });
});
