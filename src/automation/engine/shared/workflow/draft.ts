import type { ResourceSourceType } from "../resource";
import type { RuntimeConversation } from "../runtime/conversation";
import type { WorkflowV2Definition } from "../workflow-v2/definition";
import type { WorkflowV2Plan } from "../workflow-v2/planning";
import type { WorkflowV2GenerationReviewState } from "../workflow-v2/generation-review";
import type { WorkflowRunProgressItem, WorkflowRunState, WorkflowStatus } from "./run";

export interface WorkflowGrillMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
}

export interface WorkflowDraftState {
  workflowId: string;
  sourceType?: ResourceSourceType;
  topologyLocked?: boolean;
  title: string;
  status: WorkflowStatus;
  revision: number;
  confirmedRevision?: number;
  configuredAgentId: string;
  modelId: string;
  reviewerConfiguredAgentId: string;
  reviewerModelId: string;
  objective: string;
  definition: WorkflowV2Definition;
  workDir?: string;
  messages: WorkflowGrillMessage[];
  reply: string;
  error: string | undefined;
  runProgress: WorkflowRunProgressItem[];
  runContextDocument: string;
  contextDocument: string;
  workflowV2Plan?: WorkflowV2Plan;
  generationReview?: WorkflowV2GenerationReviewState;
  finalReport?: string;
  runIds: string[];
  runtimeConversation?: RuntimeConversation;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStoreState {
  activeWorkflowId: string | undefined;
  workflows: WorkflowDraftState[];
  runs: WorkflowRunState[];
}
