import type { AppendWorkflowContextRequest, AppendWorkflowRunContextRequest, WorkflowOperationResult } from "../../../shared/workflow/commands";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import { isWorkflowRunTerminalStatus } from "../../../shared/workflow/run";
import type { WorkflowStore } from "../../workflow-store";
import { contextAppendLimitError, formatWorkflowContextAppend } from "./agent-hub-workflow-inputs";

export class WorkflowContextService {
  constructor(private readonly deps: {
    store: WorkflowStore;
    cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
    now: () => number;
    changed: () => void;
    limits: { maxContextAppendChars: number; maxArtifactsPerAppend: number; maxTextArtifactChars: number };
  }) {}

  appendWorkflow(input: AppendWorkflowContextRequest): WorkflowOperationResult {
    const workflow = this.deps.store.getWorkflow(input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    const error = this.limitError(input);
    if (error) return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error };
    const appended = formatWorkflowContextAppend(input.report, input.handoff, input.artifacts);
    const next = this.deps.cloneDraft({ ...workflow, contextDocument: [workflow.contextDocument.trim(), appended].filter(Boolean).join("\n\n"), revision: workflow.revision + 1, updatedAt: this.deps.now() });
    this.deps.store.setWorkflow(next.workflowId, next);
    this.deps.changed();
    return { ok: true, workflowId: next.workflowId, revision: next.revision };
  }

  appendRun(input: AppendWorkflowRunContextRequest): WorkflowOperationResult {
    const run = this.deps.store.getRun(input.runId);
    if (!run || run.workflowId !== input.workflowId) return { ok: false, error: `Workflow run ${input.runId} was not found.` };
    if (isWorkflowRunTerminalStatus(run.status)) return { ok: false, error: "Cannot append to a workflow run after it has finished." };
    const error = this.limitError(input);
    if (error) return { ok: false, workflowId: input.workflowId, error };
    const appended = formatWorkflowContextAppend(input.report, input.handoff, input.artifacts, input.nodeId);
    this.deps.store.setRun(run.runId, { ...run, contextDocument: [run.contextDocument.trim(), appended].filter(Boolean).join("\n\n") });
    this.deps.changed();
    return { ok: true, workflowId: input.workflowId };
  }

  private limitError(input: AppendWorkflowContextRequest): string | undefined {
    return contextAppendLimitError({ request: input, ...this.deps.limits });
  }
}
