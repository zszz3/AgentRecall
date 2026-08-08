import type {
  AppSnapshot,
  RunTaskRequest,
} from "../../shared/types";
import type { FinishWorkflowRunRequest, StartWorkflowRunRequest, WorkflowOperationResult } from "../../shared/workflow/commands";
import type { WorkflowEvent, WorkflowRunProgressItem } from "../../shared/workflow/run";
import type { WorkflowNodeConversation } from "../../shared/workflow-v2/conversation";
import type { WorkflowV2ScriptAuthorization, WorkflowV2ScriptNode } from "../../shared/workflow-v2/definition";
import type { WorkflowV2ScriptWorkerOutput, WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import type {
  WorkflowV2NodeCompletionLedger,
  WorkflowV2NodeCompletionSubmission,
  WorkflowV2NodeCompletionSubmissionStatus,
} from "../../shared/workflow-v2/completion";
import type { WorkflowV2ResultPacket } from "../../shared/workflow-v2/planning";
import type {
  WorkflowV2CacheEntryMetadata,
  WorkflowV2DurableEvent,
  WorkflowV2PersistedRunState,
} from "../../shared/workflow-v2/storage";
import type { WorkflowV2ReviewerInput, WorkflowV2ReviewerResponse } from "../../shared/workflow-v2/review";
import type { WorkflowCommitPlan, WorkflowOperationRecord, WorkflowOperationState, WorkflowTransactionMode } from "../../shared/workflow-v2/transaction";
import type { WorkflowRecoveryDecisionRecord, WorkflowRecoveryManagerRecommendation, WorkflowRecoveryPreview, WorkflowTransactionState } from "../../shared/workflow-v2/transaction";
import type { WorkflowWorkspaceCommitResult, WorkflowWorkspaceConflictPreview, WorkflowWorkspaceDiffResult, WorkflowWorkspacePreparation, WorkflowWorkspaceRollbackResult } from "./v2/workflow-v2-workspace-transaction";

export interface WorkflowRunStateUpdate {
  workflowId: string;
  runId: string;
  status?: "running" | "waiting_for_user";
  progress?: WorkflowRunProgressItem[];
  appendEvents?: WorkflowEvent[];
  contextDocument?: string;
  finalReport?: string;
  lastError?: string;
  transaction?: WorkflowTransactionState;
  operations?: WorkflowOperationRecord[] | null;
  recovery?: WorkflowRecoveryPreview | null;
  recoveryDecisions?: WorkflowRecoveryDecisionRecord[];
}

export interface ExecuteWorkflowV2ScriptRequest {
  node: WorkflowV2ScriptNode;
  workDir: string;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  signal: AbortSignal;
  timeoutMs: number;
  inputs: Readonly<Record<string, unknown>>;
  authorization: WorkflowV2ScriptAuthorization;
  transactionMode?: WorkflowTransactionMode;
  requireReversibleOperations?: boolean;
}

export interface WorkflowV2StorePort {
  persistRunState: (state: WorkflowV2PersistedRunState) => Promise<void>;
  appendEvents: (input: {
    workflowId: string;
    runId: string;
    events: readonly WorkflowV2DurableEvent[];
  }) => Promise<void>;
  planOperation?: (input: { workflowId: string; record: WorkflowOperationRecord }) => Promise<WorkflowOperationRecord>;
  transitionOperation?: (input: {
    workflowId: string;
    runId: string;
    operationId: string;
    state: WorkflowOperationState;
    updatedAt: number;
    receipt?: unknown;
    error?: string;
  }) => Promise<WorkflowOperationRecord>;
  readOperations?: (workflowId: string, runId: string) => Promise<WorkflowOperationRecord[]>;
  resolveUnknownOperation?: (input: {
    workflowId: string;
    runId: string;
    operationId: string;
    verifiedState: "applied" | "compensated";
    actor: string;
    reason: string;
    updatedAt: number;
    evidence?: unknown;
  }) => Promise<WorkflowOperationRecord>;
  prepareWorkspaceTransaction?: (input: { workflowId: string; runId: string; sourceDir: string; baselineId: string; now?: number }) => Promise<WorkflowWorkspacePreparation>;
  createWorkspaceSavepoint?: (input: { workflowId: string; runId: string; savepointId: string; nodeId: string; attempt: number; now?: number }) => Promise<void>;
  restoreWorkspaceSavepoint?: (input: { workflowId: string; runId: string; savepointId: string }) => Promise<void>;
  commitWorkspaceTransaction?: (input: { workflowId: string; runId: string }) => Promise<WorkflowWorkspaceCommitResult>;
  discardWorkspaceTransaction?: (input: { workflowId: string; runId: string }) => Promise<void>;
  rollbackWorkspaceTransaction?: (input: { workflowId: string; runId: string }) => Promise<WorkflowWorkspaceRollbackResult>;
  inspectWorkspaceTransaction?: (input: { workflowId: string; runId: string }) => Promise<WorkflowWorkspaceDiffResult>;
  inspectWorkspaceConflicts?: (input: { workflowId: string; runId: string; paths: readonly string[] }) => Promise<WorkflowWorkspaceConflictPreview[]>;
  resolveWorkspaceConflict?: (input: { workflowId: string; runId: string; path: string; resolution: "isolated" | "current" | "manual"; expectedCurrentSha256?: string; content?: string }) => Promise<WorkflowWorkspaceConflictPreview>;
  inspectWorkspaceSavepointDiff?: (input: { workflowId: string; runId: string; savepointId: string }) => Promise<WorkflowWorkspaceDiffResult>;
  persistCommitPlan?: (plan: WorkflowCommitPlan) => Promise<WorkflowCommitPlan>;
  readCommitPlan?: (workflowId: string, runId: string) => Promise<WorkflowCommitPlan | undefined>;
  cleanupRunMaterials?: (workflowId: string, runId: string) => Promise<void>;
  persistCacheEntry?: (entry: WorkflowV2CacheEntryMetadata) => Promise<void>;
  readRunState?: (workflowId: string, runId: string) => Promise<WorkflowV2PersistedRunState | undefined>;
  readCacheEntry?: (
    workflowId: string,
    graphVersion: number,
    nodeId: string,
  ) => Promise<WorkflowV2CacheEntryMetadata | undefined>;
  beginNodeCompletionExecution?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    attempt: number;
    startedAt: number;
  }) => Promise<WorkflowV2NodeCompletionLedger>;
  submitNodeCompletion?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    output: WorkflowV2WorkerOutput;
    submittedAt: number;
  }) => Promise<WorkflowV2NodeCompletionSubmission>;
  readLatestNodeCompletionSubmission?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
  }) => Promise<WorkflowV2NodeCompletionSubmission | undefined>;
  resolveNodeCompletionSubmission?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    submissionId: string;
    status: Extract<WorkflowV2NodeCompletionSubmissionStatus, "consumed" | "accepted" | "rejected">;
    resolvedAt: number;
    reason?: string;
  }) => Promise<WorkflowV2NodeCompletionSubmission>;
}

export interface WorkflowV2RecoveryOperationBroker {
  canInspectOperation: (operation: WorkflowOperationRecord) => boolean;
  canCompensateOperation: (operation: WorkflowOperationRecord) => boolean;
  inspect: (input: { workflowId: string; runId: string; operationId: string; signal?: AbortSignal }) => Promise<"applied" | "not_applied" | "unknown">;
  applyPrepared?: (input: { workflowId: string; runId: string; operationId: string; signal?: AbortSignal }) => Promise<unknown>;
  compensateRun: (input: { workflowId: string; runId: string; operationIds?: readonly string[]; signal?: AbortSignal }) => Promise<{ compensated: string[]; skipped: string[]; failed?: { operationId: string; error: string } }>;
}

export interface WorkflowRuntimeDependencies {
  snapshot: () => AppSnapshot;
  startWorkflowRun: (input: StartWorkflowRunRequest) => WorkflowOperationResult;
  finishWorkflowRun: (input: FinishWorkflowRunRequest) => WorkflowOperationResult;
  updateWorkflowRunState: (input: WorkflowRunStateUpdate) => void;
  runTask: (input: RunTaskRequest, approvalPolicy?: { allowedFileWriteRoot: string; workspaceOnly?: boolean; readOnly?: boolean }) => Promise<AppSnapshot>;
  stopTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, options?: { preserveRuntimeConversation?: boolean }) => Promise<AppSnapshot>;
  beginWorkflowReviewGate?: (input: {
    workflowId: string;
    runId: string;
    executionId: string;
    reviewerNodeId: string;
    reviewerInput: WorkflowV2ReviewerInput;
  }) => void;
  takeWorkflowReviewGateSubmission?: (executionId: string) => WorkflowV2ReviewerResponse | undefined;
  clearWorkflowReviewGate?: (executionId: string) => void;
  executeWorkflowV2Script: (input: ExecuteWorkflowV2ScriptRequest) => Promise<WorkflowV2ScriptWorkerOutput>;
  /** Executes brokered_external scripts through a host integration that records external operations in the Broker ledger. */
  executeWorkflowV2BrokeredScript?: (input: ExecuteWorkflowV2ScriptRequest) => Promise<WorkflowV2ScriptWorkerOutput>;
  workflowV2BrokeredAdapters?: readonly string[];
  startWorkflowNodeConversation: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    configuredAgentId: string;
    modelId: string;
    workDir: string;
    initialPrompt: string;
    developerInstructions?: string;
    contextDocument?: string;
    attempt?: number;
  }) => Promise<WorkflowNodeConversation>;
  markWorkflowNodeConversationWaiting: (conversationId: string, question: string) => WorkflowNodeConversation;
  stopWorkflowNodeConversations: (workflowId: string, runId: string) => Promise<void>;
  createWorkflowV2Store?: () => WorkflowV2StorePort | undefined;
  createWorkflowV2RecoveryOperationBroker?: (store: WorkflowV2StorePort) => WorkflowV2RecoveryOperationBroker | undefined;
  generateWorkflowV2RecoveryRecommendation?: (input: { workflowId: string; runId: string; recovery: WorkflowRecoveryPreview; evidence: unknown }) => Promise<WorkflowRecoveryManagerRecommendation | undefined>;
}
