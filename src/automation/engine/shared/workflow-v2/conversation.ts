import type { AgentEvent, ChatEvent, RuntimeConversation } from "../types";
import type { WorkflowV2WorkerOutput } from "./packets";
import type { WorkflowRunNodeTelemetry } from "../workflow/run";

export type WorkflowNodeConversationStatus =
  | "starting"
  | "active"
  | "waiting_for_user"
  | "completion_proposed"
  | "closed"
  | "failed";

export interface WorkflowNodeMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at: number;
  eventType?: AgentEvent["type"];
  name?: string;
  event?: ChatEvent;
}

export interface WorkflowNodeCompletionProposal {
  output: WorkflowV2WorkerOutput;
  acceptanceCriteria: Array<{ key: string; satisfied: boolean; evidence?: string }>;
  unresolvedRisks: string[];
  proposedAt: number;
}

export interface WorkflowNodeConversation {
  conversationId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  configuredAgentId: string;
  modelId: string;
  workDir: string;
  runtimeConversation?: RuntimeConversation;
  telemetry?: WorkflowRunNodeTelemetry;
  status: WorkflowNodeConversationStatus;
  messages: WorkflowNodeMessage[];
  completionProposal?: WorkflowNodeCompletionProposal;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

export function workflowNodeConversationId(workflowId: string, runId: string, nodeId: string): string {
  return [workflowId, runId, nodeId].map((part) => encodeURIComponent(part)).join("::");
}
