import { describe, expect, test } from "vitest";
import { addWorkflowNode, createWorkflowCopy, createWorkflowDefinition, workflowConnections } from "./workflow-editor-model";

describe("structured Workflow editor model", () => {
  test("creates a useful Agent node with described structured output", () => {
    const definition = createWorkflowDefinition("agent-1", 10);

    expect(definition.nodes).toMatchObject([{
      kind: "agent",
      agentId: "agent-1",
      outputs: [{ key: "result", name: "Result", description: "The completed result", type: "text" }],
    }]);
  });

  test("adds explicit node kinds and derives connections only from input references", () => {
    let definition = createWorkflowDefinition("agent-1", 10);
    definition = addWorkflowNode(definition, "review", "agent-1", 20);
    definition.nodes[1]!.inputs = [{
      source: "node",
      nodeId: definition.nodes[0]!.id,
      outputKey: "result",
    }];

    expect(definition.nodes[1]).toMatchObject({ kind: "review", onReject: "continue", targetNodeIds: [definition.nodes[0]!.id] });
    expect(definition.nodes[1]).not.toHaveProperty("maxRevisions");
    expect(workflowConnections(definition)).toEqual([{
      fromNodeId: definition.nodes[0]!.id,
      fromOutputKey: "result",
      toNodeId: definition.nodes[1]!.id,
    }]);
  });

  test("creates an editable Workflow copy without changing the source", () => {
    const template = { ...createWorkflowDefinition("agent-1", 10), id: "template", name: "Template", isTemplate: true };

    const copy = createWorkflowCopy(template, 20);

    expect(copy).toMatchObject({ id: "workflow_20", name: "Template 副本", createdAt: 20, updatedAt: 20 });
    expect(copy.isTemplate).toBeUndefined();
    expect(template).toMatchObject({ id: "template", name: "Template", isTemplate: true });
  });

  test("clones a personal Workflow with a new identity", () => {
    const personal = { ...createWorkflowDefinition("agent-1", 10), id: "personal", name: "Personal" };

    const copy = createWorkflowCopy(personal, 20);

    expect(copy).toMatchObject({ id: "workflow_20", name: "Personal 副本", createdAt: 20, updatedAt: 20 });
    expect(copy.nodes).toEqual(personal.nodes);
    expect(copy.nodes).not.toBe(personal.nodes);
    expect(personal).toMatchObject({ id: "personal", name: "Personal" });
  });
});
