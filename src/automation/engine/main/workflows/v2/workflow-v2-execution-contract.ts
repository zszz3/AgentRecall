import type { RuntimeConversation } from "../../../shared/runtime/conversation";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2ModelProfile } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import type { WorkflowV2DurableNodeControlState } from "../../../shared/workflow-v2/storage";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";

export interface WorkflowV2RecoveryOverride {
  modelProfile?: WorkflowV2ModelProfile;
  forceIndependentReview: boolean;
  instruction: string;
  userInput?: string;
  scriptApproval?: {
    requestId: string;
    operationDigest: string;
  };
}

export interface ExecuteWorkflowV2RunInput {
  workflow: WorkflowDraftState;
  plan: WorkflowV2Plan;
  runId: string;
  baseWorkflowContextDocument: string;
  storagePlanDocument: string;
  initialCheckpoint?: ExecuteWorkflowV2Checkpoint;
  initialNodeControl?: Record<string, WorkflowV2DurableNodeControlState>;
  initialDurableEventCount?: number;
  recoveryCheckpoints?: ReadonlyMap<string, string>;
  resumeConversations?: ReadonlyMap<string, RuntimeConversation>;
  recoveryOverrides?: ReadonlyMap<string, WorkflowV2RecoveryOverride>;
}
