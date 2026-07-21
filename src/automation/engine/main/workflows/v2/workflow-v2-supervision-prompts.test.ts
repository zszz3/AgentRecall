import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { DEFAULT_WORKFLOW_V2_EXECUTION_LEASE_POLICY } from "../../../shared/workflow-v2/supervision";
import {
  parseWorkflowV2ProgressReport,
  parseWorkflowV2SupervisorDecision,
  workflowV2ProgressProbePrompt,
  workflowV2SupervisorDecisionPrompt,
} from "./workflow-v2-supervision-prompts";

const node: WorkflowV2LLMNode = {
  id: "implement",
  kind: "implementation",
  title: "Implement",
  execModel: "llm",
        executionMode: "one-shot",
  prompt: "Implement the change",
  outputFields: [{ key: "patch", required: true }],
};

const report = {
  nodeId: "implement",
  attempt: 1,
  phase: "testing",
  completedItems: ["added regression test"],
  remainingItems: ["apply fix"],
  blockers: [],
  evidence: ["test reproduces failure"],
  checkpoint: "checkpoint-1",
  estimatedRemainingMs: 30_000,
  safeToInterrupt: true,
  requestedAction: "continue" as const,
  reportedAt: 1_000,
};

describe("workflow-v2 supervision prompts", () => {
  test("keeps a progress probe separate from completion and graph navigation", () => {
    const prompt = workflowV2ProgressProbePrompt({ node, attempt: 1, partialArtifact: "partial output", now: 1_000 });
    expect(prompt).toContain("Report progress only");
    expect(prompt).toContain("Do not claim final node completion");
    expect(prompt).toContain("partial output");
  });

  test("parses a fenced structured progress report", () => {
    expect(parseWorkflowV2ProgressReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``)).toEqual(report);
  });

  test("rejects free-form progress prose", () => {
    expect(() => parseWorkflowV2ProgressReport("I am about eighty percent done.")).toThrow("not valid JSON");
  });

  test("builds and parses a bounded supervisor decision", () => {
    const prompt = workflowV2SupervisorDecisionPrompt({
      node,
      report,
      policy: DEFAULT_WORKFLOW_V2_EXECUTION_LEASE_POLICY,
      extensionCount: 0,
    });
    expect(prompt).toContain("cannot mark the node completed");
    expect(parseWorkflowV2SupervisorDecision('{"action":"continue","extensionMs":1000,"reason":"Evidence is concrete."}')).toEqual({
      action: "continue",
      extensionMs: 1_000,
      reason: "Evidence is concrete.",
    });
  });

  test("rejects a malformed supervisor decision", () => {
    expect(() => parseWorkflowV2SupervisorDecision('{"action":"continue","extensionMs":0,"reason":""}')).toThrow("malformed");
  });
});
