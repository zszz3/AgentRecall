import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec } from "../../../shared/workflow-v2/definition";
import { executeWorkflowV2Script } from "./workflow-v2-script-executor";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";

describe("workflow-v2 script executor", () => {
  test("executes an auto-authorized inline typescript transform", async () => {
    const node = {
      id: "echo",
      kind: "transform",
      title: "Echo",
      execModel: "script" as const,
      executionMode: "script" as const,
      outputFields: [{ key: "result", required: true }],
      script: {
        executable: { kind: "inline" as const, language: "typescript" as const, code: "return { result: 'ok' };" },
        parameters: [],
        capabilities: [],
        managerRisk: { level: "safe" as const, rationale: "Pure in-memory transform." },
        outputSchema: { type: "object" as const, required: ["result"] },
      },
    };
    const workDir = process.cwd();
    const output = await executeWorkflowV2Script({
      node,
      workDir,
      upstreamOutputs: [],
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: workflowV2ScriptCapabilityDigest([]), operationDigest: workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir, inputs: {} }) },
    });

    expect(output.outputs).toEqual({ result: "ok" });
  });

  test("rejects an authorization whose capability digest does not match", async () => {
    await expect(executeWorkflowV2Script({
      node: { id: "echo", kind: "transform", title: "Echo", execModel: "script", executionMode: "script", outputFields: [], script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return {};" }) },
      workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: "stale", operationDigest: "stale" },
    })).rejects.toThrow("capability digest");
  });
});
