import { describe, expect, test } from "vitest";
import { decideWorkflowV2ScriptPermission } from "./workflow-v2-script-permission";

describe("decideWorkflowV2ScriptPermission", () => {
  test("uses the maximum manager reviewer and static risk", () => {
    expect(decideWorkflowV2ScriptPermission({ managerRisk: "safe", reviewerRisk: "write", staticRisk: "read", confirmed: false }).risk).toBe("write");
  });

  test.each([["safe", "auto_allow"], ["read", "auto_allow"], ["write", "require_confirmation"], ["dangerous", "require_confirmation"]] as const)("maps %s to %s", (risk, decision) => {
    expect(decideWorkflowV2ScriptPermission({ managerRisk: risk, reviewerRisk: "safe", staticRisk: "safe", confirmed: false }).decision).toBe(decision);
  });

  test("turns a confirmed risky execution into allow once", () => {
    expect(decideWorkflowV2ScriptPermission({ managerRisk: "write", reviewerRisk: "safe", staticRisk: "safe", confirmed: true }).decision).toBe("allow_once");
  });
});
