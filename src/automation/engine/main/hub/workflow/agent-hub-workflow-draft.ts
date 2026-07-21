import type {
  MaterializeWorkflowDraftRequest,
  PatchWorkflowDraftRequest,
  RuntimeConversation,
  UpdateWorkflowRequest,
  WorkflowDraftState,
  WorkflowV2Definition,
} from "../../../shared/types";
import { cloneWorkflowV2Plan } from "../../../shared/workflow-v2/planning";

function emptyWorkflowDefinition(workflowId: string): WorkflowV2Definition {
  return {
    workflowId,
    graphVersion: 1,
    objective: "",
    nodes: [],
    edges: [],
  };
}

export function versionWorkflowDefinition(current: WorkflowV2Definition, candidate: WorkflowV2Definition): { definition: WorkflowV2Definition; changed: boolean } {
  const definition = structuredClone(candidate);
  const changed = JSON.stringify({ ...current, graphVersion: 0 }) !== JSON.stringify({ ...definition, graphVersion: 0 });
  definition.graphVersion = changed
    ? current.nodes.length > 0 ? current.graphVersion + 1 : Math.max(current.graphVersion, definition.graphVersion)
    : current.graphVersion;
  return { definition, changed };
}

export function applyWorkflowDraftPatch(input: {
  current: WorkflowDraftState;
  patch: PatchWorkflowDraftRequest;
  now?: number;
  normalizeConfiguredAgentId: (configuredAgentId: string | undefined) => string;
  normalizeModelId: (configuredAgentId: string | undefined, modelId: string | undefined) => string;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
}): WorkflowDraftState {
  const { current, patch } = input;
  const resetRunState = Boolean(patch.resetRunState && current.status !== "running");
  const nextConfiguredAgentId = patch.configuredAgentId !== undefined
    ? input.normalizeConfiguredAgentId(patch.configuredAgentId)
    : current.configuredAgentId;
  const nextModelId = patch.configuredAgentId !== undefined || patch.modelId !== undefined
    ? input.normalizeModelId(nextConfiguredAgentId, patch.modelId ?? current.modelId)
    : current.modelId;
  const nextReviewerConfiguredAgentId = patch.reviewerConfiguredAgentId !== undefined
    ? input.normalizeConfiguredAgentId(patch.reviewerConfiguredAgentId)
    : current.reviewerConfiguredAgentId;
  const nextReviewerModelId = patch.reviewerConfiguredAgentId !== undefined || patch.reviewerModelId !== undefined
    ? input.normalizeModelId(nextReviewerConfiguredAgentId, patch.reviewerModelId ?? current.reviewerModelId)
    : current.reviewerModelId;
  const routeChanged = nextConfiguredAgentId !== current.configuredAgentId || nextModelId !== current.modelId;
  const reviewerRouteChanged = nextReviewerConfiguredAgentId !== current.reviewerConfiguredAgentId || nextReviewerModelId !== current.reviewerModelId;
  const candidateDefinition = patch.definition
    ? structuredClone(patch.definition)
    : patch.objective !== undefined
      ? { ...structuredClone(current.definition), objective: patch.objective }
      : structuredClone(current.definition);
  const versionedDefinition = versionWorkflowDefinition(current.definition, candidateDefinition);
  const definitionChanged = versionedDefinition.changed;
  const executableChanged = definitionChanged || routeChanged || reviewerRouteChanged || patch.workDir !== undefined;
  const clearRunProjection = resetRunState || executableChanged;
  const definition = versionedDefinition.definition;
  const nextWorkflowV2Plan = patch.workflowV2Plan === null
    ? undefined
    : patch.workflowV2Plan !== undefined
      ? cloneWorkflowV2Plan(patch.workflowV2Plan)
      : definitionChanged || resetRunState || routeChanged
        ? undefined
        : current.workflowV2Plan
          ? cloneWorkflowV2Plan(current.workflowV2Plan)
          : undefined;
  const {
    workDir: _workDir,
    workflowV2Plan: _workflowV2Plan,
    finalReport: _finalReport,
    runtimeConversation: _runtimeConversation,
    confirmedRevision: _confirmedRevision,
    generationReview: _generationReview,
    ...base
  } = current;
  const workDir = patch.workDir === null ? undefined : patch.workDir ?? current.workDir;
  const finalReport = patch.finalReport === null || clearRunProjection ? undefined : patch.finalReport ?? current.finalReport;
  const runtimeConversation = patch.runtimeConversation === null
    ? undefined
    : patch.runtimeConversation !== undefined
      ? input.cloneConversation(patch.runtimeConversation)
      : current.runtimeConversation
        ? input.cloneConversation(current.runtimeConversation)
        : undefined;
  const next = input.cloneDraft({
    ...base,
    title: patch.title ?? current.title,
    status: current.status === "running" ? "running" : executableChanged ? "draft" : patch.status ?? current.status,
    revision: executableChanged ? current.revision + 1 : current.revision,
    ...(!executableChanged && current.confirmedRevision === current.revision
      ? { confirmedRevision: current.revision }
      : {}),
    configuredAgentId: nextConfiguredAgentId,
    modelId: nextModelId,
    reviewerConfiguredAgentId: nextReviewerConfiguredAgentId,
    reviewerModelId: nextReviewerModelId,
    objective: patch.objective ?? definition.objective,
    definition,
    ...(workDir ? { workDir } : {}),
    messages: patch.messages ?? current.messages,
    reply: patch.reply ?? current.reply,
    error: patch.error === null ? undefined : patch.error ?? current.error,
    runProgress: clearRunProjection ? [] : patch.runProgress ?? current.runProgress,
    runContextDocument: clearRunProjection ? "" : patch.runContextDocument ?? current.runContextDocument,
    contextDocument: patch.contextDocument ?? current.contextDocument,
    ...(nextWorkflowV2Plan ? { workflowV2Plan: nextWorkflowV2Plan } : {}),
    ...(!executableChanged && patch.generationReview === undefined && current.generationReview
      ? { generationReview: structuredClone(current.generationReview) }
      : patch.generationReview && !executableChanged
        ? { generationReview: structuredClone(patch.generationReview) }
        : {}),
    ...(finalReport !== undefined ? { finalReport } : {}),
    runIds: resetRunState ? [] : [...current.runIds],
    ...(runtimeConversation ? { runtimeConversation } : {}),
    updatedAt: input.now ?? Date.now(),
  });
  if (resetRunState) next.status = "draft";
  return next;
}

export function createWorkflowDraftState(input: {
  workflowId: string;
  request: MaterializeWorkflowDraftRequest;
  configuredAgentId: string;
  modelId: string;
  reviewerConfiguredAgentId: string;
  reviewerModelId: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  const now = input.now ?? Date.now();
  const definition = structuredClone(input.request.definition);
  const objective = input.request.objective.trim() || definition.objective;
  definition.objective = objective;
  return input.cloneDraft({
    workflowId: input.workflowId,
    sourceType: "user",
    topologyLocked: false,
    title: input.request.title.trim() || objective || "Untitled workflow",
    status: "draft",
    revision: 1,
    configuredAgentId: input.configuredAgentId,
    modelId: input.modelId,
    reviewerConfiguredAgentId: input.reviewerConfiguredAgentId,
    reviewerModelId: input.reviewerModelId,
    objective,
    definition,
    ...(input.request.workDir?.trim() ? { workDir: input.request.workDir.trim() } : {}),
    messages: input.request.messages ?? [],
    reply: input.request.reply ?? "",
    error: input.request.error,
    runProgress: input.request.runProgress ?? [],
    runContextDocument: input.request.runContextDocument ?? "",
    contextDocument: input.request.contextDocument ?? "",
    ...(input.request.workflowV2Plan ? { workflowV2Plan: cloneWorkflowV2Plan(input.request.workflowV2Plan) } : {}),
    ...(input.request.finalReport !== undefined ? { finalReport: input.request.finalReport } : {}),
    runIds: input.request.runIds ?? [],
    ...(input.request.runtimeConversation ? { runtimeConversation: input.request.runtimeConversation } : {}),
    createdAt: input.request.createdAt ?? now,
    updatedAt: input.request.updatedAt ?? now,
  });
}

export function updateWorkflowDraftState(input: {
  current: WorkflowDraftState;
  request: UpdateWorkflowRequest;
  definition: WorkflowV2Definition;
  configuredAgentId: string;
  modelId: string;
  reviewerConfiguredAgentId: string;
  reviewerModelId: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  const routeChanged = input.configuredAgentId !== input.current.configuredAgentId || input.modelId !== input.current.modelId;
  const reviewerRouteChanged = input.reviewerConfiguredAgentId !== input.current.reviewerConfiguredAgentId || input.reviewerModelId !== input.current.reviewerModelId;
  const versionedDefinition = versionWorkflowDefinition(input.current.definition, input.definition);
  const definitionChanged = versionedDefinition.changed;
  const executableChanged = definitionChanged || routeChanged || reviewerRouteChanged;
  const nextWorkflowV2Plan = input.request.workflowV2Plan === null
    ? undefined
    : input.request.workflowV2Plan !== undefined
      ? cloneWorkflowV2Plan(input.request.workflowV2Plan)
      : definitionChanged || routeChanged
        ? undefined
        : input.current.workflowV2Plan
          ? cloneWorkflowV2Plan(input.current.workflowV2Plan)
          : undefined;
  const { workflowV2Plan: _plan, confirmedRevision: _confirmedRevision, generationReview: _generationReview, finalReport: _finalReport, runProgress: _runProgress, runContextDocument: _runContextDocument, ...base } = input.current;
  return input.cloneDraft({
    ...base,
    title: input.request.title ?? input.current.title,
    objective: input.request.objective ?? input.definition.objective,
    definition: versionedDefinition.definition,
    configuredAgentId: input.configuredAgentId,
    modelId: input.modelId,
    reviewerConfiguredAgentId: input.reviewerConfiguredAgentId,
    reviewerModelId: input.reviewerModelId,
    messages: input.request.messages ?? input.current.messages,
    reply: input.request.reply ?? input.current.reply,
    error: input.request.error ?? input.current.error,
    runProgress: executableChanged ? [] : input.request.runProgress ?? input.current.runProgress,
    runContextDocument: executableChanged ? "" : input.request.runContextDocument ?? input.current.runContextDocument,
    contextDocument: input.request.contextDocument ?? input.current.contextDocument,
    ...(nextWorkflowV2Plan ? { workflowV2Plan: nextWorkflowV2Plan } : {}),
    ...(!executableChanged && (input.request.finalReport ?? input.current.finalReport) !== undefined
      ? { finalReport: input.request.finalReport ?? input.current.finalReport }
      : {}),
    ...(input.request.runtimeConversation !== undefined
      ? { runtimeConversation: input.request.runtimeConversation }
      : {}),
    status: input.current.status === "running" ? "running" : executableChanged ? "draft" : input.current.status,
    revision: executableChanged ? input.current.revision + 1 : input.current.revision,
    ...(!executableChanged && input.current.confirmedRevision === input.current.revision
      ? { confirmedRevision: input.current.revision }
      : {}),
    ...(!executableChanged && input.request.generationReview === undefined && input.current.generationReview
      ? { generationReview: structuredClone(input.current.generationReview) }
      : input.request.generationReview && !executableChanged
        ? { generationReview: structuredClone(input.request.generationReview) }
        : {}),
    updatedAt: input.now ?? Date.now(),
  });
}

export function replaceWorkflowDraftMessage(
  messages: WorkflowDraftState["messages"],
  messageId: string,
  content: string,
): WorkflowDraftState["messages"] {
  return messages.map((message) => (message.id === messageId ? { ...message, content } : message));
}

export function completeWorkflowDraftRequest(input: {
  workflow: WorkflowDraftState;
  activeRequest: { assistantMessageId: string; content: string };
  content: string;
  runtimeConversation: RuntimeConversation | undefined;
  thinkingMessage: string;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  const finalContent = (input.content.trim() || input.activeRequest.content.trim() || input.thinkingMessage).trim();
  return input.cloneDraft({
    ...input.workflow,
    status: input.workflow.status === "running" ? input.workflow.status : "draft",
    messages: replaceWorkflowDraftMessage(input.workflow.messages, input.activeRequest.assistantMessageId, finalContent),
    reply: "",
    error: undefined,
    ...(input.runtimeConversation !== undefined
      ? { runtimeConversation: input.cloneConversation(input.runtimeConversation) }
      : {}),
    updatedAt: input.now ?? Date.now(),
  });
}

export function failWorkflowDraftRequest(input: {
  workflow: WorkflowDraftState;
  activeRequest: { assistantMessageId: string };
  error: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  return input.cloneDraft({
    ...input.workflow,
    messages: replaceWorkflowDraftMessage(
      input.workflow.messages,
      input.activeRequest.assistantMessageId,
      `Workflow agent error: ${input.error}`,
    ),
    error: input.error,
    updatedAt: input.now ?? Date.now(),
  });
}

export function resetWorkflowDraftSessionState(input: {
  workflow: WorkflowDraftState;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  const {
    workDir: _workDir,
    workflowV2Plan: _plan,
    finalReport: _report,
    runtimeConversation: _conversation,
    ...base
  } = input.workflow;
  return input.cloneDraft({
    ...base,
    title: "Untitled workflow",
    status: "draft",
    revision: input.workflow.revision + 1,
    objective: "",
    definition: emptyWorkflowDefinition(input.workflow.workflowId),
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "",
    contextDocument: "",
    runIds: [],
    updatedAt: input.now ?? Date.now(),
  });
}
