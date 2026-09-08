export type WorkflowValueType = "text" | "number" | "boolean" | "file" | "object" | "list";

export interface WorkflowInputDefinition {
  key: string;
  name: string;
  description: string;
  type: WorkflowValueType;
  required: boolean;
}

export type WorkflowNodeInput =
  | { source: "workflow"; workflowInputKey: string }
  | { source: "node"; nodeId: string; outputKey: string };

export function workflowNodeInputKey(input: WorkflowNodeInput): string {
  return input.source === "workflow" ? input.workflowInputKey : `${input.nodeId}.${input.outputKey}`;
}

export interface WorkflowOutputField {
  key: string;
  name: string;
  description: string;
  type: WorkflowValueType;
  required: boolean;
}

export interface WorkflowNodeBase {
  id: string;
  kind: "agent" | "script" | "review" | "approval";
  title: string;
  goal: string;
  inputs: WorkflowNodeInput[];
  outputs: WorkflowOutputField[];
  acceptanceCriteria: string[];
  position?: { x: number; y: number };
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  kind: "agent";
  agentId: string;
  instructions: string[];
  constraints: string[];
}

export type WorkflowScriptRuntime = "bash" | "python" | "typescript";
export type WorkflowScriptPermission = "workspace_read" | "workspace_write" | "workspace_delete" | "network" | "process";

export interface WorkflowScriptNode extends WorkflowNodeBase {
  kind: "script";
  runtime: WorkflowScriptRuntime;
  source: string;
  timeoutSeconds: number;
  permissions: WorkflowScriptPermission[];
}

export interface WorkflowReviewCriterion {
  key: string;
  description: string;
}

export interface WorkflowReviewNode extends WorkflowNodeBase {
  kind: "review";
  agentId: string;
  instructions: string[];
  constraints: string[];
  targetNodeIds: string[];
  criteria: WorkflowReviewCriterion[];
  maxRevisions: number;
  onReject: "revise" | "stop";
}

export interface WorkflowApprovalOption {
  value: string;
  label: string;
  description: string;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  kind: "approval";
  message: string;
  options: WorkflowApprovalOption[];
  allowComment: boolean;
}

export type WorkflowNode = WorkflowAgentNode | WorkflowScriptNode | WorkflowReviewNode | WorkflowApprovalNode;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  /** Optional Workflow-specific directory; null explicitly falls back to the global default. */
  workDir?: string | null;
  isTemplate?: boolean;
  /** Optional authoring conversation; older definitions have no planning state. */
  planning?: WorkflowPlanningState;
  inputs: WorkflowInputDefinition[];
  nodes: WorkflowNode[];
  createdAt: number;
  updatedAt: number;
}

export type WorkflowProposal = Pick<WorkflowDefinition, "name" | "description" | "inputs" | "nodes">;

export interface WorkflowPlanningState {
  agentId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  proposal?: WorkflowProposal;
}

export interface WorkflowPlanningRequest {
  requestId: string;
  definition: WorkflowDefinition;
  agentId: string;
  message: string;
  intent: "interview" | "generate";
}

export type WorkflowRunStatus = "running" | "paused" | "waiting" | "completed" | "failed" | "cancelled";
export type WorkflowNodeRunStatus = "pending" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type WorkflowRunEventType =
  | "run_started"
  | "run_paused"
  | "run_resumed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "node_started"
  | "node_waiting"
  | "node_completed"
  | "node_failed"
  | "node_retried"
  | "approval_resolved"
  | "review_revised";

export interface WorkflowRunEvent {
  sequence: number;
  type: WorkflowRunEventType;
  timestamp: number;
  nodeId?: string;
  attempt?: number;
  durationMs?: number;
  errorCode?: string;
}

export type WorkflowRunStreamEvent =
  | {
      runId: string;
      nodeId: string;
      type: "started";
      timestamp: number;
    }
  | {
      runId: string;
      nodeId: string;
      type: "delta";
      content: string;
      timestamp: number;
    };

export interface WorkflowRunError {
  code: string;
  message: string;
  fieldPath?: string;
}

export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  attempt: number;
  resolvedInputs?: Record<string, unknown>;
  revisionFeedback?: string[];
  outputs?: Record<string, unknown>;
  error?: WorkflowRunError;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  status: WorkflowRunStatus;
  nodeRuns: Record<string, WorkflowNodeRun>;
  events: WorkflowRunEvent[];
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowCoreSnapshot {
  definitions: WorkflowDefinition[];
  runs: WorkflowRun[];
}
