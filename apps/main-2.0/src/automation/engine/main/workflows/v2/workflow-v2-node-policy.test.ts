import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2LLMNode, type WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import { workflowV2ReviewerPolicy } from "./workflow-v2-node-policy";

const node: WorkflowV2LLMNode = {
  id: "draft",
  title: "Draft",
  kind: "draft",
  execModel: "llm",
  executionMode: "one-shot",
  prompt: "Draft.",
  outputFields: [{ key: "draft", required: true }],
  reviewLevel: "high",
  judgeDimensions: [{ key: "quality", description: "The draft must be correct." }],
};

describe("Workflow V2 reviewer policy", () => {
  test("includes the global Review switch in the cache contract", () => {
    expect(workflowV2ReviewerPolicy(node, false)).toMatchObject({ reviewEnabled: false, requiresIndependentReview: false });
    expect(workflowV2ReviewerPolicy(node, true)).toMatchObject({ reviewEnabled: true, requiresIndependentReview: true });
  });

  test("never nests Review around a reviewer node", () => {
    expect(workflowV2ReviewerPolicy({ ...node, role: "reviewer" }, true, true)).toMatchObject({ requiresIndependentReview: false });
  });

  test("removes legacy Review criticality from script node policy", () => {
    const scriptNode: WorkflowV2ScriptNode = {
      id: "verify",
      title: "Verify",
      kind: "verification",
      execModel: "script",
      executionMode: "script",
      script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { verified: true };" }),
      outputFields: [{ key: "verified", required: true }],
      reviewLevel: "high",
      reviewMaxRetries: 2,
      judgeDimensions: [{ key: "quality", description: "Legacy script dimension." }],
    };

    expect(workflowV2ReviewerPolicy(scriptNode, true, true)).toEqual({
      reviewEnabled: false,
      judgeDimensions: [],
      reviewLevel: "none",
      reviewMaxRetries: 0,
      requiresIndependentReview: false,
      forceIndependentReview: false,
    });
  });
});
