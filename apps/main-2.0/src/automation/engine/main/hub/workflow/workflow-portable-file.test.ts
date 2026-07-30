import { describe, expect, test } from "vitest";
import type { WorkflowDraftState, WorkflowV2Definition } from "../../../shared/types";
import {
  WORKFLOW_PORTABLE_MAX_BYTES,
  WorkflowPortableError,
  applyWorkflowImportMappings,
  parseWorkflowPortableFile,
  portableFileFromWorkflow,
  safeWorkflowExportFileName,
  sanitizeWorkflowPortableDefinition,
  workflowImportPreview,
} from "./workflow-portable-file";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "wf-source",
    graphVersion: 1,
    objective: "Move a workflow",
    nodes: [{
      id: "script",
      kind: "script",
      title: "Script",
      execModel: "script",
      executionMode: "script",
      outputFields: [{ key: "result", required: true }],
      script: {
        executable: { kind: "inline", language: "typescript", code: "return inputs;" },
        parameters: [
          { key: "token", label: "Token", location: "environment", valueType: "secret", source: "literal", required: true, defaultValue: "secret-default", literalValue: "secret-literal" },
          { key: "count", label: "Count", location: "argument", valueType: "number", source: "literal", required: true, defaultValue: 3, literalValue: 4 },
        ],
        capabilities: [],
        managerRisk: { level: "safe", rationale: "Pure transformation." },
      },
    }],
    edges: [],
  };
}

function workflow(sourceType: "official" | "user" = "user"): WorkflowDraftState {
  return {
    workflowId: "wf-source",
    sourceType,
    topologyLocked: sourceType === "official",
    title: "Portable: workflow?",
    status: "draft",
    revision: 7,
    confirmedRevision: 7,
    configuredAgentId: "agent-a",
    modelId: "model-a",
    reviewerConfiguredAgentId: "agent-b",
    reviewerModelId: "model-b",
    objective: "Move a workflow",
    definition: definition(),
    workDir: "C:\\private\\repo",
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "private runtime context",
    contextDocument: "private context",
    finalReport: "private report",
    runIds: ["run-1"],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("workflow portable files", () => {
  test("exports only the portable contract and removes secret literals", () => {
    const result = portableFileFromWorkflow(workflow());

    expect(result.removedSecretValueCount).toBe(2);
    expect(result.file.workflow).toMatchObject({ workflowId: "wf-source", revision: 7, title: "Portable: workflow?" });
    expect(result.file.workflow).not.toHaveProperty("workDir");
    expect(result.file.workflow).not.toHaveProperty("runIds");
    const script = result.file.workflow.definition.nodes[0];
    if (script?.execModel !== "script") throw new Error("expected script fixture");
    expect(script.script.parameters[0]).not.toHaveProperty("defaultValue");
    expect(script.script.parameters[0]).not.toHaveProperty("literalValue");
    expect(script.script.parameters[1]).toMatchObject({ defaultValue: 3, literalValue: 4 });
  });

  test("sanitizes hand-authored imports again without mutating the input", () => {
    const source = definition();
    const result = sanitizeWorkflowPortableDefinition(source);
    const sourceScript = source.nodes[0];
    const resultScript = result.definition.nodes[0];
    if (sourceScript?.execModel !== "script" || resultScript?.execModel !== "script") throw new Error("expected script fixture");

    expect(result.removedSecretValueCount).toBe(2);
    expect(sourceScript.script.parameters[0]).toHaveProperty("literalValue", "secret-literal");
    expect(resultScript.script.parameters[0]).not.toHaveProperty("literalValue");
  });

  test("round trips a valid v1 file and reports preview facts", () => {
    const exported = portableFileFromWorkflow(workflow()).file;
    const content = JSON.stringify(exported);
    const parsed = parseWorkflowPortableFile(content);
    const preview = workflowImportPreview({ previewToken: "preview-1", fileName: "fixture.agentrecall-workflow.json", content }).preview;

    expect(parsed.file).toEqual(exported);
    expect(parsed.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview).toMatchObject({ previewToken: "preview-1", sourceWorkflowId: "wf-source", sourceRevision: 7, nodeCount: 1, edgeCount: 0 });
    expect(preview.scripts).toEqual([{ nodeId: "script", title: "Script", effectiveRisk: "safe", capabilities: [], uncertain: false }]);
  });

  test.each([
    [{ schemaVersion: 1, workflow: {} }, "WORKFLOW_IMPORT_FORMAT_UNSUPPORTED"],
    [{ format: "agentrecall.workflow", workflow: {} }, "WORKFLOW_IMPORT_VERSION_UNSUPPORTED"],
    [{ format: "agentrecall.workflow", schemaVersion: 2, workflow: {} }, "WORKFLOW_IMPORT_VERSION_UNSUPPORTED"],
    [{ format: "agentrecall.workflow", schemaVersion: 1, workflow: {}, extra: true }, "WORKFLOW_IMPORT_SCHEMA_INVALID"],
  ])("rejects invalid envelopes", (value, code) => {
    expect(() => parseWorkflowPortableFile(JSON.stringify(value))).toThrowError(expect.objectContaining({ code }));
  });

  test("rejects mismatched ids, oversized files, invalid json, and official export", () => {
    const mismatched = portableFileFromWorkflow(workflow()).file;
    mismatched.workflow.definition.workflowId = "wf-other";
    expect(() => parseWorkflowPortableFile(JSON.stringify(mismatched))).toThrowError(expect.objectContaining({ code: "WORKFLOW_IMPORT_SCHEMA_INVALID" }));
    expect(() => parseWorkflowPortableFile("{".repeat(WORKFLOW_PORTABLE_MAX_BYTES + 1))).toThrowError(expect.objectContaining({ code: "WORKFLOW_IMPORT_FILE_TOO_LARGE" }));
    expect(() => parseWorkflowPortableFile("{" )).toThrowError(expect.objectContaining({ code: "WORKFLOW_IMPORT_INVALID_JSON" }));
    expect(() => portableFileFromWorkflow(workflow("official"))).toThrowError(expect.objectContaining({ code: "WORKFLOW_EXPORT_OFFICIAL_FORBIDDEN" }));
  });

  test("creates a Windows-safe export name", () => {
    expect(safeWorkflowExportFileName("Portable: workflow? .")).toBe("Portable- workflow-.agentrecall-workflow.json");
    expect(new WorkflowPortableError("WORKFLOW_IMPORT_INVALID_JSON", "bad").name).toBe("WorkflowPortableError");
  });

  test("applies mappings to node models that inherit the Workflow Agent", () => {
    const file = portableFileFromWorkflow(workflow()).file;
    file.workflow.executionDefaults.configuredAgentId = "missing-agent";
    file.workflow.executionDefaults.modelId = "missing-default-model";
    file.workflow.definition.nodes = [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", modelId: "missing-node-model", prompt: "Answer", outputFields: [{ key: "answer" }] }];
    const mapped = applyWorkflowImportMappings({
      file,
      mapping: { agentMappings: { "missing-agent": "agent-local" }, modelMappings: { ["missing-agent\u0000missing-node-model"]: "model-local" } },
      configuredAgents: [{ id: "agent-local", name: "Local", description: "", runtimeAgentId: "codex", channelId: "channel-local", modelId: "model-local", tags: [], createdAt: 1, updatedAt: 1 }],
      channels: [{ id: "channel-local", agentId: "codex", label: "Local", models: [{ id: "model-local", label: "Local" }] }],
    });
    const node = mapped.workflow.definition.nodes[0];
    expect(mapped.workflow.executionDefaults).toMatchObject({ configuredAgentId: "agent-local", modelId: "model-local" });
    expect(node?.execModel === "llm" ? node.modelId : undefined).toBe("model-local");
  });
});
