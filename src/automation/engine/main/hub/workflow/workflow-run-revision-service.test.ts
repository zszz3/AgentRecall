import { describe, expect, test, vi } from "vitest";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowRunState } from "../../../shared/workflow/run";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { buildWorkflowV2PlanSync } from "../../workflows/v2/workflow-v2-planner";
import type { WorkflowRuntime } from "../../workflows/workflow-runtime";
import { WorkflowStore } from "../../workflow-store";
import { WorkflowRunRevisionService } from "./workflow-run-revision-service";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "wf-revise",
    graphVersion: 1,
    objective: "Revise a paused workflow",
    nodes: [{ id: "draft", kind: "worker", title: "Draft", execModel: "llm", executionMode: "one-shot", prompt: "Write draft", outputFields: [{ key: "draft", required: true }] }],
    edges: [],
  };
}

function fixture() {
  const store = new WorkflowStore({ normalizeDraft: structuredClone, now: () => 1, createWorkflowId: () => "wf", createRunId: () => "run", onChange: () => undefined });
  const plan = buildWorkflowV2PlanSync({ definition: definition(), approvedBy: "planner", now: 1 });
  const workflow: WorkflowDraftState = {
    workflowId: "wf-revise", sourceType: "user", topologyLocked: false, title: "Revise", status: "waiting_for_user", revision: 2, confirmedRevision: 2,
    configuredAgentId: "agent", modelId: "model", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "reviewer-model", objective: plan.objective,
    definition: structuredClone(plan.definition), workflowV2Plan: plan, messages: [], reply: "", error: undefined, runProgress: [], runContextDocument: "", contextDocument: "", runIds: ["run-revise"], createdAt: 1, updatedAt: 1,
  };
  const run: WorkflowRunState = {
    runId: "run-revise", workflowId: workflow.workflowId, status: "waiting_for_user", workflowV2Plan: structuredClone(plan),
    progress: [{ nodeId: "draft", title: "Draft", status: "paused" }], events: [], contextDocument: "", startedAt: 2, finishedAt: undefined, lastError: undefined,
  };
  store.setWorkflow(workflow.workflowId, workflow);
  store.setRun(run.runId, run);
  const startWorkflowNode = vi.fn(async () => ({ ok: true, workflowId: workflow.workflowId, runId: run.runId }));
  const service = new WorkflowRunRevisionService({ runtime: { startWorkflowNode } as unknown as WorkflowRuntime, store, cloneDraft: structuredClone, changed: vi.fn(), now: () => 10 });
  return { store, workflow, run, service, startWorkflowNode };
}

describe("WorkflowRunRevisionService", () => {
  test("validates a human revision, increments graph version, and resumes the same run", async () => {
    const value = fixture();
    const nextDefinition = definition();
    const node = nextDefinition.nodes[0]!;
    if (node.execModel === "llm") node.prompt = "Write a revised draft";

    const result = await value.service.reviseAndResume({ workflowId: value.workflow.workflowId, runId: value.run.runId, nodeId: "draft", definition: nextDefinition, reason: "Adjust the instructions", approvedBy: "human" });

    expect(result.ok).toBe(true);
    expect(value.store.workflows.get(value.workflow.workflowId)).toMatchObject({ revision: 3, confirmedRevision: 3, definition: { graphVersion: 2 } });
    expect(value.store.runs.get(value.run.runId)).toMatchObject({ runId: value.run.runId, workflowV2Plan: { graphVersion: 2 }, events: [{ type: "graph_revised", nodeId: "draft" }] });
    expect(value.startWorkflowNode).toHaveBeenCalledWith({ workflowId: value.workflow.workflowId, runId: value.run.runId, nodeId: "draft" });
  });

  test("rejects an invalid revision without mutating the frozen plan", async () => {
    const value = fixture();
    const invalid = definition();
    invalid.nodes.push(structuredClone(invalid.nodes[0]!));

    const result = await value.service.reviseAndResume({ workflowId: value.workflow.workflowId, runId: value.run.runId, nodeId: "draft", definition: invalid, reason: "Bad edit", approvedBy: "human" });

    expect(result.ok).toBe(false);
    expect(value.store.workflows.get(value.workflow.workflowId)?.workflowV2Plan?.graphVersion).toBe(1);
    expect(value.store.runs.get(value.run.runId)?.events).toEqual([]);
    expect(value.startWorkflowNode).not.toHaveBeenCalled();
  });

  test("rolls the workflow and run back when recovery cannot resume", async () => {
    const value = fixture();
    value.startWorkflowNode.mockResolvedValueOnce({ ok: false, workflowId: value.workflow.workflowId, runId: value.run.runId });

    const result = await value.service.reviseAndResume({ workflowId: value.workflow.workflowId, runId: value.run.runId, nodeId: "draft", definition: definition(), reason: "Retry safely", approvedBy: "human" });

    expect(result.ok).toBe(false);
    expect(value.store.workflows.get(value.workflow.workflowId)).toMatchObject({ revision: 2, definition: { graphVersion: 1 } });
    expect(value.store.runs.get(value.run.runId)?.events).toEqual([]);
  });
});
