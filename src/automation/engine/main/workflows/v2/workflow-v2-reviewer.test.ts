import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2ReviewVerdict } from "../../../shared/workflow-v2/review";
import {
  assertIndependentWorkflowV2Reviewer,
  createWorkflowV2ReviewerInput,
  isWorkflowV2ReviewVerdict,
  parseWorkflowV2ReviewerResponse,
  resolveWorkflowV2ReviewVerdict,
  workflowV2ReviewerPrompt,
} from "./workflow-v2-reviewer";

const node: WorkflowV2LLMNode = {
  id: "implement",
  kind: "implementation",
  title: "Implement",
  execModel: "llm",
        executionMode: "one-shot",
  prompt: "Implement the change",
  outputFields: [{ key: "patch", required: true }],
  constraints: [{ key: "tests", description: "Tests must pass" }],
};

const rejectVerdict: WorkflowV2ReviewVerdict = {
  decision: "reject",
  reasons: ["Tests are missing."],
  requiredFixes: ["Add regression coverage."],
  riskLevel: "high",
  evidence: ["No test file changed."],
  confidence: "high",
};

describe("workflow-v2 reviewer", () => {
  test("builds an independent review prompt and parses its structured verdict", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Ship a verified change",
      output: {
        nodeId: "implement",
        summary: "Implemented with tests",
        outputs: { patch: "diff" },
        evidence: ["Regression test passed"],
        proposals: [],
      },
    });
    const prompt = workflowV2ReviewerPrompt(input);

    expect(prompt).toContain("independent Workflow V2 reviewer");
    expect(prompt).toContain('"executorNodeId":"implement"');
    expect(parseWorkflowV2ReviewerResponse(JSON.stringify({
      reviewerNodeId: "reviewer:implement",
      verdict: {
        decision: "accept",
        reasons: ["Evidence matches the acceptance contract."],
        riskLevel: "low",
        confidence: "high",
      },
    }), "implement")).toMatchObject({
      reviewerNodeId: "reviewer:implement",
      verdict: { decision: "accept" },
    });
  });

  test("rejects self-review and malformed reviewer payloads", () => {
    expect(() => parseWorkflowV2ReviewerResponse(JSON.stringify({
      reviewerNodeId: "implement",
      verdict: {
        decision: "accept",
        reasons: ["Self approved."],
        riskLevel: "low",
        confidence: "high",
      },
    }), "implement")).toThrow("cannot certify its own output");
    expect(() => parseWorkflowV2ReviewerResponse("not json", "implement")).toThrow("not valid JSON");
  });

  test("builds independent reviewer data without worker control proposals", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Ship a tested change",
      output: {
        nodeId: "implement",
        summary: "Implemented",
        outputs: { patch: "diff" },
        risks: ["Coverage is incomplete"],
        proposals: [{ kind: "continue", reason: "Executor thinks it is done" }],
      },
    });
    expect(input.constraints).toEqual(node.constraints);
    expect(input.result.risks).toEqual(["Coverage is incomplete"]);
    expect(Object.hasOwn(input.result, "proposals")).toBe(false);
  });

  test("rejects executor self-certification", () => {
    expect(() => assertIndependentWorkflowV2Reviewer("implement", {
      reviewerNodeId: "implement",
      verdict: rejectVerdict,
    })).toThrow("cannot certify its own output");
  });

  test("validates structured verdicts at the runtime boundary", () => {
    expect(isWorkflowV2ReviewVerdict(rejectVerdict)).toBe(true);
    expect(isWorkflowV2ReviewVerdict({ decision: "reject", reasons: "missing tests" })).toBe(false);
  });

  test("resolves reject into retry before exhaustion", () => {
    expect(resolveWorkflowV2ReviewVerdict(rejectVerdict, {
      attempt: 1,
      maxRetry: 1,
      onExhausted: "fail",
    }).action).toBe("retry");
  });

  test.each([
    ["fail", "fail"],
    ["skip", "skip"],
    ["ask_human", "pause"],
  ] as const)("resolves exhausted %s policy to %s", (onExhausted, action) => {
    expect(resolveWorkflowV2ReviewVerdict(rejectVerdict, {
      attempt: 2,
      maxRetry: 1,
      onExhausted,
    }).action).toBe(action);
  });

  test("keeps escalation distinct from pause and rejection", () => {
    expect(resolveWorkflowV2ReviewVerdict({ ...rejectVerdict, decision: "escalate" }, {
      attempt: 1,
      maxRetry: 5,
      onExhausted: "fail",
    }).action).toBe("escalate");
  });
});
