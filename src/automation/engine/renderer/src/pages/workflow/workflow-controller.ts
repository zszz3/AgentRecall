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
  WorkflowStatus,
  WorkflowV2Plan,
} from "../../../../shared/types";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";
import type { WorkflowV2InterventionAction } from "../../../../shared/workflow-v2/review";
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
  runtimes: AgentRuntime[];
  channels: AgentChannel[];
  configuredAgents?: ConfiguredAgent[];
  workDir: string;
  running: boolean;
  runProgress?: WorkflowRunProgressItem[];
  activeRunId?: string | undefined;
  activeRunStatus?: WorkflowStatus;
  artifacts?: RegisteredArtifact[];
  contextDocument?: string;
  finalReport?: string;
  nodeConversations?: WorkflowNodeConversation[];
  nodeTasks?: TaskRun[];
  workflowV2Plan?: WorkflowV2Plan;
  onObjectiveChange: (value: string) => void;
  onPauseNode?: (nodeId: string) => MaybePromise;
  onStopRun?: () => MaybePromise;
  onStartNode?: (nodeId: string) => MaybePromise;
  onReviseRun?: (nodeId: string, definition: WorkflowV2Definition, reason: string) => MaybePromise;
  onSubmitScriptInput?: (nodeId: string, values: Record<string, unknown>) => MaybePromise;
  onResolveIntervention?: (nodeId: string, action: WorkflowV2InterventionAction, reason?: string) => MaybePromise;
  onSendNodeMessage?: (conversationId: string, message: string) => MaybePromise;
  onCompleteNodeConversation?: (conversationId: string) => MaybePromise;
  onRejectNodeCompletion?: (conversationId: string, instruction: string) => MaybePromise;
  onInterruptNodeConversation?: (conversationId: string) => MaybePromise;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => MaybePromise;
  onSelectConfiguredAgent: (configuredAgentId: string) => void;
  onSelectModel?: (modelId: string) => void;
  onSelectReviewerConfiguredAgent: (configuredAgentId: string) => void;
  onSelectReviewerModel?: (modelId: string) => void;
  onReviewWorkflow?: () => MaybePromise;
  onInterruptWorkflowReview?: () => MaybePromise;
  onBuildDefinition: () => void;
  onReplyChange: (value: string) => void;
  onSendReply: () => void;
  onUpdateNode: (nodeId: string, update: Partial<WorkflowV2Node>) => MaybePromise;
  onUpdateDefinition?: (definition: WorkflowV2Definition) => MaybePromise;
  onRunWorkflow: () => MaybePromise;
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
