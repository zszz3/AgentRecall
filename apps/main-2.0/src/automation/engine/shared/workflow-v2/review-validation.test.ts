import { describe, expect, test } from "vitest";
import type { WorkflowV2AuthoredDefinition, WorkflowV2Definition, WorkflowV2ReviewGate } from "./definition";
import { compileWorkflowV2Definition, createWorkflowV2TemplateRegistry } from "./templates";
import { migrateWorkflowV2ReviewGates, workflowV2ReviewGateForNode } from "./review-gates";
import { validateWorkflowV2Definition } from "./validation";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "review-validation",
    graphVersion: 1,
    objective: "Validate Review settings",
    reviewEnabled: false,
    nodes: [{
      id: "result",
      kind: "agent",
      title: "Result",
      execModel: "llm",
      executionMode: "one-shot",
      prompt: "Return a result.",
      outputFields: [{ key: "result", required: true }],
    }],
    edges: [],
  };
}

describe("Workflow V2 Review definition validation", () => {
  test("requires judge dimensions for every reviewed node", () => {
    const value = definition();
    value.nodes[0]!.reviewLevel = "high";
    expect(validateWorkflowV2Definition(value).errors).toContain("Workflow V2 reviewed node result must declare at least one judge dimension.");
  });

  test("accepts legacy Review settings for reviewer-role LLM nodes", () => {
    const value = definition();
    value.reviewEnabled = true;
    value.nodes[0] = {
      ...value.nodes[0]!,
      role: "reviewer",
      reviewLevel: "medium",
      reviewMaxRetries: 2,
      judgeDimensions: [{ key: "quality", description: "The result must meet the Workflow objective." }],
    };
    expect(validateWorkflowV2Definition(value)).toMatchObject({ valid: true, errors: [] });
  });

  test("rejects malformed judge dimensions without throwing", () => {
    const value = definition();
    value.nodes[0]!.reviewLevel = "high";
    value.nodes[0]!.judgeDimensions = [{ key: 1, description: null }] as never;

    expect(() => validateWorkflowV2Definition(value)).not.toThrow();
    expect(validateWorkflowV2Definition(value).errors).toContain("Workflow V2 node result judge dimensions require string keys and descriptions.");
  });

  test("preserves the Review switch while compiling an authored definition", () => {
    const authored: WorkflowV2AuthoredDefinition = { ...definition(), reviewEnabled: true };
    const compiled = compileWorkflowV2Definition(authored, createWorkflowV2TemplateRegistry([]));

    expect(compiled.reviewEnabled).toBe(true);
  });

  test("validates independently routed Review Gates without adding DAG edges", () => {
    const value = definition();
    const targetNode = value.nodes[0]!;
    if (targetNode.execModel !== "llm") throw new Error("Expected an LLM node.");
    targetNode.configuredAgentId = "executor";
    value.reviewGates = [{
      id: "review-result",
      targetNodeId: "result",
      configuredAgentId: "reviewer",
      reviewLevel: "high",
      judgeDimensions: [
        { key: "accuracy", description: "The result must be accurate." },
        { key: "coverage", description: "The result must be complete." },
      ],
      maxQualityRetries: 2,
    }];

    expect(validateWorkflowV2Definition(value, { configuredAgentIds: ["executor", "reviewer"] })).toMatchObject({
      valid: true,
      errors: [],
      topologicalNodeIds: ["result"],
    });
  });

  test("rejects Review Gates attached to script nodes", () => {
    const value = definition();
    value.nodes = [{
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
    }];
    value.reviewGates = [{ id: "review-transform", targetNodeId: "transform", configuredAgentId: "reviewer", reviewLevel: "medium", judgeDimensions: [{ key: "quality", description: "Check output." }], maxQualityRetries: 2 }];

    expect(validateWorkflowV2Definition(value).errors).toContain("Workflow V2 Review Gate review-transform cannot target script node transform.");
    expect(workflowV2ReviewGateForNode(value, "transform")).toBeUndefined();
  });

  test("rejects duplicate target gates and invalid retry limits", () => {
    const value = definition();
    value.reviewGates = ["a", "b"].map((id, index) => ({
      id,
      targetNodeId: "result",
      configuredAgentId: `reviewer-${index}`,
      reviewLevel: "medium" as const,
      judgeDimensions: [{ key: "quality", description: "Check quality." }],
      maxQualityRetries: 6,
    }));

    const errors = validateWorkflowV2Definition(value).errors;
    expect(errors).toContain("Workflow V2 node result may have at most one Review Gate.");
    expect(errors).toContain("Workflow V2 Review Gate a maxQualityRetries must be between 0 and 5.");
  });

  test("rejects Review Gate identifiers that runtime normalization would change", () => {
    const value = definition();
    value.reviewGates = [{
      id: " review-result ",
      targetNodeId: "result ",
      configuredAgentId: "reviewer ",
      reviewLevel: "high",
      judgeDimensions: [
        { key: " quality ", description: "Check quality." },
        { key: "quality", description: "Duplicate after trimming." },
      ],
      maxQualityRetries: 2,
    }];

    const errors = validateWorkflowV2Definition(value).errors;
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining("must not contain surrounding whitespace")]));
  });

  test("drops legacy Review Gate tool allowlists during migration", () => {
    const value = definition();
    value.reviewGates = [{
      id: "review-result",
      targetNodeId: "result",
      configuredAgentId: "reviewer",
      reviewLevel: "high",
      judgeDimensions: [{ key: "quality", description: "Check quality." }],
      maxQualityRetries: 2,
      requiredTools: ["search"],
    } as WorkflowV2ReviewGate & { requiredTools: string[] }];

    expect(migrateWorkflowV2ReviewGates(value, "legacy-reviewer").reviewGates?.[0]).not.toHaveProperty("requiredTools");
  });

  test("migrates legacy node review fields into one explicit Gate", () => {
    const value = definition();
    value.reviewEnabled = true;
    value.nodes[0]!.reviewLevel = "high";
    value.nodes[0]!.reviewMaxRetries = 8;
    value.nodes[0]!.judgeDimensions = [{ key: "quality", description: "Check quality." }];

    const migrated = migrateWorkflowV2ReviewGates(value, "legacy-reviewer");

    expect(migrated.reviewEnabled).toBeUndefined();
    expect(migrated.nodes[0]).not.toHaveProperty("reviewLevel");
    expect(migrated.reviewGates).toEqual([{
      id: "review-result",
      targetNodeId: "result",
      configuredAgentId: "legacy-reviewer",
      reviewLevel: "high",
      judgeDimensions: [{ key: "quality", description: "Check quality." }],
      maxQualityRetries: 5,
    }]);
  });

  test("drops explicit and legacy Review Gates for script nodes during migration", () => {
    const value = definition();
    value.nodes[0] = {
      id: "transform",
      kind: "worker",
      title: "Transform",
      execModel: "script",
      executionMode: "script",
      reviewLevel: "high",
      judgeDimensions: [{ key: "quality", description: "Legacy script review." }],
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
    };
    value.reviewGates = [{ id: "review-transform", targetNodeId: "transform", configuredAgentId: "reviewer", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Explicit script review." }], maxQualityRetries: 2 }];

    const migrated = migrateWorkflowV2ReviewGates(value, "legacy-reviewer");
    expect(migrated.reviewGates).toEqual([]);
    expect(migrated.nodes[0]).not.toHaveProperty("reviewLevel");
    expect(migrated.nodes[0]).not.toHaveProperty("judgeDimensions");
  });

  test("preserves Review Gates with unknown targets so validation can reject them", () => {
    const value = definition();
    value.reviewGates = [{ id: "review-missing", targetNodeId: "missing", configuredAgentId: "reviewer", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Check quality." }], maxQualityRetries: 2 }];

    const migrated = migrateWorkflowV2ReviewGates(value, "legacy-reviewer");

    expect(migrated.reviewGates).toEqual(value.reviewGates);
    expect(validateWorkflowV2Definition(migrated).errors).toContain("Workflow V2 Review Gate review-missing references missing node missing.");
  });
});
