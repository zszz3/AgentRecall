import { useMemo } from "react";
import type { AppSnapshot, ApprovalDecision, WorkflowRunState } from "../../../../../shared/types";
import { defaultConfiguredAgentId } from "../../../app/agents";
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
  onChooseWorkDir,
  onRefresh,
  onReadOutputFile,
  onResolveRuntimeApproval,
}: UseWorkflowFeatureControllerOptions): WorkflowController {
  const activeWorkflow = snapshot.workflowStore.workflows.find((workflow) => workflow.workflowId === draft.workflowId);
  const latestRunId = activeWorkflow?.runIds.at(-1);
  const activeRun = selectWorkflowRunContext(snapshot.workflowStore.runs, draft.workflowId, latestRunId);
  const activeRunId = activeRun?.runId;
  const nodeConversations = activeRunId
    ? snapshot.workflowNodeConversations.filter((conversation) => conversation.workflowId === draft.workflowId && conversation.runId === activeRunId)
    : [];
  const artifacts = activeRunId ? (snapshot.artifacts ?? []).filter((artifact) => artifact.target === activeRunId) : [];

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
      configuredAgentId: draft.workflowConfiguredAgentId || defaultConfiguredAgentId(snapshot.configuredAgents),
      modelId: draft.workflowModelId,
      reviewerConfiguredAgentId: draft.workflowReviewerConfiguredAgentId,
      reviewerModelId: draft.workflowReviewerModelId,
      generationReview: activeWorkflow?.generationReview,
      runtimes: snapshot.runtimes,
      channels: snapshot.channels,
      configuredAgents: snapshot.configuredAgents,
      workDir: snapshot.workDir,
      running: draft.workflowRunning,
      runProgress: draft.workflowRunProgress,
      ...(activeRunId ? { activeRunId } : {}),
      ...(activeRun ? { activeRunStatus: activeRun.status } : {}),
      artifacts,
      contextDocument: draft.workflowRunContextDocument,
      finalReport: draft.workflowFinalReport,
      ...(activeWorkflow?.workflowV2Plan ? { workflowV2Plan: activeWorkflow.workflowV2Plan } : {}),
      nodeTasks: snapshot.tasks.filter((task) => draft.workflowRunProgress.some((item) => item.taskId === task.id)),
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
      onRejectNodeCompletion: async (conversationId, instruction) => setSnapshot(await workflows.rejectNodeCompletion({ conversationId, instruction })),
      onInterruptNodeConversation: async (conversationId) => setSnapshot(await workflows.interruptNodeConversation({ conversationId })),
      ...(onResolveRuntimeApproval ? { onResolveRuntimeApproval } : {}),
      onSelectConfiguredAgent: (configuredAgentId: string) => {
        void draft.selectConfiguredAgent(configuredAgentId);
      },
      onSelectModel: (modelId: string) => {
        void draft.selectModel(modelId);
      },
      onSelectReviewerConfiguredAgent: (configuredAgentId: string) => {
        void draft.selectReviewerConfiguredAgent(configuredAgentId);
      },
      onSelectReviewerModel: (modelId: string) => {
        void draft.selectReviewerModel(modelId);
      },
    onReviewWorkflow: async () => {
        if (!draft.workflowId || !activeWorkflow) return;
        setSnapshot(await workflows.reviewWorkflow({ workflowId: draft.workflowId, expectedRevision: activeWorkflow.revision }));
    },
    onInterruptWorkflowReview: async () => {
      if (!draft.workflowId) return;
      setSnapshot(await workflows.interruptWorkflowReview({ workflowId: draft.workflowId }));
    },
      onBuildDefinition: () => {
        void draft.buildWorkflowDefinition();
      },
      onReplyChange: draft.setWorkflowReply,
      onSendReply: () => {
        void draft.sendWorkflowReply();
      },
      onUpdateNode: (nodeId: string, update) => {
        return draft.updateWorkflowNode(nodeId, update);
      },
      onUpdateDefinition: (definition) => draft.updateWorkflowDefinition(definition),
      onRunWorkflow: async () => {
        const result = await runner.runWorkflowInternal();
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
      onChooseWorkDir,
      onReadOutputFile,
      onResolveRuntimeApproval,
      onRefresh,
      runner,
      setSnapshot,
      snapshot.channels,
      snapshot.configuredAgents,
      snapshot.runtimes,
      snapshot.workDir,
      workflows,
    ],
  );
}
