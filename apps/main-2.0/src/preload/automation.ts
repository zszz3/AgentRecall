import type { IpcRenderer } from "electron";
import type {
  AgentChannel,
  ApplyWorkflowReviewToManagerRequest,
  AgentTestEvent,
  AgentTestResult,
  AppSnapshot,
  ClaudeDefaultConfig,
  CodexDefaultConfig,
  CodexPluginCatalogItem,
  CompleteWorkflowNodeConversationRequest,
  ConfiguredAgent,
  ConfirmWorkflowRequest,
  CreateWorkflowDraftRequest,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  ListEvaluationRunsRequest,
  InterruptWorkflowNodeConversationRequest,
  InterruptWorkflowReviewRequest,
  ListWorkflowOutputsRequest,
  LocalFilePreview,
  ModelCatalogRefreshResult,
  PatchWorkflowDraftRequest,
  PauseWorkflowNodeRequest,
  ProviderBalanceResult,
  RejectWorkflowNodeCompletionRequest,
  ResolveWorkflowV2InterventionRequest,
  ResolveWorkflowV2RecoveryRequest,
  RefreshWorkflowV2RecoveryRequest,
  ResolveWorkflowV2ConflictRequest,
  ResolveWorkflowV2UnknownOperationRequest,
  CleanupWorkflowV2RunRequest,
  ReviewWorkflowRequest,
  ReviseWorkflowV2RunRequest,
  RunWorkflowRequest,
  RuntimeLocalConfigImportResult,
  ResolveRuntimeApprovalRequest,
  SendWorkflowDraftReplyRequest,
  SendWorkflowNodeMessageRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  UpdateWorkflowRequest,
  WorkflowOperationResult,
  WorkflowImportPreview,
  ConfirmWorkflowImportRequest,
  WorkflowExportResult,
  WorkflowCoreSnapshot,
  WorkflowPlanningRequest,
  WorkflowPlanningState,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStreamEvent,
  McpExternalClientConnections,
  McpExternalClientUpdate,
  McpServerDefinition,
} from "../automation/contracts";
import {
  AUTOMATION_CHANNELS,
  type AutomationChange,
  type AutomationHealth,
  type WorkflowSidebarSnapshot,
  type WorkflowWorkbenchSnapshot,
} from "../shared/ipc/automation";

export type AutomationIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createAutomationApi(ipc: AutomationIpcRenderer) {
  return {
    getHealth: (): Promise<AutomationHealth> => ipc.invoke(AUTOMATION_CHANNELS.health),
    getWorkflowSidebar: (): Promise<WorkflowSidebarSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowSidebar),
    getWorkflowWorkbench: (): Promise<WorkflowWorkbenchSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowWorkbench),
    getSnapshot: (): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.snapshot),
    saveModelChannels: (channels: AgentChannel[]): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, channels),
    saveConfiguredAgents: (agents: ConfiguredAgent[]): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.runtimeSaveAgents, agents),
    deleteConfiguredAgent: (agentId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.runtimeDeleteAgent, agentId),
    testRuntimeChannel: (channelId: string): Promise<AgentTestResult> => ipc.invoke(AUTOMATION_CHANNELS.runtimeTestChannel, channelId),
    testConfiguredAgent: (agentId: string): Promise<AgentTestResult> => ipc.invoke(AUTOMATION_CHANNELS.runtimeTestAgent, agentId),
    queryRuntimeChannelBalance: (channelId: string): Promise<ProviderBalanceResult> => ipc.invoke(AUTOMATION_CHANNELS.runtimeBalance, channelId),
    loadCodexDefaultConfig: (): Promise<CodexDefaultConfig> => ipc.invoke(AUTOMATION_CHANNELS.runtimeLoadCodexDefault),
    loadClaudeDefaultConfig: (): Promise<ClaudeDefaultConfig> => ipc.invoke(AUTOMATION_CHANNELS.runtimeLoadClaudeDefault),
    importRuntimeLocalConfig: (runtimeId: AgentChannel["agentId"], channelId?: string): Promise<RuntimeLocalConfigImportResult> =>
      ipc.invoke(AUTOMATION_CHANNELS.runtimeImportLocal, { runtimeId, ...(channelId ? { channelId } : {}) }),
    refreshModelCatalog: (channelId: string): Promise<ModelCatalogRefreshResult> => ipc.invoke(AUTOMATION_CHANNELS.runtimeRefreshModels, channelId),
    listCodexPlugins: (): Promise<CodexPluginCatalogItem[]> => ipc.invoke(AUTOMATION_CHANNELS.runtimeListCodexPlugins),
    setWorkDir: (workDir: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workDirSet, workDir),
    chooseWorkDir: (): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workDirChoose),
    pickDirectory: (defaultPath?: string): Promise<string | undefined> => ipc.invoke(AUTOMATION_CHANNELS.directoryPick, defaultPath),

    listMcpServers: (): Promise<McpServerDefinition[]> => ipc.invoke(AUTOMATION_CHANNELS.mcpList),
    saveMcpServer: (server: McpServerDefinition): Promise<McpServerDefinition> => ipc.invoke(AUTOMATION_CHANNELS.mcpSave, server),
    testMcpServer: (server: McpServerDefinition): Promise<McpServerDefinition> => ipc.invoke(AUTOMATION_CHANNELS.mcpTest, server),
    deleteMcpServer: (serverId: string): Promise<boolean> => ipc.invoke(AUTOMATION_CHANNELS.mcpDelete, serverId),
    getMcpClientConnections: (): Promise<McpExternalClientConnections> => ipc.invoke(AUTOMATION_CHANNELS.mcpClientConnections),
    setMcpClientConnection: (request: McpExternalClientUpdate): Promise<McpExternalClientConnections> => ipc.invoke(AUTOMATION_CHANNELS.mcpClientSet, request),

    listEvaluationDatasets: (): Promise<EvaluationDataset[]> => ipc.invoke(AUTOMATION_CHANNELS.evaluationDatasetList),
    saveEvaluationDataset: (dataset: EvaluationDataset): Promise<EvaluationDataset> => ipc.invoke(AUTOMATION_CHANNELS.evaluationDatasetSave, dataset),
    deleteEvaluationDataset: (datasetId: string): Promise<boolean> => ipc.invoke(AUTOMATION_CHANNELS.evaluationDatasetDelete, datasetId),
    // The directory is chosen in a native dialog in the main process, so the
    // renderer never names a filesystem path.
    importEvaluationDatasetFolder: (): Promise<
      { dataset: EvaluationDataset; directory: string; errors: string[] } | null
    > => ipc.invoke(AUTOMATION_CHANNELS.evaluationDatasetFolderImport),
    exportEvaluationDatasetFolder: (
      datasetId: string,
    ): Promise<{ directory: string; caseCount: number } | null> =>
      ipc.invoke(AUTOMATION_CHANNELS.evaluationDatasetFolderExport, datasetId),
    listEvaluationEvaluators: (): Promise<EvaluationEvaluator[]> => ipc.invoke(AUTOMATION_CHANNELS.evaluationEvaluatorList),
    saveEvaluationEvaluator: (evaluator: EvaluationEvaluator): Promise<EvaluationEvaluator> => ipc.invoke(AUTOMATION_CHANNELS.evaluationEvaluatorSave, evaluator),
    deleteEvaluationEvaluator: (evaluatorId: string): Promise<boolean> => ipc.invoke(AUTOMATION_CHANNELS.evaluationEvaluatorDelete, evaluatorId),
    listEvaluationExperiments: (): Promise<EvaluationExperiment[]> => ipc.invoke(AUTOMATION_CHANNELS.evaluationExperimentList),
    saveEvaluationExperiment: (experiment: EvaluationExperiment): Promise<EvaluationExperiment> => ipc.invoke(AUTOMATION_CHANNELS.evaluationExperimentSave, experiment),
    deleteEvaluationExperiment: (experimentId: string): Promise<boolean> => ipc.invoke(AUTOMATION_CHANNELS.evaluationExperimentDelete, experimentId),
    listEvaluationRuns: (request?: ListEvaluationRunsRequest): Promise<EvaluationRunPage> => ipc.invoke(AUTOMATION_CHANNELS.evaluationRunList, request),
    getEvaluationRun: (runId: string): Promise<EvaluationRun | undefined> => ipc.invoke(AUTOMATION_CHANNELS.evaluationRunGet, runId),
    deleteEvaluationRun: (runId: string): Promise<boolean> => ipc.invoke(AUTOMATION_CHANNELS.evaluationRunDelete, runId),
    openEvaluationArtifactFile: (runId: string, resultId: string): Promise<string> =>
      ipc.invoke(AUTOMATION_CHANNELS.evaluationArtifactOpen, { runId, resultId }),
    runEvaluationExperiment: (experimentId: string): Promise<EvaluationRun> => ipc.invoke(AUTOMATION_CHANNELS.evaluationExperimentRun, { experimentId }),

    replyWorkflowPlanning: (request: WorkflowPlanningRequest): Promise<WorkflowPlanningState> => ipc.invoke(AUTOMATION_CHANNELS.workflowPlanningReply, request),
    cancelWorkflowPlanning: (requestId: string): Promise<void> => ipc.invoke(AUTOMATION_CHANNELS.workflowPlanningCancel, requestId),
    getWorkflowCore: (workflowId?: string): Promise<WorkflowCoreSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowCoreGet, workflowId),
    saveWorkflowDefinition: (definition: WorkflowDefinition): Promise<WorkflowDefinition> => ipc.invoke(AUTOMATION_CHANNELS.workflowDefinitionSave, definition),
    deleteWorkflowDefinition: (workflowId: string): Promise<void> => ipc.invoke(AUTOMATION_CHANNELS.workflowDefinitionDelete, { workflowId }),
    startWorkflowRun: (workflowId: string, inputs: Record<string, unknown>): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowRunStart, { workflowId, inputs }),
    pauseWorkflowRun: (runId: string): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowRunPause, { runId }),
    resumeWorkflowRun: (runId: string): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowRunResume, { runId }),
    cancelWorkflowRun: (runId: string): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowRunCancel, { runId }),
    retryWorkflowNode: (runId: string, nodeId: string): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowNodeRetry, { runId, nodeId }),
    resolveWorkflowApproval: (runId: string, nodeId: string, outputs: Record<string, unknown>): Promise<WorkflowRun> => ipc.invoke(AUTOMATION_CHANNELS.workflowApprovalResolve, { runId, nodeId, outputs }),

    createWorkflowDraft: (request?: CreateWorkflowDraftRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDraftCreate, request),
    patchWorkflowDraft: (request: PatchWorkflowDraftRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDraftPatch, request),
    updateWorkflow: (request: UpdateWorkflowRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowUpdate, request),
    resetWorkflowDraftSession: (workflowId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDraftReset, workflowId),
    sendWorkflowDraftReply: (request: SendWorkflowDraftReplyRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDraftSend, request),
    abandonWorkflowDraftReply: (workflowId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDraftAbandon, workflowId),
    selectWorkflow: (workflowId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowSelect, workflowId),
    renameWorkflow: (workflowId: string, title: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowRename, { workflowId, title }),
    deleteWorkflow: (workflowId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowDelete, workflowId),
    cloneOfficialWorkflow: (workflowId: string): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowCloneOfficial, workflowId),
    beginWorkflowImport: (): Promise<WorkflowImportPreview | undefined> => ipc.invoke(AUTOMATION_CHANNELS.workflowImportBegin),
    confirmWorkflowImport: (request: ConfirmWorkflowImportRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowImportConfirm, request),
    cancelWorkflowImport: (previewToken: string): Promise<void> => ipc.invoke(AUTOMATION_CHANNELS.workflowImportCancel, { previewToken }),
    exportWorkflow: (workflowId: string): Promise<WorkflowExportResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowExport, workflowId),
    confirmWorkflow: (request: ConfirmWorkflowRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowConfirm, request),
    reviewWorkflow: (request: ReviewWorkflowRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowReview, request),
    applyWorkflowReviewToManager: (request: ApplyWorkflowReviewToManagerRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowReviewApplyToManager, request),
    interruptWorkflowReview: (request: InterruptWorkflowReviewRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowReviewInterrupt, request),
    runWorkflow: (request: RunWorkflowRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowRun, request),
    pauseWorkflowNode: (request: PauseWorkflowNodeRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowPauseNode, request),
    reviseWorkflowV2Run: (request: ReviseWorkflowV2RunRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowReviseRun, request),
    stopWorkflowRun: (request: StopWorkflowRunRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowStopRun, request),
    resolveWorkflowV2Intervention: (request: ResolveWorkflowV2InterventionRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowResolveIntervention, request),
    resolveWorkflowV2Recovery: (request: ResolveWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowResolveRecovery, request),
    refreshWorkflowV2Recovery: (request: RefreshWorkflowV2RecoveryRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowRefreshRecovery, request),
    resolveWorkflowV2Conflict: (request: ResolveWorkflowV2ConflictRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowResolveConflict, request),
    resolveWorkflowV2UnknownOperation: (request: ResolveWorkflowV2UnknownOperationRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowResolveUnknownOperation, request),
    cleanupWorkflowV2RunMaterials: (request: CleanupWorkflowV2RunRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowCleanupRunMaterials, request),
    sendWorkflowNodeMessage: (request: SendWorkflowNodeMessageRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowSendNodeMessage, request),
    completeWorkflowNodeConversation: (request: CompleteWorkflowNodeConversationRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowCompleteNodeConversation, request),
    rejectWorkflowNodeCompletion: (request: RejectWorkflowNodeCompletionRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowRejectNodeCompletion, request),
    interruptWorkflowNodeConversation: (request: InterruptWorkflowNodeConversationRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.workflowInterruptNodeConversation, request),
    startWorkflowNode: (request: StartWorkflowNodeRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowStartNode, request),
    submitWorkflowScriptInput: (request: SubmitWorkflowScriptInputRequest): Promise<WorkflowOperationResult> => ipc.invoke(AUTOMATION_CHANNELS.workflowSubmitScriptInput, request),
    listWorkflowOutputs: (request: ListWorkflowOutputsRequest): Promise<Array<{ name: string; path: string }>> => ipc.invoke(AUTOMATION_CHANNELS.workflowOutputsList, request),
    readLocalFile: (filePath: string): Promise<LocalFilePreview> => ipc.invoke(AUTOMATION_CHANNELS.workflowOutputRead, filePath),
    revealPathInFinder: (filePath: string): Promise<string> => ipc.invoke(AUTOMATION_CHANNELS.workflowOutputReveal, filePath),
    resolveRuntimeApproval: (request: ResolveRuntimeApprovalRequest): Promise<AppSnapshot> => ipc.invoke(AUTOMATION_CHANNELS.approvalResolve, request),

    onSnapshot: (callback: (snapshot: AppSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => callback(snapshot);
      ipc.on(AUTOMATION_CHANNELS.snapshotChanged, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.snapshotChanged, listener);
    },
    onChange: (callback: (change: AutomationChange) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, change: AutomationChange) => callback(change);
      ipc.on(AUTOMATION_CHANNELS.change, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.change, listener);
    },
    onWorkflowRunStream: (callback: (event: WorkflowRunStreamEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: WorkflowRunStreamEvent) => callback(event);
      ipc.on(AUTOMATION_CHANNELS.workflowRunStream, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.workflowRunStream, listener);
    },
    onAgentTestEvent: (callback: (event: AgentTestEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AgentTestEvent) => callback(event);
      ipc.on(AUTOMATION_CHANNELS.runtimeTestEvent, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.runtimeTestEvent, listener);
    },
  };
}

export type AutomationApi = ReturnType<typeof createAutomationApi>;
