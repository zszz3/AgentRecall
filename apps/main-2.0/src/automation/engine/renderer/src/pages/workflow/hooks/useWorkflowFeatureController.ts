import { useMemo } from "react";
import type { AppSnapshot, ApprovalDecision, WorkflowRunState } from "../../../../../shared/types";
import type { WorkflowService } from "../../../app/services/workflow-service";
import type { WorkflowController } from "../workflow-controller";
import type { WorkflowDraftController } from "./useWorkflowDraft";
import type { WorkflowRunnerController } from "./useWorkflowRunner";

interface UseWorkflowFeatureControllerOptions {
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
  workflows: WorkflowService;
  draft: WorkflowDraftController;
  runner: WorkflowRunnerController;
  language: "en" | "zh";
  globalReviewEnabled: boolean;
  runtimeReviewEnabled: boolean;
  onChooseWorkDir: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onReadOutputFile?: WorkflowController["onReadOutputFile"];
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>;
}

export function selectWorkflowRunContext(runs: WorkflowRunState[], workflowId: string | undefined, latestRunId: string | undefined): WorkflowRunState | undefined {
  const workflowRuns = runs.filter((run) => run.workflowId === workflowId);
  return workflowRuns.find((run) => run.status === "running" || run.status === "waiting_for_user")
    ?? (latestRunId ? workflowRuns.find((run) => run.runId === latestRunId && (run.status === "stopped" || run.status === "failed")) : undefined);
}

export function useWorkflowFeatureController({
  snapshot,
  setSnapshot,
  workflows,
  draft,
  runner,
  language,
  globalReviewEnabled,
  runtimeReviewEnabled,
  onChooseWorkDir,
  onRefresh,
  onReadOutputFile,
  onResolveRuntimeApproval,
}: UseWorkflowFeatureControllerOptions): WorkflowController {
  const activeWorkflow = snapshot.workflowStore.workflows.find((workflow) => workflow.workflowId === draft.workflowId);
  const latestRunId = activeWorkflow?.runIds.at(-1);
  const activeRun = selectWorkflowRunContext(snapshot.workflowStore.runs, draft.workflowId, latestRunId);
  const workflowRuns = useMemo(
    () => snapshot.workflowStore.runs
      .filter((run) => run.workflowId === draft.workflowId)
      .sort((left, right) => right.startedAt - left.startedAt),
    [draft.workflowId, snapshot.workflowStore.runs],
  );
  const activeRunId = activeRun?.runId;
  const nodeConversations = activeRunId
    ? snapshot.workflowNodeConversations.filter((conversation) => conversation.workflowId === draft.workflowId && conversation.runId === activeRunId)
    : [];
  const runHistoryConversations = snapshot.workflowNodeConversations.filter((conversation) => conversation.workflowId === draft.workflowId);
  const artifacts = activeRunId ? (snapshot.artifacts ?? []).filter((artifact) => artifact.target === activeRunId) : [];
  const runHistoryArtifacts = (snapshot.artifacts ?? []).filter((artifact) => workflowRuns.some((run) => run.runId === artifact.target));

  return useMemo(
    () => ({
      ...(draft.workflowId ? { workflowId: draft.workflowId } : {}),
      sourceType: activeWorkflow?.sourceType ?? "user",
      topologyLocked: activeWorkflow?.topologyLocked === true,
      title: draft.workflowTitle,
      status: draft.workflowStatus,
      ...(activeWorkflow ? { revision: activeWorkflow.revision } : {}),
      ...(activeWorkflow?.confirmedRevision !== undefined ? { confirmedRevision: activeWorkflow.confirmedRevision } : {}),
      definition: draft.workflowDefinition,
      definitionReady: draft.workflowDefinitionReady,
      objective: draft.workflowObjective,
      messages: draft.workflowMessages,
      reply: draft.workflowReply,
      error: draft.workflowError,
      configuredAgentId: draft.workflowConfiguredAgentId,
      modelId: draft.workflowModelId,
      reviewerConfiguredAgentId: draft.workflowReviewerConfiguredAgentId,
      reviewerModelId: draft.workflowReviewerModelId,
      generationReview: activeWorkflow?.generationReview,
      reviewFeatureEnabled: globalReviewEnabled && activeWorkflow?.sourceType !== "official" && activeWorkflow?.topologyLocked !== true,
      runtimeReviewFeatureEnabled: runtimeReviewEnabled && activeWorkflow?.sourceType !== "official" && activeWorkflow?.topologyLocked !== true,
      runtimes: snapshot.runtimes,
      channels: snapshot.channels,
      configuredAgents: snapshot.configuredAgents,
      workDir: snapshot.workDir,
      running: draft.workflowRunning,
      runProgress: draft.workflowRunProgress,
      ...(activeRunId ? { activeRunId } : {}),
      ...(activeRun ? { activeRunStatus: activeRun.status } : {}),
      artifacts,
      runHistoryArtifacts,
      contextDocument: draft.workflowRunContextDocument,
      finalReport: draft.workflowFinalReport,
      ...(activeWorkflow?.workflowV2Plan ? { workflowV2Plan: activeWorkflow.workflowV2Plan } : {}),
      runs: workflowRuns,
      runHistoryConversations,
      nodeTasks: snapshot.tasks.filter((task) => draft.workflowRunProgress.some((item) => item.taskId === task.id || item.reviewTaskId === task.id)),
      nodeConversations,
      onObjectiveChange: draft.setWorkflowObjective,
      onPauseNode: async (nodeId: string) => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.pauseNode({ workflowId: draft.workflowId, runId: activeRunId, nodeId });
        if (!result.ok && result.error) {
          const next = await workflows.patchDraft({ workflowId: draft.workflowId, error: result.error });
          setSnapshot(next);
        }
      },
      onStartNode: async (nodeId: string) => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.startNode({ workflowId: draft.workflowId, runId: activeRunId, nodeId });
        if (!result.ok && result.error) {
          const next = await workflows.patchDraft({ workflowId: draft.workflowId, error: result.error });
          setSnapshot(next);
        }
      },
      onStopRun: async () => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.stopRun({ workflowId: draft.workflowId, runId: activeRunId });
        if (!result.ok && result.error) setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error: result.error }));
      },
      onSendNodeMessage: async (conversationId, message) => setSnapshot(await workflows.sendNodeMessage({ conversationId, message })),
      onCompleteNodeConversation: async (conversationId) => {
        const result = await workflows.completeNodeConversation({ conversationId });
        if (!result.ok) {
          const error = result.error ?? "Workflow node completion could not be confirmed.";
          if (draft.workflowId) setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error }));
          throw new Error(error);
        }
      },
      onReviseRun: async (nodeId, definition, reason) => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.reviseRun({ workflowId: draft.workflowId, runId: activeRunId, nodeId, definition, reason, approvedBy: "desktop-user" });
        if (!result.ok) {
          const error = result.error ?? "Workflow revision could not be applied.";
          setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error }));
          throw new Error(error);
        }
        await onRefresh();
      },
      onSubmitScriptInput: async (nodeId, values) => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.submitScriptInput({ workflowId: draft.workflowId, runId: activeRunId, nodeId, values });
        if (!result.ok) {
          const error = result.error ?? "Workflow script input could not be submitted.";
          setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error }));
          throw new Error(error);
        }
        await onRefresh();
      },
      onResolveIntervention: async (nodeId, action, reason) => {
        if (!draft.workflowId || !activeRunId) return;
        const result = await workflows.resolveIntervention({
          workflowId: draft.workflowId,
          runId: activeRunId,
          nodeId,
          action,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        });
        if (!result.ok) {
          const error = result.error ?? "Workflow intervention could not be resolved.";
          setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error }));
          throw new Error(error);
        }
        await onRefresh();
      },
      onResolveRecovery: async (runId, action, reason) => {
        if (!draft.workflowId) return;
        const result = await workflows.resolveRecovery({
          workflowId: draft.workflowId,
          runId,
          action,
          actor: "desktop-user",
          reason: reason.trim(),
        });
        if (!result.ok) {
          const error = result.error ?? "Workflow recovery action could not be applied.";
          setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error }));
          throw new Error(error);
        }
        await onRefresh();
      },
      onRefreshRecovery: async (runId) => {
        if (!draft.workflowId) return;
        const result = await workflows.refreshRecovery({ workflowId: draft.workflowId, runId });
        if (!result.ok) throw new Error(result.error ?? "Workflow recovery could not be refreshed.");
        await onRefresh();
      },
      onResolveConflict: async (runId, input) => {
        if (!draft.workflowId) return;
        const result = await workflows.resolveConflict({ workflowId: draft.workflowId, runId, path: input.path, resolution: input.resolution, ...(input.expectedCurrentSha256 ? { expectedCurrentSha256: input.expectedCurrentSha256 } : {}), ...(input.content !== undefined ? { content: input.content } : {}), actor: "desktop-user", reason: input.reason });
        if (!result.ok) throw new Error(result.error ?? "Workflow conflict could not be resolved.");
        await onRefresh();
      },
      onResolveUnknownOperation: async (runId, input) => {
        if (!draft.workflowId) return;
        const result = await workflows.resolveUnknownOperation({ workflowId: draft.workflowId, runId, operationId: input.operationId, verifiedState: input.verifiedState, actor: "desktop-user", reason: input.reason.trim() });
        if (!result.ok) throw new Error(result.error ?? "Workflow unknown operation could not be verified.");
        await onRefresh();
      },
      onCleanupRunMaterials: async (runId) => {
        if (!draft.workflowId) return;
        const result = await workflows.cleanupRunMaterials({ workflowId: draft.workflowId, runId });
        if (!result.ok) throw new Error(result.error ?? "Workflow run materials could not be cleaned.");
      },
      onRejectNodeCompletion: async (conversationId, instruction) => setSnapshot(await workflows.rejectNodeCompletion({ conversationId, instruction })),
      onInterruptNodeConversation: async (conversationId) => setSnapshot(await workflows.interruptNodeConversation({ conversationId })),
      ...(onResolveRuntimeApproval ? { onResolveRuntimeApproval } : {}),
      onSelectConfiguredAgent: (configuredAgentId: string) => {
        void draft.selectConfiguredAgent(configuredAgentId);
      },
      onSelectReviewerConfiguredAgent: (configuredAgentId: string) => {
        void draft.selectReviewerConfiguredAgent(configuredAgentId);
      },
    onReviewWorkflow: async () => {
        if (!draft.workflowId || !activeWorkflow) return;
        setSnapshot(await workflows.reviewWorkflow({ workflowId: draft.workflowId, expectedRevision: activeWorkflow.revision, reviewEnabled: globalReviewEnabled }));
    },
    onInterruptWorkflowReview: async () => {
      if (!draft.workflowId) return;
      setSnapshot(await workflows.interruptWorkflowReview({ workflowId: draft.workflowId }));
    },
      onApplyReviewToManager: async () => {
        const review = activeWorkflow?.generationReview;
        if (!draft.workflowId || draft.workflowRunning || !review?.result) return;
        setSnapshot(await workflows.applyReviewToManager({ workflowId: draft.workflowId, reviewedRevision: review.result.reviewedRevision }));
      },
      onBuildDefinition: (objective?: string) => {
        void draft.buildWorkflowDefinition(objective);
      },
      onReplyChange: draft.setWorkflowReply,
      onSendReply: (value?: string) => {
        void draft.sendWorkflowReply(value);
      },
      onUpdateNode: (nodeId: string, update) => {
        return draft.updateWorkflowNode(nodeId, update);
      },
      onUpdateDefinition: (definition) => draft.updateWorkflowDefinition(definition),
      onRunWorkflow: async (transactionApprovalMode) => {
        const result = await runner.runWorkflowInternal(undefined, transactionApprovalMode);
        if (!result.ok && result.error && draft.workflowId) {
          const next = await workflows.patchDraft({ workflowId: draft.workflowId, error: result.error });
          setSnapshot(next);
        }
      },
      onConfirmWorkflow: async () => {
        if (!draft.workflowId || !activeWorkflow) return;
        const result = await workflows.confirmWorkflow({ workflowId: draft.workflowId, expectedRevision: activeWorkflow.revision });
        if (!result.ok && result.error) {
          setSnapshot(await workflows.patchDraft({ workflowId: draft.workflowId, error: result.error }));
          return;
        }
        await onRefresh();
      },
      onResetSession: () => draft.resetWorkflowSession(),
      onStopGrill: () => draft.stopWorkflowGrill(),
      onChooseWorkDir,
      onRefresh,
      ...(onReadOutputFile ? { onReadOutputFile } : {}),
      ...(draft.workflowId
        ? {
            onListOutputs: () => activeRunId ? workflows.listOutputs({ workflowId: draft.workflowId as string, runId: activeRunId }) : Promise.resolve([]),
          }
        : {}),
      language,
    }),
    [
      activeRunId,
      activeRun?.status,
      activeWorkflow?.sourceType,
      activeWorkflow?.topologyLocked,
      artifacts,
      draft,
      language,
      nodeConversations,
      runHistoryConversations,
      onChooseWorkDir,
      onReadOutputFile,
      onResolveRuntimeApproval,
      onRefresh,
      runner,
      globalReviewEnabled,
      runtimeReviewEnabled,
      activeWorkflow?.generationReview,
      setSnapshot,
      snapshot.channels,
      snapshot.configuredAgents,
      snapshot.runtimes,
      snapshot.workDir,
      workflows,
      workflowRuns,
    ],
  );
}
