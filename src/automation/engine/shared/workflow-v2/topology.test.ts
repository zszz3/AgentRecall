import { describe, expect, test } from "vitest";

import type { WorkflowV2Definition } from "./definition";
import { listWorkflowV2TerminalNodeIds, normalizeWorkflowV2TerminalNode } from "./topology";

function parallelDefinition(): WorkflowV2Definition {
  return {
    workflowId: "parallel-workflow",
    graphVersion: 1,
    objective: "Run two independent branches and combine them",
    nodes: [
      {
        id: "left",
        kind: "analysis",
        title: "Left branch",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Analyze the left branch.",
        outputFields: [{ key: "left_result", required: true }],
      },
      {
        id: "right",
        kind: "analysis",
        title: "Right branch",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Analyze the right branch.",
        outputFields: [{ key: "right_result", required: true }],
      },
    ],
    edges: [],
  };
}

describe("workflow-v2 terminal normalization", () => {
  test("adds one summary node after every terminal branch", () => {
    const source = parallelDefinition();
    const result = normalizeWorkflowV2TerminalNode(source);

    expect(result.terminalNodeIds).toEqual(["left", "right"]);
    expect(result.addedSummaryNodeId).toBe("workflow-summary");
    expect(listWorkflowV2TerminalNodeIds(result.definition)).toEqual(["workflow-summary"]);
    expect(result.definition.edges).toEqual([
      { fromNodeId: "left", toNodeId: "workflow-summary" },
      { fromNodeId: "right", toNodeId: "workflow-summary" },
    ]);
    const summaryNode = result.definition.nodes.at(-1);
    expect(summaryNode).toMatchObject({
      id: "workflow-summary",
      kind: "summary",
      execModel: "llm",
      executionMode: "one-shot",
      role: "orchestrator",
      outputFields: [{ key: "answer_markdown", required: true }],
      contextBudget: { maxUpstreamNodes: 2 },
    });
    if (!summaryNode || summaryNode.execModel !== "llm") throw new Error("expected summary LLM node");
    expect(summaryNode.prompt).toContain("{ nodeId, summary, outputs, evidence?, risks?, nextStepSuggestions? }");
    expect(source.nodes).toHaveLength(2);
    expect(source.edges).toEqual([]);
  });

  test("keeps a single-terminal graph unchanged", () => {
    const source = parallelDefinition();
    source.edges.push({ fromNodeId: "left", toNodeId: "right" });

    const result = normalizeWorkflowV2TerminalNode(source);

    expect(result.addedSummaryNodeId).toBeUndefined();
    expect(result.terminalNodeIds).toEqual(["right"]);
    expect(result.definition).toEqual(source);
    expect(result.definition).not.toBe(source);
  });

  test("uses a collision-safe summary node id", () => {
    const source = parallelDefinition();
    source.nodes[0]!.id = "workflow-summary";

    const result = normalizeWorkflowV2TerminalNode(source);

    expect(result.addedSummaryNodeId).toBe("workflow-summary-2");
    expect(listWorkflowV2TerminalNodeIds(result.definition)).toEqual(["workflow-summary-2"]);
  });
});
