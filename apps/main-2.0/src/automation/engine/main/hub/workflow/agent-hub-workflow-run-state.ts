import type {
  FinishWorkflowRunRequest,
  StartWorkflowRunRequest,
} from "../../../shared/types";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowRunState } from "../../../shared/workflow/run";
import { cloneWorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import type { WorkflowRunStateUpdate } from "../../workflows/workflow-runtime";

export function startWorkflowRunState(input: {
  workflow: WorkflowDraftState;
  request: StartWorkflowRunRequest;
  runId: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): { nextWorkflow: WorkflowDraftState; nextRun: WorkflowRunState } {
  const now = input.now ?? Date.now();
  const contextDocument = input.request.contextDocument ?? input.workflow.contextDocument;
  if (!input.workflow.workflowV2Plan) throw new Error("Workflow V2 plan is required before starting a run.");
  if (input.workflow.confirmedRevision !== input.workflow.revision) throw new Error("Workflow must be confirmed before starting a run.");
  const { finalReport: _workflowFinalReport, ...workflowWithoutFinalReport } = input.workflow;
  const workflowV2Plan = cloneWorkflowV2Plan(input.workflow.workflowV2Plan);
  if (input.request.transactionApprovalMode && workflowV2Plan.definition.transactionPolicy) {
    workflowV2Plan.definition.transactionPolicy.approvalMode = input.request.transactionApprovalMode;
  }
  if (input.request.reviewEnabled !== undefined) workflowV2Plan.definition.reviewEnabled = input.request.reviewEnabled;

  return {
    nextRun: {
      runId: input.runId,
      workflowId: input.workflow.workflowId,
      status: "running",
      triggerSource: input.request.triggerSource ?? "manual",
      ...(input.request.parentRunId ? { parentRunId: input.request.parentRunId } : {}),
      ...(input.request.configurationSnapshot ? { configurationSnapshot: structuredClone(input.request.configurationSnapshot) } : {}),
      workflowV2Plan,
      progress: [],
      events: [],
      contextDocument,
      startedAt: now,
      finishedAt: undefined,
      lastError: undefined,
    },
    nextWorkflow: input.cloneDraft({
      ...workflowWithoutFinalReport,
      status: "running",
      runIds: [...input.workflow.runIds, input.runId],
      error: undefined,
      runProgress: [],
      runContextDocument: input.request.contextDocument ?? input.workflow.runContextDocument,
      updatedAt: now,
    }),
  };
}

export function finishWorkflowRunState(input: {
  workflow: WorkflowDraftState;
  run: WorkflowRunState;
  request: FinishWorkflowRunRequest;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): { nextWorkflow: WorkflowDraftState; nextRun: WorkflowRunState } {
  const nextRun: WorkflowRunState = {
    ...input.run,
    status: input.request.status,
    progress: input.request.progress ?? input.run.progress,
    events:
      input.request.appendEvents && input.request.appendEvents.length > 0
        ? [...input.run.events, ...input.request.appendEvents]
        : input.run.events,
    contextDocument: input.request.contextDocument ?? input.run.contextDocument,
    ...((input.request.finalReport ?? input.run.finalReport) !== undefined
      ? { finalReport: input.request.finalReport ?? input.run.finalReport }
      : {}),
    finishedAt: input.now ?? Date.now(),
    lastError: input.request.lastError,
  };

  const nextWorkflow = input.cloneDraft({
    ...input.workflow,
    status: input.request.status,
    runProgress: input.request.progress ?? input.workflow.runProgress,
    runContextDocument: input.request.contextDocument ?? input.workflow.runContextDocument,
    ...((input.request.finalReport ?? input.workflow.finalReport) !== undefined
      ? { finalReport: input.request.finalReport ?? input.workflow.finalReport }
      : {}),
    error: input.request.lastError,
    updatedAt: input.now ?? Date.now(),
  });

  return { nextWorkflow, nextRun };
}

export function updateWorkflowRunState(input: {
  workflow: WorkflowDraftState;
  run: WorkflowRunState;
  update: WorkflowRunStateUpdate;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): { nextWorkflow: WorkflowDraftState; nextRun: WorkflowRunState } {
  const nextRun: WorkflowRunState = {
    ...input.run,
    status: input.update.status ?? input.run.status,
    progress: input.update.progress ?? input.run.progress,
    events:
      input.update.appendEvents && input.update.appendEvents.length > 0
        ? [...input.run.events, ...input.update.appendEvents]
        : input.run.events,
    contextDocument: input.update.contextDocument ?? input.run.contextDocument,
    ...((input.update.finalReport ?? input.run.finalReport) !== undefined
      ? { finalReport: input.update.finalReport ?? input.run.finalReport }
      : {}),
    ...((input.update.transaction ?? input.run.transaction) !== undefined
      ? { transaction: structuredClone(input.update.transaction ?? input.run.transaction!) }
      : {}),
    ...((input.update.operations ?? input.run.operations) !== undefined
      ? { operations: structuredClone(input.update.operations ?? input.run.operations!) }
      : {}),
    ...((input.update.recoveryDecisions ?? input.run.recoveryDecisions) !== undefined
      ? { recoveryDecisions: structuredClone(input.update.recoveryDecisions ?? input.run.recoveryDecisions!) }
      : {}),
    ...((input.update.recovery ?? input.run.recovery) !== undefined
      ? { recovery: structuredClone(input.update.recovery ?? input.run.recovery!) }
      : {}),
    lastError: input.update.lastError ?? input.run.lastError,
    finishedAt: input.run.finishedAt,
  };
  if (input.update.operations === null) delete nextRun.operations;
  if (input.update.recovery === null) delete nextRun.recovery;

  const nextWorkflow = input.cloneDraft({
    ...input.workflow,
    status: input.update.status ?? input.workflow.status,
    runProgress: input.update.progress ?? input.workflow.runProgress,
    runContextDocument: input.update.contextDocument ?? input.workflow.runContextDocument,
    ...((input.update.finalReport ?? input.workflow.finalReport) !== undefined
      ? { finalReport: input.update.finalReport ?? input.workflow.finalReport }
      : {}),
    error: input.update.lastError ?? input.workflow.error,
    updatedAt: input.now ?? Date.now(),
  });

  return { nextWorkflow, nextRun };
}
