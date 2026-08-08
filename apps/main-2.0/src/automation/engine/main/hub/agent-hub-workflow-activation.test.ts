import { describe, expect, test, vi } from "vitest";
import { AgentHub } from "./agent-hub";
import { createWorkflowV2InlineScriptSpec } from "../../shared/workflow-v2/definition";
import { createStrictWorkflowTransactionPolicy } from "../../shared/workflow-v2/transaction";

const TEST_AGENT_ID = "runtime-agent:codex-openai";

describe("AgentHub workflow materialization", () => {
  test("rejects locked topology changes sent through the draft patch endpoint", () => {
    const hub = new AgentHub();
    hub.ensureBundledWorkflows([{
      workflowId: "bundled-patch-test",
      title: "Bundled patch test",
      objective: "Keep the official topology locked",
      definition: {
        workflowId: "bundled-patch-test",
        graphVersion: 1,
        objective: "Keep the official topology locked",
        nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }],
        edges: [],
      },
    }]);
    const before = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-patch-test")!;
    const changedDefinition = structuredClone(before.definition);
    changedDefinition.nodes[0]!.title = "Changed through patch";

    hub.patchWorkflowDraft({ workflowId: before.workflowId, definition: changedDefinition });

    const after = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === before.workflowId)!;
    expect(after.definition).toEqual(before.definition);
    expect(after.revision).toBe(before.revision);
    expect(after.error).toBe("Official workflow topology is locked.");
  });

  test("seeds bundled workflows as locked official workflows", () => {
    const hub = new AgentHub();
    hub.ensureBundledWorkflows([{
      workflowId: "bundled-test",
      title: "Bundled test",
      objective: "Test bundled workflow",
      definition: {
        workflowId: "bundled-test",
        graphVersion: 1,
        objective: "Test bundled workflow",
        nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: TEST_AGENT_ID, prompt: "Answer.", outputFields: [{ key: "answer_markdown", required: true }] }],
        edges: [],
      },
    }]);

    const bundledWorkflow = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(bundledWorkflow).toMatchObject({
      sourceType: "official",
      topologyLocked: true,
    });
    expect(bundledWorkflow.workflowV2Plan).toBeUndefined();

    const reviewUpdate = hub.updateWorkflow({
      workflowId: "bundled-test",
      expectedRevision: bundledWorkflow.revision,
      definition: { ...structuredClone(bundledWorkflow.definition), reviewEnabled: true },
    });
    expect(reviewUpdate).toMatchObject({ ok: false, error: "Official workflow topology is locked." });
    const reviewEnabledWorkflow = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(reviewEnabledWorkflow.definition.reviewEnabled).not.toBe(true);

    const routedDefinition = structuredClone(reviewEnabledWorkflow.definition);
    const routedNode = routedDefinition.nodes[0]!;
    if (routedNode.execModel !== "llm") throw new Error("Bundled test node must be an LLM node.");
    routedNode.modelId = "gpt-5.4";
    const routeUpdate = hub.updateWorkflow({
      workflowId: "bundled-test",
      expectedRevision: reviewEnabledWorkflow.revision,
      definition: routedDefinition,
    });
    expect(routeUpdate).toMatchObject({ ok: true, revision: reviewEnabledWorkflow.revision + 1 });
    const routedWorkflow = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(routedWorkflow.definition.nodes[0]).toMatchObject({ modelId: "gpt-5.4", prompt: "Answer." });

    const bundledNode = structuredClone(bundledWorkflow.definition.nodes[0]!);
    if (bundledNode.execModel !== "llm") throw new Error("Bundled test node must be an LLM node.");
    hub.ensureBundledWorkflows([{
      workflowId: "bundled-test",
      title: "Bundled test",
      objective: "Test bundled workflow",
      definition: {
        ...structuredClone(bundledWorkflow.definition),
        nodes: [{ ...bundledNode, prompt: "Updated official prompt." }],
      },
    }]);
    const refreshedWorkflow = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(refreshedWorkflow.definition.nodes[0]).toMatchObject({ modelId: "gpt-5.4", prompt: "Updated official prompt." });

    const changedTopology = structuredClone(refreshedWorkflow.definition);
    changedTopology.nodes[0]!.title = "Changed locked title";
    expect(hub.updateWorkflow({ workflowId: "bundled-test", expectedRevision: refreshedWorkflow.revision, definition: changedTopology })).toMatchObject({
      ok: false,
      error: "Official workflow topology is locked.",
    });

    hub.patchWorkflowDraft({ workflowId: "bundled-test", reviewerConfiguredAgentId: TEST_AGENT_ID });
    const configuredWorkflow = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(hub.confirmWorkflow({ workflowId: "bundled-test", expectedRevision: configuredWorkflow.revision })).toMatchObject({ ok: true });
    expect(hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")).toMatchObject({
      confirmedRevision: configuredWorkflow.revision,
      workflowV2Plan: {
        approvedBy: "workflow-confirmation",
        definition: { workflowId: "bundled-test" },
      },
    });
    const run = vi.spyOn((hub as any).workflowRunService, "run").mockReturnValue({ ok: true, workflowId: "bundled-test", runId: "run-1" });
    expect(hub.runWorkflow({ workflowId: "bundled-test", reviewEnabled: true })).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "bundled-test", reviewEnabled: false }));
  });

  test("repairs legacy bundled workflow provenance without replacing customized content", () => {
    const hub = new AgentHub();
    const legacy = hub.createWorkflowDraft().workflowDraft!;
    const customizedDefinition = {
      workflowId: legacy.workflowId,
      graphVersion: 1,
      objective: "Customized objective",
      nodes: [{ id: "custom", kind: "answer" as const, title: "Custom", execModel: "llm" as const, executionMode: "one-shot" as const, prompt: "Customized prompt.", outputFields: [{ key: "answer", required: true }] }],
      edges: [],
    };
    hub.materializeWorkflowDraft(legacy.workflowId, {
      title: "Customized bundled workflow",
      objective: "Customized objective",
      definition: customizedDefinition,
    });
    const before = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === legacy.workflowId)!;

    hub.ensureBundledWorkflows([{
      workflowId: legacy.workflowId,
      title: "Catalog title",
      objective: "Catalog objective",
      definition: {
        workflowId: legacy.workflowId,
        graphVersion: 2,
        objective: "Catalog objective",
        nodes: [{ id: "catalog", kind: "answer", title: "Catalog", execModel: "llm", executionMode: "one-shot", prompt: "Catalog prompt.", outputFields: [{ key: "answer", required: true }] }],
        edges: [],
      },
    }]);

    const repaired = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === legacy.workflowId)!;
    expect(repaired).toMatchObject({
      sourceType: "official",
      topologyLocked: true,
      title: before.title,
      objective: before.objective,
      revision: before.revision,
      updatedAt: before.updatedAt,
      definition: customizedDefinition,
    });
    expect(hub.snapshot().workflowStore.workflows).toHaveLength(1);
  });

  test("refreshes an existing official workflow from the bundled definition", () => {
    const hub = new AgentHub();
    hub.ensureBundledWorkflows([{
      workflowId: "bundled-test",
      title: "Old title",
      objective: "Old objective",
      definition: {
        workflowId: "bundled-test",
        graphVersion: 1,
        objective: "Old objective",
        nodes: [{ id: "old", kind: "answer", title: "Old", execModel: "llm", executionMode: "one-shot", prompt: "Old prompt.", outputFields: [{ key: "answer", required: true }] }],
        edges: [],
      },
    }]);
    const seeded = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(hub.updateWorkflow({
      workflowId: seeded.workflowId,
      expectedRevision: seeded.revision,
      definition: { ...structuredClone(seeded.definition), reviewEnabled: true },
    })).toMatchObject({ ok: false, error: "Official workflow topology is locked." });
    const before = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    hub.patchWorkflowDraft({
      workflowId: before.workflowId,
      status: "failed",
      runProgress: [{ nodeId: "old", title: "Old", status: "failed" }],
      runContextDocument: "Old run context",
    });

    hub.ensureBundledWorkflows([{
      workflowId: "bundled-test",
      title: "New title",
      objective: "New objective",
      definition: {
        workflowId: "bundled-test",
        graphVersion: 1,
        objective: "New objective",
        nodes: [
          { id: "collect", kind: "analysis", title: "Collect", execModel: "llm", executionMode: "one-shot", prompt: "Collect.", outputFields: [{ key: "scope", required: true }] },
          { id: "report", kind: "answer", title: "Report", execModel: "llm", executionMode: "one-shot", prompt: "Report.", outputFields: [{ key: "answer", required: true }] },
        ],
        edges: [{ fromNodeId: "collect", toNodeId: "report" }],
      },
    }]);

    const refreshed = hub.snapshot().workflowStore.workflows.find((workflow) => workflow.workflowId === "bundled-test")!;
    expect(refreshed).toMatchObject({
      sourceType: "official",
      topologyLocked: true,
      title: "New title",
      objective: "New objective",
      status: "draft",
      revision: before.revision + 1,
      runProgress: [],
      runContextDocument: "",
      definition: {
        objective: "New objective",
        reviewEnabled: false,
        nodes: [{ id: "collect" }, { id: "report" }],
      },
    });
  });

  test("reports definition validation errors when confirming a planning draft without a plan", () => {
    const hub = new AgentHub();
    const workflow = hub.createWorkflowDraft().workflowDraft!;

    expect(hub.confirmWorkflow({ workflowId: workflow.workflowId, expectedRevision: workflow.revision })).toMatchObject({
      ok: false,
      error: "Workflow V2 definition must have an objective.",
    });
  });

  test("materializes into the originating Workflow without allocating another record", () => {
    const hub = new AgentHub();
    const source = hub.createWorkflowDraft({ configuredAgentId: "default-agent" }).workflowDraft!;
    expect(source).toMatchObject({ sourceType: "user", topologyLocked: false });
    const beforeCount = hub.snapshot().workflowStore.workflows.length;
    const result = hub.materializeWorkflowDraft(source.workflowId, {
      title: "Echo workflow",
      objective: "Echo user input",
      definition: { workflowId: "ignored", graphVersion: 1, objective: "Echo user input", nodes: [{ id: "echo", kind: "transform", title: "Echo", execModel: "script", executionMode: "script", script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return inputs;" }), outputFields: [{ key: "output", required: true }] }], edges: [] },
    });
    expect(result).toMatchObject({ ok: true, workflowId: source.workflowId });
    expect(hub.snapshot().workflowStore.workflows).toHaveLength(beforeCount);
    expect(hub.snapshot().workflowDraft).toMatchObject({
      workflowId: source.workflowId,
      sourceType: "user",
      topologyLocked: false,
      definition: { workflowId: source.workflowId },
    });
  });

  test("materializes parallel terminal nodes with one generated summary node", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;

    const result = hub.materializeWorkflowDraft(workflowId, {
      title: "Parallel workflow",
      objective: "Combine parallel results",
      definition: {
        workflowId,
        graphVersion: 1,
        objective: "Combine parallel results",
        nodes: [
          { id: "left", kind: "analysis", title: "Left", execModel: "llm", executionMode: "one-shot", prompt: "Analyze left.", outputFields: [{ key: "left", required: true }] },
          { id: "right", kind: "analysis", title: "Right", execModel: "llm", executionMode: "one-shot", prompt: "Analyze right.", outputFields: [{ key: "right", required: true }] },
        ],
        edges: [],
      },
    });

    expect(result.ok).toBe(true);
    const workflow = hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)!;
    expect(workflow.definition.nodes.at(-1)).toMatchObject({
      id: "workflow-summary",
      outputFields: [{ key: "answer_markdown", required: true }],
    });
    expect(workflow.definition.edges).toEqual([
      { fromNodeId: "left", toNodeId: "workflow-summary" },
      { fromNodeId: "right", toNodeId: "workflow-summary" },
    ]);
    expect(workflow.workflowV2Plan?.definition).toEqual(workflow.definition);
  });

  test("requires confirmation and invalidates it after a draft definition change", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft({ reviewerConfiguredAgentId: TEST_AGENT_ID }).workflowDraft!.workflowId;
    const materialized = hub.materializeWorkflowDraft(workflowId, {
      title: "Answer",
      objective: "Answer",
      definition: { workflowId, graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: TEST_AGENT_ID, prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] },
    });
    expect(hub.runWorkflow({ workflowId })).toMatchObject({ ok: false, error: "Workflow must be confirmed before starting a run." });
    expect(hub.confirmWorkflow({ workflowId, ...(materialized.revision !== undefined ? { expectedRevision: materialized.revision } : {}) })).toMatchObject({ ok: true });
    const confirmed = hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)!;
    hub.patchWorkflowDraft({ workflowId, objective: "Changed answer" });
    expect(hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)).toMatchObject({ status: "draft", definition: { graphVersion: 2 } });
    expect(hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)?.confirmedRevision).toBeUndefined();
    expect(hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)?.workflowV2Plan).toBeUndefined();
    expect(confirmed.confirmedRevision).toBe(confirmed.revision);
  });

  test("fails closed before creating a run when strict transaction capabilities are unavailable", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft({ reviewerConfiguredAgentId: TEST_AGENT_ID }).workflowDraft!.workflowId;
    const materialized = hub.materializeWorkflowDraft(workflowId, {
      title: "Strict answer",
      objective: "Answer safely",
      definition: {
        workflowId,
        graphVersion: 1,
        objective: "Answer safely",
        nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: TEST_AGENT_ID, prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }],
        edges: [],
        transactionPolicy: createStrictWorkflowTransactionPolicy(),
      },
    });
    expect(hub.confirmWorkflow({ workflowId, expectedRevision: materialized.revision! })).toMatchObject({ ok: true });

    expect(hub.runWorkflow({ workflowId, transactionApprovalMode: "batch" })).toMatchObject({ ok: false, error: expect.stringContaining("strict_atomic mode is unavailable") });
    expect(hub.runWorkflow({ workflowId, triggerSource: "scheduled" })).toMatchObject({ ok: false, error: expect.stringContaining("strict_atomic mode is unavailable") });
    expect(hub.runWorkflow({ workflowId, triggerSource: "mcp" })).toMatchObject({ ok: false, error: expect.stringContaining("strict_atomic mode is unavailable") });
    expect(hub.snapshot().workflowStore.runs).toHaveLength(0);
  });

  test("derives a new editable revision from a completed frozen workflow", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const materialized = hub.materializeWorkflowDraft(workflowId, { title: "Answer", objective: "Answer", definition: { workflowId, graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] } });
    hub.confirmWorkflow({ workflowId, expectedRevision: materialized.revision! });
    hub.patchWorkflowDraft({ workflowId, status: "completed" });
    const completed = hub.snapshot().workflowDraft!;
    hub.updateWorkflowDraft({
      ...completed,
      runIds: ["run-old-version"],
      finalReport: "Old result",
      runProgress: [{ nodeId: "answer", title: "Answer", status: "completed", outputs: { answer: "old" } }],
      runContextDocument: "Old run context",
    });
    const definition = structuredClone(completed.definition);
    const node = definition.nodes[0]!;
    if (node.execModel === "llm") node.prompt = "Answer briefly.";

    const result = hub.updateWorkflow({ workflowId, expectedRevision: completed.revision, definition });

    expect(result).toMatchObject({ ok: true, revision: completed.revision + 1 });
    expect(hub.snapshot().workflowDraft).toMatchObject({ status: "draft", revision: completed.revision + 1, definition: { graphVersion: 2 } });
    expect(hub.snapshot().workflowDraft?.runIds).toEqual(["run-old-version"]);
    expect(hub.snapshot().workflowDraft?.finalReport).toBeUndefined();
    expect(hub.snapshot().workflowDraft?.runProgress).toEqual([]);
    expect(hub.snapshot().workflowDraft?.runContextDocument).toBe("");
    expect(hub.snapshot().workflowDraft?.confirmedRevision).toBeUndefined();
    expect(hub.snapshot().workflowDraft?.workflowV2Plan).toBeUndefined();
  });

  test("removes legacy Review criticality from script nodes during workflow updates", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const materialized = hub.materializeWorkflowDraft(workflowId, {
      title: "Transform",
      objective: "Transform deterministically",
      definition: {
        workflowId,
        graphVersion: 1,
        objective: "Transform deterministically",
        nodes: [{
          id: "transform",
          kind: "transform",
          title: "Transform",
          execModel: "script",
          executionMode: "script",
          script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { result: 'done' };" }),
          outputFields: [{ key: "result", required: true }],
        }],
        edges: [],
      },
    });
    const revisionBeforeUpdate = hub.snapshot().workflowDraft!.revision;
    const definition = structuredClone(hub.snapshot().workflowDraft!.definition);
    definition.nodes[0] = {
      ...definition.nodes[0]!,
      reviewLevel: "high",
      reviewMaxRetries: 2,
      judgeDimensions: [{ key: "quality", description: "Legacy script review must be ignored." }],
    };

    const result = hub.updateWorkflow({ workflowId, expectedRevision: materialized.revision, definition });

    expect(result).toMatchObject({ ok: true, revision: revisionBeforeUpdate });
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("reviewLevel");
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("reviewMaxRetries");
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("judgeDimensions");
    expect(hub.snapshot().workflowDraft?.definition.reviewGates).toEqual([]);

    hub.patchWorkflowDraft({ workflowId, definition });
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("reviewLevel");
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("reviewMaxRetries");
    expect(hub.snapshot().workflowDraft?.definition.nodes[0]).not.toHaveProperty("judgeDimensions");
    expect(hub.snapshot().workflowDraft?.definition.reviewGates).toEqual([]);
  });

  test("persists an explicit Manager Agent route on every generated LLM node", () => {
    const hub = new AgentHub();
    const draft = hub.createWorkflowDraft().workflowDraft!;
    const result = hub.materializeWorkflowDraft(draft.workflowId, {
      title: "Assigned answer",
      objective: "Answer",
      definition: {
        workflowId: draft.workflowId,
        graphVersion: 1,
        objective: "Answer",
        nodes: [
          {
            id: "answer-a",
            kind: "answer",
            title: "Answer A",
            execModel: "llm",
            executionMode: "one-shot",
            prompt: "Answer part A.",
            outputFields: [{ key: "answer", required: true }],
          },
          {
            id: "answer-b",
            kind: "answer",
            title: "Answer B",
            execModel: "llm",
            executionMode: "one-shot",
            prompt: "Answer part B.",
            outputFields: [{ key: "answer", required: true }],
          },
        ],
        edges: [],
      },
    });

    expect(result.ok).toBe(true);
    expect(draft.configuredAgentId).toBeTruthy();
    const llmNodes = hub.snapshot().workflowDraft?.definition.nodes.filter((node) => node.execModel === "llm") ?? [];
    expect(llmNodes).toHaveLength(3);
    expect(llmNodes.every((node) => node.configuredAgentId === draft.configuredAgentId)).toBe(true);
  });

  test("lets the planning agent revise a confirmed workflow in place", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const first = hub.materializeWorkflowDraft(workflowId, { title: "Answer", objective: "Answer", definition: { workflowId, graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] } });
    hub.confirmWorkflow({ workflowId, expectedRevision: first.revision! });
    const frozen = hub.snapshot().workflowDraft!;

    const revised = hub.materializeWorkflowDraft(workflowId, { title: "Short answer", objective: "Answer", definition: { ...structuredClone(frozen.definition), nodes: [{ ...frozen.definition.nodes[0]!, title: "Short answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer briefly." }] } });

    expect(revised).toMatchObject({ ok: true, revision: frozen.revision + 1 });
    expect(hub.snapshot().workflowDraft).toMatchObject({ workflowId, status: "draft", definition: { graphVersion: 2, nodes: [{ title: "Short answer" }] }, workflowV2Plan: { graphVersion: 2 } });
    expect(hub.snapshot().workflowDraft?.confirmedRevision).toBeUndefined();
  });

  test("keeps optional review feedback until executable content changes", () => {
    const hub = new AgentHub();
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const materialized = hub.materializeWorkflowDraft(workflowId, { title: "Answer", objective: "Answer", definition: { workflowId, graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] } });
    const route = hub.snapshot().workflowDraft!;
    hub.patchWorkflowDraft({ workflowId, generationReview: { status: "approved", reviewerConfiguredAgentId: route.reviewerConfiguredAgentId, reviewerModelId: route.reviewerModelId, reviewedRevision: materialized.revision!, result: { verdict: "approve", reviewedRevision: materialized.revision!, summary: "Approved", findings: [], scriptRisks: {}, suggestions: [] }, updatedAt: 1 } });
    hub.patchWorkflowDraft({ workflowId, messages: [{ id: "m1", role: "user", content: "Looks good" }] });
    expect(hub.snapshot().workflowDraft).toMatchObject({ revision: materialized.revision, generationReview: { status: "approved", reviewedRevision: materialized.revision } });
    hub.patchWorkflowDraft({ workflowId, objective: "Changed" });
    expect(hub.snapshot().workflowDraft?.generationReview).toBeUndefined();
  });

  test("prevents deleting a configured Agent that is still selected by a workflow node", () => {
    const hub = new AgentHub();
    const existing = hub.snapshot().configuredAgents;
    const specialist = { ...existing[0]!, id: "specialist", name: "Specialist", managed: false, createdAt: 2, updatedAt: 2 };
    hub.updateConfiguredAgents([...existing, specialist]);
    const workflowId = hub.createWorkflowDraft().workflowDraft!.workflowId;
    const result = hub.materializeWorkflowDraft(workflowId, { title: "Answer", objective: "Answer", definition: { workflowId, graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: specialist.id, prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] } });
    expect(result.ok).toBe(true);
    expect(() => hub.updateConfiguredAgents(existing)).toThrow(/Workflow Answer node Answer/);
  });
});
