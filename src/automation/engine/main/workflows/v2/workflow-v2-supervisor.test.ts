import { describe, expect, test } from "vitest";
import { DEFAULT_WORKFLOW_V2_EXECUTION_LEASE_POLICY } from "../../../shared/workflow-v2/supervision";
import {
  assertWorkflowV2ProgressReportIdentity,
  createWorkflowV2ExecutionLease,
  inspectWorkflowV2ExecutionLease,
  isWorkflowV2ProgressReport,
  resolveWorkflowV2SupervisorDecision,
  validateWorkflowV2ExecutionLeasePolicy,
} from "./workflow-v2-supervisor";

const policy = DEFAULT_WORKFLOW_V2_EXECUTION_LEASE_POLICY;

function report(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "implement",
    attempt: 1,
    phase: "writing tests",
    completedItems: ["added failing test"],
    remainingItems: ["implement fix"],
    blockers: [],
    evidence: ["test fails before fix"],
    estimatedRemainingMs: 60_000,
    safeToInterrupt: true,
    requestedAction: "continue" as const,
    reportedAt: 100_000,
    ...overrides,
  };
}

describe("workflow-v2 execution supervisor", () => {
  test("validates ordered soft and hard lease boundaries", () => {
    expect(validateWorkflowV2ExecutionLeasePolicy(policy)).toBe(true);
    expect(validateWorkflowV2ExecutionLeasePolicy({ ...policy, softTimeoutMs: policy.hardTimeoutMs })).toBe(false);
  });

  test("distinguishes active, probe-required, and hard-timeout states", () => {
    const lease = createWorkflowV2ExecutionLease({ nodeId: "implement", attempt: 1, startedAt: 0, policy });
    expect(inspectWorkflowV2ExecutionLease({ lease, policy, now: 1_000 })).toBe("active");
    expect(inspectWorkflowV2ExecutionLease({ lease, policy, now: policy.inactivityTimeoutMs })).toBe("probe_required");
    expect(inspectWorkflowV2ExecutionLease({ lease, policy, now: policy.hardTimeoutMs })).toBe("hard_timeout");
  });

  test("rejects malformed and wrong-attempt progress reports", () => {
    const lease = createWorkflowV2ExecutionLease({ nodeId: "implement", attempt: 1, startedAt: 0, policy });
    expect(isWorkflowV2ProgressReport(report())).toBe(true);
    expect(isWorkflowV2ProgressReport(report({ completedItems: "done" }))).toBe(false);
    expect(() => assertWorkflowV2ProgressReportIdentity(lease, report({ attempt: 2 }))).toThrow("identity does not match");
  });

  test("renews only when the report contains new evidence or completed work", () => {
    const lease = createWorkflowV2ExecutionLease({ nodeId: "implement", attempt: 1, startedAt: 0, policy });
    const firstReport = report();
    const resolution = resolveWorkflowV2SupervisorDecision({
      lease,
      policy,
      report: firstReport,
      decision: { action: "continue", extensionMs: 30_000, reason: "Progress is evidenced." },
      now: 100_000,
    });
    expect(resolution.action).toBe("continue");
    if (resolution.action === "continue") {
      expect(resolution.lease.extensionCount).toBe(1);
      expect(resolution.lease.softDeadlineAt).toBe(130_000);
    }

    expect(() => resolveWorkflowV2SupervisorDecision({
      lease,
      policy,
      report: report({ reportedAt: 110_000 }),
      previousReport: firstReport,
      decision: { action: "continue", extensionMs: 30_000, reason: "No actual progress." },
      now: 110_000,
    })).toThrow("without new evidence");
  });

  test("never renews beyond extension or hard-timeout limits", () => {
    const lease = createWorkflowV2ExecutionLease({ nodeId: "implement", attempt: 1, startedAt: 0, policy });
    expect(() => resolveWorkflowV2SupervisorDecision({
      lease,
      policy,
      report: report(),
      decision: { action: "continue", extensionMs: policy.maxExtensionMs + 1, reason: "Too long." },
      now: 100_000,
    })).toThrow("configured maximum");

    expect(resolveWorkflowV2SupervisorDecision({
      lease,
      policy,
      report: report({ reportedAt: policy.hardTimeoutMs }),
      decision: { action: "continue", extensionMs: 1_000, reason: "Too late." },
      now: policy.hardTimeoutMs,
    })).toEqual({ action: "cancel", reason: "Workflow V2 node implement reached its hard timeout." });
  });

  test("keeps retry, escalation, pause, and cancel decisions explicit", () => {
    const lease = createWorkflowV2ExecutionLease({ nodeId: "implement", attempt: 1, startedAt: 0, policy });
    const base = { lease, policy, report: report(), now: 100_000 };
    expect(resolveWorkflowV2SupervisorDecision({
      ...base,
      decision: { action: "retry", fromCheckpoint: "checkpoint-1", reason: "Current attempt is stuck." },
    }).action).toBe("retry");
    expect(resolveWorkflowV2SupervisorDecision({
      ...base,
      decision: { action: "escalate", modelProfile: "expert", reason: "Needs stronger reasoning." },
    }).action).toBe("escalate");
    expect(resolveWorkflowV2SupervisorDecision({
      ...base,
      decision: { action: "pause", question: "Provide the missing credential?", reason: "Needs user input." },
    }).action).toBe("pause");
    expect(resolveWorkflowV2SupervisorDecision({
      ...base,
      decision: { action: "cancel", reason: "No useful progress." },
    }).action).toBe("cancel");
  });
});
