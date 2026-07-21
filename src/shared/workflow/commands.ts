import type { RuntimeConversation } from "../runtime/conversation";
import type { WorkflowV2ContextBudget, WorkflowV2Definition, WorkflowV2ModelProfile, WorkflowV2NodeRole, WorkflowV2ValidationResult } from "../workflow-v2/definition";
import type { WorkflowV2AcceptanceCriterion, WorkflowV2CostBudget, WorkflowV2GraphRevision, WorkflowV2Plan } from "../workflow-v2/planning";
import type { WorkflowV2InterventionAction } from "../workflow-v2/review";
import type { WorkflowV2GenerationReviewState } from "../workflow-v2/generation-review";
import type { WorkflowGrillMessage } from "./draft";
import type { WorkflowArtifactReference, WorkflowEvent, WorkflowRunProgressItem, WorkflowStatus } from "./run";

// Shared request/result shells for workflow mutations. Keeping these stable
// lets preload/main/UI layers migrate independently without renaming payloads.
export interface SendWorkflowNodeMessageRequest {
  conversationId: string;
  message: string;
}

export interface CompleteWorkflowNodeConversationRequest {
  conversationId: string;
}

export interface RejectWorkflowNodeCompletionRequest {
  conversationId: string;
  instruction: string;
}

export interface InterruptWorkflowNodeConversationRequest {
  conversationId: string;
}
export interface WorkflowOperationResult {
  ok: boolean;
  workflowId?: string;
  runId?: string;
  revision?: number;
  error?: string;
}

export interface MaterializeWorkflowDraftRequest {
  title: string;
  objective: string;
  definition: WorkflowV2Definition;
  configuredAgentId?: string;
  modelId?: string;
  reviewerConfiguredAgentId?: string;
  reviewerModelId?: string;
  workDir?: string;
  messages?: WorkflowGrillMessage[];
  reply?: string;
  error?: string;
  runProgress?: WorkflowRunProgressItem[];
  runContextDocument?: string;
  contextDocument?: string;
  workflowV2Plan?: WorkflowV2Plan;
  finalReport?: string;
  runIds?: string[];
  runtimeConversation?: RuntimeConversation;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateWorkflowDraftRequest {
  title?: string;
  configuredAgentId?: string;
  modelId?: string;
  reviewerConfiguredAgentId?: string;
  reviewerModelId?: string;
}

export interface PatchWorkflowDraftRequest {
  workflowId: string;
  title?: string;
  status?: WorkflowStatus;
  configuredAgentId?: string;
  modelId?: string;
  reviewerConfiguredAgentId?: string;
  reviewerModelId?: string;
  objective?: string;
  workDir?: string | null;
  definition?: WorkflowV2Definition;
  messages?: WorkflowGrillMessage[];
  reply?: string;
  error?: string | null;
  runProgress?: WorkflowRunProgressItem[];
  runContextDocument?: string;
  contextDocument?: string;
  workflowV2Plan?: WorkflowV2Plan | null;
  generationReview?: WorkflowV2GenerationReviewState | null;
  finalReport?: string | null;
  runtimeConversation?: RuntimeConversation | null;
  resetRunState?: boolean;
}

export interface SendWorkflowDraftReplyRequest {
  workflowId: string;
  reply: string;
}

export interface UpdateWorkflowRequest {
  workflowId: string;
  expectedRevision?: number;
  title?: string;
  objective?: string;
  definition?: WorkflowV2Definition;
  configuredAgentId?: string;
  modelId?: string;
  reviewerConfiguredAgentId?: string;
  reviewerModelId?: string;
  messages?: WorkflowGrillMessage[];
  reply?: string;
  error?: string;
  runProgress?: WorkflowRunProgressItem[];
  runContextDocument?: string;
  contextDocument?: string;
  workflowV2Plan?: WorkflowV2Plan | null;
  generationReview?: WorkflowV2GenerationReviewState | null;
  finalReport?: string;
  runtimeConversation?: RuntimeConversation;
}

export interface AppendWorkflowContextRequest {
  workflowId: string;
  report: string;
  handoff: string;
  artifacts?: WorkflowArtifactReference[];
}

export interface AppendWorkflowRunContextRequest extends AppendWorkflowContextRequest {
  runId: string;
  nodeId?: string;
}

export interface StartWorkflowRunRequest {
  workflowId: string;
  contextDocument?: string;
}

export interface ListWorkflowOutputsRequest {
  workflowId: string;
  runId: string;
}
export interface RunWorkflowRequest {
  workflowId: string;
  contextDocument?: string;
}

export interface ConfirmWorkflowRequest {
  workflowId: string;
  expectedRevision?: number;
}

export interface ReviewWorkflowRequest {
  workflowId: string;
  expectedRevision: number;
}

export interface InterruptWorkflowReviewRequest {
  workflowId: string;
}

export interface BuildWorkflowV2PlanRequest {
  definition: WorkflowV2Definition;
  objective?: string;
  approvedBy: string;
  acceptanceCriteria?: WorkflowV2AcceptanceCriterion[];
  contextBudget?: WorkflowV2ContextBudget;
  costBudget?: WorkflowV2CostBudget;
  roleModelProfiles?: Partial<Record<WorkflowV2NodeRole, WorkflowV2ModelProfile>>;
}

export interface BuildWorkflowV2PlanResult {
  ok: boolean;
  plan?: WorkflowV2Plan;
  error?: string;
  validation?: WorkflowV2ValidationResult;
}

export interface BuildWorkflowV2GraphRevisionRequest {
  basedOnGraphVersion: number;
  nextGraphVersion?: number;
  reason: string;
  changesSummary: string;
  approvedBy: string;
  now?: number;
}

export interface BuildWorkflowV2GraphRevisionResult {
  ok: boolean;
  revision?: WorkflowV2GraphRevision;
  error?: string;
}

export interface PauseWorkflowNodeRequest {
  workflowId: string;
  runId: string;
  nodeId: string;
}

export interface StopWorkflowRunRequest {
  workflowId: string;
  runId: string;
}

export interface StartWorkflowNodeRequest extends PauseWorkflowNodeRequest {}

export interface ResolveWorkflowV2InterventionRequest extends PauseWorkflowNodeRequest {
  action: WorkflowV2InterventionAction;
  reason?: string;
}

export interface ReviseWorkflowV2RunRequest extends PauseWorkflowNodeRequest {
  definition: WorkflowV2Definition;
  reason: string;
  approvedBy: string;
}

export interface AnswerWorkflowGateRequest {
  workflowId: string;
  runId: string;
  nodeId: string;
  answer: string;
}

export interface SubmitWorkflowScriptInputRequest {
  workflowId: string;
  runId: string;
  nodeId: string;
  values: Record<string, unknown>;
}

export interface FinishWorkflowRunRequest {
  workflowId: string;
  runId: string;
  status: "completed" | "failed" | "stopped";
  progress?: WorkflowRunProgressItem[];
  appendEvents?: WorkflowEvent[];
  contextDocument?: string;
  finalReport?: string;
  lastError?: string;
}
