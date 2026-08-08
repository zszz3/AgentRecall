import { useCallback } from "react";
import type { WorkflowDraftState } from "../../../../../shared/types";
import type { WorkflowService } from "../../../app/services/workflow-service";

export interface RunWorkflowResult {
  ok: boolean;
  workflowRunId?: string;
  error?: string;
}

interface UseWorkflowRunnerOptions {
  workflows: WorkflowService;
  workflowId: string | undefined;
  workflowContextDocument: string;
  reviewEnabled: boolean;
}

export interface WorkflowRunnerController {
  runWorkflow: () => Promise<void>;
  runWorkflowInternal: (targetWorkflow?: WorkflowDraftState, transactionApprovalMode?: "batch" | "per_operation") => Promise<RunWorkflowResult>;
}

export function useWorkflowRunner({
  workflows,
  workflowId,
  workflowContextDocument,
  reviewEnabled,
}: UseWorkflowRunnerOptions): WorkflowRunnerController {
  const runWorkflowInternal = useCallback(async (targetWorkflow?: WorkflowDraftState, transactionApprovalMode?: "batch" | "per_operation"): Promise<RunWorkflowResult> => {
    const targetWorkflowId = targetWorkflow?.workflowId ?? workflowId;
    if (!targetWorkflowId) {
      return { ok: false, error: "Workflow was not found." };
    }

    const result = await workflows.runWorkflow({
      workflowId: targetWorkflowId,
      contextDocument: targetWorkflow?.contextDocument ?? workflowContextDocument,
      reviewEnabled,
      ...(transactionApprovalMode ? { transactionApprovalMode } : {}),
    });
    return {
      ok: result.ok,
      ...(result.runId ? { workflowRunId: result.runId } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }, [reviewEnabled, workflowContextDocument, workflowId, workflows]);

  const runWorkflow = useCallback(async (): Promise<void> => {
    await runWorkflowInternal();
  }, [runWorkflowInternal]);

  return {
    runWorkflow,
    runWorkflowInternal,
  };
}
