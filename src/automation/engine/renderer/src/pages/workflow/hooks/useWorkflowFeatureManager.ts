import { useMemo } from "react";
import type { AppSnapshot, ApprovalDecision, LocalFilePreview } from "../../../../../shared/types";
import type { WorkflowService } from "../../../app/services/workflow-service";
import { buildWorkflowSidebarController, type WorkflowSidebarFeatureController, useWorkflowSidebarState } from "./useWorkflowSidebarState";
import { useWorkflowDraft, type WorkflowDraftController } from "./useWorkflowDraft";
import { useWorkflowFeatureController } from "./useWorkflowFeatureController";
import { useWorkflowRunner, type WorkflowRunnerController } from "./useWorkflowRunner";
import type { WorkflowController } from "../workflow-controller";

interface UseWorkflowFeatureManagerOptions {
  workflows: WorkflowService;
  snapshot: AppSnapshot;
  snapshotRef: React.MutableRefObject<AppSnapshot>;
  setSnapshot: (snapshot: AppSnapshot) => void;
  language: "en" | "zh";
  onChooseWorkDir: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onReadOutputFile?: (filePath: string) => Promise<LocalFilePreview>;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>;
  onEnterWorkflow?: () => void;
}

export interface WorkflowFeatureManager {
  draft: WorkflowDraftController;
  runner: WorkflowRunnerController;
  controller: WorkflowController;
  sidebarController: WorkflowSidebarFeatureController;
  closeSidebarContextMenu: () => void;
  resetWorkflowLocalDraft: WorkflowDraftController["resetWorkflowLocalDraft"];
}

export function useWorkflowFeatureManager({
  workflows,
  snapshot,
  snapshotRef,
  setSnapshot,
  language,
  onChooseWorkDir,
  onRefresh,
  onReadOutputFile,
  onResolveRuntimeApproval,
  onEnterWorkflow,
}: UseWorkflowFeatureManagerOptions): WorkflowFeatureManager {
  const initialWorkflowDefinition = useMemo(() => ({ workflowId: "draft", graphVersion: 1, objective: "", nodes: [], edges: [] }), []);
  const draft = useWorkflowDraft({
    snapshot,
    setSnapshot,
    snapshotRef,
    initialWorkflowDefinition,
    workflows,
    configuredAgents: snapshot.configuredAgents,
    channels: snapshot.channels,
    ...(onEnterWorkflow ? { onCreateNewWorkflow: onEnterWorkflow } : {}),
  });
  const sidebarState = useWorkflowSidebarState({
    workflows: snapshot.workflowStore.workflows,
    activeWorkflowId: draft.workflowId,
    workflowRunning: draft.workflowRunning,
    setSnapshot,
    workflowsService: workflows,
    canRenameWorkflow: true,
    canDeleteWorkflow: true,
  });
  const sidebarController = useMemo(() => {
    const options = {
      workflows: snapshot.workflowStore.workflows,
      running: draft.workflowRunning,
      state: sidebarState,
      onNewWorkflow: draft.createNewWorkflow,
      onSelectWorkflow: draft.selectWorkflow,
    };
    return snapshot.workflowStore.activeWorkflowId
      ? buildWorkflowSidebarController({ ...options, activeWorkflowId: snapshot.workflowStore.activeWorkflowId })
      : buildWorkflowSidebarController(options);
  }, [
    draft.createNewWorkflow,
    draft.selectWorkflow,
    draft.workflowRunning,
    sidebarState,
    snapshot.workflowStore.activeWorkflowId,
    snapshot.workflowStore.workflows,
  ]);
  const runner = useWorkflowRunner({
    workflows,
    workflowId: draft.workflowId,
    workflowContextDocument: draft.workflowContextDocument,
  });
  const controller = useWorkflowFeatureController({
    snapshot,
    setSnapshot,
    workflows,
    draft,
    runner,
    language,
    onChooseWorkDir,
    onRefresh,
    onReadOutputFile,
    ...(onResolveRuntimeApproval ? { onResolveRuntimeApproval } : {}),
  });

  return {
    draft,
    runner,
    controller,
    sidebarController,
    closeSidebarContextMenu: sidebarState.closeWorkflowContextMenu,
    resetWorkflowLocalDraft: draft.resetWorkflowLocalDraft,
  };
}
