import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { buildWorkflowV2PlanSync } from "./workflow-v2-planner";
import { freezeWorkflowV2ScriptGovernance } from "./workflow-v2-script-governance";

describe("freezeWorkflowV2ScriptGovernance", () => {
  test("freezes the maximum manager reviewer and static risk per script node", () => {
    const definition: WorkflowV2Definition = { workflowId: "wf", graphVersion: 1, objective: "Write", nodes: [{ id: "write", kind: "transform", title: "Write", execModel: "script", executionMode: "script", script: { ...createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { ok: true };", risk: "read" }), capabilities: ["workspace_write"] }, outputFields: [{ key: "ok", required: true }] }], edges: [] };
    const plan = buildWorkflowV2PlanSync({ definition, approvedBy: "manager" });
    const frozen = freezeWorkflowV2ScriptGovernance({ plan, reviewedRevision: 2, reviewerRisks: { write: { level: "dangerous", rationale: "External impact" } } });
    expect(frozen.nodes[0]?.scriptGovernance).toMatchObject({ managerRisk: "read", reviewerRisk: "dangerous", staticRisk: "write", effectiveRisk: "dangerous", capabilities: ["workspace_write"], capabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/), reviewedRevision: 2 });
  });
});
