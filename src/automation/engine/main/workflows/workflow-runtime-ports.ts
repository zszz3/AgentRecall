import type {
  AppSnapshot,
  RunTaskRequest,
} from "../../shared/types";
import type { FinishWorkflowRunRequest, WorkflowOperationResult } from "../../shared/workflow/commands";
import type { WorkflowEvent, WorkflowRunProgressItem } from "../../shared/workflow/run";
import type { WorkflowNodeConversation } from "../../shared/workflow-v2/conversation";
import type { WorkflowV2ScriptAuthorization, WorkflowV2ScriptNode } from "../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import type { WorkflowV2ResultPacket } from "../../shared/workflow-v2/planning";
import type {
  WorkflowV2CacheEntryMetadata,
  WorkflowV2DurableEvent,
  WorkflowV2PersistedRunState,
} from "../../shared/workflow-v2/storage";

export interface WorkflowRunStateUpdate {
  workflowId: string;
  runId: string;
  status?: "running" | "waiting_for_user";
  progress?: WorkflowRunProgressItem[];
  appendEvents?: WorkflowEvent[];
  contextDocument?: string;
  finalReport?: string;
  lastError?: string;
}

export interface ExecuteWorkflowV2ScriptRequest {
  node: WorkflowV2ScriptNode;
  workDir: string;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  signal: AbortSignal;
  timeoutMs: number;
  inputs: Readonly<Record<string, unknown>>;
  authorization: WorkflowV2ScriptAuthorization;
}

export interface WorkflowV2StorePort {
  persistRunState: (state: WorkflowV2PersistedRunState) => Promise<void>;
  appendEvents: (input: {
    workflowId: string;
    runId: string;
    events: readonly WorkflowV2DurableEvent[];
  }) => Promise<void>;
  persistCacheEntry?: (entry: WorkflowV2CacheEntryMetadata) => Promise<void>;
  readRunState?: (workflowId: string, runId: string) => Promise<WorkflowV2PersistedRunState | undefined>;
  readCacheEntry?: (
    workflowId: string,
    graphVersion: number,
    nodeId: string,
  ) => Promise<WorkflowV2CacheEntryMetadata | undefined>;
}

export interface WorkflowRuntimeDependencies {
  snapshot: () => AppSnapshot;
  startWorkflowRun: (input: { workflowId: string; contextDocument?: string }) => WorkflowOperationResult;
  finishWorkflowRun: (input: FinishWorkflowRunRequest) => WorkflowOperationResult;
  updateWorkflowRunState: (input: WorkflowRunStateUpdate) => void;
  runTask: (input: RunTaskRequest, approvalPolicy?: { allowedFileWriteRoot: string }) => Promise<AppSnapshot>;
  stopTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, options?: { preserveRuntimeConversation?: boolean }) => Promise<AppSnapshot>;
  executeWorkflowV2Script: (input: ExecuteWorkflowV2ScriptRequest) => Promise<WorkflowV2WorkerOutput>;
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
  }) => Promise<WorkflowNodeConversation>;
  markWorkflowNodeConversationWaiting: (conversationId: string, question: string) => WorkflowNodeConversation;
  stopWorkflowNodeConversations: (workflowId: string, runId: string) => Promise<void>;
  createWorkflowV2Store?: () => WorkflowV2StorePort | undefined;
}
