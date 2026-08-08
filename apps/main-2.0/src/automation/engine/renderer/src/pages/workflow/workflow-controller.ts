import type {
  AgentChannel,
  AgentRuntime,
  ApprovalDecision,
  ConfiguredAgent,
  LocalFilePreview,
  RegisteredArtifact,
  TaskRun,
  WorkflowDraftState,
  WorkflowV2Definition,
  WorkflowV2Node,
  WorkflowGrillMessage,
  WorkflowRunProgressItem,
  WorkflowRunState,
  WorkflowStatus,
  WorkflowV2Plan,
} from "../../../../shared/types";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";
import type { WorkflowV2InterventionAction } from "../../../../shared/workflow-v2/review";
import type { WorkflowRecoveryAction } from "../../../../shared/workflow-v2/transaction";
import type { Language } from "../../app/language";

type MaybePromise = void | Promise<void>;

export interface WorkflowSidebarContextMenu {
  workflowId: string;
  x: number;
  y: number;
}

export interface WorkflowSidebarRenameDraft {
  workflowId: string;
  title: string;
}

export interface WorkflowSidebarController {
  workflows: WorkflowDraftState[];
  activeWorkflowId?: string;
  running: boolean;
  contextMenu?: WorkflowSidebarContextMenu;
  renameDraft?: WorkflowSidebarRenameDraft;
  onNewWorkflow: () => MaybePromise;
  onSelectWorkflow: (workflowId: string) => MaybePromise;
  onOpenContextMenu: (workflowId: string, x: number, y: number) => void;
  onStartRename: (workflowId: string) => MaybePromise;
  onRenameDraftChange: (title: string) => void;
  onConfirmRename: () => MaybePromise;
  onCancelRename: () => void;
  onDeleteWorkflow: (workflowId: string) => MaybePromise;
}

export interface WorkflowController {
  workflowId?: string;
  sourceType?: "official" | "user";
  topologyLocked?: boolean;
  title?: string;
  status?: WorkflowStatus;
  revision?: number;
  confirmedRevision?: number;
  definition: WorkflowV2Definition;
  definitionReady: boolean;
  objective: string;
  messages: WorkflowGrillMessage[];
  reply: string;
  error: string | undefined;
  configuredAgentId: string;
  modelId?: string;
  reviewerConfiguredAgentId: string;
  reviewerModelId?: string;
  generationReview?: WorkflowDraftState["generationReview"];
  reviewFeatureEnabled?: boolean;
  runtimeReviewFeatureEnabled?: boolean;
  runtimes: AgentRuntime[];
  channels: AgentChannel[];
  configuredAgents?: ConfiguredAgent[];
  workDir: string;
  running: boolean;
  runProgress?: WorkflowRunProgressItem[];
  activeRunId?: string | undefined;
  activeRunStatus?: WorkflowStatus;
  artifacts?: RegisteredArtifact[];
  runHistoryArtifacts?: RegisteredArtifact[];
  contextDocument?: string;
  finalReport?: string;
  nodeConversations?: WorkflowNodeConversation[];
  runHistoryConversations?: WorkflowNodeConversation[];
  nodeTasks?: TaskRun[];
  workflowV2Plan?: WorkflowV2Plan;
  runs?: WorkflowRunState[];
  onObjectiveChange: (value: string) => void;
  onPauseNode?: (nodeId: string) => MaybePromise;
  onStopRun?: () => MaybePromise;
  onStartNode?: (nodeId: string) => MaybePromise;
  onReviseRun?: (nodeId: string, definition: WorkflowV2Definition, reason: string) => MaybePromise;
  onSubmitScriptInput?: (nodeId: string, values: Record<string, unknown>) => MaybePromise;
  onResolveIntervention?: (nodeId: string, action: WorkflowV2InterventionAction, reason?: string) => MaybePromise;
  onResolveRecovery?: (runId: string, action: WorkflowRecoveryAction, reason: string) => MaybePromise;
  onRefreshRecovery?: (runId: string) => MaybePromise;
  onResolveConflict?: (runId: string, input: { path: string; resolution: "isolated" | "current" | "manual"; expectedCurrentSha256?: string; content?: string; reason: string }) => MaybePromise;
  onResolveUnknownOperation?: (runId: string, input: { operationId: string; verifiedState: "applied" | "not_applied"; reason: string }) => MaybePromise;
  onCleanupRunMaterials?: (runId: string) => MaybePromise;
  onSendNodeMessage?: (conversationId: string, message: string) => MaybePromise;
  onCompleteNodeConversation?: (conversationId: string) => MaybePromise;
  onRejectNodeCompletion?: (conversationId: string, instruction: string) => MaybePromise;
  onInterruptNodeConversation?: (conversationId: string) => MaybePromise;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => MaybePromise;
  onSelectConfiguredAgent: (configuredAgentId: string) => void;
  onSelectReviewerConfiguredAgent: (configuredAgentId: string) => void;
  onReviewWorkflow?: () => MaybePromise;
  onApplyReviewToManager?: () => MaybePromise;
  onInterruptWorkflowReview?: () => MaybePromise;
  onBuildDefinition: (objective?: string) => void;
  onReplyChange?: (value: string) => void;
  onSendReply: (value?: string) => void;
  onUpdateNode: (nodeId: string, update: Partial<WorkflowV2Node>) => MaybePromise;
  onUpdateDefinition?: (definition: WorkflowV2Definition) => MaybePromise;
  onRunWorkflow: (transactionApprovalMode?: "batch" | "per_operation") => MaybePromise;
  onConfirmWorkflow?: () => MaybePromise;
  onResetSession: () => MaybePromise;
  onStopGrill?: () => void;
  onChooseWorkDir?: () => MaybePromise;
  onRefresh?: () => MaybePromise;
  onReadOutputFile?: (filePath: string) => Promise<LocalFilePreview>;
  onListOutputs?: () => Promise<Array<{ name: string; path: string }>>;
  language?: Language;
  defaultGraphExpanded?: boolean;
}
