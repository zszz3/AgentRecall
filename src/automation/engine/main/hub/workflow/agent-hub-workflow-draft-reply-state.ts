import type {
  RuntimeConversation,
  WorkflowDraftState,
} from "../../../shared/types";
import { buildWorkflowAgentPrompt, buildWorkflowRevisionPrompt } from "../../../shared/workflow-agent";
import { replaceWorkflowDraftMessage } from "./agent-hub-workflow-draft";

export function beginWorkflowDraftReply(input: {
  workflow: WorkflowDraftState;
  reply: string;
  thinkingMessage: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): {
  next: WorkflowDraftState;
  request: { requestId: string; assistantMessageId: string; content: string };
  starting: boolean;
} {
  const starting = input.workflow.messages.length === 0;
  const now = input.now ?? Date.now();
  const requestId = `workflow-${now}-${Math.random().toString(36).slice(2)}`;
  const assistantMessageId = `grill-assistant-${now}`;
  const { finalReport: _workflowFinalReport, ...workflowWithoutFinalReport } = input.workflow;
  return {
    next: input.cloneDraft({
      ...(starting ? workflowWithoutFinalReport : input.workflow),
      title: input.workflow.title || input.workflow.definition.objective || "Untitled workflow",
      status: input.workflow.status === "running" ? input.workflow.status : "draft",
      revision: starting && !input.workflow.objective.trim() ? input.workflow.revision + 1 : input.workflow.revision,
      objective: starting ? input.reply : input.workflow.objective,
      messages: [
        ...input.workflow.messages,
        { id: `grill-user-${now}`, role: "user", content: input.reply },
        { id: assistantMessageId, role: "assistant", content: input.thinkingMessage },
      ],
      reply: "",
      error: undefined,
      ...(starting
        ? {
            runProgress: [],
            runContextDocument: "",
            runIds: [],
          }
        : {}),
      updatedAt: now,
    }),
    request: {
      requestId,
      assistantMessageId,
      content: "",
    },
    starting,
  };
}

export function abandonWorkflowDraftReplyState(input: {
  workflow: WorkflowDraftState;
  activeRequest: { assistantMessageId: string; content: string };
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  now?: number;
}): WorkflowDraftState {
  const stoppedContent = input.activeRequest.content.trim() || "Stopped: workflow agent did not return a complete response yet.";
  return input.cloneDraft({
    ...input.workflow,
    messages: replaceWorkflowDraftMessage(input.workflow.messages, input.activeRequest.assistantMessageId, stoppedContent),
    error: undefined,
    updatedAt: input.now ?? Date.now(),
  });
}

export interface WorkflowDraftInteractiveRequest {
  workflowId: string;
  requestId: string;
  prompt: string;
  configuredAgentId: string;
  modelId: string;
  workDir: string;
  starting: boolean;
  runtimeConversation?: RuntimeConversation;
}

export function createWorkflowDraftInteractiveRequest(input: {
  started: {
    next: WorkflowDraftState;
    request: { requestId: string; assistantMessageId: string; content: string };
    starting: boolean;
  };
  reply: string;
  defaultWorkDir: string;
}): WorkflowDraftInteractiveRequest {
  return {
    workflowId: input.started.next.workflowId,
    requestId: input.started.request.requestId,
    prompt: input.started.starting
      ? buildWorkflowAgentPrompt({ workflowId: input.started.next.workflowId, objective: input.reply })
      : buildWorkflowRevisionPrompt({ workflowId: input.started.next.workflowId, revision: input.started.next.revision, definition: input.started.next.definition, request: input.reply }),
    configuredAgentId: input.started.next.configuredAgentId,
    modelId: input.started.next.modelId,
    workDir: input.started.next.workDir || input.defaultWorkDir,
    starting: input.started.starting,
    ...(input.started.next.runtimeConversation
      ? { runtimeConversation: input.started.next.runtimeConversation }
      : {}),
  };
}
