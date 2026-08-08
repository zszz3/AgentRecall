import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowV2Definition } from "../../../../shared/workflow-v2/definition";
import { addWorkflowReviewGate, removeWorkflowReviewGate, updateWorkflowReviewGate, WorkflowDraftEditorDialog } from "./WorkflowDraftEditorDialog";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "wf-editor",
    graphVersion: 1,
    objective: "Review a result",
    nodes: [{ id: "answer", kind: "agent", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: "executor", prompt: "Answer", outputFields: [{ key: "answer" }] }],
    edges: [],
  };
}

describe("Workflow Draft Review Gate editing", () => {
  test("adds at most one attached Gate per target and removes it without changing the node", () => {
    const added = addWorkflowReviewGate(definition(), "answer", "reviewer");
    expect(added.reviewGates).toEqual([expect.objectContaining({ targetNodeId: "answer", configuredAgentId: "reviewer", maxQualityRetries: 2 })]);
    expect(addWorkflowReviewGate(added, "answer", "other").reviewGates).toHaveLength(1);
    const updated = updateWorkflowReviewGate(added, added.reviewGates![0]!.id, (gate) => { gate.reviewLevel = "high"; });
    expect(updated.reviewGates![0]!.reviewLevel).toBe("high");
    const removed = removeWorkflowReviewGate(updated, updated.reviewGates![0]!.id);
    expect(removed.reviewGates).toEqual([]);
    expect(removed.nodes).toEqual(definition().nodes);
  });

  test("hides Review Gate controls while the Runtime Review setting is disabled", () => {
    const configuredAgents = [{ id: "reviewer", name: "Reviewer", description: "", runtimeAgentId: "codex" as const, channelId: "channel", modelId: "model", tags: [], createdAt: 1, updatedAt: 1 }];
    const disabled = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={definition()} configuredAgents={configuredAgents} runtimeReviewEnabled={false} onSave={() => undefined} onClose={() => undefined} />);
    const enabled = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={definition()} configuredAgents={configuredAgents} runtimeReviewEnabled onSave={() => undefined} onClose={() => undefined} />);

    expect(disabled).not.toContain("Runtime Review Gates");
    expect(enabled).toContain("Runtime Review Gates");
    expect(enabled).toContain("Add Review Gate for Answer");
    expect(enabled).not.toContain("Required read-only tools");
  });

  test("does not offer Review Gates for script nodes", () => {
    const configuredAgents = [{ id: "reviewer", name: "Reviewer", description: "", runtimeAgentId: "codex" as const, channelId: "channel", modelId: "model", tags: [], createdAt: 1, updatedAt: 1 }];
    const value = definition();
    value.nodes.push({
      id: "transform",
      kind: "worker",
      title: "Transform",
      execModel: "script",
      executionMode: "script",
      script: {
        executable: { kind: "inline", language: "typescript", code: "return { result: inputs.value };" },
        parameters: [{ key: "value", label: "Value", location: "body", valueType: "string", source: "user", required: true }],
        capabilities: [],
        managerRisk: { level: "safe", rationale: "Pure in-memory transformation." },
        effectMode: "pure",
        idempotency: "safe_retry",
        stderrPolicy: "fail",
      },
      outputFields: [{ key: "result", required: true }],
    });

    expect(addWorkflowReviewGate(value, "transform", "reviewer").reviewGates).toBeUndefined();
    const rendered = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={value} configuredAgents={configuredAgents} runtimeReviewEnabled onSave={() => undefined} onClose={() => undefined} />);
    expect(rendered).toContain("Add Review Gate for Answer");
    expect(rendered).not.toContain("Add Review Gate for Transform");
  });
});
