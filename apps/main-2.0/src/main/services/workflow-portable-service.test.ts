import { describe, expect, test, vi } from "vitest";
import { AgentHub } from "../../automation/engine/main/hub/agent-hub";
import { portableFileFromWorkflow } from "../../automation/engine/main/hub/workflow/workflow-portable-file";
import { WorkflowPortableService } from "./workflow-portable-service";

const TEST_AGENT_ID = "runtime-agent:codex-openai";

function sourceFixture(): { hub: AgentHub; content: string } {
  const hub = new AgentHub();
  const workflow = hub.createWorkflowDraft({ title: "Portable", reviewerConfiguredAgentId: TEST_AGENT_ID }).workflowDraft!;
  const definition = {
    workflowId: workflow.workflowId,
    graphVersion: 1,
    objective: "Portable objective",
    nodes: [{ id: "answer", kind: "answer" as const, title: "Answer", execModel: "llm" as const, executionMode: "one-shot" as const, configuredAgentId: TEST_AGENT_ID, prompt: "Answer", outputFields: [{ key: "answer", required: true }] }],
    edges: [],
  };
  hub.materializeWorkflowDraft(workflow.workflowId, { title: "Portable", objective: "Portable objective", definition });
  const saved = hub.snapshot().workflowDraft!;
  return { hub, content: JSON.stringify(portableFileFromWorkflow(saved).file) };
}

describe("WorkflowPortableService", () => {
  test("keeps preview read-only and consumes a successful token once", async () => {
    const { content } = sourceFixture();
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
    await expect(service.confirmImport(preview!.previewToken)).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_PREVIEW_EXPIRED" });
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

  test("distinguishes cancelled exports and writes only chosen synthetic paths", async () => {
    const { hub } = sourceFixture();
    const workflowId = hub.snapshot().workflowDraft!.workflowId;
    const write = vi.fn(async () => undefined);
    const cancelled = new WorkflowPortableService({ hub, chooseImportFile: async () => undefined, chooseExportPath: async () => undefined, writeExportFile: write });
    await expect(cancelled.exportWorkflow(workflowId)).resolves.toEqual({ status: "cancelled" });
    expect(write).not.toHaveBeenCalled();

    const exported = new WorkflowPortableService({ hub, chooseImportFile: async () => undefined, chooseExportPath: async () => "C:\\synthetic\\Portable.agentrecall-workflow.json", writeExportFile: write });
    await expect(exported.exportWorkflow(workflowId)).resolves.toMatchObject({ status: "exported", fileName: "Portable.agentrecall-workflow.json" });
    expect(write).toHaveBeenCalledWith("C:\\synthetic\\Portable.agentrecall-workflow.json", expect.stringContaining('"format": "agentrecall.workflow"'));
  });
});
