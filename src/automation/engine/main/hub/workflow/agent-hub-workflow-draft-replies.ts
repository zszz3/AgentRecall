import type {
  RuntimeConversation,
  WorkflowAgentEvent,
  WorkflowAgentResponse,
  WorkflowDraftState,
} from "../../../shared/types";
import type { WorkflowGrillEvent } from "../../../shared/workflow/draft";
import { replaceWorkflowDraftMessage } from "./agent-hub-workflow-draft";
import { runWorkflowDraftReply } from "./agent-hub-workflow-agent";
import {
  beginWorkflowDraftReply,
  type WorkflowDraftInteractiveRequest,
} from "./agent-hub-workflow-draft-reply-state";

export interface ActiveWorkflowDraftRequest {
  requestId: string;
  assistantMessageId: string;
  content: string;
}

function safeWorkflowToolEventContent(content: string): string {
  const redacted = content
    .replace(/(\bauthorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\b\s*=\s*)[^\s\r\n]+/gi, "$1[REDACTED]")
    .replace(/("(?:authorization|[^"\r\n]*(?:token|secret|password|api_key)[^"\r\n]*)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
  return redacted.length <= 4_000 ? redacted : `${redacted.slice(0, 4_000).trimEnd()}\n...`;
}

export async function dispatchWorkflowDraftReply(input: {
  workflow: WorkflowDraftState | undefined;
  reply: string;
  activeRequest: ActiveWorkflowDraftRequest | undefined;
  thinkingMessage: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  activateWorkflow: (workflowId: string) => void;
  storeWorkflow: (workflow: WorkflowDraftState) => void;
  storeActiveRequest: (workflowId: string, request: ActiveWorkflowDraftRequest) => void;
  emit: () => void;
  persist: () => Promise<void>;
  defaultWorkDir: string;
  askWorkflowDraftAgent: (
    request: WorkflowDraftInteractiveRequest,
    onEvent?: (event: WorkflowAgentEvent) => void,
  ) => Promise<WorkflowAgentResponse>;
  handleEvent: (workflowId: string, event: WorkflowAgentEvent) => void;
  completeRequest: (
    workflowId: string,
    requestId: string,
    content: string,
    runtimeConversation?: RuntimeConversation,
  ) => void;
  failRequest: (workflowId: string, requestId: string, error: string) => void;
}): Promise<boolean> {
  const text = input.reply.trim();
  if (!input.workflow || !text || input.activeRequest) return false;

  const started = beginWorkflowDraftReply({
    workflow: input.workflow,
    reply: text,
    thinkingMessage: input.thinkingMessage,
    cloneDraft: input.cloneDraft,
  });
  input.storeWorkflow(started.next);
  input.activateWorkflow(started.next.workflowId);
  input.storeActiveRequest(started.next.workflowId, started.request);
  input.emit();
  await input.persist();

  await runWorkflowDraftReply({
    started,
    reply: text,
    defaultWorkDir: input.defaultWorkDir,
    askWorkflowDraftAgent: input.askWorkflowDraftAgent,
    handleEvent: input.handleEvent,
    completeRequest: input.completeRequest,
    failRequest: input.failRequest,
  });
  return true;
}

export function reduceWorkflowDraftReplyEvent(input: {
  workflow: WorkflowDraftState | undefined;
  activeRequest: ActiveWorkflowDraftRequest | undefined;
  event: WorkflowAgentEvent;
  thinkingMessage: string;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  replaceMessage: (messages: WorkflowDraftState["messages"], messageId: string, content: string) => WorkflowDraftState["messages"];
  now?: number;
}):
  | { type: "ignored" }
  | { type: "delta"; workflow: WorkflowDraftState }
  | { type: "event"; workflow: WorkflowDraftState }
  | { type: "completed"; requestId: string; content: string; runtimeConversation: RuntimeConversation | undefined }
  | { type: "error"; requestId: string; error: string } {
  if (!input.activeRequest || input.activeRequest.requestId !== input.event.requestId) return { type: "ignored" };

  if (input.event.type === "delta") {
    if (!input.workflow) return { type: "ignored" };
    input.activeRequest.content += input.event.content;
    return {
      type: "delta",
      workflow: input.cloneDraft({
        ...input.workflow,
        revision: input.workflow.revision + 1,
        messages: input.replaceMessage(
          input.workflow.messages,
          input.activeRequest.assistantMessageId,
          input.activeRequest.content || input.thinkingMessage,
        ),
        updatedAt: input.now ?? Date.now(),
      }),
    };
  }

  if (
    input.event.type === "tool_call"
    || input.event.type === "tool_result"
    || input.event.type === "approval_request"
    || input.event.type === "approval_response"
  ) {
    if (!input.workflow) return { type: "ignored" };
    const runtimeEvent = input.event;
    const timestamp = input.now ?? Date.now();
    const event: WorkflowGrillEvent = runtimeEvent.type === "approval_request"
      ? {
          id: `workflow-approval-${runtimeEvent.approvalRequestId}-${timestamp}`,
          type: "approval_request",
          content: runtimeEvent.content,
          timestamp,
          requestId: runtimeEvent.approvalRequestId,
          requestState: "live",
          ...(runtimeEvent.metadata ? { metadata: structuredClone(runtimeEvent.metadata) } : {}),
        }
      : runtimeEvent.type === "approval_response"
        ? {
            id: `workflow-approval-response-${runtimeEvent.approvalRequestId}-${timestamp}`,
            type: "approval_response",
            content: runtimeEvent.content ?? "",
            timestamp,
            requestId: runtimeEvent.approvalRequestId,
            decision: runtimeEvent.decision,
            ...(runtimeEvent.metadata ? { metadata: structuredClone(runtimeEvent.metadata) } : {}),
          }
        : {
            id: `workflow-tool-${runtimeEvent.requestId}-${runtimeEvent.type}-${timestamp}`,
            type: runtimeEvent.type,
            content: safeWorkflowToolEventContent(runtimeEvent.content),
            timestamp,
            ...(runtimeEvent.name ? { name: runtimeEvent.name } : {}),
            ...(runtimeEvent.metadata ? { metadata: structuredClone(runtimeEvent.metadata) } : {}),
          };
    const messages = input.workflow.messages.map((message) => message.id === input.activeRequest!.assistantMessageId
      ? {
          ...message,
          events: [
            ...(message.events ?? []).map((existing) =>
              runtimeEvent.type === "approval_response"
              && existing.type === "approval_request"
              && existing.requestId === runtimeEvent.approvalRequestId
              && existing.requestState === "live"
                ? { ...existing, requestState: "resolved" as const }
                : existing),
            event,
          ],
        }
      : message);
    return {
      type: "event",
      workflow: input.cloneDraft({
        ...input.workflow,
        revision: input.workflow.revision + 1,
        messages,
        updatedAt: input.now ?? Date.now(),
      }),
    };
  }

  if (input.event.type === "completed") {
    return {
      type: "completed",
      requestId: input.event.requestId,
      content: input.event.content,
      runtimeConversation: input.event.runtimeConversation,
    };
  }

  if (input.event.type === "error") {
    return {
      type: "error",
      requestId: input.event.requestId,
      error: input.event.error,
    };
  }

  return { type: "ignored" };
}
