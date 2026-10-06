import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowOutputField } from "./model";
import { validateWorkflowDefinition } from "./validation";

function field(
  key: string,
  type: WorkflowOutputField["type"] = "text",
  extra: Partial<WorkflowOutputField> = {},
): WorkflowOutputField {
  return {
    key,
    name: key,
    description: `${key} description`,
    type,
    required: true,
    ...extra,
  };
}

function validDefinition(): WorkflowDefinition {
  return {
    id: "resume",
    name: "Resume",
    description: "Build and review a resume.",
    inputs: [{
      key: "source",
      name: "Source resume",
      description: "Existing resume content.",
      type: "text",
      required: true,
    }],
    nodes: [
      {
        id: "draft",
        kind: "agent",
        title: "Draft",
        goal: "Draft the resume.",
        agentId: "writer",
        instructions: ["Preserve facts."],
        constraints: ["Do not invent metrics."],
        inputs: [{
          source: "workflow",
          workflowInputKey: "source",
        }],
        outputs: [field("resume")],
        acceptanceCriteria: ["All facts are preserved."],
      },
      {
        id: "review",
        kind: "review",
        title: "Review",
        goal: "Review the resume.",
        agentId: "reviewer",
        instructions: ["Check every criterion."],
        constraints: ["Use only supplied evidence."],
        targetNodeIds: ["draft"],
        criteria: [{ key: "fidelity", description: "Facts match the source." }],
        maxRevisions: 2,
        onReject: "revise",
        inputs: [{
          source: "node",
          nodeId: "draft",
          outputKey: "resume",
        }],
        outputs: [
          field("verdict"),
          field("criteriaResults", "list"),
          field("feedback"),
        ],
        acceptanceCriteria: ["Every criterion has a result."],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("validateWorkflowDefinition", () => {
  test("accepts an explicit unlimited Review revision allowance", () => {
    const definition = validDefinition();
    const review = definition.nodes[1]!;
    if (review.kind !== "review") throw new Error("Expected review fixture");
    review.maxRevisions = null;
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });
  test("accepts a structured agent and review workflow", () => {
    expect(validateWorkflowDefinition(validDefinition(), new Set(["writer", "reviewer"]))).toEqual([]);
  });

  test("reports duplicate output keys with a stable field path", () => {
    const definition = validDefinition();
    definition.nodes[0]!.outputs.push(field("resume"));

    expect(validateWorkflowDefinition(definition)).toContainEqual({
      path: "nodes.draft.outputs.resume",
      message: "Output key must be unique within the node.",
    });
  });

  test("reports missing node output references", () => {
    const definition = validDefinition();
    definition.nodes[1]!.inputs[0] = {
      ...definition.nodes[1]!.inputs[0]!,
      source: "node",
      nodeId: "draft",
      outputKey: "missing",
    };

    expect(validateWorkflowDefinition(definition)).toContainEqual({
      path: "nodes.review.inputs.node.draft.missing.outputKey",
      message: "Referenced node output does not exist.",
    });
  });

  test("reports duplicate references without requiring node-local input keys", () => {
    const definition = validDefinition();
    definition.nodes[0]!.inputs.push({ source: "workflow", workflowInputKey: "source" });

    expect(validateWorkflowDefinition(definition)).toContainEqual({
      path: "nodes.draft.inputs.workflow.source",
      message: "Node input references must be unique.",
    });
  });

  test("rejects cyclic node input references", () => {
    const definition = validDefinition();
    definition.nodes[0]!.inputs.push({
      source: "node",
      nodeId: "review",
      outputKey: "feedback",
    });

    expect(validateWorkflowDefinition(definition)).toContainEqual({
      path: "nodes",
      message: "Node input references must form an acyclic graph.",
    });
  });

  test("requires review protocol outputs", () => {
    const definition = validDefinition();
    definition.nodes[1]!.outputs = [field("feedback")];

    const issues = validateWorkflowDefinition(definition);
    expect(issues).toContainEqual({
      path: "nodes.review.outputs.verdict",
      message: "Review nodes must declare a required text verdict output.",
    });
    expect(issues).toContainEqual({
      path: "nodes.review.outputs.criteriaResults",
      message: "Review nodes must declare a required list criteriaResults output.",
    });
  });

  test("requires at least two distinct approval options", () => {
    const definition = validDefinition();
    definition.nodes = [{
      id: "approve",
      kind: "approval",
      title: "Approve",
      goal: "Approve publishing.",
      message: "Publish?",
      options: [{ value: "yes", label: "Yes", description: "Publish." }],
      allowComment: false,
      inputs: [],
      outputs: [field("decision")],
      acceptanceCriteria: ["A decision is recorded."],
    }];

    expect(validateWorkflowDefinition(definition)).toContainEqual({
      path: "nodes.approve.options",
      message: "Approval nodes require at least two distinct options.",
    });
  });

  test("reports unknown configured agents", () => {
    expect(validateWorkflowDefinition(validDefinition(), new Set(["writer"]))).toContainEqual({
      path: "nodes.review.agentId",
      message: "Configured agent does not exist.",
    });
  });
});
