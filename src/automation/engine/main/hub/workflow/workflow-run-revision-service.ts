import type { ReviseWorkflowV2RunRequest, WorkflowOperationResult } from "../../../shared/workflow/commands";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2ModelProfile, WorkflowV2NodeRole } from "../../../shared/workflow-v2/definition";
import { buildWorkflowV2GraphRevision, buildWorkflowV2PlanSync } from "../../workflows/v2/workflow-v2-planner";
import type { WorkflowRuntime } from "../../workflows/workflow-runtime";
import type { WorkflowStore } from "../../workflow-store";

export class WorkflowRunRevisionService {
  constructor(private readonly deps: {
    runtime: WorkflowRuntime;
    store: WorkflowStore;
    cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
    changed: () => void;
    now: () => number;
  }) {}

  async reviseAndResume(input: ReviseWorkflowV2RunRequest): Promise<WorkflowOperationResult> {
    const workflow = this.deps.store.workflows.get(input.workflowId);
    const run = this.deps.store.runs.get(input.runId);
    if (!workflow || run?.workflowId !== input.workflowId) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow or run was not found." };
    if (workflow.topologyLocked) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Official workflow topology is locked." };
    if (run.status !== "waiting_for_user" && run.status !== "stopped" && run.status !== "failed") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run must be paused before revision." };
    if (!workflow.workflowV2Plan || !input.reason?.trim() || !input.approvedBy?.trim()) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "A frozen plan, reason, and approver are required." };
    const basedOnGraphVersion = workflow.workflowV2Plan.graphVersion;
    const definition = structuredClone(input.definition);
    definition.workflowId = workflow.workflowId;
    definition.graphVersion = basedOnGraphVersion + 1;
    if (!definition.nodes.some((node) => node.id === input.nodeId)) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "The paused node must remain in the revised workflow." };
    const oldWorkflow = structuredClone(workflow);
    const oldRun = structuredClone(run);
    let mutated = false;
    try {
      const roleModelProfiles = Object.fromEntries(Object.entries(workflow.workflowV2Plan.roleDefaults).map(([role, route]) => [role, route.modelProfile])) as Partial<Record<WorkflowV2NodeRole, WorkflowV2ModelProfile>>;
      const plan = buildWorkflowV2PlanSync({ definition, objective: workflow.objective, approvedBy: input.approvedBy.trim(), acceptanceCriteria: workflow.workflowV2Plan.acceptanceCriteria, contextBudget: workflow.workflowV2Plan.budget.context, ...(workflow.workflowV2Plan.budget.cost ? { costBudget: workflow.workflowV2Plan.budget.cost } : {}), roleModelProfiles });
      const graphRevision = buildWorkflowV2GraphRevision({ basedOnGraphVersion, nextGraphVersion: plan.graphVersion, reason: input.reason.trim(), changesSummary: `Human revised node ${input.nodeId}.`, approvedBy: input.approvedBy.trim(), now: this.deps.now() });
      const revision = workflow.revision + 1;
      this.deps.store.setWorkflow(workflow.workflowId, this.deps.cloneDraft({ ...workflow, definition: structuredClone(plan.definition), workflowV2Plan: plan, revision, confirmedRevision: revision, status: "waiting_for_user", error: undefined, updatedAt: graphRevision.createdAt }));
      this.deps.store.setRun(run.runId, { ...run, status: "waiting_for_user", workflowV2Plan: structuredClone(plan), events: [...run.events, { type: "graph_revised", nodeId: input.nodeId, at: graphRevision.createdAt, detail: JSON.stringify(graphRevision) }], finishedAt: undefined, lastError: undefined });
      mutated = true;
      this.deps.changed();
      const result = await this.deps.runtime.startWorkflowNode({ workflowId: input.workflowId, runId: input.runId, nodeId: input.nodeId });
      if (result.ok) return result;
      this.deps.store.setWorkflow(oldWorkflow.workflowId, oldWorkflow);
      this.deps.store.setRun(oldRun.runId, oldRun);
      this.deps.changed();
      return result;
    } catch (error) {
      if (mutated) {
        this.deps.store.setWorkflow(oldWorkflow.workflowId, oldWorkflow);
        this.deps.store.setRun(oldRun.runId, oldRun);
        this.deps.changed();
      }
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: error instanceof Error ? error.message : "Workflow revision failed." };
    }
  }
}
