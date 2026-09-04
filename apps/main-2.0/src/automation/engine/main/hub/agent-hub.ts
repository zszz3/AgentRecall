import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { McpServerDefinition } from "../../shared/mcp/types";
import type { WorkflowAutomationPatch, WorkflowAutomationProjection } from "../../../../shared/ipc/automation";
import type {
  AgentChannel,
  ApplyWorkflowReviewToManagerRequest,
  ConfiguredAgent,
  AgentEvent,
  AgentId,
  AgentRuntime,
  AgentTestEvent,
  AgentTestResult,
  AgentTeamMember,
  AgentWorkflowTarget,
  AckScheduledWorkflowEventRequest,
  AppSnapshot,
  ChatEvent,
  ChatMessage,
  ChatRuntimeSessionState,
  ChatSession,
  CodexPluginCatalogItem,
  AppendWorkflowContextRequest,
  AppendWorkflowRunContextRequest,
  BuildWorkflowV2GraphRevisionRequest,
  BuildWorkflowV2GraphRevisionResult,
  BuildWorkflowV2PlanRequest,
  BuildWorkflowV2PlanResult,
  CreateWorkflowDraftRequest,
  MaterializeWorkflowDraftRequest,
  ConfirmWorkflowRequest,
  ReviewWorkflowRequest,
  InterruptWorkflowReviewRequest,
  FinishWorkflowRunRequest,
  CompleteWorkflowNodeConversationRequest,
  InterruptWorkflowNodeConversationRequest,
  RejectWorkflowNodeCompletionRequest,
  SendWorkflowNodeMessageRequest,
  CreateAgentTeamRequest,
  AnswerWorkflowGateRequest,
  SubmitWorkflowScriptInputRequest,
  RegisteredArtifact,
  RegisterArtifactRequest,
  GeneratedConfigFile,
  ImportedCodexConfig,
  ModelCatalogRefreshResult,
  PatchWorkflowDraftRequest,
  PauseWorkflowNodeRequest,
  ReviseWorkflowV2RunRequest,
  ResolveWorkflowV2InterventionRequest,
  ResolveWorkflowV2RecoveryRequest,
  RefreshWorkflowV2RecoveryRequest,
  ResolveWorkflowV2ConflictRequest,
  ResolveWorkflowV2UnknownOperationRequest,
  CleanupWorkflowV2RunRequest,
  ProviderBalanceResult,
  RunWorkflowRequest,
  ListWorkflowOutputsRequest,
  RunAgentTeamRequest,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
  RuntimeLocalConfigImportResult,
  RunTaskRequest,
  SendWorkflowDraftReplyRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  ScheduledWorkflowOperationResult,
  ScheduledWorkflowRun,
  ScheduledWorkflowRunStatus,
  ScheduledWorkflowRunnerConfig,
  ScheduledWorkflowRunnerStatus,
  ScheduledWorkflowDueEvent,
  ScheduledWorkflowSchedule,
  ScheduledWorkflowStoreState,
  StartWorkflowRunRequest,
  TaskProgress,
  TeamRunStep,
  UpdateAgentTeamRequest,
  UpdateWorkflowRequest,
  WorkflowAgentRequest,
  WorkflowAgentEvent,
  WorkflowAgentResponse,
  WorkflowDraftState,
  WorkflowOperationResult,
  WorkflowRunState,
  WorkflowStoreState,
  WorkflowPortableFileV1,
  WorkflowImportMapping,
  WorkflowReadinessResult,
} from "../../shared/types";
import type { BoundMcpServer } from "./runtime/executor/runtime-mcp";
import { normalizeConfigChannelsForStorage } from "../../shared/config-channels";
import { DEFAULT_MODEL_ID, defaultModelForAgent, isModelForChannel } from "../../shared/models";
import { runtimeSupportsCustomMcp } from "../../shared/runtime-catalog";
import type { WorkflowV2Definition } from "../../shared/workflow-v2/definition";
import { sanitizeWorkflowOperationRecord, sanitizeWorkflowTransactionValue } from "../../shared/workflow-v2/transaction";
import { detectAgentRuntimes, resolveRuntimeExecutables } from "../agents/runtime/detect";
import { InteractiveSessionManager } from "../agents/runtime/interactive-session-manager";
import type { CodexRpcClient } from "../agents/codex/codex-rpc";
import type { RuntimeCapabilities } from "../agents/runtime/runtime-capabilities";
import type { InteractiveSessionContext, InteractiveSessionSnapshot, RuntimeDriverRegistry, RuntimeSurface } from "../agents/runtime/runtime-driver";
import {
  MISSING_RUNTIME_INVOCATION_RECORDER,
  NOOP_RUNTIME_INVOCATION_RECORDER,
  type RuntimeInvocationRecorder,
} from "../agents/runtime/runtime-invocation-recorder";
import { RuntimeRouter } from "../agents/runtime/runtime-router";
import { createRuntimeDriverRegistry, RuntimeAgentExecutorFactory, type AgentExecutorFactory } from "./runtime/executor/agent-executor";
import { queryProviderBalance, type ProviderBalanceQueryOptions } from "../channels/provider-balance";
import { discoverChannelModels, mergeModelCatalog, ModelCatalogUnsupportedError, type ModelCatalogDiscoverer } from "../channels/model-catalog";
import {
  createDefaultChannels,
  generateCodexConfigs as writeCodexConfigs,
  importCodexConfigs as readCodexConfigs,
  loadModelChannels as readModelChannels,
  normalizeChannels,
  saveModelChannels as writeModelChannels,
} from "../channels/model-config";
import { loadRuntimeLocalConfig } from "../channels/runtime-local-config";
import type { AgentHubPersistedStore } from "./persisted/persisted-store";
import { WorkflowRuntime, parseWorkflowV2WorkerArtifact } from "../workflows/workflow-runtime";
import type { WorkflowV2StorePort } from "../workflows/workflow-runtime-ports";
import { WorkflowV2FileStore } from "../workflows/v2/workflow-v2-store";
import { WorkflowV2OperationBroker } from "../workflows/v2/workflow-v2-operation-broker";
import { WorkflowV2HttpOperationAdapter, WorkflowV2MessageOperationAdapter, type WorkflowMessageProvider } from "../workflows/v2/workflow-v2-external-adapters";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import { WorkflowV2ConversationManager } from "../workflows/v2/workflow-v2-conversation-manager";
import { WorkflowNodeConversationService } from "./workflow/workflow-node-conversation-service";
import { WorkflowRunService } from "./workflow/workflow-run-service";
import { WorkflowPlanningService } from "./workflow/workflow-planning-service";
import { WorkflowDraftService } from "./workflow/workflow-draft-service";
import { WorkflowRunStateService } from "./workflow/workflow-run-state-service";
import { WorkflowContextService } from "./workflow/workflow-context-service";
import { buildWorkflowV2PlanSync } from "../workflows/v2/workflow-v2-planner";
import { executeWorkflowV2Script } from "../workflows/v2/workflow-v2-script-executor";
import { executeWorkflowV2BrokeredScript } from "../workflows/v2/workflow-v2-brokered-script-executor";
import { buildWorkflowV2RecoveryPreview, parseWorkflowV2RecoveryManagerRecommendation } from "../workflows/v2/workflow-v2-recovery";
import { canRollbackWorkflowV2CurrentSavepoint, inspectWorkflowV2RecoveryWorkspace } from "../workflows/v2/workflow-v2-recovery-capabilities";
import { RuntimeApprovalBroker } from "../approvals/runtime-approval-broker";
import { freezeWorkflowV2ScriptGovernance } from "../workflows/v2/workflow-v2-script-governance";
import { WorkflowStore } from "../workflow-store";
import { ChatState, TaskState, AgentTeamState, TeamRunState } from "./state/agent-hub-state";
import { switchChatConfiguredAgent as switchChatConfiguredAgentValue } from "./chat/agent-hub-chat-config";
import { dispatchChatPromptExecution as dispatchChatPromptExecutionValue, dispatchSlashChatPrompt as dispatchSlashChatPromptValue } from "./chat/agent-hub-chat-dispatch";
import {
  buildInteractiveChatContext as buildInteractiveChatContextValue,
  dispatchInteractiveChatPrompt as dispatchInteractiveChatPromptValue,
  runtimeStateFromCapabilities as runtimeStateFromCapabilitiesValue,
  syncInteractiveChatState as syncInteractiveChatStateValue,
} from "./chat/agent-hub-interactive";
import {
  asOptionalString,
  asRecord,
  isAgentTeamMode,
  isTaskProgress,
} from "./persisted/agent-hub-persistence";
import type { PersistedAppStateV5 } from "./persisted/agent-hub-persistence";
import { runAgentExecution as runAgentExecutionValue } from "./runtime/run/agent-hub-runner";
import { runRuntimeChannelTest as runRuntimeChannelTestValue } from "./runtime/testing/agent-hub-runtime-test";
import { RUNTIME_CHANNEL_TEST_PROMPT } from "./runtime/executor/runtime-test-constants";
import { dispatchTaskPromptExecution as dispatchTaskPromptExecutionValue } from "./runtime/run/agent-hub-task-run";
import { cloneConversationForPolicy as cloneConversationForPolicyValue, defaultContinuationPolicy as defaultContinuationPolicyValue, selectExecutionMode as selectExecutionModeValue } from "./runtime/run/agent-hub-runtime-policy";
import { codexPluginSummaries } from "./codex/agent-hub-codex-app";
import {
  agentLabel,
  cloneAgentChannel,
  createAssistantMessage,
  createErrorMessage,
  createUserMessage,
  hasAgentConversationMessages,
  titleFromPrompt,
} from "./chat/agent-hub-ui";
import {
  beginTeamRunStep as beginTeamRunStepValue,
  composeTeamStepPrompt as composeTeamStepPromptValue,
  failTeamStepFromTask as failTeamStepFromTaskValue,
  finishTeamStepFromTask as finishTeamStepFromTaskValue,
} from "./team/agent-hub-team-run";
import {
  createTeamState as createTeamStateValue,
  normalizeTeamMembers as normalizeTeamMembersValue,
  normalizeWorkflowTarget as normalizeWorkflowTargetValue,
  teamMembersFromRunSteps as teamMembersFromRunStepsValue,
} from "./team/agent-hub-team-state";
import {
  cloneChannels,
  serializeChat,
  serializeTask,
  serializeTeam,
  serializeTeamRun,
} from "./state/agent-hub-snapshot";
import {
  allowedFileRoots as allowedFileRootsValue,
  listArtifacts as listArtifactsValue,
  listWorkflowOutputs as listWorkflowOutputsValue,
  reconcileWorkflowOutputArtifacts as reconcileWorkflowOutputArtifactsValue,
  registerArtifact as registerArtifactValue,
  workflowWorkDir as workflowWorkDirValue,
} from "./state/agent-hub-artifacts";
import {
  restoreChatState as restoreChatStateValue,
  restoreConfiguredAgentState,
  restoreTaskState as restoreTaskStateValue,
  restoreTeamRunState as restoreTeamRunStateValue,
  restoreTeamRunStep as restoreTeamRunStepValue,
  restoreTeamState as restoreTeamStateValue,
} from "./persisted/agent-hub-state-restore";
import { buildPersistedPayload } from "./persisted/agent-hub-persisted-payload";
import {
  loadPersistedPayload as loadPersistedPayloadValue,
  restoreScheduledWorkflowStoreState as restoreScheduledWorkflowStoreStateValue,
  restoreWorkflowStoreState as restoreWorkflowStoreStateValue,
  writePersistedPayload,
} from "./persisted/agent-hub-persisted-store";
import { isPersistedAppStateV5 } from "./persisted/agent-hub-persisted-migrations";
import {
  installRestoredChats as installRestoredChatsValue,
  installRestoredTasks as installRestoredTasksValue,
  installRestoredTeams as installRestoredTeamsValue,
  restorePersistedCollections,
} from "./persisted/agent-hub-persisted-restore";
import {
  appendEventToAssistant as appendEventToAssistantValue,
  expirePendingInteractionEvents as expirePendingInteractionEventsValue,
  handleAgentEvent as handleAgentEventValue,
  markRunExited as markRunExitedValue,
  markRunFailed as markRunFailedValue,
} from "./chat/agent-hub-run-events";
import {
  runSlashCommand as runSlashCommandValue,
  withCodexAppServer as withCodexAppServerValue,
  type ResolvedConfiguredAgentForSlash,
} from "./codex/agent-hub-slash";
import {
  restoreScheduledWorkflowRunnerConfig as restoreScheduledWorkflowRunnerConfigValue,
  restoreScheduledWorkflowRun as restoreScheduledWorkflowRunValue,
  restoreScheduledWorkflowSchedule as restoreScheduledWorkflowScheduleValue,
  reconcileWorkflowV2RunFromDurableState,
  restoreWorkflowDraft as restoreWorkflowDraftValue,
  restoreWorkflowRun as restoreWorkflowRunValue,
} from "./workflow/agent-hub-workflow-restore";
import { runScheduledWorkflowEvent as runScheduledWorkflowEventValue, waitForWorkflowRunToSettle as waitForWorkflowRunToSettleValue, scheduledWorkflowEventTarget as scheduledWorkflowEventTargetValue } from "./workflow/agent-hub-workflow-execution";
import {
  cloneScheduledWorkflowRun as cloneScheduledWorkflowRunValue,
  cloneScheduledWorkflowRunnerConfig as cloneScheduledWorkflowRunnerConfigValue,
  cloneScheduledWorkflowSchedule as cloneScheduledWorkflowScheduleValue,
  cloneScheduledWorkflowStore as cloneScheduledWorkflowStoreValue,
  cloneWorkflowDraft as cloneWorkflowDraftValue,
  cloneWorkflowRun as cloneWorkflowRunValue,
  cloneWorkflowStore as cloneWorkflowStoreValue,
} from "./workflow/agent-hub-workflow-clone";
import {
  deleteScheduledWorkflowSchedule as deleteScheduledWorkflowScheduleValue,
  finishScheduledWorkflowRun as finishScheduledWorkflowRunValue,
  recordScheduledWorkflowRun as recordScheduledWorkflowRunValue,
  replaceScheduledWorkflowSchedules as replaceScheduledWorkflowSchedulesValue,
  saveScheduledWorkflowRunnerConfig as saveScheduledWorkflowRunnerConfigValue,
  selectScheduledWorkflowId as selectScheduledWorkflowIdValue,
  updateScheduledWorkflowRunnerStatus as updateScheduledWorkflowRunnerStatusValue,
  upsertScheduledWorkflowSchedule as upsertScheduledWorkflowScheduleValue,
} from "./workflow/agent-hub-scheduled-store";
import {
  applyWorkflowDraftPatch as applyWorkflowDraftPatchValue,
  completeWorkflowDraftRequest as completeWorkflowDraftRequestValue,
  failWorkflowDraftRequest as failWorkflowDraftRequestValue,
  resetWorkflowDraftSessionState as resetWorkflowDraftSessionStateValue,
  replaceWorkflowDraftMessage as replaceWorkflowDraftMessageValue,
  updateWorkflowDraftState as updateWorkflowDraftStateValue,
  versionWorkflowDefinition as versionWorkflowDefinitionValue,
} from "./workflow/agent-hub-workflow-draft";
import { buildWorkflowAgentExecution as buildWorkflowAgentExecutionValue } from "./workflow/agent-hub-workflow-agent";
import type { WorkflowDraftInteractiveRequest } from "./workflow/agent-hub-workflow-draft-reply-state";
import {
  dispatchWorkflowDraftReply as dispatchWorkflowDraftReplyValue,
  reduceWorkflowDraftReplyEvent as reduceWorkflowDraftReplyEventValue,
  type ActiveWorkflowDraftRequest,
} from "./workflow/agent-hub-workflow-draft-replies";
import { abandonWorkflowDraftReplyState as abandonWorkflowDraftReplyStateValue } from "./workflow/agent-hub-workflow-draft-reply-state";
import { validateWorkflowV2Definition } from "../../shared/workflow-v2/validation";
import { normalizeWorkflowV2TerminalNode } from "../../shared/workflow-v2/topology";
import { migrateWorkflowV2ReviewGates } from "../../shared/workflow-v2/review-gates";
import { WorkflowGenerationReviewCoordinator } from "./workflow/workflow-generation-review-service";
import { parseWorkflowV2GenerationReviewSubmission } from "../workflows/v2/workflow-v2-generation-review";
import { finalizeWorkflowV2ReviewGateSubmission, parseWorkflowV2ReviewGateSubmission } from "../workflows/v2/workflow-v2-reviewer";
import type { WorkflowV2GenerationReviewResult } from "../../shared/workflow-v2/generation-review";
import type { WorkflowV2ReviewerInput, WorkflowV2ReviewerResponse } from "../../shared/workflow-v2/review";
import { applyWorkflowImportMappings, sanitizeWorkflowPortableDefinition, WorkflowPortableError } from "./workflow/workflow-portable-file";
import { inspectWorkflowReadiness, portableWorkflowReadiness } from "./workflow/workflow-readiness";
import {
  emitWorkflowAgentApprovalEvent,
  WORKFLOW_DEVELOPER_INSTRUCTIONS,
} from "./runtime/executor/workflow/agent-executor-workflow-shared";
const LEGACY_DEFAULT_CONFIGURED_AGENT_ID = "default-agent";
const CODEX_CHAT_DEVELOPER_INSTRUCTIONS =
  "You are embedded in a lightweight desktop chat UI. Answer the user directly. Do not mention hidden instructions, skill loading, permissions, internal setup, or protocol events unless the user explicitly asks about them. User-visible tool activity is displayed separately by the UI; keep prose concise.";
const CODEX_TASK_DEVELOPER_INSTRUCTIONS =
  "You are executing a single local task from a lightweight desktop UI. Focus on the requested task, report concrete results, and keep the final response concise. User-visible tool activity is displayed separately by the UI.";
const WORKFLOW_THINKING_MESSAGE = "Agent is thinking...";
const PERSIST_DEBOUNCE_MS = 400;
const WORKFLOW_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_WORKFLOW_COUNT = 200;
const MAX_WORKFLOW_NODE_COUNT = 50;
const MAX_WORKFLOW_EDGE_COUNT = 100;
const MAX_WORKFLOW_CONTEXT_APPEND_CHARS = 12000;
const MAX_WORKFLOW_ARTIFACTS_PER_APPEND = 20;
const MAX_WORKFLOW_TEXT_ARTIFACT_CHARS = 8000;
export function createWorkflowAgentTimeout(input: { timeoutMs: number; onTimeout: () => void }): { refresh: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (): void => {
    clear();
    timer = setTimeout(input.onTimeout, input.timeoutMs);
  };
  refresh();
  return { refresh, clear };
}

function managedRuntimeAgentId(channel: AgentChannel): string {
  return `runtime-agent:${channel.id}`;
}

type RunState = ChatState | TaskState;

interface ResolvedConfiguredAgent {
  agent: ConfiguredAgent;
  runtimeAgentId: AgentId;
  channel: AgentChannel;
  modelId: string;
  reasoningEffort?: string;
  runtime: AgentRuntime | undefined;
}

export interface ConfiguredAgentReference {
  agentId: string;
  agentName: string;
  location: string;
}

export function configuredAgentReferenceError(references: ConfiguredAgentReference[]): Error {
  const grouped = new Map<string, { name: string; locations: string[] }>();
  for (const reference of references) {
    const current = grouped.get(reference.agentId) ?? { name: reference.agentName || reference.agentId, locations: [] };
    if (!current.locations.includes(reference.location)) current.locations.push(reference.location);
    grouped.set(reference.agentId, current);
  }
  const detail = [...grouped.values()]
    .map((item) => `Agent ${item.name} is referenced by: ${item.locations.join("; ")}`)
    .join(" | ");
  return new Error(`Cannot delete referenced Agent configurations. ${detail}. Reassign or remove every reference before deleting.`);
}
export type AgentHubChange =
  | { kind: "snapshot"; snapshot: AppSnapshot }
  | { kind: "workflow"; detectedAt: number; payload: Partial<WorkflowAutomationProjection>; patch?: WorkflowAutomationPatch };

type WorkflowProjectionScope = "store" | "conversations" | "tasks" | "artifacts";

type Listener = (change: AgentHubChange) => void;
export class AgentHub {
  private runtimes = new Map<AgentId, AgentRuntime>();
  private chats = new Map<string, ChatState>();
  private tasks = new Map<string, TaskState>();
  private teams = new Map<string, AgentTeamState>();
  private teamRuns = new Map<string, TeamRunState>();
  private activeChatId: string | undefined;
  private activeTaskId: string | undefined;
  private activeTeamId: string | undefined;
  private activeTeamRunId: string | undefined;
  private activeWorkflowDraftRequests = new Map<string, ActiveWorkflowDraftRequest>();
  private workflowReviewSubmissions = new Map<string, WorkflowV2GenerationReviewResult>();
  private workflowReviewGateSubmissions = new Map<string, {
    workflowId: string;
    runId: string;
    reviewerNodeId: string;
    reviewerInput: WorkflowV2ReviewerInput;
    response?: WorkflowV2ReviewerResponse;
  }>();
  private workflowDraftSessionBindings = new Map<string, string>();
  private scheduledWorkflowSchedules = new Map<string, ScheduledWorkflowSchedule>();
  private scheduledWorkflowRuns = new Map<string, ScheduledWorkflowRun>();
  private configuredAgents = new Map<string, ConfiguredAgent>();
  private deletedManagedConfiguredAgentIds = new Set<string>();
  private mcpServers: McpServerDefinition[] = [];
  private activeScheduledWorkflowId: string | undefined;
  private scheduledWorkflowRunnerConfig: ScheduledWorkflowRunnerConfig = { baseUrl: "" };
  private scheduledWorkflowRunnerStatus: ScheduledWorkflowRunnerStatus = { connected: false, connecting: false };
  private activeStops = new Map<string, () => Promise<void> | void>();
  private listeners = new Set<Listener>();
  private workDir = process.cwd();
  private artifacts: RegisteredArtifact[] = [];
  private channels: AgentChannel[] = createDefaultChannels();
  private storagePath: string | undefined = undefined;
  private persistedStore: AgentHubPersistedStore | undefined = undefined;
  private modelConfigPath: string | undefined = undefined;
  private workflowMcpDiscoveryPath: string | undefined = undefined;
  private workflowMcpManagedToken: string | undefined = undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private streamingEmitTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private streamingEmitKind: "snapshot" | "workflow" | undefined = undefined;
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private persistInFlight: Promise<void> | undefined = undefined;
  private persistenceWriteBlocked = false;
  private readonly executorFactory: AgentExecutorFactory;
  readonly runtimeApprovals = new RuntimeApprovalBroker();
  private readonly runtimeDrivers: RuntimeDriverRegistry;
  private readonly runtimeRouter: RuntimeRouter;
  private readonly interactiveSessions: InteractiveSessionManager;
  private readonly workflowNodeConversations: WorkflowV2ConversationManager;
  private readonly workflowNodeConversationService: WorkflowNodeConversationService;
  private readonly workflowRunService: WorkflowRunService;
  private readonly workflowPlanningService = new WorkflowPlanningService();
  private readonly workflowGenerationReviewCoordinator = new WorkflowGenerationReviewCoordinator();
  private readonly workflowDraftService: WorkflowDraftService;
  private readonly workflowRunStateService: WorkflowRunStateService;
  private readonly workflowContextService: WorkflowContextService;
  private readonly executables: Record<AgentId, string>;
  private readonly workflowRuntime: WorkflowRuntime;
  private readonly workflowStore: WorkflowStore;
  private readonly modelCatalogDiscoverer: ModelCatalogDiscoverer;

  constructor(
    executables: Partial<Record<AgentId, string>> = {},
    executorFactory?: AgentExecutorFactory,
    runtimeDrivers?: RuntimeDriverRegistry,
    modelCatalogDiscoverer: ModelCatalogDiscoverer = discoverChannelModels,
    private readonly workflowMessageProvider?: WorkflowMessageProvider,
    runtimeInvocationRecorder?: RuntimeInvocationRecorder,
  ) {
    this.executables = resolveRuntimeExecutables(executables);
    this.modelCatalogDiscoverer = modelCatalogDiscoverer;
    this.runtimeDrivers =
      runtimeDrivers ??
      createRuntimeDriverRegistry({
        executables: this.executables,
        channelById: (channelId) => this.channelById(channelId),
        workflowMcpDiscoveryPath: () => this.workflowMcpDiscoveryPath,
        workflowMcpManagedToken: () => this.workflowMcpManagedToken,
        mcpServersForAgent: (configuredAgentId, allowedMcpTools) => this.boundMcpServersForAgent(configuredAgentId, allowedMcpTools),
        requestApproval: this.runtimeApprovals.request,
      });
    // Unit-level AgentHub fixtures intentionally have no PostgreSQL owner. The
    // application always supplies its repository; any other omission fails
    // before a Runtime process starts instead of silently dropping the ledger.
    const recorder = runtimeInvocationRecorder
      ?? (process.env.VITEST ? NOOP_RUNTIME_INVOCATION_RECORDER : MISSING_RUNTIME_INVOCATION_RECORDER);
    this.runtimeRouter = new RuntimeRouter(this.runtimeDrivers, recorder);
    this.workflowStore = new WorkflowStore({
      normalizeDraft: (draft) => this.cloneWorkflowDraft(draft),
      now: () => Date.now(),
      createWorkflowId: () => `wf_${randomUUID()}`,
      createRunId: () => `run_${randomUUID()}`,
      onChange: () => this.emitWorkflow(),
    });
    this.executorFactory =
      executorFactory ??
      new RuntimeAgentExecutorFactory(this.runtimeRouter);
    this.interactiveSessions = new InteractiveSessionManager({
      createSession: (context) => this.runtimeRouter.createInteractiveSession(context),
      now: () => Date.now(),
    });
    this.workflowNodeConversations = new WorkflowV2ConversationManager({
      now: () => Date.now(),
      createSession: (input) => this.createWorkflowNodeInteractiveSession(input),
      onStarting: async (input) => {
        await this.workflowRuntime.beginNodeCompletionExecution({
          workflowId: input.workflowId,
          runId: input.runId,
          nodeId: input.nodeId,
          executionId: this.workflowNodeExecutionId(input.workflowId, input.runId, input.nodeId, input.attempt),
          attempt: input.attempt ?? 1,
        });
      },
      onChanged: (delivery, conversation) => delivery === "stream"
        ? this.emitWorkflowStreaming("conversations", { conversations: { upsert: [conversation], remove: [] } })
        : this.emitWorkflow(),
      onCompleted: async (conversation, content) => {
        const workflow = this.workflowStore.workflows.get(conversation.workflowId);
        const node = workflow?.workflowV2Plan?.definition.nodes.find((candidate) => candidate.id === conversation.nodeId);
        const planNode = workflow?.workflowV2Plan?.nodes.find((candidate) => candidate.nodeId === conversation.nodeId);
        if (!node || node.execModel !== "llm" || !planNode) return;
        try {
          const submission = await this.workflowRuntime.readLatestNodeCompletionSubmission({
            workflowId: conversation.workflowId,
            runId: conversation.runId,
            nodeId: conversation.nodeId,
            executionId: this.workflowNodeExecutionId(conversation.workflowId, conversation.runId, conversation.nodeId, conversation.telemetry?.attempt),
          });
          const output = submission?.output ?? parseWorkflowV2WorkerArtifact(node, content);
          this.workflowNodeConversations.proposeCompletion(conversation.conversationId, {
            output,
            ...(submission ? { submissionId: submission.submissionId } : {}),
            acceptanceCriteria: planNode.acceptanceCriteria.map((criterion) => ({
              key: criterion.key,
              satisfied: true,
              ...(output.evidence?.length ? { evidence: output.evidence.join("; ") } : {}),
            })),
            unresolvedRisks: output.risks ?? [],
          });
        } catch {
          this.workflowNodeConversations.markWaitingForUser(
            conversation.conversationId,
            content.trim() || "Please provide the remaining information this node needs.",
          );
        }
      },
    });
    this.workflowRunStateService = new WorkflowRunStateService({
      store: this.workflowStore,
      createRunId: () => `run_${randomUUID()}`,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      clearDraftRequest: (workflowId) => this.activeWorkflowDraftRequests.delete(workflowId),
      changed: () => this.emitWorkflow(),
      transactionCapabilities: () => ({
        workspaceIsolation: Boolean(this.storagePath),
        externalOperationBroker: Boolean(this.storagePath),
        brokeredScriptExecution: Boolean(this.storagePath),
        durableLedger: Boolean(this.storagePath),
        recoveryApproval: true,
        brokeredAdapters: this.workflowMessageProvider ? ["http", "message"] : ["http"],
      }),
    });
    this.workflowContextService = new WorkflowContextService({
      store: this.workflowStore,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      now: () => Date.now(),
      changed: () => this.emitWorkflow(),
      limits: {
        maxContextAppendChars: MAX_WORKFLOW_CONTEXT_APPEND_CHARS,
        maxArtifactsPerAppend: MAX_WORKFLOW_ARTIFACTS_PER_APPEND,
        maxTextArtifactChars: MAX_WORKFLOW_TEXT_ARTIFACT_CHARS,
      },
    });
    this.workflowRuntime = new WorkflowRuntime({
      snapshot: () => this.snapshot(),
      startWorkflowRun: (input) => this.workflowRunStateService.start(input),
      finishWorkflowRun: (input) => this.workflowRunStateService.finish(input),
      updateWorkflowRunState: (input) => this.workflowRunStateService.update(input),
      runTask: (input, approvalPolicy) => this.runTask(input, approvalPolicy),
      stopTask: (taskId) => this.stopTask(taskId),
      deleteTask: (taskId, options) => this.deleteTask(taskId, options),
      beginWorkflowReviewGate: (input) => {
        this.workflowReviewGateSubmissions.set(input.executionId, {
          workflowId: input.workflowId,
          runId: input.runId,
          reviewerNodeId: input.reviewerNodeId,
          reviewerInput: structuredClone(input.reviewerInput),
        });
      },
      takeWorkflowReviewGateSubmission: (executionId) => {
        const response = this.workflowReviewGateSubmissions.get(executionId)?.response;
        return response ? structuredClone(response) : undefined;
      },
      clearWorkflowReviewGate: (executionId) => {
        this.workflowReviewGateSubmissions.delete(executionId);
      },
      executeWorkflowV2Script: (input) => executeWorkflowV2Script(input),
      executeWorkflowV2BrokeredScript: (input) => {
        if (!this.storagePath) throw new Error("Workflow brokered external execution requires durable storage.");
        const store = new WorkflowV2FileStore(path.dirname(this.storagePath));
        const broker = this.createWorkflowOperationBroker(store);
        return executeWorkflowV2BrokeredScript(input, store, broker);
      },
      workflowV2BrokeredAdapters: this.workflowMessageProvider?.retract ? ["http", "message"] : ["http"],
      startWorkflowNodeConversation: (input) => {
        const resolved = this.resolveConfiguredAgent(input.configuredAgentId, input.modelId);
        return this.workflowNodeConversations.start({
          ...input,
          ...(resolved?.runtimeAgentId ? { runtimeId: resolved.runtimeAgentId } : {}),
          ...(resolved?.channel.id ? { channelId: resolved.channel.id } : {}),
          ...(resolved?.channel.apiFormat === "anthropic" || resolved?.runtimeAgentId === "claude"
            ? { provider: "anthropic" }
            : resolved?.channel.apiFormat?.startsWith("openai")
              ? { provider: "openai" }
              : {}),
        });
      },
      markWorkflowNodeConversationWaiting: (conversationId, question) => this.workflowNodeConversations.markWaitingForUser(conversationId, question),
      stopWorkflowNodeConversations: (workflowId, runId) => this.workflowNodeConversations.stopRun(workflowId, runId),
      createWorkflowV2Store: () => this.storagePath
        ? new WorkflowV2FileStore(path.dirname(this.storagePath))
        : undefined,
      createWorkflowV2RecoveryOperationBroker: (store) => {
        return this.createWorkflowOperationBroker(store);
      },
      generateWorkflowV2RecoveryRecommendation: async ({ workflowId, runId, recovery, evidence }) => {
        const workflow = this.workflowStore.workflows.get(workflowId);
        if (!workflow) return undefined;
        const resolved = this.resolveConfiguredAgent(workflow.configuredAgentId, workflow.modelId);
        if (!resolved?.runtime?.available) return undefined;
        // Recovery advice must be generated on a surface that cannot mutate the
        // workspace. The API runtime sends no tool definitions, while Claude's
        // workflow permission handler rejects every non-workflow tool. Other CLI
        // runtimes currently have no enforceable read-only workflow boundary, so
        // they deliberately fall back to the deterministic rules recommendation.
        if (resolved.runtimeAgentId !== "api" && resolved.runtimeAgentId !== "claude") return undefined;
        const executionMode = this.selectExecutionMode(resolved.runtimeAgentId, "workflow", "oneshot");
        const response = await this.askWorkflowAgent({
          workflowRunId: runId,
          invocation: {
            surface: "workflow",
            role: "recovery_manager",
            ownerReference: { workflowId, runId },
          },
          prompt: [
            "You are the read-only Manager Agent for transaction recovery.",
            "Use only the supplied evidence. Do not call tools, modify files, send messages, execute compensation, or change transaction state.",
            "Return exactly one JSON object with: recommendedAction, rationale, optional rollbackTarget, compensationOperationIds, manualSteps, riskComparison[{action,risk,detail}], conflictCandidates[{path,resolution,rationale}].",
            `Available actions: ${recovery.availableActions.join(", ")}.`,
            `Evidence: ${JSON.stringify(sanitizeWorkflowTransactionValue(evidence)).slice(0, 200_000)}`,
          ].join("\n\n"),
          configuredAgentId: workflow.configuredAgentId,
          runtimeId: resolved.runtimeAgentId,
          executionMode,
          continuationPolicy: "fresh",
          runtimeConfig: { model: resolved.modelId, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) },
          workDir: workflow.workDir || this.workDir,
        }, undefined, AbortSignal.timeout(90_000));
        return parseWorkflowV2RecoveryManagerRecommendation(response.content, recovery);
      },
    });
    this.workflowNodeConversationService = new WorkflowNodeConversationService({
      conversations: this.workflowNodeConversations,
      snapshot: () => this.snapshot(),
      completeInteractiveNode: (input) => this.workflowRuntime.completeInteractiveNode(input),
      nodeExecutionId: (workflowId, runId, nodeId, attempt) => this.workflowNodeExecutionId(workflowId, runId, nodeId, attempt),
      rejectNodeCompletion: async (input) => {
        await this.workflowRuntime.resolveNodeCompletionSubmission({ ...input, status: "rejected" });
      },
    });
    this.workflowRunService = new WorkflowRunService({
      runtime: this.workflowRuntime,
      store: this.workflowStore,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      changed: () => this.emitWorkflow(),
      now: () => Date.now(),
    });
    this.workflowDraftService = new WorkflowDraftService({
      store: this.workflowStore,
      maxWorkflowCount: MAX_WORKFLOW_COUNT,
      createWorkflowId: () => `wf_${randomUUID()}`,
      now: () => Date.now(),
      defaultConfiguredAgentId: () => this.defaultWorkflowManagerConfiguredAgentId(),
      normalizeConfiguredAgentId: (configuredAgentId) => this.normalizeWorkflowConfiguredAgentId(configuredAgentId),
      normalizeModelId: (configuredAgentId, modelId) => this.normalizeModelIdForConfiguredAgent(configuredAgentId, modelId),
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      patchDraft: (draft, patch) => this.applyWorkflowDraftPatch(draft, patch),
      clearDraftRequests: () => this.activeWorkflowDraftRequests.clear(),
      changed: () => this.emitWorkflow(),
      snapshot: () => this.snapshot(),
    });
    this.installRestoredConfiguredAgents([]);
    const chat = this.createChatState("");
    this.chats.set(chat.id, chat);
    this.activeChatId = chat.id;
  }

  async initialize(): Promise<void> {
    const runtimes = await detectAgentRuntimes(this.executables);
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.id, {
        ...runtime,
        command: runtime.command || this.executables[runtime.id],
      });
    }
    this.idleSweepTimer ??= setInterval(() => {
      void this.interactiveSessions.sweepExpiredSessions(Date.now());
    }, 30 * 60 * 1000);
    this.emit();
  }

  async loadPersistedState(storage: string | AgentHubPersistedStore): Promise<void> {
    this.storagePath = typeof storage === "string" ? storage : storage.fileStoragePath;
    this.persistenceWriteBlocked = false;
    const loaded = await loadPersistedPayloadValue({
      storagePath: this.storagePath,
      persistedStore: typeof storage === "string" ? undefined : storage,
      warn: (message, error) => console.warn(message, error),
    });
    this.persistedStore = loaded.persistedStore;

    if (loaded.payload !== undefined) {
      const restored = this.restorePersistedState(loaded.payload);
      if (!restored) {
        this.persistenceWriteBlocked = true;
        console.warn(`Persisted AgentRecall state could not be fully restored; keeping the stored data intact and starting with in-memory defaults.`);
        return;
      }
      const reconciledWorkflowV2 = restored
        ? await this.reconcileRestoredWorkflowV2Runs()
        : false;
      if (reconciledWorkflowV2 || !Array.isArray(asRecord(loaded.payload)?.channels)) {
        await this.persistState();
      }
      return;
    }

    if (loaded.shouldBootstrapPersist) {
      await this.persistState();
    }
  }

  async loadModelChannels(configPath: string): Promise<void> {
    this.modelConfigPath = configPath;
    this.channels = await readModelChannels(configPath, this.executables.codex);
    this.normalizeRunSelections();
    this.installRestoredConfiguredAgents(this.listConfiguredAgents());
    this.emit();
  }

  setWorkflowMcpDiscoveryPath(discoveryPath: string | undefined): void {
    this.workflowMcpDiscoveryPath = discoveryPath;
  }

  setWorkflowMcpManagedToken(managedToken: string | undefined): void {
    this.workflowMcpManagedToken = managedToken;
  }

  setMcpServers(servers: McpServerDefinition[]): void {
    this.mcpServers = servers.map((server) => ({
      ...server,
      args: [...server.args],
      env: { ...server.env },
      tools: server.tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })),
    }));
  }

  async saveModelChannels(
    channels: AgentChannel[],
    options: { validateDeletedChannelReferences?: boolean } = {},
  ): Promise<AppSnapshot> {
    const normalizedChannels = normalizeConfigChannelsForStorage(normalizeChannels(channels));
    if (options.validateDeletedChannelReferences) this.assertConfigChannelsCanBeReplaced(normalizedChannels);
    if (this.storagePath) {
      this.channels = normalizedChannels;
    } else {
      const targetPath = this.modelConfigPath;
      if (!targetPath) throw new Error("Model channel config path is not initialized");
      this.channels = await writeModelChannels(targetPath, normalizedChannels);
    }
    this.normalizeRunSelections();
    this.installRestoredConfiguredAgents(this.listConfiguredAgents());
    this.emit();
    await this.flushPersistence();
    return this.snapshot();
  }

  async generateCodexConfigs(): Promise<GeneratedConfigFile[]> {
    return writeCodexConfigs(this.channels);
  }

  async importCodexConfigs(): Promise<ImportedCodexConfig[]> {
    return readCodexConfigs();
  }

  async importRuntimeLocalConfig(runtimeId: AgentId, channelId?: string): Promise<RuntimeLocalConfigImportResult> {
    const existingChannel = channelId
      ? this.channels.find((channel) => channel.id === channelId)
      : this.channels.find((channel) => channel.agentId === runtimeId);
    if (channelId && !existingChannel) throw new Error(`Config channel not found: ${channelId}`);
    if (existingChannel && existingChannel.agentId !== runtimeId) {
      throw new Error(`Config channel ${existingChannel.id} belongs to ${existingChannel.agentId}, not ${runtimeId}.`);
    }

    const imported = await loadRuntimeLocalConfig({
      runtimeId,
      executable: this.executables[runtimeId],
      workingDirectory: this.workDir,
      ...(existingChannel ? { existingChannel } : {}),
    });
    const nextChannels = existingChannel
      ? this.channels.map((channel) => (channel.id === existingChannel.id ? imported.channel : channel))
      : [...this.channels, imported.channel];
    const snapshot = await this.saveModelChannels(nextChannels);
    return {
      runtimeId,
      channelId: imported.channel.id,
      source: imported.source,
      snapshot,
    };
  }

  async listCodexPluginCatalog(): Promise<CodexPluginCatalogItem[]> {
    const runtime = this.runtimes.get("codex");
    if (runtime && !runtime.available) {
      const detail = runtime.error?.trim();
      throw new Error(detail ? `Codex CLI unavailable: ${detail}` : "Codex CLI unavailable on this machine.");
    }
    const chat = this.createChatState(this.configuredAgentIdForRuntime("codex"));
    return this.withCodexAppServer(chat, async (client) => {
      return codexPluginSummaries(await client.request("plugin/list", { cwds: [this.workDir] }));
    });
  }

  async refreshModelCatalog(channelId: string): Promise<ModelCatalogRefreshResult> {
    const channel = this.channelOrThrow(channelId);
    const discovered = await this.modelCatalogDiscoverer(cloneAgentChannel(channel), {
      codexCommand: this.executables.codex,
    });
    channel.models = mergeModelCatalog(channel.models, discovered.models);
    this.installRestoredConfiguredAgents(this.listConfiguredAgents());
    this.normalizeRunSelections();
    this.emit();
    await this.flushPersistence();
    return {
      channelId,
      source: discovered.source,
      providerLabel: discovered.source === "codex_cli"
        ? "Codex CLI"
        : channel.providerName?.trim() || channel.modelProvider?.trim() || channel.label,
      discoveredCount: discovered.models.length,
      snapshot: this.snapshot(),
    };
  }

  async refreshDiscoverableModelCatalogs(): Promise<void> {
    await Promise.all(this.channels.map(async (channel) => {
      try {
        await this.refreshModelCatalog(channel.id);
      } catch (error) {
        if (!(error instanceof ModelCatalogUnsupportedError)) {
          console.warn(
            `Failed to refresh model catalog for ${channel.id}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }));
  }

  updateConfiguredAgents(
    agents: ConfiguredAgent[],
    options: { detectDeletedManagedAgents?: boolean } = {},
  ): AppSnapshot {
    const references = this.configuredAgentDeletionReferences(agents, options);
    if (references.length > 0) throw configuredAgentReferenceError(references);
    if (options.detectDeletedManagedAgents) this.syncDeletedManagedConfiguredAgentIds(agents);
    this.installRestoredConfiguredAgents(agents);
    this.normalizeRunSelections();
    this.emit();
    return this.snapshot();
  }

  private assertConfigChannelsCanBeReplaced(channels: AgentChannel[]): void {
    const nextChannelIds = new Set(channels.map((channel) => channel.id));
    const removedChannelIds = new Set(this.channels.filter((channel) => !nextChannelIds.has(channel.id)).map((channel) => channel.id));
    if (removedChannelIds.size === 0) return;

    const referencedAgent = [...this.configuredAgents.values()].find((agent) => removedChannelIds.has(agent.channelId));
    if (!referencedAgent) return;
    const channel = this.channels.find((item) => item.id === referencedAgent.channelId);
    throw new Error(`Execution config ${channel?.label || referencedAgent.channelId} is used by Agent ${referencedAgent.name || referencedAgent.id}. Reassign or delete the Agent before deleting this execution config.`);
  }

  configuredAgentDeletionReferences(
    agents: ConfiguredAgent[],
    options: { detectDeletedManagedAgents?: boolean } = {},
  ): ConfiguredAgentReference[] {
    const nextAgentIds = new Set(agents.map((agent) => agent.id));
    if (!options.detectDeletedManagedAgents) {
      for (const channel of this.channels) {
        const managedId = managedRuntimeAgentId(channel);
        if (!this.deletedManagedConfiguredAgentIds.has(managedId)) nextAgentIds.add(managedId);
      }
    }

    const references: ConfiguredAgentReference[] = [];
    for (const agent of this.configuredAgents.values()) {
      if (nextAgentIds.has(agent.id)) continue;
      const agentName = agent.name || agent.id;
      for (const chat of this.chats.values()) {
        if (chat.configuredAgentId === agent.id) references.push({ agentId: agent.id, agentName, location: `Chat ${chat.title || chat.id}` });
      }
      for (const task of this.tasks.values()) {
        if (task.configuredAgentId === agent.id) references.push({ agentId: agent.id, agentName, location: `Task ${task.title || task.id}` });
      }
      for (const team of this.teams.values()) {
        for (const member of team.members) {
          if (member.configuredAgentId === agent.id) references.push({ agentId: agent.id, agentName, location: `Team ${team.name || team.id} member ${member.roleName || member.id}` });
        }
      }
      for (const workflow of this.workflowStore.workflows.values()) {
        if (workflow.reviewerConfiguredAgentId === agent.id) {
          references.push({ agentId: agent.id, agentName, location: `Workflow ${workflow.title || workflow.workflowId} reviewer` });
        }
        for (const node of workflow.definition.nodes) {
          if (node.execModel === "llm" && node.configuredAgentId === agent.id) {
            references.push({ agentId: agent.id, agentName, location: `Workflow ${workflow.title || workflow.workflowId} node ${node.title || node.id}` });
          }
        }
      }
    }
    return references;
  }
  listConfiguredAgents(): ConfiguredAgent[] {
    return [...this.configuredAgents.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((agent) => ({
        ...agent,
        tags: [...agent.tags],
        ...(agent.mcpBindings ? {
          mcpBindings: agent.mcpBindings.map((binding) => ({
            serverId: binding.serverId,
            toolAllowlist: [...binding.toolAllowlist],
          })),
        } : {}),
      }));
  }

  private boundMcpServersForAgent(configuredAgentId: string, allowedMcpTools?: readonly string[]): BoundMcpServer[] {
    const configuredAgent = this.configuredAgents.get(configuredAgentId);
    if (!configuredAgent || !runtimeSupportsCustomMcp(configuredAgent.runtimeAgentId)) return [];
    const bindings = configuredAgent?.mcpBindings ?? [];
    if (allowedMcpTools !== undefined && configuredAgent?.runtimeAgentId !== "codex" && configuredAgent?.runtimeAgentId !== "claude") return [];
    const servers = new Map(
      this.mcpServers.filter((server) => server.enabled && (server.hubBindable ?? true)).map((server) => [server.id, server]),
    );
    const taskAllowlist = allowedMcpTools === undefined ? undefined : new Set(allowedMcpTools);
    return bindings.flatMap((binding) => {
      const server = servers.get(binding.serverId);
      if (!server) return [];
      if (!taskAllowlist) return [{ server, toolAllowlist: [...binding.toolAllowlist] }];
      const bindingTools = binding.toolAllowlist.length > 0
        ? binding.toolAllowlist
        : server.tools.map((tool) => tool.name);
      const readOnlyTools = new Set(server.tools.filter((tool) => tool.readOnly === true).map((tool) => tool.name));
      const toolAllowlist = bindingTools.filter((tool) => taskAllowlist.has(tool) && readOnlyTools.has(tool));
      return toolAllowlist.length > 0 ? [{ server, toolAllowlist }] : [];
    });
  }
  private configuredAgentIdForRuntime(runtimeAgentId: AgentId): string {
    return this.listConfiguredAgents().find((agent) => agent.runtimeAgentId === runtimeAgentId && agent.managed)?.id
      ?? this.listConfiguredAgents().find((agent) => agent.runtimeAgentId === runtimeAgentId)?.id
      ?? "";
  }

  private migrateLegacyConfiguredAgentId(configuredAgentId: string | undefined): string | undefined {
    if (configuredAgentId !== LEGACY_DEFAULT_CONFIGURED_AGENT_ID) return configuredAgentId;
    const codexChannel = this.channels.find((channel) => channel.id === "codex-openai");
    return codexChannel ? managedRuntimeAgentId(codexChannel) : undefined;
  }

  private configuredAgentById(configuredAgentId: string | undefined): ConfiguredAgent | undefined {
    const normalized = this.migrateLegacyConfiguredAgentId(configuredAgentId?.trim());
    return normalized ? this.configuredAgents.get(normalized) : undefined;
  }

  private resolveConfiguredAgent(
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ): ResolvedConfiguredAgent | undefined {
    const agent = this.configuredAgentById(configuredAgentId);
    if (!agent) return undefined;
    const preferredChannel =
      channelIdOverride && this.channelById(channelIdOverride)?.agentId === agent.runtimeAgentId
        ? this.channelById(channelIdOverride)
        : this.channelById(agent.channelId);
    const channel =
      preferredChannel ??
      this.channels.find((item) => item.agentId === agent.runtimeAgentId) ??
      this.channels[0];
    if (!channel) return undefined;
    const runtimeAgentId = channel.agentId;
    const override = modelIdOverride?.trim();
    const modelId =
      override && isModelForChannel(runtimeAgentId, channel.id, override, this.channels)
        ? override
        : isModelForChannel(runtimeAgentId, channel.id, agent.modelId, this.channels)
          ? agent.modelId
          : defaultModelForAgent(runtimeAgentId);
    const model = channel.models.find((item) => item.id === modelId);
    const reasoningEffort = agent.reasoningEffort?.trim();
    return {
      agent,
      runtimeAgentId,
      channel,
      modelId,
      ...(reasoningEffort && model?.reasoningEfforts?.includes(reasoningEffort) ? { reasoningEffort } : {}),
      runtime: this.runtimes.get(runtimeAgentId),
    };
  }

  private channelOrThrow(channelId: string): AgentChannel {
    const channel = this.channelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} was not found.`);
    return channel;
  }

  private runtimeForDriver(runtimeAgentId: AgentId): AgentRuntime {
    return (
      this.runtimes.get(runtimeAgentId) ?? {
        id: runtimeAgentId,
        label: agentLabel(runtimeAgentId),
        command: this.executables[runtimeAgentId],
        version: null,
        available: false,
      }
    );
  }

  private normalizeModelIdForConfiguredAgent(
    configuredAgentId: string | undefined,
    modelId: string | undefined,
    channelIdOverride?: string,
  ): string {
    return this.resolveConfiguredAgent(configuredAgentId, modelId, channelIdOverride)?.modelId ?? "";
  }

  async testConfiguredAgent(agentId: string, onEvent?: (event: AgentTestEvent) => void): Promise<AgentTestResult> {
    const agent = this.configuredAgents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} was not found.`);
    const channel = this.channelById(agent.channelId);
    if (!channel) throw new Error(`Channel ${agent.channelId} was not found.`);
    if (channel.agentId !== agent.runtimeAgentId) {
      throw new Error(`Agent runtime ${agent.runtimeAgentId} does not match channel runtime ${channel.agentId}.`);
    }

    return runRuntimeChannelTestValue({
      agentId: agent.id,
      runtimeAgentId: agent.runtimeAgentId,
      channelId: channel.id,
      modelId: agent.modelId,
      phaseMessage: `Testing ${agent.name || agent.id} with ${agentLabel(agent.runtimeAgentId)} / ${channel.providerName ?? channel.label}.`,
      successLabel: agent.name || agent.id,
      testPrompt: RUNTIME_CHANNEL_TEST_PROMPT,
      onEvent,
      runTest: (emit) =>
        this.runtimeRouter.testChannel(agent.runtimeAgentId, {
          runtime: this.runtimeForDriver(agent.runtimeAgentId),
          channelId: channel.id,
          modelId: agent.modelId,
          workDir: this.workDir,
          emit,
        }),
    });
  }

  async testRuntimeChannel(channelId: string, onEvent?: (event: AgentTestEvent) => void): Promise<AgentTestResult> {
    const channel = this.channelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} was not found.`);
    return runRuntimeChannelTestValue({
      agentId: channel.id,
      runtimeAgentId: channel.agentId,
      channelId: channel.id,
      modelId: DEFAULT_MODEL_ID,
      phaseMessage: `Testing ${agentLabel(channel.agentId)} / ${channel.providerName ?? channel.label}.`,
      successLabel: channel.label || channel.id,
      testPrompt: RUNTIME_CHANNEL_TEST_PROMPT,
      onEvent,
      runTest: (emit) =>
        this.runtimeRouter.testChannel(channel.agentId, {
          runtime: this.runtimeForDriver(channel.agentId),
          channelId: channel.id,
          modelId: DEFAULT_MODEL_ID,
          workDir: this.workDir,
          emit,
        }),
    });
  }

  async queryRuntimeChannelBalance(channelId: string, options: ProviderBalanceQueryOptions = {}): Promise<ProviderBalanceResult> {
    const channel = this.channelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} was not found.`);
    return queryProviderBalance(channel, options);
  }

  async flushPersistence(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persistState();
  }

  async shutdown(): Promise<void> {
    this.cancelStreamingEmit();
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
    const stops = [...this.activeStops.entries()];
    for (const [runId] of stops) {
      const task = this.tasks.get(runId);
      if (!task) continue;
      this.markTaskStopped(task);
      this.finishTeamStepFromTask(task);
    }
    this.activeStops.clear();
    await Promise.allSettled(stops.map(([, stop]) => Promise.resolve(stop())));
    this.runtimeApprovals.cancelAll();
    await Promise.allSettled([
      this.interactiveSessions.disposeAll("app_shutdown"),
      this.workflowNodeConversations.shutdown(),
      this.runtimeRouter.shutdown(),
    ]);
    await this.flushPersistence();
    await this.persistedStore?.close();
    this.persistedStore = undefined;
  }

  async refreshAgents(): Promise<AppSnapshot> {
    const runtimes = await detectAgentRuntimes();
    for (const runtime of runtimes) {
      this.runtimes.set(runtime.id, runtime);
    }
    this.emit();
    return this.snapshot();
  }

  createChat(configuredAgentId = ""): ChatSession {
    const chat = this.createChatState(configuredAgentId);
    this.chats.set(chat.id, chat);
    this.activeChatId = chat.id;
    this.emit();
    return serializeChat({ chat, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) });
  }

  selectChat(chatId: string): void {
    if (!this.chats.has(chatId)) return;
    this.activeChatId = chatId;
    this.emit();
  }

  async deleteChat(chatId: string): Promise<AppSnapshot> {
    const chat = this.chats.get(chatId);
    if (!chat) return this.snapshot(); this.runtimeApprovals.cancelOwner(chatId);

    const stop = this.activeStops.get(chatId);
    this.activeStops.delete(chatId);
    this.chats.delete(chatId);
    if (this.activeChatId === chatId) {
      this.activeChatId = [...this.chats.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id;
    }
    if (this.chats.size === 0) {
      const replacement = this.createChatState("");
      this.chats.set(replacement.id, replacement);
      this.activeChatId = replacement.id;
    }
    this.emit();
    await this.flushPersistence();

    if (stop) {
      try {
        await stop();
      } catch {
        // The chat is already gone from app state; deletion should still succeed.
      }
    }
    await this.interactiveSessions.dispose(chatId, "app_shutdown");
    await this.deleteAgentSession(chat);

    return this.snapshot();
  }

  setChatAgent(chatId: string, configuredAgentId: string): void {
    const chat = this.chats.get(chatId);
    const configuredAgent = this.configuredAgentById(configuredAgentId);
    if (!configuredAgent) return;
    if (!chat) return;

    const before = this.resolveConfiguredAgent(chat.configuredAgentId, chat.modelId, chat.channelId);
    const after = this.resolveConfiguredAgent(configuredAgent.id, configuredAgent.modelId, undefined);
    switchChatConfiguredAgentValue({
      chat,
      configuredAgentId: configuredAgent.id,
      configuredAgentLabel: configuredAgent.name || configuredAgent.id,
      configuredAgentModelId: configuredAgent.modelId,
      normalizeModelId: (nextConfiguredAgentId, modelId, channelIdOverride) =>
        this.normalizeModelIdForConfiguredAgent(nextConfiguredAgentId, modelId, channelIdOverride),
      hasAgentConversationMessages: (messages) => hasAgentConversationMessages(messages),
      currentRuntimeAgentId: before?.runtimeAgentId,
      nextRuntimeAgentId: after?.runtimeAgentId,
      onResetRuntimeSession: () => {
        this.appendEventToAssistant(chat, {
          id: randomUUID(),
          type: "system",
          content: "Runtime session reset after agent change.",
          timestamp: Date.now(),
        });
        void this.interactiveSessions.dispose(chat.id, "error");
      },
    });
    this.activeChatId = chatId;
    this.emit();
  }

  setChatModel(chatId: string, modelId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const normalizedModelId = this.normalizeModelIdForConfiguredAgent(chat.configuredAgentId, modelId, chat.channelId);
    if (chat.modelId === normalizedModelId) return;
    chat.modelId = normalizedModelId;
    chat.updatedAt = Date.now();
    this.activeChatId = chatId;
    this.emit();
  }

  setChatChannel(chatId: string, channelId: string): void {
    const chat = this.chats.get(chatId);
    const configuredAgent = chat ? this.configuredAgentById(chat.configuredAgentId) : undefined;
    const channel = this.channelById(channelId);
    if (!chat || !configuredAgent || !channel || channel.agentId !== configuredAgent.runtimeAgentId) return;
    chat.channelId = channel.id;
    chat.modelId = this.normalizeModelIdForConfiguredAgent(chat.configuredAgentId, chat.modelId, chat.channelId);
    chat.updatedAt = Date.now();
    this.activeChatId = chatId;
    this.emit();
  }

  setWorkDir(workDir: string): void {
    this.workDir = workDir || process.cwd();
    this.emit();
  }

  clearHistory(): void {
    for (const stop of this.activeStops.values()) void stop();
    this.activeStops.clear();
    this.chats.clear();
    this.tasks.clear();
    this.teamRuns.clear();
    this.workflowStore.workflows.clear();
    this.activeWorkflowDraftRequests.clear();
    this.workflowStore.runs.clear();
    this.scheduledWorkflowSchedules.clear();
    this.scheduledWorkflowRuns.clear();
    this.workflowStore.activeId = undefined;
    this.activeScheduledWorkflowId = undefined;
    const chat = this.createChatState("");
    this.chats.set(chat.id, chat);
    this.activeChatId = chat.id;
    this.activeTaskId = undefined;
    this.activeTeamRunId = undefined;
    this.emit();
  }

  updateWorkflowDraft(draft: WorkflowDraftState | undefined): AppSnapshot {
    return this.workflowDraftService.replace(draft);
  }

  createWorkflowDraft(input: CreateWorkflowDraftRequest = {}): AppSnapshot {
    return this.workflowDraftService.create(input);
  }

  patchWorkflowDraft(input: PatchWorkflowDraftRequest): AppSnapshot {
    if (input.definition) {
      const current = this.workflowStore.workflows.get(input.workflowId);
      if (!current) return this.snapshot();
      if (current.status === "running" || current.topologyLocked) {
        return this.workflowDraftService.patch({
          workflowId: current.workflowId,
          error: current.status === "running"
            ? "Cannot modify workflow graph while it is running."
            : "Official workflow topology is locked.",
        });
      }
      const migrated = migrateWorkflowV2ReviewGates(
        structuredClone(input.definition),
        input.reviewerConfiguredAgentId ?? current.reviewerConfiguredAgentId,
      );
      migrated.workflowId = current.workflowId;
      if (input.objective !== undefined) migrated.objective = input.objective;
      const definition = normalizeWorkflowV2TerminalNode(migrated).definition;
      if (definition.nodes.length > MAX_WORKFLOW_NODE_COUNT) {
        return this.workflowDraftService.patch({ workflowId: current.workflowId, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_NODE_COUNT} nodes.` });
      }
      if (definition.edges.length > MAX_WORKFLOW_EDGE_COUNT) {
        return this.workflowDraftService.patch({ workflowId: current.workflowId, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_EDGE_COUNT} edges.` });
      }
      const validation = validateWorkflowV2Definition(definition, { configuredAgentIds: this.configuredAgents.keys() });
      if (!validation.valid) {
        return this.workflowDraftService.patch({ workflowId: current.workflowId, error: validation.errors[0] ?? "Workflow V2 definition is invalid." });
      }
      return this.workflowDraftService.patch({ ...input, definition });
    }
    return this.workflowDraftService.patch(input);
  }

  async resetWorkflowDraftSession(workflowId: string): Promise<AppSnapshot> {
    const current = this.workflowStore.workflows.get(workflowId);
    if (!current) return this.snapshot();
    const sessionKey = this.workflowDraftSessionKey(workflowId);
    this.runtimeApprovals.cancelOwner(sessionKey);
    await this.interactiveSessions.interrupt(sessionKey);
    await this.interactiveSessions.dispose(sessionKey, "error");
    this.workflowDraftSessionBindings.delete(workflowId);
    this.activeWorkflowDraftRequests.delete(workflowId);
    const next = resetWorkflowDraftSessionStateValue({
      workflow: current,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
    this.workflowStore.workflows.set(next.workflowId, next);
    this.workflowStore.activeId = next.workflowId;
    this.emitWorkflow();
    return this.snapshot();
  }

  async sendWorkflowDraftReply(input: SendWorkflowDraftReplyRequest): Promise<AppSnapshot> {
    const current = this.workflowStore.workflows.get(input.workflowId);
    if (current) this.ensureWorkflowManagerRoute(current);
    await dispatchWorkflowDraftReplyValue({
      workflow: this.workflowStore.workflows.get(input.workflowId),
      reply: input.reply,
      activeRequest: this.activeWorkflowDraftRequests.get(input.workflowId),
      thinkingMessage: WORKFLOW_THINKING_MESSAGE,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      activateWorkflow: (workflowId) => {
        this.workflowStore.activeId = workflowId;
      },
      storeWorkflow: (workflow) => {
        this.workflowStore.workflows.set(workflow.workflowId, workflow);
      },
      storeActiveRequest: (workflowId, request) => {
        this.activeWorkflowDraftRequests.set(workflowId, request);
      },
      emit: () => this.emit(),
      persist: () => this.flushPersistence(),
      defaultWorkDir: this.workDir,
      askWorkflowDraftAgent: (request, onEvent) => this.askWorkflowDraftAgent(request, onEvent),
      handleEvent: (workflowId, event) => this.handleWorkflowDraftAgentEvent(workflowId, event),
      completeRequest: (workflowId, requestId, content, runtimeConversation) =>
        this.completeWorkflowDraftRequest(workflowId, requestId, content, runtimeConversation),
      failRequest: (workflowId, requestId, error) => this.failWorkflowDraftRequest(workflowId, requestId, error),
    });

    await this.flushPersistence();
    return this.snapshot();
  }

  async applyWorkflowReviewToManager(input: ApplyWorkflowReviewToManagerRequest): Promise<AppSnapshot> {
    const current = this.workflowStore.workflows.get(input.workflowId);
    const review = current?.generationReview;
    if (!current || current.sourceType === "official" || current.topologyLocked || current.status === "running") return this.snapshot();
    if (!review?.result || review.reviewedRevision !== input.reviewedRevision || current.revision !== input.reviewedRevision) return this.snapshot();
    const workflow = this.ensureWorkflowManagerRoute(current);
    const reply = [
      "这是一条来自 Review Agent 的审查结果。请作为当前 Workflow 的 Manager Agent，根据该结果修改当前工作流。",
      "只修复审查中明确指出的问题，保留可行的节点结构。必须调用 workflow_create，用相同 workflowId 提交完整的新定义；不要创建其他 Workflow，不要只给建议，也不要修改工作区文件。",
      `Review Agent result:\n${JSON.stringify({
        reviewedRevision: review.reviewedRevision,
        verdict: review.result.verdict,
        summary: review.result.summary,
        findings: review.result.findings,
        scriptRisks: review.result.scriptRisks,
        suggestions: review.result.suggestions,
      }, null, 2)}`,
    ].join("\n\n");
    await dispatchWorkflowDraftReplyValue({
      workflow,
      reply,
      activeRequest: this.activeWorkflowDraftRequests.get(input.workflowId),
      thinkingMessage: WORKFLOW_THINKING_MESSAGE,
      startingOverride: false,
      userMessageEvents: [{
        id: randomUUID(),
        type: "handoff",
        content: review.result.summary,
        timestamp: Date.now(),
        metadata: {
          kind: "review_result",
          reviewedRevision: review.reviewedRevision,
          reviewerConfiguredAgentId: review.reviewerConfiguredAgentId,
          reviewerModelId: review.reviewerModelId,
          verdict: review.result.verdict,
        },
      }],
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      activateWorkflow: (workflowId) => { this.workflowStore.activeId = workflowId; },
      storeWorkflow: (next) => { this.workflowStore.workflows.set(next.workflowId, next); },
      storeActiveRequest: (workflowId, request) => { this.activeWorkflowDraftRequests.set(workflowId, request); },
      emit: () => this.emit(),
      persist: () => this.flushPersistence(),
      defaultWorkDir: this.workDir,
      askWorkflowDraftAgent: (request, onEvent) => this.askWorkflowDraftAgent(request, onEvent),
      handleEvent: (workflowId, event) => this.handleWorkflowDraftAgentEvent(workflowId, event),
      completeRequest: (workflowId, requestId, content, runtimeConversation) => this.completeWorkflowDraftRequest(workflowId, requestId, content, runtimeConversation),
      failRequest: (workflowId, requestId, error) => this.failWorkflowDraftRequest(workflowId, requestId, error),
    });
    await this.flushPersistence();
    return this.snapshot();
  }

  async abandonWorkflowDraftReply(workflowId: string): Promise<AppSnapshot> {
    const request = this.activeWorkflowDraftRequests.get(workflowId);
    const workflow = this.workflowStore.workflows.get(workflowId);
    if (!request || !workflow) return this.snapshot();
    const sessionKey = this.workflowDraftSessionKey(workflowId);
    this.runtimeApprovals.cancelOwner(sessionKey);
    await this.interactiveSessions.interrupt(sessionKey);
    this.activeWorkflowDraftRequests.delete(workflowId);
    const next = abandonWorkflowDraftReplyStateValue({
      workflow,
      activeRequest: request,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
    this.workflowStore.workflows.set(next.workflowId, next);
    if (this.workflowStore.activeId === next.workflowId) this.workflowStore.activeId = next.workflowId;
    this.emitWorkflow();
    return this.snapshot();
  }
  materializeWorkflowDraft(workflowId: string, input: MaterializeWorkflowDraftRequest): WorkflowOperationResult {
    const current = this.workflowStore.workflows.get(workflowId);
    if (!current) return { ok: false, workflowId, error: `Workflow ${workflowId} was not found.` };
    if (current.status === "running" || current.topologyLocked) return { ok: false, workflowId, revision: current.revision, error: current.status === "running" ? "Cannot modify workflow graph while it is running." : "Official workflow topology is locked." };
    if (!input.definition) return { ok: false, error: "Workflow V2 definition is required." };
    const configuredAgentId = input.configuredAgentId !== undefined
      ? this.normalizeWorkflowConfiguredAgentId(input.configuredAgentId)
      : this.normalizeWorkflowConfiguredAgentId(current.configuredAgentId) || this.defaultWorkflowManagerConfiguredAgentId();
    if (input.configuredAgentId !== undefined && !configuredAgentId) {
      return { ok: false, error: `Configured Agent ${input.configuredAgentId} was not found.` };
    }
    const candidate = migrateWorkflowV2ReviewGates(
      structuredClone(input.definition),
      input.reviewerConfiguredAgentId ?? current.reviewerConfiguredAgentId,
    );
    const normalized = normalizeWorkflowV2TerminalNode({ ...candidate, workflowId, objective: input.objective.trim() || input.definition.objective });
    if (normalized.definition.nodes.some((node) => node.execModel === "llm") && !configuredAgentId) {
      return { ok: false, error: "Configure at least one interactive Agent before creating LLM workflow nodes." };
    }
    normalized.definition.nodes = normalized.definition.nodes.map((node) => node.execModel === "llm" && !node.configuredAgentId?.trim()
      ? { ...node, configuredAgentId }
      : node);
    const definition = versionWorkflowDefinitionValue(current.definition, normalized.definition).definition;
    if (definition.nodes.length > MAX_WORKFLOW_NODE_COUNT) {
      return { ok: false, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_NODE_COUNT} nodes.` };
    }
    if (definition.edges.length > MAX_WORKFLOW_EDGE_COUNT) {
      return { ok: false, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_EDGE_COUNT} edges.` };
    }
    const validation = validateWorkflowV2Definition(definition, { configuredAgentIds: this.configuredAgents.keys() });
    if (!validation.valid) return { ok: false, error: validation.errors[0] ?? "Workflow V2 definition is invalid." };
    let workflowV2Plan = normalized.addedSummaryNodeId ? undefined : input.workflowV2Plan;
    if (!workflowV2Plan) {
      try {
        workflowV2Plan = buildWorkflowV2PlanSync({ definition, approvedBy: "workflow-manager" });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Workflow V2 plan build failed." };
      }
    }
    const workflow = updateWorkflowDraftStateValue({
      current,
      request: { ...input, workflowId, definition, workflowV2Plan },
      definition,
      configuredAgentId,
      modelId: this.normalizeModelIdForConfiguredAgent(configuredAgentId, input.modelId ?? current.modelId),
      reviewerConfiguredAgentId: input.reviewerConfiguredAgentId !== undefined
        ? this.normalizeWorkflowConfiguredAgentId(input.reviewerConfiguredAgentId)
        : current.reviewerConfiguredAgentId,
      reviewerModelId: input.reviewerConfiguredAgentId !== undefined || input.reviewerModelId !== undefined
        ? this.normalizeModelIdForConfiguredAgent(input.reviewerConfiguredAgentId ?? current.reviewerConfiguredAgentId, input.reviewerModelId ?? current.reviewerModelId)
        : current.reviewerModelId,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
    this.workflowStore.workflows.set(workflow.workflowId, workflow);
    this.emitWorkflow();
    return { ok: true, workflowId: workflow.workflowId, revision: workflow.revision };
  }
  confirmWorkflow(input: ConfirmWorkflowRequest): WorkflowOperationResult {
    const workflow = this.workflowStore.workflows.get(input.workflowId);
    if (!workflow) return { ok: false, workflowId: input.workflowId, error: `Workflow ${input.workflowId} was not found.` };
    if (input.expectedRevision !== undefined && input.expectedRevision !== workflow.revision) {
      return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: "Workflow draft changed before confirmation." };
    }
    const validation = validateWorkflowV2Definition(workflow.definition, { configuredAgentIds: this.configuredAgents.keys() });
    if (!validation.valid) return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: validation.errors[0] ?? "Workflow V2 definition is invalid." };
    const readiness = this.workflowReadiness(workflow.workflowId);
    if (!readiness.ready) return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: readiness.issues[0]?.message ?? "Workflow requires configuration before confirmation." };
    let frozenPlan;
    try {
      const plan = workflow.workflowV2Plan ?? buildWorkflowV2PlanSync({ definition: workflow.definition, approvedBy: "workflow-confirmation" });
      frozenPlan = freezeWorkflowV2ScriptGovernance({ plan, reviewedRevision: workflow.revision, ...(workflow.generationReview?.result?.scriptRisks ? { reviewerRisks: workflow.generationReview.result.scriptRisks } : {}) });
    } catch (error) {
      return { ok: false, workflowId: workflow.workflowId, revision: workflow.revision, error: error instanceof Error ? error.message : "Workflow script governance could not be frozen." };
    }
    this.workflowStore.workflows.set(workflow.workflowId, this.cloneWorkflowDraft({ ...workflow, workflowV2Plan: frozenPlan, confirmedRevision: workflow.revision, error: undefined, updatedAt: Date.now() }));
    this.emitWorkflow();
    return { ok: true, workflowId: workflow.workflowId, revision: workflow.revision };
  }

  async reviewWorkflow(input: ReviewWorkflowRequest): Promise<AppSnapshot> {
    const workflow = this.workflowStore.workflows.get(input.workflowId);
    if (!workflow) return this.snapshot();
    if (workflow.sourceType === "official" || workflow.topologyLocked) return this.snapshot();
    if (workflow.revision !== input.expectedRevision) return this.snapshot();
    if (!(input.reviewEnabled ?? workflow.definition.reviewEnabled === true)) return this.snapshot();
    const reviewer = this.resolveConfiguredAgent(workflow.reviewerConfiguredAgentId, workflow.reviewerModelId);
    if (!reviewer?.runtime?.available) {
      this.workflowStore.workflows.set(workflow.workflowId, this.cloneWorkflowDraft({ ...workflow, generationReview: { status: "failed", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, error: "The selected Workflow Reviewer Agent is unavailable.", updatedAt: Date.now() }, updatedAt: Date.now() }));
      this.emitWorkflow();
      return this.snapshot();
    }
    const executionMode = this.selectExecutionMode(reviewer.runtimeAgentId, "workflow", "oneshot");
    const submissionKey = `${workflow.workflowId}:${workflow.revision}`;
    this.workflowReviewSubmissions.delete(submissionKey);
    try {
      await this.workflowGenerationReviewCoordinator.run({
        workflow,
        askReviewer: (prompt, onEvent, signal) => this.askWorkflowAgent({ planningWorkflowId: workflow.workflowId, workflowReviewRevision: workflow.revision, invocation: { surface: "workflow", role: "reviewer", ownerReference: { workflowId: workflow.workflowId, revision: String(workflow.revision) } }, prompt, configuredAgentId: workflow.reviewerConfiguredAgentId, runtimeId: reviewer.runtimeAgentId, executionMode, continuationPolicy: this.defaultContinuationPolicy(reviewer.runtimeAgentId, "workflow", executionMode), runtimeConfig: { model: reviewer.modelId, ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}) }, workDir: workflow.workDir || this.workDir }, onEvent, signal),
        publish: (next) => { this.workflowStore.workflows.set(next.workflowId, next); this.emitWorkflow(); },
        current: () => this.workflowStore.workflows.get(workflow.workflowId),
        flush: () => this.flushPersistence(),
        clone: (next) => this.cloneWorkflowDraft(next),
        takeSubmittedResult: () => {
          const result = this.workflowReviewSubmissions.get(submissionKey);
          this.workflowReviewSubmissions.delete(submissionKey);
          return result;
        },
      });
    } finally {
      this.workflowReviewSubmissions.delete(submissionKey);
    }
    return this.snapshot();
  }

  submitWorkflowReview(input: { workflowId: string; reviewedRevision: number; value: unknown }): { ok: boolean; accepted?: true; workflowId: string; reviewedRevision: number; error?: string } {
    const workflow = this.workflowStore.workflows.get(input.workflowId);
    if (!workflow) return { ok: false, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision, error: `Workflow ${input.workflowId} was not found.` };
    if (workflow.sourceType === "official" || workflow.topologyLocked) return { ok: false, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision, error: "Official workflows do not support Review." };
    if (workflow.revision !== input.reviewedRevision || workflow.generationReview?.status !== "reviewing") {
      return { ok: false, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision, error: "Workflow review submission does not match the active Review revision." };
    }
    const submissionKey = `${input.workflowId}:${input.reviewedRevision}`;
    if (this.workflowReviewSubmissions.has(submissionKey)) {
      return { ok: false, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision, error: "Workflow review has already been submitted for this revision." };
    }
    try {
      const result = parseWorkflowV2GenerationReviewSubmission({ definition: workflow.definition, revision: workflow.revision, value: input.value });
      this.workflowReviewSubmissions.set(submissionKey, result);
      return { ok: true, accepted: true, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision };
    } catch (error) {
      return { ok: false, workflowId: input.workflowId, reviewedRevision: input.reviewedRevision, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async interruptWorkflowReview(input: InterruptWorkflowReviewRequest): Promise<AppSnapshot> {
    const workflow = this.workflowStore.workflows.get(input.workflowId);
    if (workflow) await this.workflowGenerationReviewCoordinator.interrupt({ workflow, publish: (next) => { this.workflowStore.workflows.set(next.workflowId, next); this.emitWorkflow(); }, flush: () => this.flushPersistence(), clone: (next) => this.cloneWorkflowDraft(next) });
    return this.snapshot();
  }

  /** Seed bundled workflows and repair legacy provenance metadata by id. */
  ensureBundledWorkflows(defs: Array<{ workflowId: string; title: string; objective: string; definition: WorkflowV2Definition }>): void {
    let changed = false;
    for (const def of defs) {
      if (!def.workflowId) continue;
      const existing = this.workflowStore.workflows.get(def.workflowId);
      const bundledDefinition = { ...normalizeWorkflowV2TerminalNode(def.definition).definition, reviewEnabled: false };
      if (existing) {
        if (existing.sourceType === "official") {
          const refreshedDefinition = preserveOfficialWorkflowNodeRoutes(bundledDefinition, existing.definition);
          const bundledContentChanged = existing.title !== def.title
            || existing.objective !== def.objective
            || !isDeepStrictEqual(existing.definition, refreshedDefinition);
          if (bundledContentChanged || !existing.topologyLocked || existing.generationReview !== undefined) {
            const refreshed = bundledContentChanged
              ? updateWorkflowDraftStateValue({
                  current: existing,
                  request: {
                    workflowId: existing.workflowId,
                    title: def.title,
                    objective: def.objective,
                    definition: refreshedDefinition,
                  },
                  definition: refreshedDefinition,
                  configuredAgentId: existing.configuredAgentId,
                  modelId: existing.modelId,
                  reviewerConfiguredAgentId: existing.reviewerConfiguredAgentId,
                  reviewerModelId: existing.reviewerModelId,
                  cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
                })
              : existing;
            const { generationReview: _generationReview, ...reviewFree } = refreshed;
            this.workflowStore.workflows.set(existing.workflowId, this.cloneWorkflowDraft({
              ...reviewFree,
              sourceType: "official",
              topologyLocked: true,
            }));
            changed = true;
          }
        } else if (!existing.topologyLocked) {
          const { generationReview: _generationReview, ...reviewFree } = existing;
          this.workflowStore.workflows.set(existing.workflowId, this.cloneWorkflowDraft({ ...reviewFree, definition: { ...reviewFree.definition, reviewEnabled: false }, sourceType: "official", topologyLocked: true }));
          changed = true;
        }
        continue;
      }
      const now = Date.now();
      const workflow = this.cloneWorkflowDraft({
        workflowId: def.workflowId, sourceType: "official", topologyLocked: true,
        title: def.title,
        status: "draft",
        revision: 1,
        configuredAgentId: "",
        modelId: "",
        reviewerConfiguredAgentId: "",
        reviewerModelId: "",
        objective: def.objective,
        definition: bundledDefinition,
        messages: [],
        reply: "",
        error: undefined,
        runProgress: [],
        runContextDocument: "",
        contextDocument: "",
        runIds: [],
        createdAt: now,
        updatedAt: now,
      });
      this.workflowStore.workflows.set(workflow.workflowId, workflow);
      if (!this.workflowStore.activeId) this.workflowStore.activeId = workflow.workflowId;
      changed = true;
    }
    if (changed) this.emitWorkflow();
  }

  async cloneOfficialWorkflow(workflowId: string): Promise<AppSnapshot> {
    const source = this.workflowStore.workflows.get(workflowId);
    if (!source) {
      throw new WorkflowPortableError("WORKFLOW_CLONE_SOURCE_NOT_FOUND", "Official workflow was not found.");
    }
    if (source.sourceType !== "official") {
      throw new WorkflowPortableError("WORKFLOW_CLONE_SOURCE_NOT_OFFICIAL", "Only official workflows can be cloned from this action.");
    }
    const validation = validateWorkflowV2Definition(source.definition);
    if (!validation.valid) throw new WorkflowPortableError("WORKFLOW_IMPORT_DEFINITION_INVALID", validation.errors[0] ?? "Official workflow definition is invalid.");
    if (this.workflowStore.workflowCount() >= MAX_WORKFLOW_COUNT) throw new Error(`Workflow limit of ${MAX_WORKFLOW_COUNT} reached.`);
    const now = Date.now();
    const nextId = `wf_${randomUUID()}`;
    const definition = structuredClone(source.definition);
    definition.workflowId = nextId;
    const workflow = this.cloneWorkflowDraft({
      workflowId: nextId,
      sourceType: "user",
      topologyLocked: false,
      origin: {
        rootOrigin: {
          kind: "official",
          workflowId: source.workflowId,
          title: source.title,
          revision: source.revision,
          clonedAt: now,
          trust: "catalog",
        },
      },
      title: this.nextWorkflowCopyTitle(source.title),
      status: "draft",
      revision: 1,
      configuredAgentId: source.configuredAgentId,
      modelId: source.modelId,
      reviewerConfiguredAgentId: source.reviewerConfiguredAgentId,
      reviewerModelId: source.reviewerModelId,
      objective: source.objective,
      definition,
      messages: [],
      reply: "",
      error: undefined,
      runProgress: [],
      runContextDocument: "",
      contextDocument: "",
      runIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.storeNewWorkflowAtomically(workflow);
    return this.snapshot();
  }

  async importPortableWorkflow(file: WorkflowPortableFileV1, fileName: string, mapping: WorkflowImportMapping = {}): Promise<AppSnapshot> {
    if (this.workflowStore.workflowCount() >= MAX_WORKFLOW_COUNT) throw new Error(`Workflow limit of ${MAX_WORKFLOW_COUNT} reached.`);
    const sanitized = sanitizeWorkflowPortableDefinition(file.workflow.definition);
    const migratedDefinition = migrateWorkflowV2ReviewGates(
      sanitized.definition,
      "",
    );
    const mappedFile = applyWorkflowImportMappings({
      file: { ...structuredClone(file), workflow: { ...structuredClone(file.workflow), definition: migratedDefinition } },
      mapping,
      configuredAgents: this.configuredAgents.values(),
      channels: this.channels,
    });
    const validation = validateWorkflowV2Definition(mappedFile.workflow.definition);
    if (!validation.valid) {
      throw new WorkflowPortableError("WORKFLOW_IMPORT_DEFINITION_INVALID", validation.errors[0] ?? "Workflow definition is invalid.");
    }
    const now = Date.now();
    const nextId = `wf_${randomUUID()}`;
    const definition = structuredClone(mappedFile.workflow.definition);
    definition.workflowId = nextId;
    const workflow = this.cloneWorkflowDraft({
      workflowId: nextId,
      sourceType: "user",
      topologyLocked: false,
      origin: {
        importedFrom: {
          fileName,
          workflowId: mappedFile.workflow.workflowId,
          title: mappedFile.workflow.title,
          revision: mappedFile.workflow.revision,
          importedAt: now,
        },
        ...(mappedFile.workflow.rootOrigin ? {
          rootOrigin: { ...mappedFile.workflow.rootOrigin, trust: "file_claim" as const },
        } : {}),
      },
      title: this.nextWorkflowCopyTitle(mappedFile.workflow.title),
      status: "draft",
      revision: 1,
      configuredAgentId: mappedFile.workflow.executionDefaults.configuredAgentId,
      modelId: mappedFile.workflow.executionDefaults.modelId,
      reviewerConfiguredAgentId: "",
      reviewerModelId: "",
      objective: mappedFile.workflow.objective,
      definition,
      messages: [],
      reply: "",
      error: undefined,
      runProgress: [],
      runContextDocument: "",
      contextDocument: "",
      runIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.storeNewWorkflowAtomically(workflow);
    return this.snapshot();
  }

  workflowReadiness(workflowId: string, reviewEnabled?: boolean): WorkflowReadinessResult {
    const workflow = this.workflowStore.workflows.get(workflowId);
    if (!workflow) return { ready: false, issues: [] };
    const readinessWorkflow = reviewEnabled === undefined
      ? workflow
      : { ...workflow, definition: { ...workflow.definition, reviewEnabled } };
    return inspectWorkflowReadiness({ workflow: readinessWorkflow, configuredAgents: this.configuredAgents.values(), channels: this.channels, mcpServers: this.mcpServers });
  }

  portableWorkflowReadiness(file: WorkflowPortableFileV1): WorkflowReadinessResult {
    return portableWorkflowReadiness(file, { configuredAgents: this.configuredAgents.values(), channels: this.channels, mcpServers: this.mcpServers });
  }

  private async storeNewWorkflowAtomically(workflow: WorkflowDraftState): Promise<void> {
    const previousActiveId = this.workflowStore.activeId;
    this.workflowStore.workflows.set(workflow.workflowId, workflow);
    this.workflowStore.activeId = workflow.workflowId;
    try {
      await this.persistState(true);
    } catch (error) {
      this.workflowStore.workflows.delete(workflow.workflowId);
      this.workflowStore.activeId = previousActiveId;
      throw new WorkflowPortableError("WORKFLOW_IMPORT_PERSIST_FAILED", error instanceof Error ? error.message : "Workflow could not be saved.");
    }
    this.emitWorkflow();
  }

  private nextWorkflowCopyTitle(sourceTitle: string): string {
    const existing = new Set([...this.workflowStore.workflows.values()].map((workflow) => workflow.title));
    const base = `${sourceTitle} - 副本`;
    if (!existing.has(base)) return base;
    for (let copy = 2; copy < 10_000; copy += 1) {
      const candidate = `${base} ${copy}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base} ${randomUUID().slice(0, 8)}`;
  }

  selectWorkflow(workflowId: string): AppSnapshot {
    if (this.workflowStore.workflows.has(workflowId)) {
      this.workflowStore.activeId = workflowId;
      this.emitWorkflow();
    }
    return this.snapshot();
  }

  renameWorkflow(workflowId: string, title: string): AppSnapshot {
    const workflow = this.workflowStore.workflows.get(workflowId);
    const nextTitle = title.trim();
    if (!workflow || !nextTitle) return this.snapshot();
    this.workflowStore.workflows.set(workflowId, this.cloneWorkflowDraft({
      ...workflow,
      title: nextTitle,
      revision: workflow.revision + 1,
      updatedAt: Date.now(),
    }));
    this.emitWorkflow();
    return this.snapshot();
  }

  async deleteWorkflow(workflowId: string): Promise<AppSnapshot> {
    if (!this.workflowStore.workflows.has(workflowId)) return this.snapshot();
    const sessionKey = this.workflowDraftSessionKey(workflowId);
    this.runtimeApprovals.cancelOwner(sessionKey);
    await this.interactiveSessions.interrupt(sessionKey);
    await this.interactiveSessions.dispose(sessionKey, "app_shutdown");
    this.workflowDraftSessionBindings.delete(workflowId);
    this.workflowStore.workflows.delete(workflowId);
    this.activeWorkflowDraftRequests.delete(workflowId);
    for (const run of [...this.workflowStore.runs.values()]) {
      if (run.workflowId === workflowId) this.workflowStore.runs.delete(run.runId);
    }
    if (this.workflowStore.activeId === workflowId || (this.workflowStore.activeId && !this.workflowStore.workflows.has(this.workflowStore.activeId))) {
      this.workflowStore.activeId = [...this.workflowStore.workflows.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.workflowId;
    }
    this.emitWorkflow();
    return this.snapshot();
  }

  updateWorkflow(input: UpdateWorkflowRequest): WorkflowOperationResult {
    const current = this.workflowStore.workflows.get(input.workflowId);
    if (!current) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (current.status === "running") return { ok: false, error: "Cannot modify workflow graph while it is running." };
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      return { ok: false, workflowId: current.workflowId, revision: current.revision, error: "Workflow changed since you read it. Call workflow_get and retry." };
    }
    const requestedDefinition = input.definition ? structuredClone(input.definition) : structuredClone(current.definition);
    const sourceDefinition = current.topologyLocked
      ? requestedDefinition
      : migrateWorkflowV2ReviewGates(requestedDefinition, input.reviewerConfiguredAgentId ?? current.reviewerConfiguredAgentId);
    sourceDefinition.workflowId = current.workflowId;
    if (input.objective !== undefined) sourceDefinition.objective = input.objective;
    const definition = normalizeWorkflowV2TerminalNode(sourceDefinition).definition;
    if (definition.nodes.length > MAX_WORKFLOW_NODE_COUNT) {
      return { ok: false, workflowId: current.workflowId, revision: current.revision, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_NODE_COUNT} nodes.` };
    }
    if (definition.edges.length > MAX_WORKFLOW_EDGE_COUNT) {
      return { ok: false, workflowId: current.workflowId, revision: current.revision, error: `Workflow V2 definition exceeds ${MAX_WORKFLOW_EDGE_COUNT} edges.` };
    }
    if (current.topologyLocked && !isLockedWorkflowConfigurationUpdate(input, current.definition, definition)) {
      return { ok: false, workflowId: current.workflowId, revision: current.revision, error: "Official workflow topology is locked." };
    }
    const validation = validateWorkflowV2Definition(definition, { configuredAgentIds: this.configuredAgents.keys() });
    if (!validation.valid) return { ok: false, workflowId: current.workflowId, revision: current.revision, error: validation.errors[0] ?? "Workflow V2 definition is invalid." };
    const next = updateWorkflowDraftStateValue({
      current,
      request: input,
      definition,
      configuredAgentId:
        input.configuredAgentId !== undefined ? this.normalizeWorkflowConfiguredAgentId(input.configuredAgentId) : current.configuredAgentId,
      modelId:
        input.configuredAgentId !== undefined || input.modelId !== undefined
          ? this.normalizeModelIdForConfiguredAgent(input.configuredAgentId ?? current.configuredAgentId, input.modelId ?? current.modelId)
          : current.modelId,
      reviewerConfiguredAgentId:
        input.reviewerConfiguredAgentId !== undefined ? this.normalizeWorkflowConfiguredAgentId(input.reviewerConfiguredAgentId) : current.reviewerConfiguredAgentId,
      reviewerModelId:
        input.reviewerConfiguredAgentId !== undefined || input.reviewerModelId !== undefined
          ? this.normalizeModelIdForConfiguredAgent(input.reviewerConfiguredAgentId ?? current.reviewerConfiguredAgentId, input.reviewerModelId ?? current.reviewerModelId)
          : current.reviewerModelId,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
    this.workflowStore.workflows.set(next.workflowId, next);
    this.emitWorkflow();
    return { ok: true, workflowId: next.workflowId, revision: next.revision };
  }

  appendWorkflowContext(input: AppendWorkflowContextRequest): WorkflowOperationResult {
    return this.workflowContextService.appendWorkflow(input);
  }

  appendWorkflowRunContext(input: AppendWorkflowRunContextRequest): WorkflowOperationResult {
    return this.workflowContextService.appendRun(input);
  }

  startWorkflowRun(input: StartWorkflowRunRequest): WorkflowOperationResult {
    return this.workflowRunStateService.start(input);
  }

  finishWorkflowRun(input: FinishWorkflowRunRequest): WorkflowOperationResult {
    return this.workflowRunStateService.finish(input);
  }

  runWorkflow(input: RunWorkflowRequest): WorkflowOperationResult {
    const workflow = this.workflowStore.workflows.get(input.workflowId);
    const request = workflow?.sourceType === "official" || workflow?.topologyLocked
      ? { ...input, reviewEnabled: false }
      : input;
    if (workflow) {
      const readiness = this.workflowReadiness(input.workflowId, request.reviewEnabled);
      if (!readiness.ready) return { ok: false, workflowId: input.workflowId, error: readiness.issues[0]?.message ?? "Workflow requires configuration before running." };
    }
    return this.workflowRunService.run(request);
  }

  async buildWorkflowV2Plan(input: BuildWorkflowV2PlanRequest): Promise<BuildWorkflowV2PlanResult> {
    return this.workflowPlanningService.buildPlan(input);
  }

  async buildWorkflowV2GraphRevision(input: BuildWorkflowV2GraphRevisionRequest): Promise<BuildWorkflowV2GraphRevisionResult> {
    return this.workflowPlanningService.buildGraphRevision(input);
  }
  pauseWorkflowNode(input: PauseWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.pauseNode(input);
  }
  reviseWorkflowV2Run(input: ReviseWorkflowV2RunRequest): Promise<WorkflowOperationResult> { return this.workflowRunService.revise(input); }
  resolveWorkflowV2Intervention(input: ResolveWorkflowV2InterventionRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.resolveIntervention(input);
  }
  resolveWorkflowV2Recovery(input: ResolveWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.resolveRecovery(input);
  }
  refreshWorkflowV2Recovery(input: RefreshWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.refreshRecovery(input);
  }
  resolveWorkflowV2Conflict(input: ResolveWorkflowV2ConflictRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.resolveConflict(input);
  }
  resolveWorkflowV2UnknownOperation(input: ResolveWorkflowV2UnknownOperationRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.resolveUnknownOperation(input);
  }
  cleanupWorkflowV2RunMaterials(input: CleanupWorkflowV2RunRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.cleanupMaterials(input);
  }

  stopWorkflowRun(input: StopWorkflowRunRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.stop(input);
  }

  async sendWorkflowNodeMessage(input: SendWorkflowNodeMessageRequest): Promise<AppSnapshot> {
    return this.workflowNodeConversationService.sendMessage(input.conversationId, input.message);
  }

  async completeWorkflowNodeConversation(input: CompleteWorkflowNodeConversationRequest): Promise<WorkflowOperationResult> {
    return this.workflowNodeConversationService.confirmCompletion(input.conversationId);
  }

  async rejectWorkflowNodeCompletion(input: RejectWorkflowNodeCompletionRequest): Promise<AppSnapshot> {
    return this.workflowNodeConversationService.rejectCompletion(input.conversationId, input.instruction);
  }

  async interruptWorkflowNodeConversation(input: InterruptWorkflowNodeConversationRequest): Promise<AppSnapshot> {
    return this.workflowNodeConversationService.interrupt(input.conversationId);
  }

  startWorkflowNode(input: StartWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.startNode(input);
  }

  answerWorkflowGate(input: AnswerWorkflowGateRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.answerGate(input);
  }

  submitWorkflowScriptInput(input: SubmitWorkflowScriptInputRequest): Promise<WorkflowOperationResult> {
    return this.workflowRunService.submitScriptInput(input);
  }

  submitWorkflowNodeCompletion(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    output: WorkflowV2WorkerOutput;
  }) {
    return this.workflowRuntime.submitNodeCompletion(input);
  }

  async runScheduledWorkflowEvent(
    event: ScheduledWorkflowDueEvent,
    ackEvent: (eventId: string, request: AckScheduledWorkflowEventRequest) => Promise<void>,
  ): Promise<void> {
    const target = scheduledWorkflowEventTargetValue(event);
    await runScheduledWorkflowEventValue({
      event,
      ackEvent,
      target,
      workflow: target ? this.workflowStore.workflows.get(target.workflowId) : undefined,
      runId: `scheduled_run_${event.eventId}`,
      recordScheduledWorkflowRun: (run) => {
        this.recordScheduledWorkflowRun(run);
      },
      runWorkflow: (request) => this.runWorkflow(request),
      finishScheduledWorkflowRun: (runId, request) => {
        this.finishScheduledWorkflowRun(runId, request);
      },
      waitForWorkflowRunToSettle: (runId) => this.waitForWorkflowRunToSettle(runId),
    });
  }

  saveScheduledWorkflowRunnerConfig(config: ScheduledWorkflowRunnerConfig): AppSnapshot {
    this.scheduledWorkflowRunnerConfig = saveScheduledWorkflowRunnerConfigValue(
      config,
      (nextConfig) => this.cloneScheduledWorkflowRunnerConfig(nextConfig),
    );
    this.emit();
    return this.snapshot();
  }

  updateScheduledWorkflowRunnerStatus(status: Partial<ScheduledWorkflowRunnerStatus>): AppSnapshot {
    this.scheduledWorkflowRunnerStatus = updateScheduledWorkflowRunnerStatusValue(this.scheduledWorkflowRunnerStatus, status);
    this.emit();
    return this.snapshot();
  }

  selectScheduledWorkflow(scheduleId: string): AppSnapshot {
    const nextActiveScheduledWorkflowId = selectScheduledWorkflowIdValue({
      scheduleId,
      hasSchedule: (nextScheduleId) => this.scheduledWorkflowSchedules.has(nextScheduleId),
      activeScheduleId: this.activeScheduledWorkflowId,
    });
    if (nextActiveScheduledWorkflowId === this.activeScheduledWorkflowId) return this.snapshot();
    this.activeScheduledWorkflowId = nextActiveScheduledWorkflowId;
    this.emit();
    return this.snapshot();
  }

  upsertScheduledWorkflowSchedule(input: ScheduledWorkflowSchedule): ScheduledWorkflowOperationResult {
    const result = upsertScheduledWorkflowScheduleValue({
      schedule: input,
      current: this.scheduledWorkflowSchedules.get(input.scheduleId),
      hasWorkflow: this.workflowStore.workflows.has(input.workflowId),
      workflowTitle: this.workflowStore.workflows.get(input.workflowId)?.title,
      cloneSchedule: (schedule) => this.cloneScheduledWorkflowSchedule(schedule),
    });
    if (!result.ok || !result.schedule) return result;
    const schedule = result.schedule;
    this.scheduledWorkflowSchedules.set(schedule.scheduleId, schedule);
    this.activeScheduledWorkflowId = schedule.scheduleId;
    this.emit();
    return { ok: true, scheduleId: schedule.scheduleId };
  }

  replaceScheduledWorkflowSchedules(schedules: ScheduledWorkflowSchedule[]): AppSnapshot {
    const next = replaceScheduledWorkflowSchedulesValue({
      schedules,
      hasWorkflow: (workflowId) => this.workflowStore.workflows.has(workflowId),
      cloneSchedule: (schedule) => this.cloneScheduledWorkflowSchedule(schedule),
      activeScheduleId: this.activeScheduledWorkflowId,
    });
    this.scheduledWorkflowSchedules = next.schedules;
    this.activeScheduledWorkflowId = next.activeScheduleId;
    this.emit();
    return this.snapshot();
  }

  deleteScheduledWorkflowSchedule(scheduleId: string): AppSnapshot {
    const next = deleteScheduledWorkflowScheduleValue({
      scheduleId,
      schedules: this.scheduledWorkflowSchedules,
      activeScheduleId: this.activeScheduledWorkflowId,
    });
    if (!next.deleted) return this.snapshot();
    this.activeScheduledWorkflowId = next.activeScheduleId;
    this.emit();
    return this.snapshot();
  }

  recordScheduledWorkflowRun(input: ScheduledWorkflowRun): AppSnapshot {
    const schedule = this.scheduledWorkflowSchedules.get(input.scheduleId);
    const run = recordScheduledWorkflowRunValue({
      run: input,
      hasWorkflow: this.workflowStore.workflows.has(input.workflowId),
      scheduleTitle: schedule?.title,
      workflowTitle: this.workflowStore.workflows.get(input.workflowId)?.title,
      cloneRun: (nextRun) => this.cloneScheduledWorkflowRun(nextRun),
    });
    if (!run) return this.snapshot();
    this.scheduledWorkflowRuns.set(run.runId, run);
    this.activeScheduledWorkflowId = run.scheduleId;
    this.emit();
    return this.snapshot();
  }

  finishScheduledWorkflowRun(
    runId: string,
    input: {
      status: Exclude<ScheduledWorkflowRunStatus, "queued" | "running">;
      workflowRunId?: string;
      message?: string;
      finishedAt?: number;
    },
  ): AppSnapshot {
    const nextRun = finishScheduledWorkflowRunValue({
      run: this.scheduledWorkflowRuns.get(runId),
      update: input,
      cloneRun: (run) => this.cloneScheduledWorkflowRun(run),
    });
    if (!nextRun) return this.snapshot();
    this.scheduledWorkflowRuns.set(runId, nextRun);
    this.emit();
    return this.snapshot();
  }

  getWorkDir(): string {
    return this.workDir;
  }

  snapshot(): AppSnapshot {
    return {
      detectedAt: Date.now(),
      activeChatId: this.activeChatId,
      activeTaskId: this.activeTaskId,
      activeTeamId: this.activeTeamId,
      activeTeamRunId: this.activeTeamRunId,
      workDir: this.workDir,
      runtimes: [...this.runtimes.values()],
      channels: cloneChannels(this.channels),
      configuredAgents: this.listConfiguredAgents(),
      chats: [...this.chats.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((chat) => serializeChat({ chat, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) })),
      tasks: [...this.tasks.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((task) => serializeTask({ task, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) })),
      teams: [...this.teams.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((team) => serializeTeam(team)),
      teamRuns: [...this.teamRuns.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((run) => serializeTeamRun(run)),
      workflowStore: this.cloneWorkflowStore(),
      scheduledWorkflowStore: this.cloneScheduledWorkflowStore(),
      workflowNodeConversations: this.workflowNodeConversations.list(),
      workflowDraft: this.activeWorkflowDraft(),
      artifacts: this.artifacts.map((artifact) => ({ ...artifact })),
    };
  }

  workflowProjection(scopes: ReadonlySet<WorkflowProjectionScope> = new Set(["store", "conversations", "tasks", "artifacts"])): Partial<WorkflowAutomationProjection> {
    return {
      ...(scopes.has("store") ? { workflowStore: this.cloneWorkflowStore(), workflowDraft: this.activeWorkflowDraft() } : {}),
      ...(scopes.has("conversations") ? { workflowNodeConversations: this.workflowNodeConversations.list() } : {}),
      ...(scopes.has("tasks") ? { tasks: [...this.tasks.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((task) => serializeTask({ task, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) })) } : {}),
      ...(scopes.has("artifacts") ? { artifacts: this.artifacts.map((artifact) => ({ ...artifact })) } : {}),
    };
  }

  async registerArtifact(input: RegisterArtifactRequest): Promise<{ ok: boolean; error?: string; artifact?: RegisteredArtifact }> {
    const result = await registerArtifactValue({
      request: input,
      workDir: this.workDir,
    });
    if (!result.ok || !result.artifact) return result;
    const artifact = result.artifact;
    this.artifacts.push(artifact);
    this.emit();
    return { ok: true, artifact };
  }

  async listWorkflowOutputs(request: ListWorkflowOutputsRequest): Promise<Array<{ name: string; path: string }>> {
    const workflow = this.workflowStore.workflows.get(request.workflowId);
    const run = this.workflowStore.runs.get(request.runId);
    await reconcileWorkflowOutputArtifactsValue(workflow, run, this.workDir);
    return listWorkflowOutputsValue(workflow, this.workDir, request.workflowId, request.runId);
  }

  workflowWorkDir(workflowId: string): string | undefined {
    return workflowWorkDirValue(this.workflowStore.workflows.get(workflowId), this.workDir);
  }

  /** Directories from which local files may be previewed: global + each workflow's dir. */
  allowedFileRoots(): string[] {
    return allowedFileRootsValue(this.workflowStore.workflows.values(), this.workDir);
  }

  listArtifacts(target?: string): RegisteredArtifact[] {
    return listArtifactsValue(this.artifacts, target);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ kind: "snapshot", snapshot: this.snapshot() });
    return () => this.listeners.delete(listener);
  }

  private runtimeStateFromCapabilities(capabilities: RuntimeCapabilities): ChatRuntimeSessionState {
    return runtimeStateFromCapabilitiesValue(capabilities);
  }

  private syncInteractiveChatState(chat: ChatState, state: InteractiveSessionSnapshot): void {
    syncInteractiveChatStateValue({
      chat,
      state,
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
    });
    this.emit();
  }

  private selectExecutionMode(
    runtimeId: AgentId,
    surface: RuntimeSurface,
    preferred: RuntimeExecutionMode,
  ): RuntimeExecutionMode {
    return selectExecutionModeValue({
      runtimeDrivers: this.runtimeDrivers,
      runtimeId,
      surface,
      preferred,
    });
  }

  private defaultContinuationPolicy(
    runtimeId: AgentId,
    surface: RuntimeSurface,
    executionMode: RuntimeExecutionMode,
  ): RuntimeContinuationPolicy {
    return defaultContinuationPolicyValue({
      runtimeDrivers: this.runtimeDrivers,
      runtimeId,
      surface,
      executionMode,
    });
  }

  private cloneConversationForPolicy(
    continuationPolicy: RuntimeContinuationPolicy,
    runtimeConversation: RuntimeConversation | undefined,
  ): RuntimeConversation | undefined {
    return cloneConversationForPolicyValue(
      continuationPolicy,
      runtimeConversation,
      (conversation) => this.runtimeRouter.cloneConversation(conversation),
    );
  }

  private buildInteractiveChatContext(chat: ChatState, resolved: ResolvedConfiguredAgent): InteractiveSessionContext {
    return buildInteractiveChatContextValue({
      chat,
      resolved,
      workDir: this.runWorkDir(chat),
      developerInstructions: CODEX_CHAT_DEVELOPER_INSTRUCTIONS,
      selectExecutionMode: (runtimeId, surface, preferred) => this.selectExecutionMode(runtimeId, surface, preferred),
      defaultContinuationPolicy: (runtimeId, surface, executionMode) =>
        this.defaultContinuationPolicy(runtimeId, surface, executionMode),
      cloneConversationForPolicy: (continuationPolicy, runtimeConversation) =>
        this.cloneConversationForPolicy(continuationPolicy, runtimeConversation),
      emit: (event) => this.handleAgentEvent(chat, event),
      syncState: (state) => this.syncInteractiveChatState(chat, state),
    });
  }

  async sendPrompt(prompt: string, chatId = this.activeChatId): Promise<void> {
    if (!chatId) return;
    const chat = this.chats.get(chatId);
    if (!chat || chat.running) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    if (trimmedPrompt.startsWith("/")) {
      await dispatchSlashChatPromptValue({
        chat,
        prompt: trimmedPrompt,
        createUserMessage: (content, hidden) => createUserMessage(content, hidden),
        createAssistantMessage: (content, hidden) => createAssistantMessage(content, hidden),
        activateChat: (nextChatId) => {
          this.activeChatId = nextChatId;
        },
        emit: () => this.emit(),
        runSlashCommand: (currentChat, currentPrompt) =>
          runSlashCommandValue({
            chat: currentChat,
            prompt: currentPrompt,
            executable: this.executables.codex,
            workDir: this.workDir,
            resolveConfiguredAgent: (configuredAgentId, modelIdOverride, channelIdOverride) =>
              this.resolveConfiguredAgentForSlash(configuredAgentId, modelIdOverride, channelIdOverride),
          }),
      });
      return;
    }

    await dispatchChatPromptExecutionValue({
      chat,
      prompt: trimmedPrompt,
      resolveConfiguredAgent: (configuredAgentId, modelIdOverride, channelIdOverride) =>
        this.resolveConfiguredAgent(configuredAgentId, modelIdOverride, channelIdOverride),
      selectExecutionMode: (runtimeId, surface, preferred) => this.selectExecutionMode(runtimeId, surface, preferred),
      capabilitiesForRuntime: (runtime) => this.runtimeRouter.capabilitiesFor(runtime),
      hasAgentConversationMessages: (messages) => hasAgentConversationMessages(messages),
      titleFromPrompt: (currentPrompt) => titleFromPrompt(currentPrompt),
      createUserMessage: (content) => createUserMessage(content),
      createErrorMessage: (content) => createErrorMessage(content),
      createRuntimeState: (runtimeCapabilities) => this.runtimeStateFromCapabilities(runtimeCapabilities),
      activateChat: (nextChatId) => {
        this.activeChatId = nextChatId;
      },
      emit: () => this.emit(),
      dispatchInteractivePrompt: async (currentChat, currentPrompt, preparedResolved) => {
        await dispatchInteractiveChatPromptValue({
          chat: currentChat,
          prompt: currentPrompt,
          interactiveSessions: this.interactiveSessions,
          buildContext: () => this.buildInteractiveChatContext(currentChat, preparedResolved),
          syncInteractiveChatState: (nextChat, state) => this.syncInteractiveChatState(nextChat, state),
          registerStop: (stop) => {
            this.activeStops.set(currentChat.id, stop);
          },
          markRunFailed: (nextChat, error) => this.markRunFailed(nextChat, error),
        });
      },
      run: (currentChat, currentPrompt, preparedResolved) => {
        void this.runChat(currentChat, currentPrompt, preparedResolved);
      },
    });
  }

  private async withCodexAppServer<T>(chat: ChatState, callback: (client: CodexRpcClient) => Promise<T>): Promise<T> {
    return withCodexAppServerValue({
      chat,
      executable: this.executables.codex,
      workDir: this.workDir,
      resolved: this.resolveConfiguredAgentForSlash(chat.configuredAgentId, chat.modelId, chat.channelId),
      callback,
    });
  }

  private resolveConfiguredAgentForSlash(
    configuredAgentId: string | undefined,
    modelIdOverride?: string,
    channelIdOverride?: string,
  ): ResolvedConfiguredAgentForSlash | undefined {
    const resolved = this.resolveConfiguredAgent(configuredAgentId, modelIdOverride, channelIdOverride);
    if (!resolved) return undefined;
    return resolved;
  }

  async runTask(input: RunTaskRequest, approvalPolicy?: { allowedFileWriteRoot: string; workspaceOnly?: boolean; readOnly?: boolean }): Promise<AppSnapshot> {
    const task = this.createTaskState(input);
    dispatchTaskPromptExecutionValue({
      task,
      registerTask: (nextTask) => {
        if (approvalPolicy?.readOnly) this.runtimeApprovals.restrictToReadOnly(nextTask.id);
        else if (approvalPolicy?.workspaceOnly) this.runtimeApprovals.restrictToFileWritesWithin(nextTask.id, approvalPolicy.allowedFileWriteRoot);
        else if (approvalPolicy) this.runtimeApprovals.allowFileWritesWithin(nextTask.id, approvalPolicy.allowedFileWriteRoot);
        this.tasks.set(nextTask.id, nextTask);
        this.activeTaskId = nextTask.id;
      },
      resolveConfiguredAgent: (configuredAgentId, modelId) => this.resolveConfiguredAgent(configuredAgentId, modelId),
      createUserMessage: (content) => createUserMessage(content),
      createErrorMessage: (content) => createErrorMessage(content),
      emit: () => input.planningWorkflowId || input.workflowRunId ? this.emitWorkflow() : this.emit(),
      run: (nextTask, preparedResolved) => {
        void this.runChat(nextTask, nextTask.prompt, preparedResolved);
      },
    });
    return this.snapshot();
  }

  private workflowDraftSessionKey(workflowId: string): string {
    return `workflow-draft:${workflowId}`;
  }

  private workflowNodeExecutionId(workflowId: string, runId: string, nodeId: string, attempt = 1): string {
    return `workflow-node:${workflowId}:${runId}:${nodeId}:attempt:${Math.max(1, Math.floor(attempt))}`;
  }

  private createWorkflowNodeInteractiveSession(input: Parameters<WorkflowV2ConversationManager["start"]>[0] & { emit: (event: AgentEvent) => void }) {
    const resolved = this.resolveConfiguredAgent(input.configuredAgentId, input.modelId);
    if (!resolved || !resolved.runtime?.available) throw new Error("The configured workflow node agent is unavailable.");
    const executionMode = this.selectExecutionMode(resolved.runtimeAgentId, "chat", "interactive");
    if (executionMode !== "interactive") throw new Error("The configured workflow node agent does not support interactive sessions.");
    const sessionKey = `workflow-node:${input.workflowId}:${input.runId}:${input.nodeId}`; this.runtimeApprovals.allowWorkflowOutputWrites(sessionKey, input.workDir, input.workflowId, input.runId);
    const completionExecutionId = this.workflowNodeExecutionId(input.workflowId, input.runId, input.nodeId, input.attempt);
    let latestRuntimeConversation: RuntimeConversation | undefined;
    const context: InteractiveSessionContext = {
      chatId: sessionKey,
      configuredAgentId: resolved.agent.id,
      runtimeId: resolved.runtimeAgentId,
      executionMode,
      continuationPolicy: this.defaultContinuationPolicy(resolved.runtimeAgentId, "chat", executionMode),
      runtimeConfig: {
        model: resolved.modelId,
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
      },
      runtime: resolved.runtime,
      channelId: resolved.channel.id,
      workDir: input.workDir,
      planningWorkflowId: input.workflowId,
      workflowRunId: input.runId,
      workflowNodeId: input.nodeId,
      workflowNodeExecutionId: completionExecutionId,
      invocation: {
        surface: "workflow",
        role: "node",
        ownerReference: {
          workflowId: input.workflowId,
          runId: input.runId,
          nodeId: input.nodeId,
          executionId: completionExecutionId,
        },
      },
      developerInstructions: [WORKFLOW_DEVELOPER_INSTRUCTIONS, resolved.agent.instructions, input.developerInstructions, input.contextDocument ? `# Runtime context\n${input.contextDocument}` : undefined].filter(Boolean).join("\n\n"),
      emit: (event) => {
        if (event.type === "runtime_conversation") latestRuntimeConversation = this.runtimeRouter.cloneConversation(event.runtimeConversation);
        input.emit(event);
      },
      syncState: (state) => {
        if (state.runtimeConversation) latestRuntimeConversation = this.runtimeRouter.cloneConversation(state.runtimeConversation);
      },
    };
    return {
      sendPrompt: async (prompt: string) => this.interactiveSessions.dispatch(sessionKey, context, async (session, lease) => {
        await session.ensureAttached();
        lease.syncAttachmentGeneration(session.snapshot().runtimeState.attachmentGeneration);
        await session.sendPrompt(prompt);
      }),
      interrupt: () => this.interactiveSessions.interrupt(sessionKey),
      close: async () => { this.runtimeApprovals.cancelOwner(sessionKey); await this.interactiveSessions.dispose(sessionKey, "app_shutdown"); },
      runtimeConversation: () => latestRuntimeConversation,
    };
  }

  private async askWorkflowDraftAgent(
    input: WorkflowDraftInteractiveRequest,
    onEvent?: (event: WorkflowAgentEvent) => void,
  ): Promise<WorkflowAgentResponse> {
    const resolved = this.resolveConfiguredAgent(input.configuredAgentId, input.modelId);
    if (!resolved) throw new Error("No configured agent is selected.");
    const runtime = resolved.runtime;
    if (!runtime?.available) {
      throw new Error(`${resolved.agent.name || resolved.agent.id} is not available on this machine.`);
    }

    const executionMode = this.selectExecutionMode(resolved.runtimeAgentId, "chat", "interactive");
    if (executionMode !== "interactive") {
      throw new Error(
        `${resolved.agent.name || resolved.agent.id} does not support interactive workflow planning. ` +
        "Choose Codex, Claude, Hermes, OpenCode, or OpenClaw for the Workflow dialog.",
      );
    }
    const continuationPolicy = this.defaultContinuationPolicy(resolved.runtimeAgentId, "chat", executionMode);
    const configuredAgentCatalog = this.listConfiguredAgents().map((agent) => {
      const target = this.resolveConfiguredAgent(agent.id, agent.modelId);
      return {
        configuredAgentId: agent.id,
        name: agent.name,
        description: agent.description,
        tags: agent.tags,
        runtimeId: target?.runtimeAgentId ?? agent.runtimeAgentId,
        modelId: target?.modelId ?? agent.modelId,
        available: Boolean(target?.runtime?.available),
        supportsInteractivePlanning: target
          ? this.selectExecutionMode(target.runtimeAgentId, "chat", "interactive") === "interactive"
          : false,
        mcpBindings: (runtimeSupportsCustomMcp(agent.runtimeAgentId) ? agent.mcpBindings ?? [] : []).map((binding) => ({
          serverId: binding.serverId,
          toolAllowlist: binding.toolAllowlist,
        })),
      };
    });
    const prompt = [
      input.prompt,
      "Configured Agent runtime catalog (current AgentRecall configuration):",
      "Assign an explicit configuredAgentId from this catalog to every LLM node. Choose by node responsibility, Agent description/tags, runtime/model, and MCP bindings. Prefer available=true. Do not invent IDs. An empty toolAllowlist means all tools from that MCP server are allowed. Script nodes must not receive configuredAgentId.",
      JSON.stringify(configuredAgentCatalog, null, 2),
    ].join("\n\n");
    const runtimeConversation = input.runtimeConversation?.runtimeId === resolved.runtimeAgentId
      ? this.cloneConversationForPolicy(continuationPolicy, input.runtimeConversation)
      : undefined;
    const sessionKey = this.workflowDraftSessionKey(input.workflowId);
    const binding = JSON.stringify({
      runtimeId: resolved.runtimeAgentId,
      configuredAgentId: resolved.agent.id,
      channelId: resolved.channel.id,
      modelId: resolved.modelId,
      workDir: input.workDir,
    });
    const previousBinding = this.workflowDraftSessionBindings.get(input.workflowId);
    if (previousBinding && (previousBinding !== binding || (input.starting && !runtimeConversation))) {
      this.runtimeApprovals.cancelOwner(sessionKey);
      await this.interactiveSessions.dispose(sessionKey, "error");
    }
    this.workflowDraftSessionBindings.set(input.workflowId, binding);

    let content = "";
    let latestRuntimeConversation = runtimeConversation;
    let settled = false;
    let timingOut = false;
    let timeout: ReturnType<typeof createWorkflowAgentTimeout> | undefined;

    return new Promise<WorkflowAgentResponse>((resolve, reject) => {
      const settle = (callback: () => void): void => {
        if (settled || timingOut) return;
        settled = true;
        timeout?.clear();
        callback();
      };
      const fail = (error: unknown): void => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        settle(() => reject(normalized));
      };
      const finishTimeout = (error: unknown): void => {
        if (settled || !timingOut) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        timingOut = false;
        settled = true;
        reject(normalized);
      };

      timeout = createWorkflowAgentTimeout({
        timeoutMs: WORKFLOW_AGENT_IDLE_TIMEOUT_MS,
        onTimeout: () => {
          if (settled || timingOut) return;
          timingOut = true;
          timeout?.clear();
          const error = new Error("Workflow planning agent timed out after 10 minutes without activity");
          this.runtimeApprovals.cancelOwner(sessionKey);
          void this.interactiveSessions
            .interrupt(sessionKey, { status: "timed_out", error })
            .then(() => finishTimeout(error), finishTimeout);
        },
      });

      const context: InteractiveSessionContext = {
        chatId: sessionKey,
        configuredAgentId: resolved.agent.id,
        runtimeId: resolved.runtimeAgentId,
        executionMode,
        continuationPolicy,
        runtimeConfig: {
          model: resolved.modelId,
          ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
        },
        ...(runtimeConversation ? { runtimeConversation } : {}),
        runtime,
        channelId: resolved.channel.id,
        workDir: input.workDir,
        planningWorkflowId: input.workflowId,
        invocation: {
          surface: "workflow",
          role: "draft",
          ownerReference: { workflowId: input.workflowId, requestId: input.requestId },
        },
        developerInstructions: [WORKFLOW_DEVELOPER_INSTRUCTIONS, resolved.agent.instructions]
          .filter(Boolean)
          .join("\n\n"),
        emit: (event) => {
          if (settled || timingOut) return;
          timeout?.refresh();
          if (emitWorkflowAgentApprovalEvent({ requestId: input.requestId, onEvent }, event)) return;
          if (event.type === "runtime_conversation") {
            latestRuntimeConversation = this.runtimeRouter.cloneConversation(event.runtimeConversation);
            const workflow = this.workflowStore.workflows.get(input.workflowId);
            if (workflow) {
              this.workflowStore.workflows.set(input.workflowId, this.cloneWorkflowDraft({
                ...workflow,
                runtimeConversation: latestRuntimeConversation,
                updatedAt: Date.now(),
              }));
              this.workflowStore.activeId = input.workflowId;
              this.emitWorkflow();
            }
            return;
          }
          if (event.type === "delta") {
            content += event.content;
            onEvent?.({ requestId: input.requestId, type: "delta", content: event.content });
            return;
          }
          if (event.type === "tool_call" || event.type === "tool_result") {
            onEvent?.({
              requestId: input.requestId,
              type: event.type,
              content: event.content,
              ...(event.name ? { name: event.name } : {}),
              ...(event.metadata ? { metadata: structuredClone(event.metadata) } : {}),
            });
            return;
          }
          if (event.type === "completed") {
            const finalContent = (content || event.content || "").trim();
            settle(() => resolve({
              content: finalContent,
              ...(latestRuntimeConversation ? { runtimeConversation: latestRuntimeConversation } : {}),
            }));
            return;
          }
          if (event.type === "error") fail(new Error(event.error));
        },
        syncState: (state) => {
          if (settled || timingOut) return;
          if (state.runtimeConversation) {
            latestRuntimeConversation = this.runtimeRouter.cloneConversation(state.runtimeConversation);
          }
        },
      };

      void this.interactiveSessions.dispatch(sessionKey, context, async (session, lease) => {
        await session.ensureAttached();
        lease.syncAttachmentGeneration(session.snapshot().runtimeState.attachmentGeneration);
        await session.sendPrompt(prompt);
      }).catch(fail);
    });
  }

  async askWorkflowAgent(input: WorkflowAgentRequest, onEvent?: (event: WorkflowAgentEvent) => void, signal?: AbortSignal): Promise<WorkflowAgentResponse> {
    return this.askAgentWithInstructionScope(input, "workflow", onEvent, signal);
  }

  async askConfiguredAgent(input: WorkflowAgentRequest, onEvent?: (event: WorkflowAgentEvent) => void, signal?: AbortSignal): Promise<WorkflowAgentResponse> {
    return this.askAgentWithInstructionScope(input, "agent", onEvent, signal);
  }

  private async askAgentWithInstructionScope(
    input: WorkflowAgentRequest,
    instructionScope: "workflow" | "agent",
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<WorkflowAgentResponse> {
    return this.runtimeRouter.askWorkflow({
      ...buildWorkflowAgentExecutionValue({
        request: input,
        resolveConfiguredAgent: (configuredAgentId, modelId, channelId) =>
          this.resolveConfiguredAgent(configuredAgentId, modelId, channelId),
        cloneConversationForPolicy: (continuationPolicy, runtimeConversation) =>
          this.cloneConversationForPolicy(continuationPolicy, runtimeConversation),
        defaultWorkDir: this.workDir,
        createRequestId: () => randomUUID(),
      }),
      instructionScope,
      onEvent,
      signal,
    });
  }

  async stopChat(chatId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat) return; this.runtimeApprovals.cancelOwner(chatId);
    const stop = this.activeStops.get(chatId);
    this.activeStops.delete(chatId);
    try {
      if (stop) await stop();
    } finally {
      chat.running = false;
      if (chat.runtimeState) {
        chat.runtimeState.attachmentState = "interrupted";
        chat.runtimeState.lastMeaningfulActivityAt = Date.now();
        delete chat.runtimeState.activeTurnId;
      }
      chat.messages = this.expirePendingInteractionEvents(chat.messages);
      chat.messages.push(createErrorMessage("Stopped"));
      chat.updatedAt = Date.now();
      this.emit();
    }
  }

  selectTask(taskId: string): void {
    if (!this.tasks.has(taskId)) return;
    this.activeTaskId = taskId;
    this.emit();
  }

  private markTaskStopped(task: TaskState): void {
    task.running = false;
    task.status = "stopped";
    task.lastError = "Stopped";
    task.messages.push(createErrorMessage("Stopped"));
    task.updatedAt = Date.now();
  }

  async stopTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return; this.runtimeApprovals.cancelOwner(taskId);
    const stop = this.activeStops.get(taskId);
    this.activeStops.delete(taskId);
    this.markTaskStopped(task);
    try {
      if (stop) await stop();
    } finally {
      this.finishTeamStepFromTask(task);
      if (task.planningWorkflowId || task.workflowRunId) this.emitWorkflow();
      else this.emit();
    }
  }

  updateTaskProgress(taskId: string, progress: TaskProgress): AppSnapshot {
    const task = this.tasks.get(taskId);
    if (!task || !isTaskProgress(progress)) return this.snapshot();
    task.progress = progress;
    task.updatedAt = Date.now();
    this.activeTaskId = task.id;
    if (task.planningWorkflowId || task.workflowRunId) this.emitWorkflow();
    else this.emit();
    return this.snapshot();
  }

  async deleteTask(taskId: string, options?: { preserveRuntimeConversation?: boolean }): Promise<AppSnapshot> {
    const task = this.tasks.get(taskId);
    if (!task) return this.snapshot(); this.runtimeApprovals.cancelOwner(taskId);

    const stop = this.activeStops.get(taskId);
    this.activeStops.delete(taskId);
    this.tasks.delete(taskId);
    if (this.activeTaskId === taskId) {
      this.activeTaskId = [...this.tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id;
    }
    if (task.planningWorkflowId || task.workflowRunId) this.emitWorkflow();
    else this.emit();
    await this.flushPersistence();

    if (stop) {
      try {
        await stop();
      } catch {
        // The task is already gone from app state; deletion should still succeed.
      }
    }
    if (!options?.preserveRuntimeConversation) await this.deleteAgentSession(task);

    return this.snapshot();
  }

  createTeam(input: CreateAgentTeamRequest): AppSnapshot {
    const team = this.createTeamState(input);
    this.teams.set(team.id, team);
    this.activeTeamId = team.id;
    this.emit();
    return this.snapshot();
  }

  updateTeam(teamId: string, input: UpdateAgentTeamRequest): AppSnapshot {
    const team = this.teams.get(teamId);
    if (!team) return this.snapshot();

    const name = input.name?.trim();
    if (name) team.name = name;
    if (isAgentTeamMode(input.mode)) team.mode = input.mode;
    if (typeof input.sharedContext === "string") team.sharedContext = input.sharedContext;
    if (input.members) team.members = this.normalizeTeamMembers(input.members);
    team.updatedAt = Date.now();
    this.activeTeamId = team.id;
    this.emit();
    return this.snapshot();
  }

  deleteTeam(teamId: string): AppSnapshot {
    const team = this.teams.get(teamId);
    if (!team) return this.snapshot();

    for (const run of this.teamRuns.values()) {
      if (run.teamId === teamId && run.status === "running") void this.stopTeamRun(run.id);
    }
    this.teams.delete(teamId);
    for (const run of [...this.teamRuns.values()]) {
      if (run.teamId === teamId) this.teamRuns.delete(run.id);
    }
    if (this.activeTeamId === teamId) {
      this.activeTeamId = [...this.teams.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id;
    }
    if (this.activeTeamRunId && !this.teamRuns.has(this.activeTeamRunId)) {
      this.activeTeamRunId = [...this.teamRuns.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id;
    }
    this.emit();
    return this.snapshot();
  }

  selectTeam(teamId: string): AppSnapshot {
    if (!this.teams.has(teamId)) return this.snapshot();
    this.activeTeamId = teamId;
    const latestRun = [...this.teamRuns.values()]
      .filter((run) => run.teamId === teamId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (latestRun) this.activeTeamRunId = latestRun.id;
    this.emit();
    return this.snapshot();
  }

  selectTeamRun(teamRunId: string): AppSnapshot {
    const run = this.teamRuns.get(teamRunId);
    if (!run) return this.snapshot();
    this.activeTeamRunId = run.id;
    this.activeTeamId = run.teamId;
    this.emit();
    return this.snapshot();
  }

  async runTeam(input: RunAgentTeamRequest): Promise<AppSnapshot> {
    const team = this.teams.get(input.teamId);
    const prompt = input.prompt.trim();
    if (!team || !prompt || team.members.length === 0) return this.snapshot();

    const teamRun = new TeamRunState(team, prompt, this.normalizeWorkflowTarget(input.target), input.workDir?.trim() || this.workDir);
    teamRun.status = "running";
    teamRun.updatedAt = Date.now();
    this.teamRuns.set(teamRun.id, teamRun);
    this.activeTeamId = team.id;
    this.activeTeamRunId = teamRun.id;
    this.emit();

    await this.startTeamRun(teamRun.id);
    return this.snapshot();
  }

  async stopTeamRun(teamRunId: string): Promise<AppSnapshot> {
    const run = this.teamRuns.get(teamRunId);
    if (!run) return this.snapshot();
    const runningSteps = run.steps.filter((step) => step.status === "running" && step.taskId);
    await Promise.all(runningSteps.map((step) => (step.taskId ? this.stopTask(step.taskId) : Promise.resolve(this.snapshot()))));
    run.status = "stopped";
    run.lastError = "Stopped";
    run.updatedAt = Date.now();
    this.activeTeamRunId = run.id;
    this.emit();
    return this.snapshot();
  }

  private async deleteAgentSession(run: RunState): Promise<void> {
    const resolved = this.resolveConfiguredAgent(run.configuredAgentId, run.modelId, run.kind === "chat" ? run.channelId : undefined);
    if (!resolved) return;
    if (!this.runtimeRouter.supportsSurface(resolved.runtimeAgentId, "cleanup")) return;
    const workDir = "workDir" in run ? run.workDir : this.workDir;
    await this.runtimeRouter.deleteSessionArtifacts(resolved.runtimeAgentId, {
      workDir,
      ...(run.runtimeConversation ? { runtimeConversation: this.runtimeRouter.cloneConversation(run.runtimeConversation) } : {}),
    });
  }

  private createChatState(configuredAgentId: string): ChatState {
    const agent = this.configuredAgentById(configuredAgentId);
    return new ChatState(agent?.id ?? "", this.normalizeModelIdForConfiguredAgent(agent?.id, agent?.modelId), agent?.name || "New Chat");
  }

  private createTaskState(input: RunTaskRequest): TaskState {
    const agent = this.configuredAgentById(input.configuredAgentId);
    const task = new TaskState(
      input.prompt.trim(),
      agent?.id ?? "",
      this.normalizeModelIdForConfiguredAgent(agent?.id, input.modelId ?? agent?.modelId),
      input.workDir?.trim() || this.workDir,
    );
    task.continuationPolicy = input.continuationPolicy ?? "fresh";
    task.developerInstructions = input.developerInstructions?.trim() || undefined;
    task.contextDocument = input.contextDocument?.trim() || undefined;
    task.runtimeConversation = this.cloneConversationForPolicy(task.continuationPolicy, input.runtimeConversation);
    task.planningWorkflowId = input.planningWorkflowId;
    task.workflowReviewRevision = input.workflowReviewRevision;
    task.workflowRunId = input.workflowRunId;
    task.workflowNodeId = input.workflowNodeId;
    task.workflowNodeExecutionId = input.workflowNodeExecutionId;
    task.allowedMcpTools = input.allowedMcpTools ? [...input.allowedMcpTools] : undefined;
    return task;
  }

  private createTeamState(input: CreateAgentTeamRequest): AgentTeamState {
    return createTeamStateValue(input, (members) => this.normalizeTeamMembers(members));
  }

  private normalizeWorkflowTarget(target: AgentWorkflowTarget | undefined): AgentWorkflowTarget | undefined {
    return normalizeWorkflowTargetValue(target);
  }

  private normalizeTeamMembers(members: Array<Partial<Omit<AgentTeamMember, "id">> & { id?: string }>): AgentTeamMember[] {
    return normalizeTeamMembersValue(members, (configuredAgentId) => this.configuredAgentById(configuredAgentId)?.id ?? "");
  }

  private teamMembersFromRunSteps(steps: TeamRunStep[]): AgentTeamMember[] {
    return teamMembersFromRunStepsValue(steps, (members) => this.normalizeTeamMembers(members));
  }

  private applyWorkflowDraftPatch(current: WorkflowDraftState, patch: PatchWorkflowDraftRequest): WorkflowDraftState {
    return applyWorkflowDraftPatchValue({
      current,
      patch,
      normalizeConfiguredAgentId: (configuredAgentId) => this.normalizeWorkflowConfiguredAgentId(configuredAgentId),
      normalizeModelId: (configuredAgentId, modelId) => this.normalizeModelIdForConfiguredAgent(configuredAgentId, modelId),
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
  }

  private replaceWorkflowDraftMessage(messages: WorkflowDraftState["messages"], messageId: string, content: string): WorkflowDraftState["messages"] {
    return replaceWorkflowDraftMessageValue(messages, messageId, content);
  }

  private workflowIdForActiveDraftRequest(requestId: string): string | undefined {
    for (const [workflowId, request] of this.activeWorkflowDraftRequests) {
      if (request.requestId === requestId) return workflowId;
    }
    return undefined;
  }

  private handleWorkflowDraftAgentEvent(workflowId: string, event: WorkflowAgentEvent): void {
    const reduced = reduceWorkflowDraftReplyEventValue({
      workflow: this.workflowStore.workflows.get(workflowId),
      activeRequest: this.activeWorkflowDraftRequests.get(workflowId),
      event,
      thinkingMessage: WORKFLOW_THINKING_MESSAGE,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      replaceMessage: (messages, messageId, content) => this.replaceWorkflowDraftMessage(messages, messageId, content),
    });

    if (reduced.type === "delta") {
      this.workflowStore.workflows.set(workflowId, reduced.workflow);
      this.emitWorkflowStreaming("store", { workflows: { upsert: [this.cloneWorkflowDraft(reduced.workflow)], remove: [] } });
      return;
    }

    if (reduced.type === "event") {
      this.workflowStore.workflows.set(workflowId, reduced.workflow);
      this.emitWorkflow();
      return;
    }

    if (reduced.type === "completed") {
      this.completeWorkflowDraftRequest(workflowId, reduced.requestId, reduced.content, reduced.runtimeConversation);
      return;
    }

    if (reduced.type === "error") {
      this.failWorkflowDraftRequest(workflowId, reduced.requestId, reduced.error);
    }
  }

  private completeWorkflowDraftRequest(workflowId: string, requestId: string, content: string, runtimeConversation: RuntimeConversation | undefined): void {
    workflowId = this.workflowIdForActiveDraftRequest(requestId) ?? workflowId;
    const activeRequest = this.activeWorkflowDraftRequests.get(workflowId);
    if (!activeRequest || activeRequest.requestId !== requestId) return;
    this.activeWorkflowDraftRequests.delete(workflowId);
    const workflow = this.workflowStore.workflows.get(workflowId);
    if (!workflow) return;
    const next = completeWorkflowDraftRequestValue({
      workflow,
      activeRequest,
      content,
      runtimeConversation,
      thinkingMessage: WORKFLOW_THINKING_MESSAGE,
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
    this.workflowStore.workflows.set(workflowId, next);
    this.emitWorkflow();
  }

  private failWorkflowDraftRequest(workflowId: string, requestId: string, error: string): void {
    workflowId = this.workflowIdForActiveDraftRequest(requestId) ?? workflowId;
    const activeRequest = this.activeWorkflowDraftRequests.get(workflowId);
    if (!activeRequest || activeRequest.requestId !== requestId) return;
    this.activeWorkflowDraftRequests.delete(workflowId);
    const workflow = this.workflowStore.workflows.get(workflowId);
    if (!workflow) return;
    this.workflowStore.workflows.set(workflowId, failWorkflowDraftRequestValue({
      workflow,
      activeRequest,
      error,
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
    }));
    this.emitWorkflow();
  }

  private waitForWorkflowRunToSettle(runId: string): Promise<WorkflowRunState> {
    return waitForWorkflowRunToSettleValue({
      runId,
      getRun: (currentRunId) => this.workflowStore.runs.get(currentRunId),
      cloneRun: (run) => this.cloneWorkflowRun(run),
      onChange: (listener) =>
        this.onChange(() => {
          listener();
        }),
    });
  }

  private activeWorkflowDraft(): WorkflowDraftState | undefined {
    const workflow = this.workflowStore.activeId ? this.workflowStore.workflows.get(this.workflowStore.activeId) : undefined;
    return workflow ? this.cloneWorkflowDraft(workflow) : undefined;
  }

  private cloneWorkflowStore(): WorkflowStoreState {
    const store = cloneWorkflowStoreValue({
      activeWorkflowId: this.workflowStore.activeId,
      workflows: this.workflowStore.workflows.values(),
      workflowRuns: this.workflowStore.runs.values(),
      cloneDraft: (draft) => this.cloneWorkflowDraft(draft),
      cloneRun: (run) => this.cloneWorkflowRun(run),
    });
    store.readinessByWorkflowId = Object.fromEntries(store.workflows.map((workflow) => [workflow.workflowId, this.workflowReadiness(workflow.workflowId)]));
    return store;
  }

  private cloneWorkflowRun(run: WorkflowRunState): WorkflowRunState {
    return cloneWorkflowRunValue(run);
  }

  private cloneScheduledWorkflowStore(): ScheduledWorkflowStoreState {
    return cloneScheduledWorkflowStoreValue({
      activeScheduleId: this.activeScheduledWorkflowId,
      runnerConfig: this.scheduledWorkflowRunnerConfig,
      runnerStatus: this.scheduledWorkflowRunnerStatus,
      schedules: this.scheduledWorkflowSchedules.values(),
      runs: this.scheduledWorkflowRuns.values(),
      cloneRunnerConfig: (config) => this.cloneScheduledWorkflowRunnerConfig(config),
      cloneSchedule: (schedule) => this.cloneScheduledWorkflowSchedule(schedule),
      cloneRun: (run) => this.cloneScheduledWorkflowRun(run),
    });
  }

  private cloneScheduledWorkflowRunnerConfig(config: ScheduledWorkflowRunnerConfig): ScheduledWorkflowRunnerConfig {
    return cloneScheduledWorkflowRunnerConfigValue(config);
  }

  private cloneScheduledWorkflowSchedule(schedule: ScheduledWorkflowSchedule): ScheduledWorkflowSchedule {
    const workflowTitle = this.workflowStore.workflows.get(schedule.workflowId)?.title;
    return workflowTitle === undefined
      ? cloneScheduledWorkflowScheduleValue({ schedule })
      : cloneScheduledWorkflowScheduleValue({ schedule, workflowTitle });
  }

  private cloneScheduledWorkflowRun(run: ScheduledWorkflowRun): ScheduledWorkflowRun {
    const scheduleTitle = this.scheduledWorkflowSchedules.get(run.scheduleId)?.title;
    return scheduleTitle === undefined
      ? cloneScheduledWorkflowRunValue({ run })
      : cloneScheduledWorkflowRunValue({ run, scheduleTitle });
  }

  private cloneWorkflowDraft(draft: WorkflowDraftState): WorkflowDraftState {
    return cloneWorkflowDraftValue({
      draft,
      normalizeConfiguredAgentId: (configuredAgentId) => this.normalizeWorkflowConfiguredAgentId(configuredAgentId),
      normalizeModelId: (configuredAgentId, modelId) => this.normalizeModelIdForConfiguredAgent(configuredAgentId, modelId),
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
    });
  }

  private normalizeWorkflowConfiguredAgentId(configuredAgentId: string | undefined): string {
    return this.configuredAgentById(configuredAgentId)?.id ?? "";
  }

  submitWorkflowReviewGate(input: { workflowId: string; runId: string; executionId: string; value: unknown }): { ok: boolean; accepted?: true; error?: string } {
    const context = this.workflowReviewGateSubmissions.get(input.executionId);
    if (!context || context.workflowId !== input.workflowId || context.runId !== input.runId) {
      return { ok: false, error: "Workflow Review Gate submission does not match an active bound review execution." };
    }
    try {
      const submission = parseWorkflowV2ReviewGateSubmission(input.value, context.reviewerInput);
      const response = finalizeWorkflowV2ReviewGateSubmission({
        reviewerNodeId: context.reviewerNodeId,
        input: context.reviewerInput,
        submission,
      });
      if (context.response) {
        return isDeepStrictEqual(context.response, response)
          ? { ok: true, accepted: true }
          : { ok: false, error: "Workflow Review Gate already received a different result for this execution." };
      }
      context.response = response;
      return { ok: true, accepted: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private defaultWorkflowManagerConfiguredAgentId(): string {
    const candidates = this.listConfiguredAgents()
      .map((agent) => this.resolveConfiguredAgent(agent.id, agent.modelId))
      .filter((resolved): resolved is ResolvedConfiguredAgent => Boolean(
        resolved
        && this.selectExecutionMode(resolved.runtimeAgentId, "chat", "interactive") === "interactive",
      ));
    return candidates.find((resolved) => resolved.runtime?.available)?.agent.id
      ?? candidates[0]?.agent.id
      ?? "";
  }

  private ensureWorkflowManagerRoute(workflow: WorkflowDraftState): WorkflowDraftState {
    if (this.configuredAgentById(workflow.configuredAgentId)) return workflow;
    const configuredAgentId = this.defaultWorkflowManagerConfiguredAgentId();
    if (!configuredAgentId) return workflow;
    const next = this.cloneWorkflowDraft({
      ...workflow,
      configuredAgentId,
      modelId: this.normalizeModelIdForConfiguredAgent(configuredAgentId, undefined),
      updatedAt: Date.now(),
    });
    this.workflowStore.workflows.set(workflow.workflowId, next);
    return next;
  }

  private channelById(channelId: string): AgentChannel | undefined {
    return this.channels.find((channel) => channel.id === channelId);
  }

  private normalizeRunSelections(): void {
    for (const chat of this.chats.values()) {
      chat.configuredAgentId = this.configuredAgentById(chat.configuredAgentId)?.id ?? "";
      if (chat.channelId && this.channelById(chat.channelId)?.agentId !== this.configuredAgentById(chat.configuredAgentId)?.runtimeAgentId) {
        chat.channelId = undefined;
      }
      chat.modelId = this.normalizeModelIdForConfiguredAgent(chat.configuredAgentId, chat.modelId, chat.channelId);
    }
    for (const task of this.tasks.values()) {
      task.configuredAgentId = this.configuredAgentById(task.configuredAgentId)?.id ?? "";
      task.modelId = this.normalizeModelIdForConfiguredAgent(task.configuredAgentId, task.modelId);
    }
    for (const team of this.teams.values()) {
      team.members = this.normalizeTeamMembers(team.members);
    }
    for (const workflow of this.workflowStore.workflows.values()) {
      this.workflowStore.workflows.set(workflow.workflowId, this.cloneWorkflowDraft(workflow));
    }
  }

  private runWorkDir(run: RunState): string {
    return run.kind === "task" ? run.workDir : this.workDir;
  }

  private composeTeamStepPrompt(run: TeamRunState, stepIndex: number): string {
    return composeTeamStepPromptValue(run, stepIndex);
  }

  private async startTeamRunStep(teamRunId: string, stepIndex: number): Promise<void> {
    const run = this.teamRuns.get(teamRunId);
    if (!run || run.status !== "running") return;
    const prepared = beginTeamRunStepValue({
      run,
      stepIndex,
      composePrompt: (currentRun, currentStepIndex) => this.composeTeamStepPrompt(currentRun, currentStepIndex),
      createTask: (request) => this.createTaskState(request),
    });
    if (!prepared) {
      return;
    }
    if ("completed" in prepared) {
      this.emit();
      return;
    }

    const dispatched = dispatchTaskPromptExecutionValue({
      task: prepared.task,
      registerTask: (task) => {
        this.tasks.set(task.id, task);
        this.activeTaskId = task.id;
      },
      resolveConfiguredAgent: (configuredAgentId, modelId) => this.resolveConfiguredAgent(configuredAgentId, modelId),
      createUserMessage: (content) => createUserMessage(content),
      createErrorMessage: (content) => createErrorMessage(content),
      onUnavailable: (error) => this.failTeamStepFromTask(prepared.task, error),
      emit: () => this.emit(),
      run: (task, preparedResolved) => {
        void this.runChat(task, task.prompt, preparedResolved);
      },
    });
    if (!dispatched) return;
  }

  private async startTeamRun(teamRunId: string): Promise<void> {
    const run = this.teamRuns.get(teamRunId);
    if (!run || run.status !== "running") return;
    if (run.mode === "parallel") {
      await Promise.all(run.steps.map((_step, index) => this.startTeamRunStep(run.id, index)));
      return;
    }
    await this.startTeamRunStep(run.id, 0);
  }

  private finishTeamStepFromTask(task: TaskState): void {
    if (!task.teamRunId || !task.teamStepId) return;
    const run = this.teamRuns.get(task.teamRunId);
    if (!run) return;
    const result = finishTeamStepFromTaskValue({ run, task });
    for (const nextStepIndex of result.startStepIndexes) {
      void this.startTeamRunStep(run.id, nextStepIndex);
    }
  }

  private failTeamStepFromTask(task: TaskState, error: string): void {
    if (!task.teamRunId || !task.teamStepId) return;
    const run = this.teamRuns.get(task.teamRunId);
    if (!run) return;
    failTeamStepFromTaskValue({ run, taskStepId: task.teamStepId, error });
  }

  private markRunExited(run: RunState): void {
    markRunExitedValue(run, (task) => this.finishTeamStepFromTask(task));
  }

  private markRunFailed(run: RunState, error: string): void {
    markRunFailedValue({
      run,
      error,
      takeStop: (runId) => this.activeStops.get(runId),
      finishTaskRun: (task) => this.finishTeamStepFromTask(task),
      emit: () => {
        this.activeStops.delete(run.id);
        if (run instanceof TaskState && (run.planningWorkflowId || run.workflowRunId)) this.emitWorkflow();
        else this.emit();
      },
    });
  }

  private async runChat(run: RunState, prompt: string, resolved: ResolvedConfiguredAgent): Promise<void> {
    const workflowOwned = run instanceof TaskState && Boolean(run.planningWorkflowId || run.workflowRunId);
    await runAgentExecutionValue({
      run,
      prompt,
      resolved,
      workDir: this.runWorkDir(run),
      chatDeveloperInstructions: CODEX_CHAT_DEVELOPER_INSTRUCTIONS,
      taskDeveloperInstructions: CODEX_TASK_DEVELOPER_INSTRUCTIONS,
      executorFactory: this.executorFactory,
      selectExecutionMode: (runtimeId, surface, preferred) => this.selectExecutionMode(runtimeId, surface, preferred),
      defaultContinuationPolicy: (runtimeId, surface, executionMode) =>
        this.defaultContinuationPolicy(runtimeId, surface, executionMode),
      cloneConversationForPolicy: (continuationPolicy, runtimeConversation) =>
        this.cloneConversationForPolicy(continuationPolicy, runtimeConversation),
      handleAgentEvent: (currentRun, event) => this.handleAgentEvent(currentRun, event),
      markRunExited: (currentRun) => this.markRunExited(currentRun),
      markRunFailed: (currentRun, error) => this.markRunFailed(currentRun, error),
      registerStop: (runId, stop) => {
        this.activeStops.set(runId, stop);
      },
      clearStop: (runId) => this.activeStops.delete(runId),
      emit: () => workflowOwned ? this.emitWorkflow() : this.emit(),
    });
  }

  private handleAgentEvent(run: RunState, event: AgentEvent): void {
    const workflowOwned = run instanceof TaskState && Boolean(run.planningWorkflowId || run.workflowRunId);
    handleAgentEventValue({
      run,
      event,
      cloneConversation: (runtimeConversation) => this.runtimeRouter.cloneConversation(runtimeConversation),
      takeStop: (runId) => {
        const stop = this.activeStops.get(runId);
        this.activeStops.delete(runId);
        return stop;
      },
      finishTaskRun: (task) => this.finishTeamStepFromTask(task),
      emit: () => {
        if (workflowOwned) {
          if (event.type === "delta") this.emitWorkflowStreaming("tasks", {
            tasks: {
              upsert: [serializeTask({ task: run, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) })],
              remove: [],
            },
          });
          else this.emitWorkflow();
          return;
        }
        if (event.type === "delta") this.emitStreaming();
        else this.emit();
      },
    });
  }

  private appendEventToAssistant(run: RunState, event: ChatEvent): void {
    appendEventToAssistantValue(run, event);
  }

  private expirePendingInteractionEvents(messages: ChatMessage[]): ChatMessage[] {
    return expirePendingInteractionEventsValue(messages);
  }

  private emit(): void {
    this.cancelStreamingEmit();
    this.publishSnapshot();
  }

  private emitWorkflow(scopes?: WorkflowProjectionScope | WorkflowProjectionScope[]): void {
    this.cancelStreamingEmit();
    this.publishWorkflowProjection(this.workflowScopeSet(scopes));
  }

  private emitStreaming(): void {
    this.scheduleStreamingEmit("snapshot");
  }

  private emitWorkflowStreaming(scopes?: WorkflowProjectionScope | WorkflowProjectionScope[], directPatch?: WorkflowAutomationPatch): void {
    this.scheduleStreamingEmit("workflow", scopes, directPatch);
  }

  private pendingWorkflowScopes = new Set<WorkflowProjectionScope>();
  private pendingWorkflowPatch: WorkflowAutomationPatch | undefined;

  private scheduleStreamingEmit(kind: "snapshot" | "workflow", scopes?: WorkflowProjectionScope | WorkflowProjectionScope[], directPatch?: WorkflowAutomationPatch): void {
    if (kind === "workflow") for (const scope of this.workflowScopeSet(scopes)) this.pendingWorkflowScopes.add(scope);
    if (kind === "workflow" && directPatch) this.pendingWorkflowPatch = this.mergeWorkflowPatches(this.pendingWorkflowPatch, directPatch);
    if (this.streamingEmitTimer) {
      if (this.streamingEmitKind === "snapshot" || this.streamingEmitKind === kind) return;
      clearTimeout(this.streamingEmitTimer);
    }
    this.streamingEmitKind = kind;
    this.streamingEmitTimer = setTimeout(() => {
      const pendingKind = this.streamingEmitKind;
      this.streamingEmitTimer = undefined;
      this.streamingEmitKind = undefined;
      if (pendingKind === "workflow") {
        const pendingScopes = new Set(this.pendingWorkflowScopes);
        const pendingPatch = this.pendingWorkflowPatch;
        this.pendingWorkflowScopes.clear();
        this.pendingWorkflowPatch = undefined;
        this.publishWorkflowProjection(pendingScopes, pendingPatch);
      }
      else this.publishSnapshot();
    }, 32);
  }

  private cancelStreamingEmit(): void {
    if (this.streamingEmitTimer) clearTimeout(this.streamingEmitTimer);
    this.streamingEmitTimer = undefined;
    this.streamingEmitKind = undefined;
    this.pendingWorkflowScopes.clear();
    this.pendingWorkflowPatch = undefined;
  }

  private publishSnapshot(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener({ kind: "snapshot", snapshot });
    this.schedulePersist();
  }

  private workflowScopeSet(scopes?: WorkflowProjectionScope | WorkflowProjectionScope[]): Set<WorkflowProjectionScope> {
    return new Set(scopes ? (Array.isArray(scopes) ? scopes : [scopes]) : ["store", "conversations", "tasks", "artifacts"]);
  }

  private publishWorkflowProjection(scopes: ReadonlySet<WorkflowProjectionScope>, directPatch?: WorkflowAutomationPatch): void {
    const projectionScopes = new Set(scopes);
    if (directPatch?.workflows) projectionScopes.delete("store");
    if (directPatch?.conversations) projectionScopes.delete("conversations");
    if (directPatch?.tasks) projectionScopes.delete("tasks");
    if (directPatch?.artifacts) projectionScopes.delete("artifacts");
    const payload = projectionScopes.size > 0 ? this.workflowProjection(projectionScopes) : {};
    const detectedAt = Date.now();
    for (const listener of this.listeners) listener({ kind: "workflow", detectedAt, payload, ...(directPatch ? { patch: directPatch } : {}) });
    this.schedulePersist();
  }

  private mergeWorkflowPatches(previous: WorkflowAutomationPatch | undefined, next: WorkflowAutomationPatch): WorkflowAutomationPatch {
    if (!previous) return next;
    const mergeEntities = <T>(left: { upsert: T[]; remove: string[] } | undefined, right: { upsert: T[]; remove: string[] } | undefined, idOf: (value: T) => string) => {
      if (!left && !right) return undefined;
      const upsert = new Map<string, T>();
      for (const value of [...(left?.upsert ?? []), ...(right?.upsert ?? [])]) upsert.set(idOf(value), value);
      const remove = new Set([...(left?.remove ?? []), ...(right?.remove ?? [])]);
      for (const id of upsert.keys()) remove.delete(id);
      return { upsert: [...upsert.values()], remove: [...remove] };
    };
    const workflows = mergeEntities(previous.workflows, next.workflows, (value) => value.workflowId);
    const runs = mergeEntities(previous.runs, next.runs, (value) => value.runId);
    const conversations = mergeEntities(previous.conversations, next.conversations, (value) => value.conversationId);
    const tasks = mergeEntities(previous.tasks, next.tasks, (value) => value.id);
    const artifacts = mergeEntities(previous.artifacts, next.artifacts, (value) => value.id);
    return {
      ...(workflows ? { workflows } : {}),
      ...(runs ? { runs } : {}),
      ...(conversations ? { conversations } : {}),
      ...(tasks ? { tasks } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(next.activeWorkflowId !== undefined ? { activeWorkflowId: next.activeWorkflowId } : previous.activeWorkflowId !== undefined ? { activeWorkflowId: previous.activeWorkflowId } : {}),
    };
  }

  private restorePersistedState(raw: unknown): boolean {
    if (!isPersistedAppStateV5(raw)) return false;
    const record = raw as PersistedAppStateV5 & Record<string, unknown>;
    if (Array.isArray(record.channels)) {
      this.channels = normalizeConfigChannelsForStorage(normalizeChannels(record.channels));
    }
    this.deletedManagedConfiguredAgentIds = new Set(
      Array.isArray(record.deletedConfiguredAgentIds)
        ? record.deletedConfiguredAgentIds
          .filter((id): id is string => typeof id === "string")
          .map((id) => this.migrateLegacyConfiguredAgentId(id) ?? id)
        : [],
    );

    this.installRestoredConfiguredAgents(Array.isArray(record.configuredAgents) ? record.configuredAgents : []);
    const restored = restorePersistedCollections(record, {
      restoreChatState: (payload) => this.restoreChatState(payload),
      restoreTaskState: (payload) => this.restoreTaskState(payload),
      restoreTeamState: (payload) => this.restoreTeamState(payload),
      restoreTeamRunState: (payload) => this.restoreTeamRunState(payload),
    });
    if (!restored) return false;

    this.installRestoredChats(restored.chats, asOptionalString(record.activeChatId), asOptionalString(record.workDir));
    this.installRestoredTasks(restored.tasks, asOptionalString(record.activeTaskId));
    this.installRestoredTeams(
      restored.teams,
      restored.teamRuns,
      asOptionalString(record.activeTeamId),
      asOptionalString(record.activeTeamRunId),
    );
    if (!this.restoreWorkflowStore(record.workflowStore)) return false;
    this.workflowNodeConversations.restore(record.workflowNodeConversations ?? []);
    this.restoreScheduledWorkflowStore(record.scheduledWorkflowStore);
    return true;
  }

  private installRestoredConfiguredAgents(rawAgents: unknown[]): void {
    this.pruneDeletedManagedConfiguredAgentIds();
    this.configuredAgents.clear();
    const now = Date.now();
    for (const rawAgent of rawAgents) {
      const agent = this.restoreConfiguredAgent(rawAgent, now);
      if (agent) this.configuredAgents.set(agent.id, agent);
    }
    for (const channel of this.channels) {
      const id = managedRuntimeAgentId(channel);
      if (this.deletedManagedConfiguredAgentIds.has(id)) continue;
      if (this.configuredAgents.has(id)) continue;
      this.configuredAgents.set(id, {
        id,
        name: channel.label,
        description: "",
        runtimeAgentId: channel.agentId,
        channelId: channel.id,
        modelId: defaultModelForAgent(channel.agentId),
        tags: [],
        managed: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private pruneDeletedManagedConfiguredAgentIds(): void {
    const managedIds = new Set(this.channels.map(managedRuntimeAgentId));
    for (const id of [...this.deletedManagedConfiguredAgentIds]) {
      if (!managedIds.has(id)) this.deletedManagedConfiguredAgentIds.delete(id);
    }
  }

  private syncDeletedManagedConfiguredAgentIds(agents: ConfiguredAgent[]): void {
    const providedIds = new Set(agents.map((agent) => agent.id));
    const managedIds = new Set(this.channels.map(managedRuntimeAgentId));
    for (const id of managedIds) {
      if (providedIds.has(id)) {
        this.deletedManagedConfiguredAgentIds.delete(id);
      } else {
        this.deletedManagedConfiguredAgentIds.add(id);
      }
    }
    this.pruneDeletedManagedConfiguredAgentIds();
  }

  private restoreConfiguredAgent(raw: unknown, now = Date.now()): ConfiguredAgent | undefined {
    const restored = restoreConfiguredAgentState(
      raw,
      {
        channels: this.channels,
        channelById: (channelId) => this.channelById(channelId),
      },
      now,
    );
    if (!restored) return undefined;
    const id = this.migrateLegacyConfiguredAgentId(restored.id) ?? restored.id;
    return id === restored.id
      ? restored
      : {
          ...restored,
          id,
          name: restored.name === "Default Agent"
            ? this.channelById(restored.channelId)?.label ?? restored.name
            : restored.name,
        };
  }

  private installRestoredChats(chats: ChatState[], activeChatId: string | undefined, workDir: string | undefined): void {
    const installed = installRestoredChatsValue({
      target: this.chats,
      chats,
      activeChatId,
      workDir,
      createDefaultChat: () => this.createChatState(""),
    });
    this.activeChatId = installed.activeChatId;
    if (installed.workDir) this.workDir = installed.workDir;
  }

  private installRestoredTasks(tasks: TaskState[], activeTaskId: string | undefined): void {
    this.activeTaskId = installRestoredTasksValue({
      target: this.tasks,
      tasks,
      activeTaskId,
    });
  }

  private installRestoredTeams(
    teams: AgentTeamState[],
    teamRuns: TeamRunState[],
    activeTeamId: string | undefined,
    activeTeamRunId: string | undefined,
  ): void {
    const installed = installRestoredTeamsValue({
      teamsTarget: this.teams,
      teams,
      activeTeamId,
      teamRunsTarget: this.teamRuns,
      teamRuns,
      activeTeamRunId,
    });
    this.activeTeamId = installed.activeTeamId;
    this.activeTeamRunId = installed.activeTeamRunId;
  }

  private runtimeSupportsInteractiveChat(runtimeAgentId: AgentId): boolean {
    return this.selectExecutionMode(runtimeAgentId, "chat", "interactive") === "interactive";
  }

  private restoreChatState(raw: unknown): ChatState | null {
    return restoreChatStateValue(raw, {
      configuredAgentById: (configuredAgentId) => this.configuredAgentById(configuredAgentId),
      normalizeModelIdForConfiguredAgent: (configuredAgentId, modelId, channelIdOverride) =>
        this.normalizeModelIdForConfiguredAgent(configuredAgentId, modelId, channelIdOverride),
      channelById: (channelId) => this.channelById(channelId),
      restoreRuntimeConversation: (payload) => this.runtimeRouter.restorePersistedConversation(payload),
      cloneRuntimeConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
      runtimeSupportsInteractiveChat: (runtimeAgentId) => this.runtimeSupportsInteractiveChat(runtimeAgentId),
      expirePendingInteractionEvents: (messages) => this.expirePendingInteractionEvents(messages),
    });
  }

  private restoreTaskState(raw: unknown): TaskState | null {
    return restoreTaskStateValue(raw, {
      workDir: this.workDir,
      configuredAgentById: (configuredAgentId) => this.configuredAgentById(configuredAgentId),
      normalizeModelIdForConfiguredAgent: (configuredAgentId, modelId, channelIdOverride) =>
        this.normalizeModelIdForConfiguredAgent(configuredAgentId, modelId, channelIdOverride),
      restoreRuntimeConversation: (payload) => this.runtimeRouter.restorePersistedConversation(payload),
      cloneRuntimeConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
    });
  }

  private restoreTeamState(raw: unknown): AgentTeamState | null {
    return restoreTeamStateValue(raw, {
      normalizeTeamMembers: (members) => this.normalizeTeamMembers(members),
    });
  }

  private restoreTeamRunState(raw: unknown): TeamRunState | null {
    return restoreTeamRunStateValue(raw, {
      workDir: this.workDir,
      normalizeTeamMembers: (members) => this.normalizeTeamMembers(members),
      teamMembersFromRunSteps: (steps) => this.teamMembersFromRunSteps(steps),
      restoreTeamRunStep: (step) => this.restoreTeamRunStep(step),
    });
  }

  private restoreTeamRunStep(raw: unknown): TeamRunStep | null {
    return restoreTeamRunStepValue(raw, {
      configuredAgentById: (configuredAgentId) => this.configuredAgentById(configuredAgentId),
    });
  }

  private restoreWorkflowStore(rawStore: unknown): boolean {
    const restored = restoreWorkflowStoreStateValue({
      rawStore,
      workflowsTarget: this.workflowStore.workflows,
      workflowRunsTarget: this.workflowStore.runs,
      restoreWorkflowDraft: (payload) => this.restoreWorkflowDraft(payload),
      restoreWorkflowRun: (payload) => this.restoreWorkflowRun(payload),
    });
    this.workflowStore.activeId = restored.activeWorkflowId;
    return restored.ok;
  }

  private restoreScheduledWorkflowStore(rawStore: unknown): void {
    const restored = restoreScheduledWorkflowStoreStateValue({
      rawStore,
      schedulesTarget: this.scheduledWorkflowSchedules,
      runsTarget: this.scheduledWorkflowRuns,
      restoreRunnerConfig: (payload) =>
        restoreScheduledWorkflowRunnerConfigValue(payload, (config) => this.cloneScheduledWorkflowRunnerConfig(config)),
      restoreSchedule: (payload) => this.restoreScheduledWorkflowSchedule(payload),
      restoreRun: (payload) => this.restoreScheduledWorkflowRun(payload),
    });
    this.scheduledWorkflowRunnerConfig = restored.runnerConfig;
    this.scheduledWorkflowRunnerStatus = restored.runnerStatus;
    this.activeScheduledWorkflowId = restored.activeScheduledWorkflowId;
  }

  private restoreScheduledWorkflowSchedule(raw: unknown): ScheduledWorkflowSchedule | undefined {
    return restoreScheduledWorkflowScheduleValue(raw, {
      hasWorkflow: (workflowId) => this.workflowStore.workflows.has(workflowId),
      workflowTitle: (workflowId) => this.workflowStore.workflows.get(workflowId)?.title,
      cloneScheduledWorkflowSchedule: (schedule) => this.cloneScheduledWorkflowSchedule(schedule),
    });
  }

  private restoreScheduledWorkflowRun(raw: unknown): ScheduledWorkflowRun | undefined {
    return restoreScheduledWorkflowRunValue(raw, {
      hasWorkflow: (workflowId) => this.workflowStore.workflows.has(workflowId),
      scheduledWorkflowTitle: (scheduleId) => this.scheduledWorkflowSchedules.get(scheduleId)?.title,
      cloneScheduledWorkflowRun: (run) => this.cloneScheduledWorkflowRun(run),
    });
  }

  private restoreWorkflowDraft(raw: unknown): WorkflowDraftState | undefined {
    return restoreWorkflowDraftValue(raw, {
      restoreRuntimeConversation: (payload) => this.runtimeRouter.restorePersistedConversation(payload),
      cloneWorkflowDraft: (draft) => this.cloneWorkflowDraft(draft),
    });
  }

  private createWorkflowOperationBroker(store: WorkflowV2StorePort): WorkflowV2OperationBroker {
    const broker = new WorkflowV2OperationBroker(store);
    broker.register(new WorkflowV2HttpOperationAdapter());
    if (this.workflowMessageProvider) broker.register(new WorkflowV2MessageOperationAdapter(this.workflowMessageProvider));
    return broker;
  }

  private restoreWorkflowRun(raw: unknown): WorkflowRunState | undefined {
    return restoreWorkflowRunValue(raw);
  }

  private async reconcileRestoredWorkflowV2Runs(): Promise<boolean> {
    if (!this.storagePath) return false;
    const store = new WorkflowV2FileStore(path.dirname(this.storagePath));
    let reconciled = false;
    try {
      const cleanedRuns = await store.cleanupExpiredRuns();
      for (const cleaned of cleanedRuns) {
        const run = this.workflowStore.runs.get(cleaned.runId);
        if (!run || run.workflowId !== cleaned.workflowId) continue;
        const cleanedRun = this.cloneWorkflowRun(run);
        delete cleanedRun.operations;
        delete cleanedRun.recovery;
        this.workflowStore.runs.set(cleaned.runId, cleanedRun);
        reconciled = true;
      }
    } catch (error) {
      console.warn("Failed to clean up expired Workflow V2 transaction materials:", error);
    }

    for (const [runId, run] of this.workflowStore.runs) {
      if (!run.workflowV2Plan) continue;
      const workflow = this.workflowStore.workflows.get(run.workflowId);
      if (!workflow) continue;

      let persisted: Awaited<ReturnType<WorkflowV2FileStore["readRunState"]>>;
      try {
        persisted = await store.readRunState(run.workflowId, runId);
      } catch (error) {
        console.warn(`Failed to reconcile Workflow V2 run ${runId} from durable state:`, error);
        continue;
      }
      if (!persisted) continue;

      let operationLedgerAvailable = true;
      let rawOperations: ReturnType<typeof sanitizeWorkflowOperationRecord>[];
      try {
        rawOperations = await store.readOperations(run.workflowId, runId);
      } catch {
        operationLedgerAvailable = false;
        rawOperations = [];
      }
      const broker = this.createWorkflowOperationBroker(store);
      for (const operation of operationLedgerAvailable ? rawOperations.filter((item) => item.state === "applying" || item.state === "unknown" || item.state === "compensating") : []) {
        if (!broker.canInspectOperation(operation)) continue;
        await broker.inspect({ workflowId: run.workflowId, runId, operationId: operation.operationId, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
      persisted = await store.readRunState(run.workflowId, runId) ?? persisted;
      if (operationLedgerAvailable) {
        try {
          rawOperations = await store.readOperations(run.workflowId, runId);
        } catch {
          operationLedgerAvailable = false;
        }
      }
      const operations = rawOperations.map(sanitizeWorkflowOperationRecord);
      const workspaceInspection = await inspectWorkflowV2RecoveryWorkspace({
        store,
        workflowId: run.workflowId,
        runId,
        fallbackConflictPaths: persisted.recovery?.conflicts ?? run.recovery?.conflicts ?? [],
      });
      const recoveryWorkspaceDiff = workspaceInspection.workspaceDiff
        ? { ...workspaceInspection.workspaceDiff, conflicts: workspaceInspection.conflictPaths }
        : workspaceInspection.conflictPaths.length ? { created: [], modified: [], deleted: [], conflicts: workspaceInspection.conflictPaths } : undefined;
      const compensableOperationIds = rawOperations.filter((operation) => broker.canCompensateOperation(operation)).map((operation) => operation.operationId);
      const canRollbackSavepoint = persisted.transaction
        ? await canRollbackWorkflowV2CurrentSavepoint({ store, workflowId: run.workflowId, runId, transaction: persisted.transaction })
        : false;
      const rebuiltRecovery = persisted.transaction && (persisted.transaction.status === "recovery_required" || persisted.transaction.status === "partially_rolled_back" || persisted.transaction.status === "waiting_for_user")
        ? buildWorkflowV2RecoveryPreview({
            transaction: persisted.transaction,
            operations,
            runState: persisted.runState,
            nodeControl: persisted.nodeControl,
            ...(recoveryWorkspaceDiff ? { workspaceDiff: recoveryWorkspaceDiff } : {}),
            workspaceAvailable: workspaceInspection.workspaceAvailable,
            operationLedgerAvailable,
            conflictDetails: workspaceInspection.conflictDetails,
            canRollbackSavepoint,
            canRollbackWorkspace: true,
            canCompensate: compensableOperationIds.length > 0,
            compensableOperationIds,
            now: persisted.savedAt,
          })
        : undefined;
      const recoveryFacts = (preview: NonNullable<typeof rebuiltRecovery>) => {
        const { generatedAt: _generatedAt, managerRecommendation: _managerRecommendation, ...facts } = preview;
        return facts;
      };
      const recovery = rebuiltRecovery && persisted.recovery && isDeepStrictEqual(recoveryFacts(rebuiltRecovery), recoveryFacts(persisted.recovery))
        ? { ...rebuiltRecovery, generatedAt: persisted.recovery.generatedAt, managerRecommendation: structuredClone(persisted.recovery.managerRecommendation) }
        : rebuiltRecovery;
      const latestRunId = workflow.runIds[workflow.runIds.length - 1];
      const result = reconcileWorkflowV2RunFromDurableState({
        workflow,
        run,
        persisted,
        updateWorkflowProjection: latestRunId === runId,
        operations,
        ...(recovery ? { recovery } : {}),
      });
      if (!result) {
        console.warn(`Skipped Workflow V2 durable state with mismatched identity for run ${runId}.`);
        continue;
      }
      this.workflowStore.runs.set(runId, result.run);
      if (latestRunId === runId) this.workflowStore.workflows.set(workflow.workflowId, result.workflow);
      reconciled = true;
    }

    return reconciled;
  }

  private schedulePersist(): void {
    if ((!this.storagePath && !this.persistedStore) || this.persistenceWriteBlocked) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistState();
    }, PERSIST_DEBOUNCE_MS);
  }

  private buildPersistedPayload(): PersistedAppStateV5 {
    return buildPersistedPayload({
      activeChatId: this.activeChatId,
      activeTaskId: this.activeTaskId,
      activeTeamId: this.activeTeamId,
      activeTeamRunId: this.activeTeamRunId,
      workDir: this.workDir,
      channels: this.channels,
      chats: this.chats.values(),
      tasks: this.tasks.values(),
      teams: this.teams.values(),
      teamRuns: this.teamRuns.values(),
      configuredAgents: this.listConfiguredAgents(),
      deletedConfiguredAgentIds: [...this.deletedManagedConfiguredAgentIds],
      artifacts: this.artifacts,
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
      workflowStore: this.cloneWorkflowStore(),
      scheduledWorkflowStore: this.cloneScheduledWorkflowStore(),
      workflowNodeConversations: this.workflowNodeConversations.list(),
    });
  }

  private async persistState(throwOnError = false): Promise<void> {
    if ((!this.storagePath && !this.persistedStore) || this.persistenceWriteBlocked) return;
    const previousPersist = this.persistInFlight?.catch(() => undefined);
    const persist = (async () => {
      await previousPersist;
      const payload = this.buildPersistedPayload();
      await writePersistedPayload({
        storagePath: this.storagePath,
        persistedStore: this.persistedStore,
        payload,
      });
    })();
    this.persistInFlight = persist;

    try {
      await persist;
    } catch (error) {
      if (this.persistedStore?.isShutdownError?.(error)) return;
      console.warn(
        this.persistedStore
          ? `Failed to persist app state to ${this.persistedStore.label}:`
          : `Failed to persist chat history to ${this.storagePath}:`,
        error,
      );
      if (throwOnError) throw error;
    } finally {
      if (this.persistInFlight === persist) this.persistInFlight = undefined;
    }
  }
}

export function getDefaultWorkDir(): string {
  return process.cwd();
}

function isLockedWorkflowConfigurationUpdate(
  input: UpdateWorkflowRequest,
  currentDefinition: WorkflowV2Definition,
  nextDefinition: WorkflowV2Definition,
): boolean {
  const allowedRequestKeys = new Set(["workflowId", "expectedRevision", "definition"]);
  if (!input.definition || Object.entries(input).some(([key, value]) => value !== undefined && !allowedRequestKeys.has(key))) return false;
  if (nextDefinition.reviewEnabled !== currentDefinition.reviewEnabled) return false;
  let configurationChanged = false;
  const currentTopology = structuredClone(currentDefinition);
  const nextTopology = structuredClone(nextDefinition);
  delete currentTopology.reviewEnabled;
  delete nextTopology.reviewEnabled;
  for (let index = 0; index < currentTopology.nodes.length; index += 1) {
    const currentNode = currentTopology.nodes[index];
    const nextNode = nextTopology.nodes[index];
    if (!currentNode || !nextNode || currentNode.id !== nextNode.id) return false;
    if (currentNode.execModel === "llm" && nextNode.execModel === "llm") {
      if (currentNode.configuredAgentId !== nextNode.configuredAgentId || currentNode.modelId !== nextNode.modelId) configurationChanged = true;
      delete currentNode.configuredAgentId;
      delete currentNode.modelId;
      delete nextNode.configuredAgentId;
      delete nextNode.modelId;
    }
  }
  return configurationChanged && isDeepStrictEqual(currentTopology, nextTopology);
}

function preserveOfficialWorkflowNodeRoutes(
  bundledDefinition: WorkflowV2Definition,
  existingDefinition: WorkflowV2Definition,
): WorkflowV2Definition {
  const existingNodes = new Map(existingDefinition.nodes.map((node) => [node.id, node]));
  return {
    ...bundledDefinition,
    nodes: bundledDefinition.nodes.map((node) => {
      const existingNode = existingNodes.get(node.id);
      if (node.execModel !== "llm" || existingNode?.execModel !== "llm") return node;
      return {
        ...node,
        ...(existingNode.configuredAgentId ? { configuredAgentId: existingNode.configuredAgentId } : {}),
        ...(existingNode.modelId ? { modelId: existingNode.modelId } : {}),
      };
    }),
  };
}
