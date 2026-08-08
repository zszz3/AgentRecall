import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { configuredAgentModelId } from "../../../app/agents";
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
  buildWorkflowDefinition: (objectiveOverride?: string) => Promise<void>;
  sendWorkflowReply: (textOverride?: string) => Promise<void>;
  updateWorkflowNode: (nodeId: string, update: Partial<WorkflowV2Node>) => Promise<void>;
  updateWorkflowDefinition: (definition: WorkflowV2Definition) => Promise<void>;
  selectWorkflow: (workflowId: string) => Promise<void>;
  selectConfiguredAgent: (configuredAgentId: string) => Promise<void>;
  selectReviewerConfiguredAgent: (configuredAgentId: string) => Promise<void>;
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
  const [workflowObjectiveInput, setWorkflowObjectiveInput] = useState("");
  const [workflowReplyInput, setWorkflowReplyInput] = useState("");
  const [workflowGrillBusy, setWorkflowGrillBusy] = useState(false);
  const requestTokenRef = useRef(0);
  const activeWorkflowIdRef = useRef<string | undefined>(undefined);
  const workflowObjectiveDraftsRef = useRef(new Map<string, string>());
  const workflowReplyDraftsRef = useRef(new Map<string, string>());

  const invalidatePendingWorkflowRequest = useCallback((): void => {
    requestTokenRef.current += 1;
    setWorkflowGrillBusy(false);
  }, []);

  const resetWorkflowLocalDraft = useCallback((): void => {
    invalidatePendingWorkflowRequest();
    const workflowId = activeWorkflowIdRef.current;
    if (workflowId) {
      workflowObjectiveDraftsRef.current.delete(workflowId);
      workflowReplyDraftsRef.current.delete(workflowId);
    }
    setWorkflowObjectiveInput("");
    setWorkflowReplyInput("");
  }, [invalidatePendingWorkflowRequest]);

  useEffect(() => {
    const nextWorkflowId = activeWorkflow?.workflowId;
    if (activeWorkflowIdRef.current === nextWorkflowId) return;
    activeWorkflowIdRef.current = nextWorkflowId;
    invalidatePendingWorkflowRequest();
    setWorkflowObjectiveInput(
      activeWorkflow && activeWorkflow.messages.length === 0
        ? workflowObjectiveDraftsRef.current.get(activeWorkflow.workflowId) ?? activeWorkflow.objective
        : "",
    );
    setWorkflowReplyInput(
      activeWorkflow && activeWorkflow.messages.length > 0
        ? workflowReplyDraftsRef.current.get(activeWorkflow.workflowId) ?? ""
        : "",
    );
  }, [activeWorkflow, invalidatePendingWorkflowRequest]);

  const setWorkflowObjective = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    const workflowId = activeWorkflowIdRef.current;
    if (typeof value !== "function") {
      if (workflowId) workflowObjectiveDraftsRef.current.set(workflowId, value);
      setWorkflowObjectiveInput(value);
      return;
    }
    setWorkflowObjectiveInput((current) => {
      const next = value(current);
      if (workflowId) workflowObjectiveDraftsRef.current.set(workflowId, next);
      return next;
    });
  }, []);

  const setWorkflowReply = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    const workflowId = activeWorkflowIdRef.current;
    if (typeof value !== "function") {
      if (workflowId) workflowReplyDraftsRef.current.set(workflowId, value);
      setWorkflowReplyInput(value);
      return;
    }
    setWorkflowReplyInput((current) => {
      const next = value(current);
      if (workflowId) workflowReplyDraftsRef.current.set(workflowId, next);
      return next;
    });
  }, []);

  const ensureActiveWorkflow = useCallback(async (): Promise<WorkflowDraftState | undefined> => {
    const currentWorkflow = snapshotRef.current.workflowDraft;
    if (currentWorkflow) return currentWorkflow;
    const next = await workflows.createDraft();
    setSnapshot(next);
    return next.workflowDraft;
  }, [setSnapshot, snapshotRef, workflows]);

  const createNewWorkflow = useCallback(async (): Promise<void> => {
    resetWorkflowLocalDraft();
    const next = await workflows.createDraft();
    setSnapshot(next);
    onCreateNewWorkflow?.();
  }, [onCreateNewWorkflow, resetWorkflowLocalDraft, setSnapshot, workflows]);

  const resetWorkflowSession = useCallback(async (): Promise<void> => {
    const workflow = snapshotRef.current.workflowDraft;
    resetWorkflowLocalDraft();
    if (!workflow) return;
    const next = await workflows.resetDraftSession(workflow.workflowId);
    setSnapshot(next);
  }, [resetWorkflowLocalDraft, setSnapshot, snapshotRef, workflows]);

  const sendWorkflowReply = useCallback(async (textOverride?: string): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const starting = workflow.messages.length === 0;
    const text = (textOverride ?? (starting ? workflowObjectiveInput : workflowReplyInput)).trim();
    if (!text || workflowGrillBusy || workflow.status === "running") return;

    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setWorkflowGrillBusy(true);
    if (starting) {
      workflowObjectiveDraftsRef.current.delete(workflow.workflowId);
      setWorkflowObjectiveInput("");
    } else {
      workflowReplyDraftsRef.current.delete(workflow.workflowId);
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

  const buildWorkflowDefinition = useCallback(async (additionalContext?: string): Promise<void> => {
    const context = additionalContext?.trim();
    const request = [
      ...(context ? [`补充信息：${context}`] : []),
      "现有信息已经足够。请立即基于本次 Workflow 的目标和完整对话上下文生成完整、可执行的工作流；必须调用 workflow_create，用当前 workflowId 提交完整定义。不要继续提问，不要只输出建议或 JSON 文本。",
    ].join("\n\n");
    await sendWorkflowReply(request);
  }, [sendWorkflowReply]);

  const updateWorkflowNode = useCallback(async (nodeId: string, update: Partial<WorkflowV2Node>): Promise<void> => {
    const workflow = await ensureActiveWorkflow();
    if (!workflow) return;
    const definition = {
      ...structuredClone(workflow.definition),
      nodes: workflow.definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...update } as WorkflowV2Node : node)),
    };
    if (workflow.topologyLocked) {
      const result = await workflows.updateWorkflow({ workflowId: workflow.workflowId, expectedRevision: workflow.revision, definition });
      if (!result.ok) throw new Error(result.error ?? "Workflow node route could not be updated.");
      setSnapshot(await workflows.selectWorkflow(workflow.workflowId));
      return;
    }
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

  const workflowConfiguredAgentId = activeWorkflow?.configuredAgentId ?? "";
  const workflowModelId = workflowConfiguredAgentId
    ? configuredAgentModelId(workflowConfiguredAgentId, activeWorkflow?.modelId, configuredAgents, channels)
    : "";
  const workflowReviewerConfiguredAgentId = activeWorkflow?.reviewerConfiguredAgentId ?? "";
  const workflowReviewerModelId = workflowReviewerConfiguredAgentId
    ? configuredAgentModelId(workflowReviewerConfiguredAgentId, activeWorkflow?.reviewerModelId, configuredAgents, channels)
    : "";

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
      selectReviewerConfiguredAgent,
      setWorkflowObjective,
      setWorkflowReply,
    }),
    [
      activeWorkflow,
      createNewWorkflow,
      buildWorkflowDefinition,
      initialWorkflowDefinition,
      resetWorkflowLocalDraft,
      resetWorkflowSession,
      selectConfiguredAgent,
      selectReviewerConfiguredAgent,
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
      setWorkflowObjective,
      setWorkflowReply,
    ],
  );
}
