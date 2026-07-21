import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { parseWorkflowV2GenerationReview, workflowV2GenerationReviewPrompt } from "./workflow-v2-generation-review";

const definition: WorkflowV2Definition = { workflowId: "wf", graphVersion: 2, objective: "Echo", nodes: [{ id: "echo", kind: "transform", title: "Echo", execModel: "script", executionMode: "script", script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return inputs;" }), outputFields: [{ key: "output", required: true }] }], edges: [] };

describe("Workflow V2 generation review", () => {
  test("parses a fenced structured approval", () => {
    const result = parseWorkflowV2GenerationReview({ definition, revision: 4, content: ['```json', '{"verdict":"approve","reviewedRevision":4,"summary":"Good","findings":[],"scriptRisks":{"echo":{"level":"safe","rationale":"Pure transform"}},"suggestions":[]}', '```'].join("\n") });
    expect(result).toMatchObject({ verdict: "approve", reviewedRevision: 4, scriptRisks: { echo: { level: "safe" } } });
  });

  test("rejects missing risk assessment for a script node", () => {
    expect(() => parseWorkflowV2GenerationReview({ definition, revision: 4, content: '{"verdict":"approve","reviewedRevision":4,"summary":"Good","findings":[],"scriptRisks":{},"suggestions":[]}' })).toThrow("echo");
  });

  test("rejects findings for unknown nodes", () => {
    expect(() => parseWorkflowV2GenerationReview({ definition, revision: 4, content: '{"verdict":"revise","reviewedRevision":4,"summary":"Bad","findings":[{"severity":"blocking","nodeId":"missing","summary":"Missing","failurePath":"Fails"}],"scriptRisks":{"echo":{"level":"safe","rationale":"Pure"}},"suggestions":[]}' })).toThrow("unknown node");
  });

  test("prompt requires adversarial but pragmatic review", () => {
    const prompt = workflowV2GenerationReviewPrompt({ definition, revision: 4 });
    expect(prompt).toContain("concrete execution, safety, correctness, or usability failure");
    expect(prompt).toContain("Do not block on cosmetic preferences");
    expect(prompt).toContain("missing or redundant nodes");
  });
});
