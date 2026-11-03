import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatRuntimeSessionState,
  RuntimeConversation,
  RuntimeContinuationPolicy,
  RuntimeUsage,
  TaskProgress,
  TaskRunStatus,
} from "../../../shared/types";
import { titleFromPrompt } from "../chat/agent-hub-ui";

export class ChatState {
  readonly kind = "chat";
  id: string = randomUUID();
  title: string;
  channelId: string | undefined = undefined;
  runtimeState: ChatRuntimeSessionState | undefined = undefined;
  runtimeConversation: RuntimeConversation | undefined = undefined;
  developerInstructions: string | undefined = undefined;
  contextDocument: string | undefined = undefined;
  running = false;
  messages: ChatMessage[] = [];
  pendingAssistantMessageId: string | undefined = undefined;
  lastError: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public configuredAgentId: string,
    public modelId: string,
    title = "New Chat",
  ) {
    this.title = title;
  }
}

export class TaskState {
  readonly kind = "task";
  id: string = randomUUID();
  title: string;
  runtimeConversation: RuntimeConversation | undefined = undefined;
  usage: RuntimeUsage | undefined = undefined;
  planningWorkflowId: string | undefined = undefined;
  workflowReviewRevision: number | undefined = undefined;
  workflowRunId: string | undefined = undefined;
  workflowNodeId: string | undefined = undefined;
  workflowNodeExecutionId: string | undefined = undefined;
  allowedMcpTools: string[] | undefined = undefined;
  developerInstructions: string | undefined = undefined;
  contextDocument: string | undefined = undefined;
  continuationPolicy: RuntimeContinuationPolicy = "fresh";
  running = false;
  status: TaskRunStatus = "queued";
  progress: TaskProgress = "todo";
  messages: ChatMessage[] = [];
  pendingAssistantMessageId: string | undefined = undefined;
  lastError: string | undefined = undefined;
  createdAt = Date.now();
  updatedAt = this.createdAt;

  constructor(
    public prompt: string,
    public configuredAgentId: string,
    public modelId: string,
    public workDir: string,
  ) {
    this.title = titleFromPrompt(prompt);
  }
}
