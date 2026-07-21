import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_MODEL_ID } from "../../../../../shared/models";
import type {
  AgentChannel,
  AppSnapshot,
  ConfiguredAgent,
  WorkflowDraftState,
  WorkflowV2Definition,
  WorkflowV2Node,
  WorkflowRunProgressItem,
  WorkflowStatus,
} from "../../../../../shared/types";
import { configuredAgentModelId, defaultConfiguredAgentId } from "../../../app/agents";
import type { WorkflowService } from "../../../app/services/workflow-service";

export interface WorkflowDraftController {
  workflowId: string | undefined;
  workflowTitle: string;
  workflowStatus: WorkflowStatus;
  workflowConfiguredAgentId: string;
  workflowModelId: string;
  workflowReviewerConfiguredAgentId: string;
  workflowReviewerModelId: string;
  workflowObjective: string;
  workflowDefinition: WorkflowV2Definition;
  workflowDefinitionReady: boolean;
  workflowMessages: WorkflowDraftState["messages"];
  workflowReply: string;
  workflowError: string | undefined;
  workflowRunning: boolean;
  workflowRunProgress: WorkflowRunProgressItem[];
  workflowRunContextDocument: string;
  workflowContextDocument: string;
  workflowFinalReport: string;
  workflowRunIds: string[];
  workflowCreatedAt: number;
  resetWorkflowLocalDraft: () => void;
  stopWorkflowGrill: () => Promise<void>;
  createNewWorkflow: () => Promise<void>;
  resetWorkflowSession: () => Promise<void>;
  buildWorkflowDefinition: () => Promise<void>;
  sendWorkflowReply: () => Promise<void>;
  updateWorkflowNode: (nodeId: string, update: Partial<WorkflowV2Node>) => Promise<void>;
  updateWorkflowDefinition: (definition: WorkflowV2Definition) => Promise<void>;
  selectWorkflow: (workflowId: string) => Promise<void>;
  selectConfiguredAgent: (configuredAgentId: string) => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  selectReviewerConfiguredAgent: (configuredAgentId: string) => Promise<void>;
  selectReviewerModel: (modelId: string) => Promise<void>;
  setWorkflowObjective: Dispatch<SetStateAction<string>>;
  setWorkflowReply: Dispatch<SetStateAction<string>>;
}

interface UseWorkflowDraftOptions {
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
  snapshotRef: React.MutableRefObject<AppSnapshot>;
  initialWorkflowDefinition: WorkflowV2Definition;
  workflows: WorkflowService;
  configuredAgents: ConfiguredAgent[];
  channels: AgentChannel[];
  onCreateNewWorkflow?: () => void;
}

export function useWorkflowDraft({
  snapshot,
  setSnapshot,
  snapshotRef,
  initialWorkflowDefinition,
  workflows,
  configuredAgents,
  channels,
  onCreateNewWorkflow,
}: UseWorkflowDraftOptions): WorkflowDraftController {
  const activeWorkflow = snapshot.workflowDraft;
  const fallbackConfiguredAgentId = defaultConfiguredAgentId(configuredAgents);
  const fallbackModelId = configuredAgentModelId(
    fallbackConfiguredAgentId,
    DEFAULT_MODEL_ID,
    configuredAgents,
    channels,
  );
  const [workflowObjectiveInput, setWorkflowObjectiveInput] = useState("");
  const [workflowReplyInput, setWorkflowReplyInput] = useState("");
  const [workflowGrillBusy, setWorkflowGrillBusy] = useState(false);
  const requestTokenRef = useRef(0);
  const activeWorkflowIdRef = useRef<string | undefined>(undefined);

  const invalidatePendingWorkflowRequest = useCallback((): void => {
    requestTokenRef.current += 1;
    setWorkflowGrillBusy(false);
  }, []);

  const resetWorkflowLocalDraft = useCallback((): void => {
    invalidatePendingWorkflowRequest();
    setWorkflowObjectiveInput("");
    setWorkflowReplyInput("");
  }, [invalidatePendingWorkflowRequest]);

  useEffect(() => {
    const nextWorkflowId = activeWorkflow?.workflowId;
    if (activeWorkflowIdRef.current === nextWorkflowId) return;
    activeWorkflowIdRef.current = nextWorkflowId;
    invalidatePendingWorkflowRequest();
    setWorkflowObjectiveInput(activeWorkflow && activeWorkflow.messages.length === 0 ? activeWorkflow.objective : "");
    setWorkflowReplyInput("");
  }, [activeWorkflow, invalidatePendingWorkflowRequest]);

  const ensureActiveWorkflow = useCallback(async (): Promise<WorkflowDraftState | undefined> => {
    const currentWorkflow = snapshotRef.current.workflowDraft;
    if (currentWorkflow) return currentWorkflow;
    const next = await workflows.createDraft(
      fallbackConfiguredAgentId
        ? {
            configuredAgentId: fallbackConfiguredAgentId,
            modelId: fallbackModelId,
          }
        : undefined,
    );
    setSnapshot(next);
    return next.workflowDraft;
  }, [fallbackConfiguredAgentId, fallbackModelId, setSnapshot, snapshotRef, workflows]);

  const createNewWorkflow = useCallback(async (): Promise<void> => {
    resetWorkflowLocalDraft();
    const next = await workflows.createDraft(
      fallbackConfiguredAgentId
        ? {
            configuredAgentId: fallbackConfiguredAgentId,
            modelId: fallbackModelId,
          }
        : undefined,
    );
    setSnapshot(next);
    onCreateNewWorkflow?.();
  }, [fallbackConfiguredAgentId, fallbackModelId, onCreateNewWorkflow, resetWorkflowLocalDraft, setSnapshot, workflows]);

  const resetWorkflowSession = useCallback(async (): Promise<void> => {
    const workflow = snapshotRef.current.workflowDraft;
    resetWorkflowLocalDraft();
    if (!workflow) return;
    const next = await workflows.resetDraftSession(workflow.workflowId);
    setSnapshot(next);
  }, [resetWorkflowLocalDraft, setSnapshot, snapshotRef, workflows]);

  const buildWorkflowDefinition = useCallback(async (): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const objective = workflowObjectiveInput.trim();
    const definition = { ...structuredClone(workflow.definition), objective };
    const next = await workflows.patchDraft({
      workflowId: workflow.workflowId,
      title: workflow.title || objective || "Untitled workflow",
      objective,
      definition,
      error: null,
      resetRunState: true,
      runtimeConversation: null,
      finalReport: null,
    });
    setSnapshot(next);
  }, [ensureActiveWorkflow, setSnapshot, workflowObjectiveInput, workflows]);

  const sendWorkflowReply = useCallback(async (): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const starting = workflow.messages.length === 0;
    const text = (starting ? workflowObjectiveInput : workflowReplyInput).trim();
    if (!text || workflowGrillBusy || workflow.status === "running") return;

    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setWorkflowGrillBusy(true);
    if (starting) {
      setWorkflowObjectiveInput("");
    } else {
      setWorkflowReplyInput("");
    }

    try {
      const next = await workflows.sendDraftReply({
        workflowId: workflow.workflowId,
        reply: text,
      });
      if (requestTokenRef.current === requestToken) setSnapshot(next);
    } finally {
      if (requestTokenRef.current === requestToken) setWorkflowGrillBusy(false);
    }
  }, [ensureActiveWorkflow, setSnapshot, workflowGrillBusy, workflowObjectiveInput, workflowReplyInput, workflows]);

  const updateWorkflowNode = useCallback(async (nodeId: string, update: Partial<WorkflowV2Node>): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const definition = {
      ...structuredClone(workflow.definition),
      nodes: workflow.definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...update } as WorkflowV2Node : node)),
    };
    const next = await workflows.patchDraft({
      workflowId: workflow.workflowId,
      objective: workflow.objective,
      definition,
      error: null,
      resetRunState: true,
      finalReport: null,
    });
    setSnapshot(next);
  }, [ensureActiveWorkflow, setSnapshot, workflows]);

  const selectWorkflow = useCallback(async (workflowId: string): Promise<void> => {
    invalidatePendingWorkflowRequest();
    setWorkflowReplyInput("");
    const next = await workflows.selectWorkflow(workflowId);
    setSnapshot(next);
  }, [invalidatePendingWorkflowRequest, setSnapshot, workflows]);

  const stopWorkflowGrill = useCallback(async (): Promise<void> => {
    const workflow = snapshotRef.current.workflowDraft;
    invalidatePendingWorkflowRequest();
    if (!workflow) return;
    const next = await workflows.abandonDraftReply(workflow.workflowId);
    setSnapshot(next);
  }, [invalidatePendingWorkflowRequest, setSnapshot, snapshotRef, workflows]);

  const selectConfiguredAgent = useCallback(async (configuredAgentId: string): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const modelId = configuredAgentModelId(configuredAgentId, undefined, configuredAgents, channels);
    const next = await workflows.patchDraft({
      workflowId: workflow.workflowId,
      configuredAgentId,
      modelId,
      error: null,
    });
    setSnapshot(next);
  }, [channels, configuredAgents, ensureActiveWorkflow, setSnapshot, workflows]);

  const selectModel = useCallback(async (modelId: string): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const next = await workflows.patchDraft({
      workflowId: workflow.workflowId,
      modelId,
      error: null,
    });
    setSnapshot(next);
  }, [ensureActiveWorkflow, setSnapshot, workflows]);

  const updateWorkflowDefinition = useCallback(async (definition: WorkflowV2Definition): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const result = await workflows.updateWorkflow({ workflowId: workflow.workflowId, expectedRevision: workflow.revision, definition });
    if (!result.ok) {
      setSnapshot(await workflows.patchDraft({ workflowId: workflow.workflowId, error: result.error ?? "Workflow could not be updated." }));
      throw new Error(result.error ?? "Workflow could not be updated.");
    }
    setSnapshot(await workflows.selectWorkflow(workflow.workflowId));
  }, [ensureActiveWorkflow, setSnapshot, workflows]);

  const selectReviewerConfiguredAgent = useCallback(async (configuredAgentId: string): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const reviewerModelId = configuredAgentModelId(configuredAgentId, undefined, configuredAgents, channels);
    setSnapshot(await workflows.patchDraft({ workflowId: workflow.workflowId, reviewerConfiguredAgentId: configuredAgentId, reviewerModelId, error: null }));
  }, [channels, configuredAgents, ensureActiveWorkflow, setSnapshot, workflows]);

  const selectReviewerModel = useCallback(async (reviewerModelId: string): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    setSnapshot(await workflows.patchDraft({ workflowId: workflow.workflowId, reviewerModelId, error: null }));
  }, [ensureActiveWorkflow, setSnapshot, workflows]);

  const workflowConfiguredAgentId = activeWorkflow?.configuredAgentId || fallbackConfiguredAgentId;
  const workflowModelId = configuredAgentModelId(
    workflowConfiguredAgentId,
    activeWorkflow?.modelId || fallbackModelId,
    configuredAgents,
    channels,
  );
  const workflowReviewerConfiguredAgentId = activeWorkflow?.reviewerConfiguredAgentId || workflowConfiguredAgentId;
  const workflowReviewerModelId = configuredAgentModelId(workflowReviewerConfiguredAgentId, activeWorkflow?.reviewerModelId || workflowModelId, configuredAgents, channels);

  return useMemo(
    () => ({
      workflowId: activeWorkflow?.workflowId,
      workflowTitle: activeWorkflow?.title || initialWorkflowDefinition.objective || "Untitled workflow",
      workflowStatus: activeWorkflow?.status ?? "draft",
      workflowConfiguredAgentId,
      workflowModelId,
      workflowReviewerConfiguredAgentId,
      workflowReviewerModelId,
      workflowObjective: activeWorkflow?.messages.length ? activeWorkflow.objective : workflowObjectiveInput,
      workflowDefinition: activeWorkflow?.definition ?? initialWorkflowDefinition,
      workflowDefinitionReady: Boolean(activeWorkflow && activeWorkflow.definition.nodes.length > 0),
      workflowMessages: activeWorkflow?.messages ?? [],
      workflowReply: workflowReplyInput,
      workflowError: activeWorkflow?.error,
      workflowRunning: workflowGrillBusy || activeWorkflow?.status === "running",
      workflowRunProgress: activeWorkflow?.runProgress ?? [],
      workflowRunContextDocument: activeWorkflow?.runContextDocument ?? "",
      workflowContextDocument: activeWorkflow?.contextDocument ?? "",
      workflowFinalReport: activeWorkflow?.finalReport ?? "",
      workflowRunIds: activeWorkflow?.runIds ?? [],
      workflowCreatedAt: activeWorkflow?.createdAt ?? Date.now(),
      resetWorkflowLocalDraft,
      stopWorkflowGrill,
      createNewWorkflow,
      resetWorkflowSession,
      buildWorkflowDefinition,
      sendWorkflowReply,
      updateWorkflowNode,
      updateWorkflowDefinition,
      selectWorkflow,
      selectConfiguredAgent,
      selectModel,
      selectReviewerConfiguredAgent,
      selectReviewerModel,
      setWorkflowObjective: setWorkflowObjectiveInput,
      setWorkflowReply: setWorkflowReplyInput,
    }),
    [
      activeWorkflow,
      createNewWorkflow,
      buildWorkflowDefinition,
      initialWorkflowDefinition,
      resetWorkflowLocalDraft,
      resetWorkflowSession,
      selectConfiguredAgent,
      selectModel,
      selectReviewerConfiguredAgent,
      selectReviewerModel,
      selectWorkflow,
      sendWorkflowReply,
      stopWorkflowGrill,
      updateWorkflowNode,
      updateWorkflowDefinition,
      workflowConfiguredAgentId,
      workflowGrillBusy,
      workflowModelId,
      workflowReviewerConfiguredAgentId,
      workflowReviewerModelId,
      workflowObjectiveInput,
      workflowReplyInput,
    ],
  );
}
