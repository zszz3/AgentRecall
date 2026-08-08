import type { RunWorkflowRequest, StartWorkflowRunRequest, WorkflowOperationResult } from "../../shared/workflow/commands";
import type { WorkflowRunConfigurationSnapshot } from "../../shared/workflow/run";
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
  if (workflow.confirmedRevision !== workflow.revision) return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: "Workflow must be confirmed before starting a run." };
  const reviewGates = workflow.workflowV2Plan.definition.reviewGates ?? [];
  if (reviewGates.length > 0 && input.request.reviewEnabled !== true) {
    return { ok: false, workflowId: workflow.workflowId, error: "Enable Runtime Review before running a Workflow that contains Review Gates, or remove the Gates and confirm the Workflow again." };
  }
  const transactionPolicy = workflow.workflowV2Plan.definition.transactionPolicy;
  const configuredApprovalMode = transactionPolicy?.defaultMode === "direct" ? undefined : transactionPolicy?.approvalMode;
  const requestedApprovalMode = input.request.transactionApprovalMode
    ?? (configuredApprovalMode === "user_choice" && (input.request.triggerSource === "scheduled" || input.request.triggerSource === "mcp") ? "batch" : undefined);
  if (configuredApprovalMode === "user_choice" && requestedApprovalMode !== "batch" && requestedApprovalMode !== "per_operation") {
    return { ok: false, workflowId: workflow.workflowId, error: "Choose batch or per-operation approval before starting this workflow." };
  }
  if (configuredApprovalMode !== "user_choice" && requestedApprovalMode && requestedApprovalMode !== configuredApprovalMode) {
    return { ok: false, workflowId: workflow.workflowId, error: "The requested approval mode does not match the confirmed workflow policy." };
  }
  const effectiveApprovalMode = configuredApprovalMode === "user_choice" ? requestedApprovalMode : configuredApprovalMode;
  const effectiveReviewEnabled = reviewGates.length > 0 || (input.request.reviewEnabled ?? workflow.workflowV2Plan.definition.reviewEnabled === true);
  const runDefinition = {
    ...workflow.workflowV2Plan.definition,
    reviewEnabled: effectiveReviewEnabled,
    ...(effectiveApprovalMode && workflow.workflowV2Plan.definition.transactionPolicy
      ? { transactionPolicy: { ...workflow.workflowV2Plan.definition.transactionPolicy, approvalMode: effectiveApprovalMode } }
      : {}),
  };
  const runPlan = { ...workflow.workflowV2Plan, definition: runDefinition };
  const planError = workflowV2PlanValidationError({ ...workflow, workflowV2Plan: runPlan }, runPlan);
  if (planError) return { ok: false, workflowId: workflow.workflowId, error: planError };
  const initialContextDocument = input.request.contextDocument ?? workflow.contextDocument;
  const configuredAgent = snapshot.configuredAgents.find((agent) => agent.id === workflow.configuredAgentId);
  const configurationSnapshot = configuredAgent ? workflowRunConfigurationSnapshot(configuredAgent) : undefined;
  const startRequest: StartWorkflowRunRequest = {
    workflowId: workflow.workflowId,
    contextDocument: initialContextDocument,
    ...(input.request.triggerSource ? { triggerSource: input.request.triggerSource } : {}),
    ...(input.request.parentRunId ? { parentRunId: input.request.parentRunId } : {}),
    ...(configurationSnapshot ? { configurationSnapshot } : {}),
    ...(effectiveApprovalMode ? { transactionApprovalMode: effectiveApprovalMode } : {}),
    reviewEnabled: effectiveReviewEnabled,
  };
  const started = input.deps.startWorkflowRun(startRequest);
  if (!started.ok || !started.runId) return started;
  const storageDocument = workflowStoragePlanDocument(workflowStoragePlanFor(workflow.workflowId, started.runId));
  const baseWorkflowContextDocument = [initialContextDocument, storageDocument].map((item) => item.trim()).filter(Boolean).join("\n\n");
  input.deps.updateWorkflowRunState({ workflowId: workflow.workflowId, runId: started.runId, status: "running", contextDocument: baseWorkflowContextDocument });
  input.registry.register({ workflowId: workflow.workflowId, runId: started.runId, pausedNodeIds: new Set(), pausedTaskIds: new Set(), gatedNodeIds: new Set(), taskIdByNodeId: new Map(), manualPauseReasonByNodeId: new Map(), abortControllerByNodeId: new Map() });
  void input.executor.execute({ workflow: { ...workflow, workflowV2Plan: runPlan }, plan: runPlan, runId: started.runId, baseWorkflowContextDocument, storagePlanDocument: storageDocument }).finally(() => input.registry.release(started.runId!));
  return started;
}

export function workflowRunConfigurationSnapshot(input: {
  id: string;
  runtimeAgentId?: string;
  channelId?: string;
  modelId?: string;
  reasoningEffort?: string;
  revision?: number;
}): WorkflowRunConfigurationSnapshot {
  return {
    configuredAgentId: input.id,
    ...(input.runtimeAgentId ? { runtimeId: input.runtimeAgentId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.revision !== undefined ? { agentRevision: input.revision } : {}),
  };
}
