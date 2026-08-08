import type { WorkflowV2Plan } from "../workflow-v2/planning";
import type { WorkflowV2HumanIntervention } from "../workflow-v2/review";
import type { WorkflowV2ScriptParameterDef } from "../workflow-v2/definition";
import type { WorkflowV2NodeAcceptanceReport, WorkflowV2ScriptExecutionReceipt } from "../workflow-v2/packets";
import type { WorkflowOperationRecord, WorkflowRecoveryDecisionRecord, WorkflowRecoveryPreview, WorkflowTransactionState } from "../workflow-v2/transaction";

export interface WorkflowNodeMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at: number;
  eventType?: string;
  name?: string;
  event?: unknown;
}

// Public run-state contract consumed by UI, persistence, and answer/resume flows.
export type WorkflowRunNodeStatus = "queued" | "running" | "paused" | "awaiting_input" | "completed" | "completed_with_override" | "failed";

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
  /** Active Runtime Review Gate task, kept separate from the executor task. */
  reviewTaskId?: string;
  intervention?: WorkflowV2HumanIntervention;
  acceptance?: WorkflowV2NodeAcceptanceReport;
  scriptReceipt?: WorkflowV2ScriptExecutionReceipt;
  inputRequest?: WorkflowNodeInputRequest;
  /** Safe, persisted summary of submitted human inputs; secret values are redacted upstream. */
  inputSummary?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  reviewHistory?: import("../workflow-v2/review").WorkflowV2ReviewAttemptRecord[];
  messages?: WorkflowNodeMessage[];
  /** Live Reviewer messages mirrored into the Run before the verdict is finalized. */
  reviewMessages?: WorkflowNodeMessage[];
  /** Durable in-progress Reviewer trace, including infrastructure retries. */
  reviewTrace?: import("../workflow-v2/review").WorkflowV2ReviewTraceEntry[];
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
  modelCalls?: number;
  reviewModelCalls?: number;
  reviewQualityAttempts?: number;
  reviewInfrastructureAttempts?: number;
  reviewInputTokens?: number;
  reviewOutputTokens?: number;
  reviewReasoningTokens?: number;
  reviewEstimatedCost?: number;
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
  sequence?: number;
}

export type WorkflowStatus = "draft" | "running" | "waiting_for_user" | "completed" | "failed" | "stopped";

export type WorkflowRunTriggerSource = "manual" | "scheduled" | "mcp" | "recovery" | "rerun";

export interface WorkflowRunConfigurationSnapshot {
  configuredAgentId: string;
  runtimeId?: string;
  channelId?: string;
  modelId?: string;
  reasoningEffort?: string;
  agentRevision?: number;
}

export type WorkflowRunTimelineSegment = {
  kind: "queued" | "executing" | "waiting_for_user" | "waiting_for_approval" | "paused";
  startedAt: number;
  finishedAt?: number;
  attempt?: number;
};

export function isWorkflowRunTerminalStatus(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  triggerSource?: WorkflowRunTriggerSource;
  parentRunId?: string;
  configurationSnapshot?: WorkflowRunConfigurationSnapshot;
  workflowV2Plan: WorkflowV2Plan;
  progress: WorkflowRunProgressItem[];
  events: WorkflowEvent[];
  contextDocument: string;
  finalReport?: string;
  transaction?: WorkflowTransactionState;
  operations?: WorkflowOperationRecord[];
  recovery?: WorkflowRecoveryPreview;
  recoveryDecisions?: WorkflowRecoveryDecisionRecord[];
  startedAt: number;
  finishedAt: number | undefined;
  lastError: string | undefined;
}
