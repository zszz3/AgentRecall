import { describe, expect, test, vi } from "vitest";
import { AgentHub } from "../agent-hub";
import { portableFileFromWorkflow } from "./workflow-portable-file";

function seedOfficial(hub: AgentHub): void {
  hub.ensureBundledWorkflows([{
    workflowId: "official-portable",
    title: "Official portable",
    objective: "Use as a template",
    definition: {
      workflowId: "official-portable",
      graphVersion: 1,
      objective: "Use as a template",
      nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer", outputFields: [{ key: "answer", required: true }] }],
      edges: [],
    },
  }]);
}

describe("AgentHub portable workflows", () => {
  test("clones an official workflow into independent, reset personal drafts", async () => {
    const hub = new AgentHub();
    seedOfficial(hub);

    await hub.cloneOfficialWorkflow("official-portable");
    await hub.cloneOfficialWorkflow("official-portable");
    const copies = hub.snapshot().workflowStore.workflows.filter((workflow) => workflow.sourceType === "user");

    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((workflow) => workflow.workflowId)).size).toBe(2);
    expect(copies.map((workflow) => workflow.title).sort()).toEqual(["Official portable - 副本", "Official portable - 副本 2"].sort());
    for (const copy of copies) {
      expect(copy).toMatchObject({ sourceType: "user", topologyLocked: false, status: "draft", revision: 1, runIds: [], messages: [], contextDocument: "", runContextDocument: "" });
      expect(copy.confirmedRevision).toBeUndefined();
      expect(copy.definition.workflowId).toBe(copy.workflowId);
      expect(copy.origin?.rootOrigin).toMatchObject({ workflowId: "official-portable", trust: "catalog" });
    }
    expect(hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "official-portable")).toMatchObject({ sourceType: "official", topologyLocked: true });
  });

  test("imports a sanitized personal copy and treats file provenance as an untrusted claim", async () => {
    const sourceHub = new AgentHub();
    seedOfficial(sourceHub);
    const clonedSnapshot = await sourceHub.cloneOfficialWorkflow("official-portable");
    const source = clonedSnapshot.workflowDraft!;
    const portable = portableFileFromWorkflow(source).file;

    const targetHub = new AgentHub();
    await targetHub.importPortableWorkflow(portable, "portable.agentrecall-workflow.json");
    const imported = targetHub.snapshot().workflowDraft!;

    expect(imported.workflowId).not.toBe(source.workflowId);
    expect(imported.definition.workflowId).toBe(imported.workflowId);
    expect(imported).toMatchObject({ sourceType: "user", topologyLocked: false, status: "draft", revision: 1 });
    expect(imported.origin).toMatchObject({
      importedFrom: { fileName: "portable.agentrecall-workflow.json", workflowId: source.workflowId, revision: 1 },
      rootOrigin: { workflowId: "official-portable", trust: "file_claim" },
    });
  });

  test("keeps unresolved exact identifiers as an editable draft but blocks confirmation", async () => {
    const sourceHub = new AgentHub();
    seedOfficial(sourceHub);
    const source = (await sourceHub.cloneOfficialWorkflow("official-portable")).workflowDraft!;
    const portable = portableFileFromWorkflow(source).file;
    portable.workflow.executionDefaults.configuredAgentId = "missing-agent";

    const targetHub = new AgentHub();
    await targetHub.importPortableWorkflow(portable, "missing.agentrecall-workflow.json");
    const imported = targetHub.snapshot().workflowDraft!;

    expect(imported.configuredAgentId).toBe("missing-agent");
    expect(targetHub.workflowReadiness(imported.workflowId)).toMatchObject({ ready: false, issues: expect.arrayContaining([expect.objectContaining({ code: "AGENT_MISSING" })]) });
    expect(targetHub.confirmWorkflow({ workflowId: imported.workflowId, expectedRevision: imported.revision })).toMatchObject({ ok: false, error: expect.stringContaining("missing-agent") });
  });

  test("rolls back the new record and active selection when persistence fails", async () => {
    const sourceHub = new AgentHub();
    seedOfficial(sourceHub);
    const source = (await sourceHub.cloneOfficialWorkflow("official-portable")).workflowDraft!;
    const portable = portableFileFromWorkflow(source).file;
    const targetHub = new AgentHub();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await targetHub.loadPersistedState({ label: "synthetic failing store", load: async () => undefined, save: async () => { throw new Error("synthetic save failure"); }, close: () => undefined });
    const before = targetHub.snapshot().workflowStore;

    await expect(targetHub.importPortableWorkflow(portable, "fixture.agentrecall-workflow.json")).rejects.toMatchObject({ code: "WORKFLOW_IMPORT_PERSIST_FAILED" });
    expect(targetHub.snapshot().workflowStore.workflows).toHaveLength(before.workflows.length);
    expect(targetHub.snapshot().workflowStore.activeWorkflowId).toBe(before.activeWorkflowId);
    warning.mockRestore();
  });
});
