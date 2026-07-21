import { describe, expect, test } from "vitest";
import {
  isWorkflowV2HumanIntervention,
  isWorkflowV2InterventionAction,
  isWorkflowV2ReviewVerdict,
} from "./review";

describe("workflow-v2 review contracts", () => {
  test("validates unified intervention and explicit script approval actions", () => {
    expect(["continue", "skip", "escalate", "replan", "increase_review_strength", "approve_once", "reject"].every(
      isWorkflowV2InterventionAction,
    )).toBe(true);
    expect(isWorkflowV2InterventionAction("retry")).toBe(false);
  });

  test("requires a bound request and only approve-once or reject for script permission", () => {
    const intervention = {
      nodeId: "write",
      source: "script_permission",
      reason: "Dangerous operation requires approval.",
      allowedActions: ["approve_once", "reject"],
      requestedAt: 1_000,
      scriptApproval: {
        requestId: "request-1",
        risk: "dangerous",
        capabilities: ["workspace_write"],
        capabilityDigest: "capability-digest",
        operationDigest: "operation-digest",
        executableSummary: "tool --write",
        workDir: "C:/workspace",
      },
    };
    expect(isWorkflowV2HumanIntervention(intervention)).toBe(true);
    expect(isWorkflowV2HumanIntervention({ ...intervention, scriptApproval: undefined })).toBe(false);
    expect(isWorkflowV2HumanIntervention({ ...intervention, allowedActions: ["continue"] })).toBe(false);
  });

  test("validates a durable supervision intervention with a resume conversation", () => {
    expect(isWorkflowV2HumanIntervention({
      nodeId: "implement",
      source: "supervision_pause",
      reason: "Needs user input.",
      allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
      requestedAt: 1_000,
      progressReport: {
        nodeId: "implement",
        attempt: 1,
        phase: "blocked",
        completedItems: ["captured checkpoint"],
        remainingItems: ["finish implementation"],
        blockers: ["needs user input"],
        evidence: ["checkpoint exists"],
        checkpoint: "checkpoint-1",
        safeToInterrupt: true,
        requestedAction: "need_input",
        reportedAt: 900,
      },
      supervisorDecision: {
        action: "pause",
        question: "Provide the missing input?",
        reason: "The task requested input.",
      },
      resumeConversation: {
        runtimeId: "codex",
        codecVersion: "1",
        payload: { native: { threadId: "thread-1" } },
      },
    })).toBe(true);
  });

  test("rejects malformed nested intervention payloads", () => {
    expect(isWorkflowV2HumanIntervention({
      nodeId: "implement",
      source: "supervision_pause",
      reason: "Needs user input.",
      allowedActions: ["continue"],
      requestedAt: 1_000,
      resumeConversation: { runtimeId: "codex", codecVersion: "1" },
    })).toBe(false);
  });

  test("validates structured reviewer verdicts at the shared persistence boundary", () => {
    expect(isWorkflowV2ReviewVerdict({
      decision: "reject",
      reasons: ["Tests are missing."],
      requiredFixes: ["Add tests."],
      riskLevel: "high",
      confidence: "high",
    })).toBe(true);
    expect(isWorkflowV2ReviewVerdict({ decision: "reject", reasons: "missing tests" })).toBe(false);
  });
});
