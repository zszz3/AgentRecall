import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2ScriptSpec } from "../../../shared/workflow-v2/definition";
import { analyzeWorkflowV2Script } from "./workflow-v2-script-analysis";

describe("analyzeWorkflowV2Script", () => {
  test("keeps a restricted in-process transform safe", () => {
    expect(analyzeWorkflowV2Script(createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { echo: inputs.value };" }))).toMatchObject({ minimumRisk: "safe", detectedCapabilities: [], uncertain: false });
  });

  test.each([
    ["workspace_read", "read"], ["network_read", "read"], ["workspace_write", "write"], ["network_write", "write"],
    ["workspace_delete", "dangerous"], ["external_read", "dangerous"], ["process_spawn", "dangerous"], ["credential_read", "dangerous"],
  ] as const)("maps %s to %s", (capability, risk) => {
    const script = { ...createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return {};" }), capabilities: [capability] };
    expect(analyzeWorkflowV2Script(script).minimumRisk).toBe(risk);
  });

  test("fails closed for command execution", () => {
    const script: WorkflowV2ScriptSpec = { executable: { kind: "command", command: "tool", args: [] }, parameters: [], capabilities: [], managerRisk: { level: "safe", rationale: "" } };
    expect(analyzeWorkflowV2Script(script)).toMatchObject({ minimumRisk: "dangerous", uncertain: true });
  });
});
