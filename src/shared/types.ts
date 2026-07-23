import type { RuntimeConversation } from "./runtime/conversation";
import type { RuntimeUsage } from "./runtime/usage";
export type { RuntimeUsage } from "./runtime/usage";

// Minimal compatibility barrel for shared workflow modules that still import
// legacy names from src/shared/types.ts in the source repo.
export type {
  WorkflowArtifactReference,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowRunNodeStatus,
  WorkflowRunProgressItem,
  WorkflowRunState,
  WorkflowStatus,
} from "./workflow/run";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error" | "meta";
  content: string;
  timestamp: number;
}

export type TaskRunStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export type TaskProgress = "backlog" | "todo" | "in_progress" | "in_review" | "done";

export interface TaskRun {
  id: string;
  title: string;
  prompt: string;
  configuredAgentId: string;
  modelId: string;
  workDir: string;
  status: TaskRunStatus;
  progress: TaskProgress;
  running: boolean;
  runtimeConversation?: RuntimeConversation;
  usage?: RuntimeUsage;
  messages: ChatMessage[];
  pendingAssistantMessageId: string | undefined;
  lastError: string | undefined;
  createdAt: number;
  updatedAt: number;
}
