import { describe, expect, test, vi } from "vitest";
import { AgentHub } from "../../automation/engine/main/hub/agent-hub";
import { portableFileFromWorkflow } from "../../automation/engine/main/hub/workflow/workflow-portable-file";
import { createWorkflowV2InlineScriptSpec } from "../../automation/engine/shared/workflow-v2/definition";
import { WorkflowPortableService } from "./workflow-portable-service";

const TEST_AGENT_ID = "runtime-agent:codex-openai";

function sourceFixture(): { hub: AgentHub; content: string } {
  const hub = new AgentHub();
  const workflow = hub.createWorkflowDraft({ title: "Portable" }).workflowDraft!;
  const definition = {
    workflowId: workflow.workflowId,
    graphVersion: 1,
    objective: "Portable objective",
    nodes: [{ id: "answer", kind: "answer" as const, title: "Answer", execModel: "llm" as const, executionMode: "one-shot" as const, configuredAgentId: TEST_AGENT_ID, prompt: "Answer", outputFields: [{ key: "answer", required: true }] }],
    edges: [],
    reviewGates: [{
      id: "review-answer",
      targetNodeId: "answer",
      configuredAgentId: TEST_AGENT_ID,
      reviewLevel: "high" as const,
      judgeDimensions: [{ key: "quality", description: "Check answer quality." }],
      maxQualityRetries: 2,
    }],
  };
  hub.materializeWorkflowDraft(workflow.workflowId, { title: "Portable", objective: "Portable objective", definition });
  const saved = hub.snapshot().workflowDraft!;
  return { hub, content: JSON.stringify(portableFileFromWorkflow(saved).file) };
}

describe("WorkflowPortableService", () => {
  test("keeps preview read-only and consumes a successful token once", async () => {
    const { content } = sourceFixture();
    const executionDefaults = JSON.parse(content).workflow.executionDefaults;
    expect(Object.keys(executionDefaults).sort()).toEqual(["configuredAgentId", "modelId"]);
    expect(executionDefaults).toEqual({ configuredAgentId: expect.any(String), modelId: expect.any(String) });
    const target = new AgentHub();
    const service = new WorkflowPortableService({
      hub: target,
      chooseImportFile: vi.fn(async () => ({ fileName: "fixture.agentrecall-workflow.json", content })),
      chooseExportPath: vi.fn(async () => undefined),
      writeExportFile: vi.fn(async () => undefined),
    });
    const before = target.snapshot().workflowStore.workflows.length;

    const preview = await service.beginImport();
    expect(target.snapshot().workflowStore.workflows).toHaveLength(before);
    expect(preview).toMatchObject({ fileName: "fixture.agentrecall-workflow.json", readiness: { ready: true } });
    await service.confirmImport(preview!.previewToken);
    expect(target.snapshot().workflowStore.workflows).toHaveLength(before + 1);
    expect(target.snapshot().workflowDraft).toMatchObject({ reviewerConfiguredAgentId: "", reviewerModelId: "" });
    expect(target.snapshot().workflowDraft!.definition.reviewGates).toEqual(JSON.parse(content).workflow.definition.reviewGates);
    await expect(service.confirmImport(preview!.previewToken)).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_PREVIEW_EXPIRED" });
  });

  test("accepts legacy exports with global Reviewer fields but does not import that route", async () => {
    const { content } = sourceFixture();
    const file = JSON.parse(content);
    file.workflow.executionDefaults.reviewerConfiguredAgentId = TEST_AGENT_ID;
    file.workflow.executionDefaults.reviewerModelId = "default";
    const target = new AgentHub();
    const service = new WorkflowPortableService({
      hub: target,
      chooseImportFile: async () => ({ fileName: "legacy-reviewer.agentrecall-workflow.json", content: JSON.stringify(file) }),
      chooseExportPath: async () => undefined,
      writeExportFile: async () => undefined,
    });

    const preview = await service.beginImport();
    await service.confirmImport(preview!.previewToken);

    expect(target.snapshot().workflowDraft).toMatchObject({ reviewerConfiguredAgentId: "", reviewerModelId: "" });
  });

  test("removes legacy review criticality from imported script nodes", async () => {
    const { content } = sourceFixture();
    const file = JSON.parse(content);
    file.workflow.definition.nodes = [{
      id: "transform",
      kind: "transform",
      title: "Transform",
      execModel: "script",
      executionMode: "script",
      script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { result: 'done' };" }),
      outputFields: [{ key: "result", required: true }],
      reviewLevel: "high",
      reviewMaxRetries: 2,
      judgeDimensions: [{ key: "quality", description: "Legacy script review must be removed." }],
    }];
    file.workflow.definition.reviewGates = [];
    const target = new AgentHub();
    const service = new WorkflowPortableService({
      hub: target,
      chooseImportFile: async () => ({ fileName: "legacy-script.agentrecall-workflow.json", content: JSON.stringify(file) }),
      chooseExportPath: async () => undefined,
      writeExportFile: async () => undefined,
    });

    const preview = await service.beginImport();
    expect(preview?.definitionErrors).toEqual([]);
    await service.confirmImport(preview!.previewToken);

    const importedNode = target.snapshot().workflowDraft!.definition.nodes[0]!;
    expect(importedNode).not.toHaveProperty("reviewLevel");
    expect(importedNode).not.toHaveProperty("reviewMaxRetries");
    expect(importedNode).not.toHaveProperty("judgeDimensions");
    expect(target.snapshot().workflowDraft!.definition.reviewGates).toEqual([]);
  });

  test("rejects concurrent confirmation of one preview token", async () => {
    const { content } = sourceFixture();
    const target = new AgentHub();
    const service = new WorkflowPortableService({ hub: target, chooseImportFile: async () => ({ fileName: "fixture.agentrecall-workflow.json", content }), chooseExportPath: async () => undefined, writeExportFile: async () => undefined });
    const preview = await service.beginImport();

    const first = service.confirmImport(preview!.previewToken);
    await expect(service.confirmImport(preview!.previewToken)).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_PREVIEW_EXPIRED" });
    await first;
    expect(target.snapshot().workflowStore.workflows).toHaveLength(1);
  });

  test("cancellation creates no record", async () => {
    const { content } = sourceFixture();
    const target = new AgentHub();
    const service = new WorkflowPortableService({ hub: target, chooseImportFile: async () => ({ fileName: "fixture.agentrecall-workflow.json", content }), chooseExportPath: async () => undefined, writeExportFile: async () => undefined });
    const preview = await service.beginImport();
    service.cancelImport(preview!.previewToken);
    await expect(service.confirmImport(preview!.previewToken)).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_PREVIEW_EXPIRED" });
    expect(target.snapshot().workflowStore.workflows).toHaveLength(0);
  });

  test("rejects blank drafts on both export and import without choosing or writing a file", async () => {
    const blankHub = new AgentHub();
    const blank = blankHub.createWorkflowDraft({ title: "Blank" }).workflowDraft!;
    const chooseExportPath = vi.fn(async () => "C:\\synthetic\\Blank.agentrecall-workflow.json");
    const writeExportFile = vi.fn(async () => undefined);
    const exporter = new WorkflowPortableService({
      hub: blankHub,
      chooseImportFile: async () => undefined,
      chooseExportPath,
      writeExportFile,
    });

    await expect(exporter.exportWorkflow(blank.workflowId)).rejects.toMatchObject({ code: "WORKFLOW_EXPORT_DEFINITION_INVALID" });
    expect(chooseExportPath).not.toHaveBeenCalled();
    expect(writeExportFile).not.toHaveBeenCalled();

    const blankFile = {
      format: "agentrecall.workflow",
      schemaVersion: 1,
      workflow: {
        workflowId: blank.workflowId,
        revision: blank.revision,
        title: blank.title,
        objective: "Draft objective",
        executionDefaults: { configuredAgentId: "", modelId: "" },
        definition: { ...blank.definition, objective: "Draft objective" },
      },
    };
    const importTarget = new AgentHub();
    const importer = new WorkflowPortableService({
      hub: importTarget,
      chooseImportFile: async () => ({ fileName: "blank.agentrecall-workflow.json", content: JSON.stringify(blankFile) }),
      chooseExportPath: async () => undefined,
      writeExportFile: async () => undefined,
    });

    const preview = await importer.beginImport();
    expect(preview?.definitionErrors.length).toBeGreaterThan(0);
    await expect(importer.confirmImport(preview!.previewToken)).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_DEFINITION_INVALID" });
    expect(importTarget.snapshot().workflowStore.workflows).toHaveLength(0);
  });

  test("distinguishes cancelled exports and writes only chosen synthetic paths", async () => {
    const { hub } = sourceFixture();
    const workflowId = hub.snapshot().workflowDraft!.workflowId;
    let exportedContent = "";
    const write = vi.fn(async (_filePath: string, content: string) => { exportedContent = content; });
    const cancelled = new WorkflowPortableService({ hub, chooseImportFile: async () => undefined, chooseExportPath: async () => undefined, writeExportFile: write });
    await expect(cancelled.exportWorkflow(workflowId)).resolves.toEqual({ status: "cancelled" });
    expect(write).not.toHaveBeenCalled();

    const exported = new WorkflowPortableService({ hub, chooseImportFile: async () => undefined, chooseExportPath: async () => "C:\\synthetic\\Portable.agentrecall-workflow.json", writeExportFile: write });
    await expect(exported.exportWorkflow(workflowId)).resolves.toMatchObject({ status: "exported", fileName: "Portable.agentrecall-workflow.json" });
    expect(write).toHaveBeenCalledWith("C:\\synthetic\\Portable.agentrecall-workflow.json", expect.stringContaining('"format": "agentrecall.workflow"'));

    const target = new AgentHub();
    const importer = new WorkflowPortableService({ hub: target, chooseImportFile: async () => ({ fileName: "Portable.agentrecall-workflow.json", content: exportedContent }), chooseExportPath: async () => undefined, writeExportFile: async () => undefined });
    const preview = await importer.beginImport();
    await importer.confirmImport(preview!.previewToken);
    expect(target.snapshot().workflowDraft?.definition.reviewGates).toEqual(hub.snapshot().workflowDraft?.definition.reviewGates);
  });
});
