import type { WorkflowV2Plan } from "../workflow-v2/planning";
import type { WorkflowV2HumanIntervention } from "../workflow-v2/review";
import type { WorkflowV2ScriptParameterDef } from "../workflow-v2/definition";

// Public run-state contract consumed by UI, persistence, and answer/resume flows.
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
