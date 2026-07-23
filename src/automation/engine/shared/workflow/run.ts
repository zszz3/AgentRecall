import type { WorkflowV2Plan } from "../workflow-v2/planning";
import type { WorkflowV2HumanIntervention } from "../workflow-v2/review";
import type { WorkflowV2ScriptParameterDef } from "../workflow-v2/definition";
import type { WorkflowNodeMessage } from "../workflow-v2/conversation";

export type WorkflowRunNodeStatus = "queued" | "running" | "paused" | "awaiting_input" | "completed" | "failed";

export type WorkflowNodeInputRequest = {
  kind: "script_parameters";
  parameters: WorkflowV2ScriptParameterDef[];
} | {
  kind: "agent_message";
  prompt: string;
};

export interface WorkflowRunProgressItem {
  nodeId: string;
  title: string;
  status: WorkflowRunNodeStatus;
  detail?: string;
  taskId?: string;
  intervention?: WorkflowV2HumanIntervention;
  inputRequest?: WorkflowNodeInputRequest;
  outputs?: Record<string, unknown>;
  messages?: WorkflowNodeMessage[];
  telemetry?: WorkflowRunNodeTelemetry;
}

export interface WorkflowRunNodeTelemetry {
  provider?: "openai" | "anthropic" | string;
  runtimeId?: string;
  channelId?: string;
  modelId?: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  /** Provider-reported input/prompt tokens; OpenAI includes cached prompt tokens here. */
  inputTokens?: number;
  /** Provider-reported output/completion tokens. */
  outputTokens?: number;
  /** Provider-reported reasoning tokens when exposed separately. */
  reasoningTokens?: number;
  /** OpenAI cached prompt tokens or Anthropic cache_read_input_tokens. */
  cacheReadInputTokens?: number;
  /** Anthropic cache_creation_input_tokens total. */
  cacheWriteInputTokens?: number;
  /** Anthropic cache_creation.ephemeral_5m_input_tokens. */
  cacheWrite5mInputTokens?: number;
  /** Anthropic cache_creation.ephemeral_1h_input_tokens. */
  cacheWrite1hInputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
}

export type WorkflowEventType =
  | "node_ready"
  | "node_started"
  | "node_paused"
  | "node_output"
  | "node_judged"
  | "node_failed"
  | "node_completed"
  | "gate_opened"
  | "gate_answered"
  | "graph_revised";

export interface WorkflowArtifactReference {
  kind: "text" | "file" | "url";
  title: string;
  content?: string;
  path?: string;
  url?: string;
}

export interface WorkflowEvent {
  type: WorkflowEventType;
  nodeId: string;
  at: number;
  attempt?: number;
  taskId?: string;
  detail?: string;
  pass?: boolean;
  summary?: string;
  artifactRefs?: WorkflowArtifactReference[];
  error?: string;
  question?: string;
  answer?: string;
  intervention?: WorkflowV2HumanIntervention;
}

export type WorkflowStatus = "draft" | "running" | "waiting_for_user" | "completed" | "failed" | "stopped";

export function isWorkflowRunTerminalStatus(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  workflowV2Plan: WorkflowV2Plan;
  progress: WorkflowRunProgressItem[];
  events: WorkflowEvent[];
  contextDocument: string;
  finalReport?: string;
  startedAt: number;
  finishedAt: number | undefined;
  lastError: string | undefined;
}
