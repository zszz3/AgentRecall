import type {
  AgentId,
  RuntimeConversation,
  WorkflowAgentEvent,
  WorkflowAgentRequest,
  WorkflowAgentResponse,
  WorkflowDraftState,
} from "../../../shared/types";
import {
  createWorkflowDraftInteractiveRequest,
  type WorkflowDraftInteractiveRequest,
} from "./agent-hub-workflow-draft-reply-state";

export async function runWorkflowDraftReply(input: {
  started: {
    next: WorkflowDraftState;
    request: { requestId: string; assistantMessageId: string; content: string };
    starting: boolean;
  };
  reply: string;
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
}): Promise<void> {
  try {
    const response = await input.askWorkflowDraftAgent(
      createWorkflowDraftInteractiveRequest({
        started: input.started,
        reply: input.reply,
        defaultWorkDir: input.defaultWorkDir,
      }),
      (event) => input.handleEvent(input.started.next.workflowId, event),
    );
    input.completeRequest(
      input.started.next.workflowId,
      input.started.request.requestId,
      response.content,
      response.runtimeConversation,
    );
  } catch (error) {
    input.failRequest(
      input.started.next.workflowId,
      input.started.request.requestId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function buildWorkflowAgentExecution<TResolved extends {
  agent: { id: string; name: string };
  runtimeAgentId: AgentId;
  runtime: { available: boolean } | undefined;
  channel: { id: string };
}>(input: {
  request: WorkflowAgentRequest;
  resolveConfiguredAgent: (configuredAgentId: string, modelId?: string, channelId?: string) => TResolved | undefined;
  cloneConversationForPolicy: (
    continuationPolicy: WorkflowAgentRequest["continuationPolicy"],
    runtimeConversation: RuntimeConversation | undefined,
  ) => RuntimeConversation | undefined;
  defaultWorkDir: string;
  createRequestId: () => string;
}): {
  requestId: string;
  planningWorkflowId?: string;
  runtimeId: AgentId;
  executionMode: WorkflowAgentRequest["executionMode"];
  continuationPolicy: WorkflowAgentRequest["continuationPolicy"];
  runtimeConfig: WorkflowAgentRequest["runtimeConfig"];
  runtimeConversation?: RuntimeConversation;
  prompt: string;
  runtime: NonNullable<TResolved["runtime"]>;
  channelId: string;
  workDir: string;
} {
  const prompt = input.request.prompt.trim();
  if (!prompt) throw new Error("Workflow agent prompt is required");

  const resolved = input.resolveConfiguredAgent(input.request.configuredAgentId, input.request.runtimeConfig.model);
  if (!resolved) throw new Error("No configured agent is selected.");
  if (resolved.runtimeAgentId !== input.request.runtimeId) {
    throw new Error(`Configured agent ${resolved.agent.id} does not match runtime ${input.request.runtimeId}.`);
  }
  if (!resolved.runtime?.available) {
    throw new Error(`${resolved.agent.name || resolved.agent.id} is not available on this machine.`);
  }

  const runtimeConversation = input.cloneConversationForPolicy(
    input.request.continuationPolicy,
    input.request.runtimeConversation,
  );

  return {
    requestId: input.request.requestId ?? input.createRequestId(),
    ...(input.request.planningWorkflowId ? { planningWorkflowId: input.request.planningWorkflowId } : {}),
    runtimeId: input.request.runtimeId,
    executionMode: input.request.executionMode,
    continuationPolicy: input.request.continuationPolicy,
    runtimeConfig: input.request.runtimeConfig,
    ...(runtimeConversation ? { runtimeConversation } : {}),
    prompt,
    runtime: resolved.runtime,
    channelId: resolved.channel.id,
    workDir: input.request.workDir?.trim() || input.defaultWorkDir,
  };
}
