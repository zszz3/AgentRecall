import type {
  RegisteredArtifact,
  TaskRun,
  WorkflowDraftState,
  WorkflowNodeConversation,
  WorkflowStoreState,
} from "../../automation/contracts";

export const AUTOMATION_CHANNELS = {
  health: "automation:health",
  snapshot: "automation:snapshot",
  snapshotChanged: "automation:snapshot-changed",
  change: "automation:change",
  runtimeSaveChannels: "automation:runtime:save-channels",
  runtimeSaveAgents: "automation:runtime:save-agents",
  runtimeTestChannel: "automation:runtime:test-channel",
  runtimeTestAgent: "automation:runtime:test-agent",
  runtimeTestEvent: "automation:runtime:test-event",
  runtimeBalance: "automation:runtime:balance",
  runtimeLoadCodexDefault: "automation:runtime:load-codex-default",
  runtimeLoadClaudeDefault: "automation:runtime:load-claude-default",
  runtimeImportLocal: "automation:runtime:import-local",
  runtimeRefreshModels: "automation:runtime:refresh-models",
  runtimeListCodexPlugins: "automation:runtime:list-codex-plugins",
  workDirSet: "automation:workdir:set",
  workDirChoose: "automation:workdir:choose",
  directoryPick: "automation:directory:pick",
  mcpList: "automation:mcp:list",
  mcpSave: "automation:mcp:save",
  mcpTest: "automation:mcp:test",
  mcpDelete: "automation:mcp:delete",
  mcpSetupStatus: "automation:mcp:setup-status",
  mcpInstalledList: "automation:mcp:installed-list",
  mcpAgentList: "automation:mcp:agent-list",
  mcpAgentInstall: "automation:mcp:agent-install",
  mcpAgentUninstall: "automation:mcp:agent-uninstall",
  evaluationDatasetList: "automation:evaluation:datasets:list",
  evaluationDatasetSave: "automation:evaluation:datasets:save",
  evaluationDatasetDelete: "automation:evaluation:datasets:delete",
  evaluationEvaluatorList: "automation:evaluation:evaluators:list",
  evaluationEvaluatorSave: "automation:evaluation:evaluators:save",
  evaluationEvaluatorDelete: "automation:evaluation:evaluators:delete",
  evaluationExperimentList: "automation:evaluation:experiments:list",
  evaluationExperimentSave: "automation:evaluation:experiments:save",
  evaluationExperimentDelete: "automation:evaluation:experiments:delete",
  evaluationExperimentRun: "automation:evaluation:experiments:run",
  evaluationRunList: "automation:evaluation:runs:list",
  evaluationRunGet: "automation:evaluation:runs:get",
  evaluationRunDelete: "automation:evaluation:runs:delete",
  workflowDraftCreate: "automation:workflow:draft-create",
  workflowDraftPatch: "automation:workflow:draft-patch",
  workflowUpdate: "automation:workflow:update",
  workflowDraftReset: "automation:workflow:draft-reset",
  workflowDraftSend: "automation:workflow:draft-send",
  workflowDraftAbandon: "automation:workflow:draft-abandon",
  workflowSelect: "automation:workflow:select",
  workflowRename: "automation:workflow:rename",
  workflowDelete: "automation:workflow:delete",
  workflowCloneOfficial: "automation:workflow:clone-official",
  workflowImportBegin: "automation:workflow:import-begin",
  workflowImportConfirm: "automation:workflow:import-confirm",
  workflowImportCancel: "automation:workflow:import-cancel",
  workflowExport: "automation:workflow:export",
  workflowConfirm: "automation:workflow:confirm",
  workflowReview: "automation:workflow:review",
  workflowReviewInterrupt: "automation:workflow:review-interrupt",
  workflowRun: "automation:workflow:run",
  workflowPauseNode: "automation:workflow:pause-node",
  workflowReviseRun: "automation:workflow:revise-run",
  workflowStopRun: "automation:workflow:stop-run",
  workflowResolveIntervention: "automation:workflow:resolve-intervention",
  workflowResolveRecovery: "automation:workflow:resolve-recovery",
  workflowRefreshRecovery: "automation:workflow:refresh-recovery",
  workflowResolveConflict: "automation:workflow:resolve-conflict",
  workflowResolveUnknownOperation: "automation:workflow:resolve-unknown-operation",
  workflowCleanupRunMaterials: "automation:workflow:cleanup-run-materials",
  workflowSendNodeMessage: "automation:workflow:send-node-message",
  workflowCompleteNodeConversation: "automation:workflow:complete-node-conversation",
  workflowRejectNodeCompletion: "automation:workflow:reject-node-completion",
  workflowInterruptNodeConversation: "automation:workflow:interrupt-node-conversation",
  workflowStartNode: "automation:workflow:start-node",
  workflowSubmitScriptInput: "automation:workflow:submit-script-input",
  workflowOutputsList: "automation:workflow:outputs-list",
  workflowOutputRead: "automation:workflow:output-read",
  workflowOutputReveal: "automation:workflow:output-reveal",
  approvalResolve: "automation:approval:resolve",
} as const;

export const AUTOMATION_CHANGE_PROTOCOL_VERSION = 1 as const;

export interface WorkflowAutomationProjection {
  workflowStore: WorkflowStoreState;
  workflowNodeConversations: WorkflowNodeConversation[];
  workflowDraft: WorkflowDraftState | undefined;
  tasks: TaskRun[];
  artifacts: RegisteredArtifact[];
}

export interface AutomationEntityPatch<T> {
  upsert: T[];
  remove: string[];
}

export interface WorkflowAutomationPatch {
  activeWorkflowId?: string | null;
  readinessByWorkflowId?: WorkflowStoreState["readinessByWorkflowId"];
  workflows?: AutomationEntityPatch<WorkflowDraftState>;
  runs?: AutomationEntityPatch<WorkflowStoreState["runs"][number]>;
  conversations?: AutomationEntityPatch<WorkflowNodeConversation>;
  tasks?: AutomationEntityPatch<TaskRun>;
  artifacts?: AutomationEntityPatch<RegisteredArtifact>;
}

export interface AutomationChange {
  protocolVersion: typeof AUTOMATION_CHANGE_PROTOCOL_VERSION;
  sequence: number;
  detectedAt: number;
  domain: "workflow";
  entityId: "workflow-state";
  operation: "patch";
  payload: WorkflowAutomationPatch;
}

export interface AutomationHealth {
  state: "idle" | "initializing" | "ready" | "error" | "stopped";
  error?: string;
}
