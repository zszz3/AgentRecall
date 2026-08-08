import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import {
  createWorkflowV2ReviewerInput,
  parseWorkflowV2ReviewGateSubmission,
  parseWorkflowV2ReviewerResponse,
  resolveWorkflowV2ReviewVerdict,
  workflowV2ReviewerPrompt,
} from "./workflow-v2-reviewer";

const node: WorkflowV2LLMNode = {
  id: "critical",
  kind: "agent",
  title: "Critical result",
  execModel: "llm",
  executionMode: "one-shot",
  prompt: "Produce a verified result.",
  outputFields: [{ key: "result", required: true }],
  reviewLevel: "high",
  reviewMaxRetries: 2,
  judgeDimensions: [
    { key: "accuracy", description: "Claims must match evidence." },
    { key: "completeness", description: "All required sections must be present." },
  ],
};

describe("Workflow V2 quality reviewer", () => {
  test("uses the lowest dimension as overall quality and compares it with the node threshold", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Deliver a verified report",
      reviewAttempt: 1,
      upstreamOutputs: [],
      output: { nodeId: node.id, summary: "Candidate", outputs: { result: "draft" }, proposals: [] },
    });
    const response = parseWorkflowV2ReviewerResponse(JSON.stringify({
      reviewerNodeId: "independent-reviewer",
      verdict: {
        decision: "accept",
        reasons: ["Completeness is below the required level."],
        requiredFixes: ["Add the missing section."],
        riskLevel: "medium",
        evidence: ["Candidate output"],
        confidence: "high",
        qualityLevel: "high",
        dimensionResults: [
          { key: "accuracy", qualityLevel: "high", reason: "Claims are supported.", evidence: ["source"] },
          { key: "completeness", qualityLevel: "medium", reason: "One section is missing.", evidence: ["candidate"] },
        ],
      },
    }), input);

    expect(response.verdict).toMatchObject({ decision: "reject", qualityLevel: "medium" });
    expect(workflowV2ReviewerPrompt(input)).toContain("Deliver a verified report");
    expect(workflowV2ReviewerPrompt(input)).toContain("Write every human-readable review field in Simplified Chinese");
    expect(workflowV2ReviewerPrompt(input)).toContain("must go through the Approval Broker");
  });

  test("requires every configured dimension exactly once", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Deliver a verified report",
      reviewAttempt: 1,
      upstreamOutputs: [],
      output: { nodeId: node.id, summary: "Candidate", outputs: { result: "draft" }, proposals: [] },
    });
    expect(() => parseWorkflowV2ReviewerResponse(JSON.stringify({
      reviewerNodeId: "independent-reviewer",
      verdict: {
        decision: "accept",
        reasons: ["Only one dimension was assessed."],
        riskLevel: "low",
        confidence: "high",
        qualityLevel: "high",
        dimensionResults: [{ key: "accuracy", qualityLevel: "high", reason: "Supported.", evidence: ["source"] }],
      },
    }), input)).toThrow(/every configured judge dimension/i);
  });

  test("accepts the strict tool and JSON fallback contract and requires concrete evidence", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Deliver a verified report",
      reviewAttempt: 1,
      upstreamOutputs: [],
      output: { nodeId: node.id, summary: "Candidate", outputs: { result: "draft" }, proposals: [] },
    });
    const submission = {
      reasons: ["两个维度均已审查。"],
      riskLevel: "low",
      confidence: "high",
      dimensionResults: [
        { key: "accuracy", qualityLevel: "high", reason: "事实有依据。", evidence: ["source-1"] },
        { key: "completeness", qualityLevel: "medium", reason: "缺少一节。", evidence: ["candidate-section-list"] },
      ],
    };
    expect(parseWorkflowV2ReviewGateSubmission(submission, input).dimensionResults).toHaveLength(2);
    expect(parseWorkflowV2ReviewerResponse(JSON.stringify(submission), input).verdict).toMatchObject({ decision: "reject", qualityLevel: "medium" });
    expect(() => parseWorkflowV2ReviewGateSubmission({ ...submission, dimensionResults: [{ ...submission.dimensionResults[0], evidence: [] }, submission.dimensionResults[1]] }, input)).toThrow(/concrete evidence/i);
  });

  test("allows a context-bound Review Gate Agent whose configured ID matches the executor node ID", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Deliver a verified report",
      reviewAttempt: 1,
      upstreamOutputs: [],
      output: { nodeId: node.id, summary: "Candidate", outputs: { result: "draft" }, proposals: [] },
      gate: {
        id: "review-critical",
        targetNodeId: node.id,
        configuredAgentId: node.id,
        reviewLevel: "high",
        maxQualityRetries: 2,
        judgeDimensions: node.judgeDimensions ?? [],
      },
    });
    const response = parseWorkflowV2ReviewerResponse(JSON.stringify({
      reasons: ["证据完整。"],
      riskLevel: "low",
      confidence: "high",
      dimensionResults: [
        { key: "accuracy", qualityLevel: "high", reason: "事实一致。", evidence: ["source"] },
        { key: "completeness", qualityLevel: "high", reason: "结构完整。", evidence: ["candidate"] },
      ],
    }), input);

    expect(response.reviewerNodeId).toBe(node.id);
    expect(response.verdict.decision).toBe("accept");
  });

  test("pauses after the independent quality retry budget is exhausted", () => {
    const verdict = {
      decision: "reject" as const,
      reasons: ["Below threshold."],
      requiredFixes: ["Improve evidence."],
      riskLevel: "medium" as const,
      confidence: "high" as const,
      qualityLevel: "medium" as const,
      dimensionResults: [{ key: "accuracy", qualityLevel: "medium" as const, reason: "Incomplete evidence.", evidence: [] }],
    };
    expect(resolveWorkflowV2ReviewVerdict(verdict, { reviewAttempt: 2, maxReviewRetries: 2 }).action).toBe("retry");
    expect(resolveWorkflowV2ReviewVerdict(verdict, { reviewAttempt: 3, maxReviewRetries: 2 }).action).toBe("pause");
  });

  test("preserves upstream evidence and runtime-authored candidate receipts", () => {
    const input = createWorkflowV2ReviewerInput({
      node,
      objective: "Deliver a verified report",
      reviewAttempt: 1,
      upstreamOutputs: [{ nodeId: "source", summary: "Collected sources", outputs: { sources: ["primary"] }, evidence: ["source-1"] }],
      output: {
        nodeId: node.id,
        summary: "Candidate",
        outputs: { result: "draft" },
        proposals: [],
        acceptance: { outcome: "degraded", issues: [{ code: "warning", severity: "warning", detail: "Needs review." }], changedPaths: ["result.md"], operationIds: ["operation-1"] },
        scriptReceipt: { exitCode: 0, signal: null, timedOut: false, stderrSummary: "", stdoutDigest: "stdout", operationDigest: "operation", effectState: "workspace_changed" },
      },
    });

    expect(input.upstreamResults[0]).toMatchObject({ nodeId: "source", evidence: ["source-1"] });
    expect(input.result).toMatchObject({
      acceptance: { outcome: "degraded", changedPaths: ["result.md"] },
      scriptReceipt: { exitCode: 0, effectState: "workspace_changed" },
    });
  });
});
