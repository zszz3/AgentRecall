import type { IpcRenderer } from "electron";
import type {
  AgentChannel,
  AgentTestEvent,
  AgentTestResult,
  AppSnapshot,
  ClaudeDefaultConfig,
  CodexDefaultConfig,
  CodexPluginCatalogItem,
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  ListEvaluationRunsRequest,
  ModelCatalogRefreshResult,
  ProviderBalanceResult,
  RuntimeLocalConfigImportResult,
  McpExternalClientConnections,
  McpExternalClientUpdate,
  McpServerDefinition,
} from "../automation/contracts";
import {
  AUTOMATION_CHANNELS,
  type AutomationHealth,
} from "../shared/ipc/automation";

export type AutomationIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createAutomationApi(ipc: AutomationIpcRenderer) {
  return {
    getHealth: (): Promise<AutomationHealth> => ipc.invoke(AUTOMATION_CHANNELS.health),
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


    onSnapshot: (callback: (snapshot: AppSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => callback(snapshot);
      ipc.on(AUTOMATION_CHANNELS.snapshotChanged, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.snapshotChanged, listener);
    },
    onAgentTestEvent: (callback: (event: AgentTestEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AgentTestEvent) => callback(event);
      ipc.on(AUTOMATION_CHANNELS.runtimeTestEvent, listener);
      return () => ipc.removeListener(AUTOMATION_CHANNELS.runtimeTestEvent, listener);
    },
  };
}

export type AutomationApi = ReturnType<typeof createAutomationApi>;
