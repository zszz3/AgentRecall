import type { RunWorkflowRequest, WorkflowOperationResult } from "../../shared/workflow/commands";
import { isWorkflowRunTerminalStatus } from "../../shared/workflow/run";
import { workflowStoragePlanDocument, workflowStoragePlanFor } from "../../shared/workflow-v2/runtime-utils";
import type { WorkflowRunRegistry } from "./workflow-run-registry";
import type { WorkflowRuntimeDependencies } from "./workflow-runtime-ports";
import type { WorkflowV2RunExecutor } from "./v2/workflow-v2-run-executor";
import { workflowV2PlanValidationError } from "./v2/workflow-v2-plan-validation";

export function startWorkflowRun(input: { request: RunWorkflowRequest; deps: WorkflowRuntimeDependencies; registry: WorkflowRunRegistry; executor: WorkflowV2RunExecutor }): WorkflowOperationResult {
  const snapshot = input.deps.snapshot();
  const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.request.workflowId);
  if (!workflow) return { ok: false, error: `Workflow ${input.request.workflowId} was not found.` };
  const hasRunningRun = snapshot.workflowStore.runs.some((run) => run.workflowId === workflow.workflowId && !isWorkflowRunTerminalStatus(run.status));
  if ((!isWorkflowRunTerminalStatus(workflow.status) && workflow.status !== "draft") || hasRunningRun) return { ok: false, workflowId: workflow.workflowId, error: "Workflow is already running." };
  if (!workflow.workflowV2Plan) return { ok: false, workflowId: workflow.workflowId, error: "Workflow V2 plan is required. Legacy workflow execution is no longer supported." };
  const planError = workflowV2PlanValidationError(workflow, workflow.workflowV2Plan);
  if (planError) return { ok: false, workflowId: workflow.workflowId, error: planError };
  const initialContextDocument = input.request.contextDocument ?? workflow.contextDocument;
  const started = input.deps.startWorkflowRun({ workflowId: workflow.workflowId, contextDocument: initialContextDocument });
  if (!started.ok || !started.runId) return started;
  const storageDocument = workflowStoragePlanDocument(workflowStoragePlanFor(workflow.workflowId, started.runId));
  const baseWorkflowContextDocument = [initialContextDocument, storageDocument].map((item) => item.trim()).filter(Boolean).join("\n\n");
  input.deps.updateWorkflowRunState({ workflowId: workflow.workflowId, runId: started.runId, status: "running", contextDocument: baseWorkflowContextDocument });
  input.registry.register({ workflowId: workflow.workflowId, runId: started.runId, pausedNodeIds: new Set(), pausedTaskIds: new Set(), gatedNodeIds: new Set(), taskIdByNodeId: new Map(), manualPauseReasonByNodeId: new Map(), abortControllerByNodeId: new Map() });
  void input.executor.execute({ workflow, plan: workflow.workflowV2Plan, runId: started.runId, baseWorkflowContextDocument, storagePlanDocument: storageDocument }).finally(() => input.registry.release(started.runId!));
  return started;
}
