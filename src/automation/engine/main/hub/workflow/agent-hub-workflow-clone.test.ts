import { describe, expect, test } from "vitest";
import { cloneWorkflowRunProgressItem } from "./agent-hub-workflow-clone";

describe("workflow progress cloning", () => {
  test("preserves and deep-clones script input requests", () => {
    const inputRequest = {
      kind: "script_parameters" as const,
      parameters: [{
        key: "text",
        label: "输入内容",
        location: "stdin" as const,
        valueType: "string" as const,
        source: "user" as const,
        required: true,
      }],
    };

    const cloned = cloneWorkflowRunProgressItem({
      nodeId: "echo-input",
      title: "原样输出用户输入",
      status: "awaiting_input",
      detail: "Waiting for 输入内容",
      inputRequest,
      outputs: { output: "hello" },
    });

    expect(cloned.inputRequest).toEqual(inputRequest);
    expect(cloned.inputRequest).not.toBe(inputRequest);
    expect(cloned.inputRequest?.kind === "script_parameters" ? cloned.inputRequest.parameters[0] : undefined).not.toBe(inputRequest.parameters[0]);
    expect(cloned.outputs).toEqual({ output: "hello" });
  });
});
