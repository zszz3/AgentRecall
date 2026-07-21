import type { WorkflowDraftState, WorkflowStoreState } from "../shared/workflow/draft";
import type { WorkflowRunState } from "../shared/workflow/run";

export interface WorkflowStoreDependencies {
  normalizeDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now: () => number;
  createWorkflowId: () => string;
  createRunId: () => string;
  onChange: () => void;
}

export class WorkflowStore {
  readonly workflows = new Map<string, WorkflowDraftState>();
  readonly runs = new Map<string, WorkflowRunState>();
  private activeWorkflowId: string | undefined;

  constructor(private readonly deps: WorkflowStoreDependencies) {}

  get activeId(): string | undefined {
    return this.activeWorkflowId;
  }

  set activeId(workflowId: string | undefined) {
    this.activeWorkflowId = workflowId;
  }

  workflowCount(): number {
    return this.workflows.size;
  }

  hasWorkflow(workflowId: string): boolean {
    return this.workflows.has(workflowId);
  }

  workflowValues(): WorkflowDraftState[] {
    return [...this.workflows.values()].map((workflow) => this.deps.normalizeDraft(workflow));
  }

  setWorkflow(_workflowId: string, workflow: WorkflowDraftState): void {
    const existing = this.workflows.get(workflow.workflowId);
    const guarded = existing?.topologyLocked
      ? {
          ...workflow,
          sourceType: "official" as const,
          topologyLocked: true,
          title: existing.title,
          objective: existing.objective,
          definition: structuredClone(existing.definition),
        }
      : workflow;
    const normalized = this.deps.normalizeDraft(guarded);
    this.workflows.set(normalized.workflowId, normalized);
  }

  removeWorkflow(workflowId: string): boolean {
    return this.workflows.delete(workflowId);
  }

  clearWorkflows(): void {
    this.workflows.clear();
    this.activeWorkflowId = undefined;
  }

  runValues(): WorkflowRunState[] {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  setRun(_runId: string, run: WorkflowRunState): void {
    this.runs.set(run.runId, structuredClone(run));
  }

  removeRun(runId: string): boolean {
    return this.runs.delete(runId);
  }

  clearRuns(): void {
    this.runs.clear();
  }

  getWorkflow(workflowId: string): WorkflowDraftState | undefined {
    const workflow = this.workflows.get(workflowId);
    return workflow ? this.deps.normalizeDraft(workflow) : undefined;
  }

  getRun(runId: string): WorkflowRunState | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  snapshot(): WorkflowStoreState {
    return {
      activeWorkflowId: this.activeWorkflowId,
      workflows: [...this.workflows.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((workflow) => this.deps.normalizeDraft(workflow)),
      runs: [...this.runs.values()]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((run) => structuredClone(run)),
    };
  }
}
