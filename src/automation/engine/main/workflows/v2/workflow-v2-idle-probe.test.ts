import { describe, expect, test } from "vitest";
import { shouldProbeWorkflowV2Node } from "./workflow-v2-idle-probe";

describe("Workflow V2 event-driven idle probe", () => {
  const policy = { quietPeriodMs: 60_000, probeCooldownMs: 120_000, maxConsecutiveProbes: 2, hardTimeoutMs: 600_000 };
  test("does not poll while runtime events remain recent", () => expect(shouldProbeWorkflowV2Node(59_999, { startedAt: 0, lastActivityAt: 0, consecutiveProbes: 0 }, policy)).toBe(false));
  test("allows one probe after quiet period and enforces cooldown", () => {
    expect(shouldProbeWorkflowV2Node(60_000, { startedAt: 0, lastActivityAt: 0, consecutiveProbes: 0 }, policy)).toBe(true);
    expect(shouldProbeWorkflowV2Node(100_000, { startedAt: 0, lastActivityAt: 0, lastProbeAt: 60_000, consecutiveProbes: 1 }, policy)).toBe(false);
  });
  test("never probes after maximum or hard timeout", () => {
    expect(shouldProbeWorkflowV2Node(300_000, { startedAt: 0, lastActivityAt: 0, consecutiveProbes: 2 }, policy)).toBe(false);
    expect(shouldProbeWorkflowV2Node(600_000, { startedAt: 0, lastActivityAt: 0, consecutiveProbes: 0 }, policy)).toBe(false);
  });
});
