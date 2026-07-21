import { useCallback, useEffect, useState } from "react";
import type { AppSnapshot, WorkflowDraftState } from "../../../../../shared/types";
import type { WorkflowService } from "../../../app/services/workflow-service";
import type { WorkflowSidebarController, WorkflowSidebarContextMenu, WorkflowSidebarRenameDraft } from "../workflow-controller";

type MaybePromise = void | Promise<void>;

export interface WorkflowSidebarStateController {
  workflowContextMenu: WorkflowSidebarContextMenu | undefined;
  workflowRenameDraft: WorkflowSidebarRenameDraft | undefined;
  openWorkflowContextMenu: (workflowId: string, x: number, y: number) => void;
  closeWorkflowContextMenu: () => void;
  startWorkflowRename: (workflowId: string) => void;
  changeWorkflowRenameDraft: (title: string) => void;
  cancelWorkflowRename: () => void;
  confirmWorkflowRename: () => Promise<void>;
  deleteWorkflow: (workflowId: string) => Promise<void>;
}

export interface WorkflowSidebarFeatureController extends WorkflowSidebarController {
  closeContextMenu: () => void;
}

interface UseWorkflowSidebarStateOptions {
  workflows: WorkflowDraftState[];
  activeWorkflowId?: string | undefined;
  workflowRunning: boolean;
  setSnapshot: (snapshot: AppSnapshot) => void;
  workflowsService: Pick<WorkflowService, "renameWorkflow" | "deleteWorkflow">;
  canRenameWorkflow: boolean;
  canDeleteWorkflow: boolean;
}

export function useWorkflowSidebarState({
  workflows,
  activeWorkflowId,
  workflowRunning,
  setSnapshot,
  workflowsService,
  canRenameWorkflow,
  canDeleteWorkflow,
}: UseWorkflowSidebarStateOptions): WorkflowSidebarStateController {
  const [workflowContextMenu, setWorkflowContextMenu] = useState<WorkflowSidebarContextMenu | undefined>();
  const [workflowRenameDraft, setWorkflowRenameDraft] = useState<WorkflowSidebarRenameDraft | undefined>();

  useEffect(() => {
    if (workflowContextMenu && !workflows.some((workflow) => workflow.workflowId === workflowContextMenu.workflowId)) {
      setWorkflowContextMenu(undefined);
    }
    if (workflowRenameDraft && !workflows.some((workflow) => workflow.workflowId === workflowRenameDraft.workflowId)) {
      setWorkflowRenameDraft(undefined);
    }
  }, [workflowContextMenu, workflowRenameDraft, workflows]);

  const openWorkflowContextMenu = useCallback((workflowId: string, x: number, y: number): void => {
    setWorkflowContextMenu({ workflowId, x, y });
  }, []);

  const closeWorkflowContextMenu = useCallback((): void => {
    setWorkflowContextMenu(undefined);
  }, []);

  const startWorkflowRename = useCallback((workflowId: string): void => {
    const workflow = workflows.find((item) => item.workflowId === workflowId);
    if (!workflow) return;
    setWorkflowContextMenu(undefined);
    setWorkflowRenameDraft({ workflowId, title: workflow.title });
  }, [workflows]);

  const changeWorkflowRenameDraft = useCallback((title: string): void => {
    setWorkflowRenameDraft((current) => (current ? { ...current, title } : current));
  }, []);

  const cancelWorkflowRename = useCallback((): void => {
    setWorkflowRenameDraft(undefined);
  }, []);

  const confirmWorkflowRename = useCallback(async (): Promise<void> => {
    if (!workflowRenameDraft) return;
    const title = workflowRenameDraft.title.trim();
    if (!title) return;
    if (!canRenameWorkflow) return;
    const next = await workflowsService.renameWorkflow(workflowRenameDraft.workflowId, title);
    setWorkflowRenameDraft(undefined);
    setSnapshot(next);
  }, [canRenameWorkflow, setSnapshot, workflowRenameDraft, workflowsService]);

  const deleteWorkflow = useCallback(async (workflowId: string): Promise<void> => {
    setWorkflowContextMenu(undefined);
    if (workflowRunning && workflowId === activeWorkflowId) return;
    if (!canDeleteWorkflow) return;
    const workflow = workflows.find((item) => item.workflowId === workflowId);
    const confirmed =
      typeof window.confirm === "function" ? window.confirm(`Delete workflow "${workflow?.title ?? workflowId}" and its run data?`) : true;
    if (!confirmed) return;
    const next = await workflowsService.deleteWorkflow(workflowId);
    setSnapshot(next);
  }, [
    activeWorkflowId,
    canDeleteWorkflow,
    setSnapshot,
    workflowRunning,
    workflows,
    workflowsService,
  ]);

  return {
    workflowContextMenu,
    workflowRenameDraft,
    openWorkflowContextMenu,
    closeWorkflowContextMenu,
    startWorkflowRename,
    changeWorkflowRenameDraft,
    cancelWorkflowRename,
    confirmWorkflowRename,
    deleteWorkflow,
  };
}

interface BuildWorkflowSidebarControllerOptions {
  workflows: WorkflowDraftState[];
  activeWorkflowId?: string;
  running: boolean;
  state: WorkflowSidebarStateController;
  onNewWorkflow: () => MaybePromise;
  onSelectWorkflow: (workflowId: string) => MaybePromise;
  onBeforeOpenContextMenu?: () => void;
}

export function buildWorkflowSidebarController({
  workflows,
  activeWorkflowId,
  running,
  state,
  onNewWorkflow,
  onSelectWorkflow,
  onBeforeOpenContextMenu,
}: BuildWorkflowSidebarControllerOptions): WorkflowSidebarFeatureController {
  return {
    workflows,
    running,
    ...(activeWorkflowId ? { activeWorkflowId } : {}),
    ...(state.workflowContextMenu ? { contextMenu: state.workflowContextMenu } : {}),
    ...(state.workflowRenameDraft ? { renameDraft: state.workflowRenameDraft } : {}),
    onNewWorkflow,
    onSelectWorkflow,
    onOpenContextMenu: (workflowId: string, x: number, y: number) => {
      onBeforeOpenContextMenu?.();
      state.openWorkflowContextMenu(workflowId, x, y);
    },
    onStartRename: state.startWorkflowRename,
    onRenameDraftChange: state.changeWorkflowRenameDraft,
    onConfirmRename: state.confirmWorkflowRename,
    onCancelRename: state.cancelWorkflowRename,
    onDeleteWorkflow: state.deleteWorkflow,
    closeContextMenu: state.closeWorkflowContextMenu,
  };
}
