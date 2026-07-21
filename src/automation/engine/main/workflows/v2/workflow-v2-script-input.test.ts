import { describe, expect, test } from "vitest";
import type { WorkflowV2ScriptParameterDef } from "../../../shared/workflow-v2/definition";
import { resolveWorkflowV2ScriptInput } from "./workflow-v2-script-input";

const parameter = (input: Partial<WorkflowV2ScriptParameterDef> & Pick<WorkflowV2ScriptParameterDef, "key" | "source">): WorkflowV2ScriptParameterDef => ({
  ...input,
  label: input.label ?? input.key,
  location: input.location ?? "argument",
  valueType: input.valueType ?? "string",
  required: input.required ?? true,
});

describe("workflow-v2 script input", () => {
  test("resolves literal, workflow, upstream, and submitted user values", () => {
    const result = resolveWorkflowV2ScriptInput({
      parameters: [
        parameter({ key: "format", source: "literal", literalValue: "markdown" }),
        parameter({ key: "topic", source: "workflow", workflowPath: "request.topic" }),
        parameter({ key: "answer", source: "upstream", upstreamNodeId: "research", upstreamOutputKey: "answer" }),
        parameter({ key: "includeSources", source: "user", valueType: "boolean" }),
      ],
      workflowContext: { request: { topic: "OpenAI" } },
      upstreamOutputs: [{ nodeId: "research", summary: "Research completed", outputs: { answer: "GPT" } }],
      submittedValues: { includeSources: true },
    });

    expect(result).toMatchObject({ complete: true, values: { format: "markdown", topic: "OpenAI", answer: "GPT", includeSources: true }, missing: [] });
  });

  test("reports only unresolved required user parameters", () => {
    const result = resolveWorkflowV2ScriptInput({
      parameters: [parameter({ key: "body", source: "user", location: "body", valueType: "json" }), parameter({ key: "note", source: "user", required: false })],
      workflowContext: {},
      upstreamOutputs: [],
      submittedValues: {},
    });

    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([expect.objectContaining({ key: "body", location: "body", valueType: "json" })]);
  });

  test("requests every unresolved user field together, including optional fields", () => {
    const result = resolveWorkflowV2ScriptInput({
      parameters: [
        parameter({ key: "query", source: "user", location: "query" }),
        parameter({ key: "authorization", source: "user", location: "header", required: false }),
        parameter({ key: "body", source: "user", location: "body", valueType: "json" }),
      ],
      workflowContext: {},
      upstreamOutputs: [],
      submittedValues: {},
    });

    expect(result).toMatchObject({ complete: false, missing: [{ key: "query" }, { key: "body" }] });
    expect(result.requested.map((item) => item.key)).toEqual(["query", "authorization", "body"]);
  });

  test("rejects a submitted enum value outside the declared request contract", () => {
    expect(() => resolveWorkflowV2ScriptInput({
      parameters: [parameter({ key: "format", source: "user", enum: ["json", "text"] })],
      workflowContext: {},
      upstreamOutputs: [],
      submittedValues: { format: "xml" },
    })).toThrow("Script parameter format must be one of: json, text.");
  });

  test("redacts secret values from audit output", () => {
    const result = resolveWorkflowV2ScriptInput({
      parameters: [parameter({ key: "token", source: "user", location: "environment", valueType: "secret" })],
      workflowContext: {},
      upstreamOutputs: [],
      submittedValues: { token: "sk-secret" },
    });

    expect(result.values.token).toBe("sk-secret");
    expect(result.auditValues.token).toBe("[REDACTED]");
    expect(JSON.stringify(result.auditValues)).not.toContain("sk-secret");
  });

  test("rejects a submitted value with the wrong declared type", () => {
    expect(() => resolveWorkflowV2ScriptInput({
      parameters: [parameter({ key: "count", source: "user", valueType: "number" })],
      workflowContext: {},
      upstreamOutputs: [],
      submittedValues: { count: "three" },
    })).toThrow("Script parameter count must be a number.");
  });
});
