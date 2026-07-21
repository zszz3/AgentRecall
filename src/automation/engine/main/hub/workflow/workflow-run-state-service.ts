import type {
  FinishWorkflowRunRequest,
  StartWorkflowRunRequest,
  WorkflowOperationResult,
} from "../../../shared/workflow/commands";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import { isWorkflowRunTerminalStatus } from "../../../shared/workflow/run";
import type { WorkflowStore } from "../../workflow-store";
import type { WorkflowRunStateUpdate } from "../../workflows/workflow-runtime-ports";
import {
  finishWorkflowRunState,
  startWorkflowRunState,
  updateWorkflowRunState,
} from "./agent-hub-workflow-run-state";

export class WorkflowRunStateService {
  constructor(private readonly deps: {
    store: WorkflowStore;
    createRunId: () => string;
    cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
    clearDraftRequest: (workflowId: string) => void;
    changed: () => void;
  }) {}

  start(input: StartWorkflowRunRequest): WorkflowOperationResult {
    const workflow = this.deps.store.getWorkflow(input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (this.deps.store.runValues().some((run) => run.workflowId === workflow.workflowId && !isWorkflowRunTerminalStatus(run.status))) {
      return { ok: false, error: "Workflow already has an active run." };
    }
    if (!workflow.workflowV2Plan) return { ok: false, workflowId: workflow.workflowId, error: "Workflow V2 plan is required before starting a run." };
    if (workflow.confirmedRevision !== workflow.revision) {
      return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: "Workflow must be confirmed before starting a run." };
    }
    this.deps.clearDraftRequest(workflow.workflowId);
    const runId = this.deps.createRunId();
    const next = startWorkflowRunState({ workflow, request: input, runId, cloneDraft: this.deps.cloneDraft });
    this.deps.store.setRun(runId, next.nextRun);
    this.deps.store.setWorkflow(workflow.workflowId, next.nextWorkflow);
    this.deps.changed();
    return { ok: true, workflowId: workflow.workflowId, runId, revision: workflow.revision };
  }

  finish(input: FinishWorkflowRunRequest): WorkflowOperationResult {
    const workflow = this.deps.store.getWorkflow(input.workflowId);
    const run = this.deps.store.getRun(input.runId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run || run.workflowId !== input.workflowId) return { ok: false, error: `Workflow run ${input.runId} was not found.` };
    const next = finishWorkflowRunState({ workflow, run, request: input, cloneDraft: this.deps.cloneDraft });
    this.deps.store.setRun(run.runId, next.nextRun);
    this.deps.store.setWorkflow(workflow.workflowId, next.nextWorkflow);
    this.deps.changed();
    return { ok: true, workflowId: workflow.workflowId, runId: run.runId, revision: workflow.revision };
  }

  update(input: WorkflowRunStateUpdate): void {
    const workflow = this.deps.store.getWorkflow(input.workflowId);
    const run = this.deps.store.getRun(input.runId);
    if (!workflow || !run || run.workflowId !== input.workflowId) return;
    const next = updateWorkflowRunState({ workflow, run, update: input, cloneDraft: this.deps.cloneDraft });
    this.deps.store.setRun(run.runId, next.nextRun);
    this.deps.store.setWorkflow(workflow.workflowId, next.nextWorkflow);
    this.deps.changed();
  }
}
