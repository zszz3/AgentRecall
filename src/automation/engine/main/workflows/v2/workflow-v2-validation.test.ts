import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2LLMNode, type WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import { validateWorkflowV2NodeOutput } from "./workflow-v2-validation";

const llmNode: WorkflowV2LLMNode = {
  id: "draft",
  kind: "draft",
  title: "Draft",
  execModel: "llm",
        executionMode: "one-shot",
  prompt: "Draft a result",
  outputFields: [{ key: "draft", required: true }],
  maxRetry: 1,
  onExhausted: "ask_human",
};

const scriptNode: WorkflowV2ScriptNode = {
  id: "verify",
  kind: "verify",
  title: "Verify",
  execModel: "script",
        executionMode: "script",
  script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "echo ok" }),
  outputFields: [{ key: "passed", required: true }],
  onError: "ask_human",
};

describe("workflow-v2 mechanical validation", () => {
  test("passes a structurally valid llm result", () => {
    expect(validateWorkflowV2NodeOutput({
      node: llmNode,
      attempt: 1,
      output: { nodeId: "draft", summary: "done", outputs: { draft: "text" }, proposals: [] },
    })).toEqual({ outcome: "pass", reasons: [], missingOutputFields: [] });
  });

  test("retries an llm result before applying its exhaustion policy", () => {
    const result = validateWorkflowV2NodeOutput({
      node: llmNode,
      attempt: 1,
      output: { nodeId: "draft", summary: "", outputs: {}, proposals: [] },
    });
    expect(result.outcome).toBe("retry");
    expect(result.missingOutputFields).toEqual(["draft"]);
  });

  test("asks a human after llm validation retries are exhausted", () => {
    expect(validateWorkflowV2NodeOutput({
      node: llmNode,
      attempt: 2,
      output: { nodeId: "draft", summary: "incomplete", outputs: {}, proposals: [] },
    }).outcome).toBe("ask_human");
  });

  test("uses the script error policy without inventing an llm retry", () => {
    expect(validateWorkflowV2NodeOutput({
      node: scriptNode,
      attempt: 1,
      output: { nodeId: "verify", summary: "invalid", outputs: {}, proposals: [] },
    }).outcome).toBe("ask_human");
  });

  test("fails a packet identity mismatch instead of retrying it", () => {
    expect(validateWorkflowV2NodeOutput({
      node: llmNode,
      attempt: 1,
      output: { nodeId: "other", summary: "done", outputs: { draft: "text" }, proposals: [] },
    }).outcome).toBe("fail");
  });
});
