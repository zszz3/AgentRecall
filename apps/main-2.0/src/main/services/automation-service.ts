import type { AppSnapshot, ConfiguredAgent, WorkflowSidebarItem } from "../../automation/contracts";
import {
  AgentHub,
  configuredAgentReferenceError,
  type AgentHubChange,
  type ConfiguredAgentReference,
} from "../../automation/engine/main/hub/agent-hub";
import { PostgresAppStore } from "../../automation/engine/main/hub/persisted/postgres-store";
import {
  startCodexChatRouter,
  setCodexChatRouterBaseUrl,
  type CodexChatRouterServer,
} from "../../automation/engine/main/bridges/codex-chat-router";
import {
  startMcpBridge,
  type McpBridgeServer,
} from "../../automation/engine/main/bridges/mcp-bridge";
import { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import { BuiltinWorkflowMcpServer, type BuiltinSessionSearchServer, type ManagedMcp, type McpBuiltinRuntime } from "../../automation/engine/main/mcp-builtin-server";
import { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import { ConfiguredAgentExecutionService } from "../../automation/engine/main/platform/configured-agent-execution-service";
import {
  loadBundledWorkflows,
  loadBundledWorkflowSummaries,
  type BundledWorkflowDefinition,
  type BundledWorkflowSummary,
} from "../../automation/engine/main/workflows/bundled-workflows";
import { workflowMcpToolDecision } from "../../automation/engine/shared/workflow-mcp-policy";
import {
  AUTOMATION_CHANGE_PROTOCOL_VERSION,
  type AutomationChange,
  type AutomationHealth,
  type AutomationEntityPatch,
  type WorkflowAutomationPatch,
  type WorkflowAutomationProjection,
  type WorkflowSidebarSnapshot,
} from "../../shared/ipc/automation";
import { resolveAutomationPaths, type AutomationPaths } from "./automation-paths";
import { EvaluationService } from "./evaluation-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { TeamChatService } from "../team-chat/team-chat-service";
import { PostgresTeamChatStore } from "../team-chat/postgres-team-chat-store";
import { McpAutomationModule } from "./mcp-automation-module";
import {
  WorkflowPortableService,
  type WorkflowPortableFileSelection,
} from "./workflow-portable-service";

export interface AutomationServiceOptions {
  database: PostgresDatabase;
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  bundledWorkflowsPath: string;
  workflowMcpServerPath: string;
  builtinSessionSearch?: BuiltinSessionSearchServer;
  workflowMcp?: {
    isEnabled(): boolean;
    setEnabled(next: boolean): Promise<boolean>;
    readRuntime(): McpBuiltinRuntime | undefined;
    writeRuntime(runtime: McpBuiltinRuntime): void;
  };
  chooseWorkflowImportFile?: () => Promise<WorkflowPortableFileSelection | undefined>;
  chooseWorkflowExportPath?: (defaultFileName: string) => Promise<string | undefined>;
  writeWorkflowExportFile?: (filePath: string, content: string) => Promise<void>;
}

interface AutomationServiceDependencies {
  hub?: AgentHub;
  registry?: McpRegistryStore;
  agents?: McpAgentManagementService;
  evaluations?: EvaluationService;
  teamChats?: TeamChatService;
  loadBundledWorkflows?: (rootPath: string) => Promise<BundledWorkflowDefinition[]>;
  loadBundledWorkflowSummaries?: (rootPath: string) => Promise<BundledWorkflowSummary[]>;
  startBridge?: typeof startMcpBridge;
  startRouter?: typeof startCodexChatRouter;
  setRouterBaseUrl?: typeof setCodexChatRouterBaseUrl;
}

type SnapshotListener = (snapshot: AppSnapshot) => void;
type ChangeListener = (change: AutomationChange) => void;

function diffEntities<T>(
  previous: T[],
  next: T[],
  idOf: (value: T) => string,
  versionOf: (value: T) => string,
): AutomationEntityPatch<T> | undefined {
  const previousById = new Map(previous.map((value) => [idOf(value), value]));
  const nextIds = new Set(next.map(idOf));
  const upsert = next.filter((value) => {
    const prior = previousById.get(idOf(value));
    return !prior || versionOf(prior) !== versionOf(value);
  });
  const remove = previous.filter((value) => !nextIds.has(idOf(value))).map(idOf);
  return upsert.length || remove.length ? { upsert, remove } : undefined;
}

function workflowRunVersion(run: AppSnapshot["workflowStore"]["runs"][number]): string {
  const lastEvent = run.events.at(-1);
  return JSON.stringify([
    run.status,
    run.finishedAt ?? "",
    run.lastError ?? "",
    run.contextDocument,
    run.events.length,
    lastEvent,
    run.progress,
  ]);
}

function buildWorkflowPatch(current: AppSnapshot, next: Partial<WorkflowAutomationProjection>): WorkflowAutomationPatch {
  const workflows = next.workflowStore ? diffEntities(current.workflowStore.workflows, next.workflowStore.workflows, (value) => value.workflowId, (value) => JSON.stringify([value.updatedAt, value.revision, value.status, value.sourceType, value.topologyLocked, value.origin, value.messages.length, value.messages.at(-1)?.id ?? "", value.messages.at(-1)?.content ?? ""])) : undefined;
  const runs = next.workflowStore ? diffEntities(current.workflowStore.runs, next.workflowStore.runs, (value) => value.runId, workflowRunVersion) : undefined;
  const conversations = next.workflowNodeConversations ? diffEntities(current.workflowNodeConversations, next.workflowNodeConversations, (value) => value.conversationId, (value) => `${value.updatedAt}:${value.status}:${value.messages.length}:${value.messages.at(-1)?.id ?? ""}:${value.messages.at(-1)?.content ?? ""}`) : undefined;
  const tasks = next.tasks ? diffEntities(current.tasks, next.tasks, (value) => value.id, (value) => `${value.updatedAt}:${value.status}:${value.messages.length}:${value.messages.at(-1)?.id ?? ""}:${value.messages.at(-1)?.content ?? ""}`) : undefined;
  const artifacts = next.artifacts ? diffEntities(current.artifacts, next.artifacts, (value) => value.id, (value) => `${value.registeredAt}:${value.kind}:${value.path ?? value.url ?? value.content ?? ""}`) : undefined;
  return {
    ...(next.workflowStore && current.workflowStore.activeWorkflowId !== next.workflowStore.activeWorkflowId
      ? { activeWorkflowId: next.workflowStore.activeWorkflowId ?? null }
      : {}),
    ...(next.workflowStore && JSON.stringify(current.workflowStore.readinessByWorkflowId ?? {}) !== JSON.stringify(next.workflowStore.readinessByWorkflowId ?? {})
      ? { readinessByWorkflowId: next.workflowStore.readinessByWorkflowId ?? {} }
      : {}),
    ...(workflows ? { workflows } : {}),
    ...(runs ? { runs } : {}),
    ...(conversations ? { conversations } : {}),
    ...(tasks ? { tasks } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function applyEntityPatch<T>(current: T[], patch: AutomationEntityPatch<T> | undefined, idOf: (value: T) => string): T[] {
  if (!patch) return current;
  const removed = new Set(patch.remove);
  const upsert = new Map(patch.upsert.map((value) => [idOf(value), value]));
  const next = current.filter((value) => !removed.has(idOf(value))).map((value) => upsert.get(idOf(value)) ?? value);
  const known = new Set(next.map(idOf));
  for (const value of patch.upsert) if (!known.has(idOf(value))) next.push(value);
  return next;
}

function applyWorkflowPatch(current: AppSnapshot, patch: WorkflowAutomationPatch, projection: Partial<WorkflowAutomationProjection>): AppSnapshot {
  const workflows = applyEntityPatch(current.workflowStore.workflows, patch.workflows, (value) => value.workflowId).sort((left, right) => right.createdAt - left.createdAt);
  const runs = applyEntityPatch(current.workflowStore.runs, patch.runs, (value) => value.runId).sort((left, right) => right.startedAt - left.startedAt);
  const activeWorkflowId = patch.activeWorkflowId === null ? undefined : patch.activeWorkflowId ?? current.workflowStore.activeWorkflowId;
  return {
    ...current,
    ...projection,
    workflowStore: {
      ...current.workflowStore,
      ...(projection.workflowStore ?? {}),
      activeWorkflowId,
      workflows,
      runs,
      ...(patch.readinessByWorkflowId !== undefined ? { readinessByWorkflowId: patch.readinessByWorkflowId } : {}),
    },
    workflowDraft: projection.workflowDraft ?? workflows.find((workflow) => workflow.workflowId === activeWorkflowId),
    workflowNodeConversations: applyEntityPatch(current.workflowNodeConversations, patch.conversations, (value) => value.conversationId),
    tasks: applyEntityPatch(current.tasks, patch.tasks, (value) => value.id).sort((left, right) => right.updatedAt - left.updatedAt),
    artifacts: applyEntityPatch(current.artifacts, patch.artifacts, (value) => value.id),
  };
}

export type RuntimeAutomationModule = Pick<
  AgentHub,
  | "saveModelChannels"
  | "updateConfiguredAgents"
  | "testRuntimeChannel"
  | "testConfiguredAgent"
  | "queryRuntimeChannelBalance"
  | "importRuntimeLocalConfig"
  | "refreshModelCatalog"
  | "listCodexPluginCatalog"
  | "setWorkDir"
  | "getWorkDir"
  | "snapshot"
>;

export type WorkflowAutomationModule = Pick<
  AgentHub,
  | "createWorkflowDraft"
  | "patchWorkflowDraft"
  | "updateWorkflow"
  | "resetWorkflowDraftSession"
  | "sendWorkflowDraftReply"
  | "abandonWorkflowDraftReply"
  | "selectWorkflow"
  | "renameWorkflow"
  | "deleteWorkflow"
  | "confirmWorkflow"
  | "reviewWorkflow"
  | "interruptWorkflowReview"
  | "runWorkflow"
  | "pauseWorkflowNode"
  | "reviseWorkflowV2Run"
  | "stopWorkflowRun"
  | "resolveWorkflowV2Intervention"
  | "resolveWorkflowV2Recovery"
  | "refreshWorkflowV2Recovery"
  | "resolveWorkflowV2Conflict"
  | "resolveWorkflowV2UnknownOperation"
  | "cleanupWorkflowV2RunMaterials"
  | "sendWorkflowNodeMessage"
  | "completeWorkflowNodeConversation"
  | "rejectWorkflowNodeCompletion"
  | "interruptWorkflowNodeConversation"
  | "startWorkflowNode"
  | "submitWorkflowScriptInput"
  | "listWorkflowOutputs"
  | "allowedFileRoots"
  | "snapshot"
>;

export class NativeAutomationService {
  readonly paths: AutomationPaths;
  readonly runtime: RuntimeAutomationModule;
  readonly workflows: WorkflowAutomationModule;
  readonly mcp: McpAutomationModule;
  readonly evaluations: EvaluationService;
  readonly teamChat: TeamChatService;
  readonly portableWorkflows: WorkflowPortableService;
  private readonly hubInstance: AgentHub;
  private readonly appStore: PostgresAppStore;
  private readonly configuredAgentExecutor: ConfiguredAgentExecutionService;
  private readonly registryInstance: McpRegistryStore;
  private readonly agentsInstance: McpAgentManagementService;
  private readonly loadWorkflows: (rootPath: string) => Promise<BundledWorkflowDefinition[]>;
  private readonly loadWorkflowSummaries: (rootPath: string) => Promise<BundledWorkflowSummary[]>;
  private readonly startBridgeService: typeof startMcpBridge;
  private readonly startRouterService: typeof startCodexChatRouter;
  private readonly setRouterBaseUrl: typeof setCodexChatRouterBaseUrl;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly unsubscribeHub: () => void;
  private currentSnapshot: AppSnapshot;
  private changeSequence = 0;
  private bridge: McpBridgeServer | undefined;
  private router: CodexChatRouterServer | undefined;
  private preparePromise: Promise<void> | undefined;
  private bundledWorkflowsPromise: Promise<BundledWorkflowDefinition[]> | undefined;
  private bundledWorkflowSummariesPromise: Promise<BundledWorkflowSummary[]> | undefined;
  private workflowSidebarPromise: Promise<WorkflowSidebarSnapshot> | undefined;
  private readonly officialSidebarCreatedAt = Date.now();
  private initializePromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownRequested = false;
  private healthState: AutomationHealth = { state: "idle" };

  constructor(
    private readonly options: AutomationServiceOptions,
    dependencies: AutomationServiceDependencies = {},
  ) {
    this.paths = resolveAutomationPaths(options.userDataPath);
    this.hubInstance = dependencies.hub ?? new AgentHub();
    this.appStore = new PostgresAppStore(options.database, this.paths.fileStoragePath);
    this.registryInstance = dependencies.registry ?? new McpRegistryStore(options.database);
    this.loadWorkflows = dependencies.loadBundledWorkflows ?? loadBundledWorkflows;
    this.loadWorkflowSummaries = dependencies.loadBundledWorkflowSummaries ?? loadBundledWorkflowSummaries;
    this.startBridgeService = dependencies.startBridge ?? startMcpBridge;
    this.startRouterService = dependencies.startRouter ?? startCodexChatRouter;
    this.setRouterBaseUrl = dependencies.setRouterBaseUrl ?? setCodexChatRouterBaseUrl;
    this.configuredAgentExecutor = new ConfiguredAgentExecutionService({
      agents: () => this.hubInstance.snapshot().configuredAgents,
      channels: () => this.hubInstance.snapshot().channels,
      defaultWorkDir: () => this.hubInstance.getWorkDir(),
      execute: (request, onEvent, signal) => this.hubInstance.askConfiguredAgent(request, onEvent, signal),
    });
    this.evaluations = dependencies.evaluations ?? new EvaluationService({
      store: new EvaluationStore(options.database),
      agents: () => this.hubInstance.snapshot().configuredAgents,
      executeAgent: (configuredAgentId, prompt, signal) =>
        this.configuredAgentExecutor.runOneShot({ configuredAgentId, prompt }, undefined, signal),
    });
    this.teamChat = dependencies.teamChats ?? new TeamChatService({
      storeFactory: () => new PostgresTeamChatStore(options.database),
      configuredAgents: () => this.hubInstance.snapshot().configuredAgents,
      executeAgent: (input, onEvent, signal) => this.configuredAgentExecutor.runConversation(input, onEvent, signal),
    });
    this.agentsInstance = dependencies.agents ?? new McpAgentManagementService({
      homeDir: () => options.homePath,
      appDataDir: () => options.appDataPath,
      workDir: () => this.hubInstance.getWorkDir(),
      serverPath: () => options.workflowMcpServerPath,
      bridgePath: () => this.bridge?.discoveryPath ?? this.paths.discoveryPath,
      bridgeRunning: () => Boolean(this.bridge),
      workflowCreateAvailable: () => workflowMcpToolDecision("planning", "workflow_create") === "allow",
      runtimeForAgent: (agentId) => this.hubInstance.snapshot().configuredAgents
        .find((agent) => agent.id === agentId)?.runtimeAgentId,
    });
    this.runtime = this.hubInstance;
    this.workflows = this.hubInstance;
    this.portableWorkflows = new WorkflowPortableService({
      hub: this.hubInstance,
      chooseImportFile: options.chooseWorkflowImportFile ?? (async () => {
        throw new Error("Workflow import file picker is unavailable.");
      }),
      chooseExportPath: options.chooseWorkflowExportPath ?? (async () => {
        throw new Error("Workflow export file picker is unavailable.");
      }),
      writeExportFile: options.writeWorkflowExportFile ?? (async () => {
        throw new Error("Workflow export writer is unavailable.");
      }),
    });
    const workflowBuiltin = options.workflowMcp
      ? new BuiltinWorkflowMcpServer({
          isEnabled: () => options.workflowMcp!.isEnabled(),
          setEnabled: async (next) => {
            const codexAgents = this.hubInstance.snapshot().configuredAgents.filter(
              (agent) => agent.runtimeAgentId === "codex",
            );
            for (const agent of codexAgents) {
              if (next) {
                await this.agentsInstance.install({ agentId: agent.id, catalogId: "workflow" });
              } else {
                await this.agentsInstance.uninstall({ agentId: agent.id, catalogId: "workflow" });
              }
            }
            return options.workflowMcp!.setEnabled(next);
          },
          launchConfig: () => ({
            id: "agent-recall-workflow",
            name: "AgentRecall Workflow",
            command: "node",
            args: [options.workflowMcpServerPath],
          }),
          testEnv: () => ({
            AGENT_RECALL_WORKFLOW_MCP_BRIDGE: this.bridge?.discoveryPath ?? this.paths.discoveryPath,
            ...(this.bridge?.token ? { AGENT_RECALL_WORKFLOW_MCP_TOKEN: this.bridge.token } : {}),
          }),
          hubBindable: false,
          readRuntime: () => options.workflowMcp!.readRuntime(),
          writeRuntime: (runtime) => options.workflowMcp!.writeRuntime(runtime),
        })
      : undefined;
    this.mcp = new McpAutomationModule({
      registry: this.registryInstance,
      agents: this.agentsInstance,
      runtime: this.hubInstance,
      builtins: [options.builtinSessionSearch, workflowBuiltin]
        .filter((item): item is NonNullable<typeof item> => Boolean(item)) as ManagedMcp[],
    });
    this.currentSnapshot = this.hubInstance.snapshot();
    this.unsubscribeHub = this.hubInstance.onChange((change) => this.handleHubChange(change));
  }

  initialize(): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.reject(new Error("AgentRecall automation has stopped."));
    }
    if (this.initializePromise) return this.initializePromise;
    this.healthState = { state: "initializing" };
    this.initializePromise = this.initializeInternal().then(
      () => {
        if (!this.shutdownRequested) this.healthState = { state: "ready" };
      },
      (error) => {
        if (!this.shutdownRequested) {
          this.healthState = {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      },
    );
    return this.initializePromise;
  }

  prepare(): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.reject(new Error("AgentRecall automation has stopped."));
    }
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = this.prepareInternal().catch((error) => {
      if (!this.shutdownRequested) {
        this.healthState = {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    });
    return this.preparePromise;
  }

  private async prepareInternal(): Promise<void> {
    await this.hubInstance.loadModelChannels(this.paths.channelsPath);
    await this.hubInstance.loadPersistedState(this.appStore);
    const defaultCodexChannel = this.hubInstance.snapshot().channels.find((channel) => (
      channel.id === "codex-openai"
      && channel.agentId === "codex"
      && (
        (
          channel.modelProvider === "openai"
          && !channel.baseUrl
          && !channel.httpHeaders
          && !channel.environment
        )
        || (channel.presetId === "codex-default" && !channel.apiFormat)
      )
    ));
    if (defaultCodexChannel) {
      try {
        await this.hubInstance.importRuntimeLocalConfig("codex", defaultCodexChannel.id);
      } catch (error) {
        console.warn("Failed to import the local Codex configuration for the default channel:", error);
      }
    }
    this.hubInstance.setMcpServers(await this.registryInstance.list());
    this.hubInstance.ensureBundledWorkflows(await this.bundledWorkflows());
  }

  workflowSidebar(): Promise<WorkflowSidebarSnapshot> {
    if (this.shutdownRequested) {
      return Promise.reject(new Error("AgentRecall automation has stopped."));
    }
    this.workflowSidebarPromise ??= this.loadWorkflowSidebar().catch((error) => {
      this.workflowSidebarPromise = undefined;
      throw error;
    });
    return this.workflowSidebarPromise;
  }

  private async loadWorkflowSidebar(): Promise<WorkflowSidebarSnapshot> {
    const [persisted, bundled] = await Promise.all([
      this.appStore.loadWorkflowSidebar(),
      this.bundledWorkflowSummaries(),
    ]);
    const workflows = new Map(persisted.workflows.map((workflow) => [workflow.workflowId, workflow]));
    for (const definition of bundled) {
      const existing = workflows.get(definition.workflowId);
      const official: WorkflowSidebarItem = {
        workflowId: definition.workflowId,
        sourceType: "official",
        title: definition.title,
        status: existing?.status ?? "draft",
        revision: existing?.revision ?? 1,
        objective: definition.objective,
        nodeCount: definition.nodeCount,
        createdAt: existing?.createdAt ?? this.officialSidebarCreatedAt,
        updatedAt: existing?.updatedAt ?? this.officialSidebarCreatedAt,
      };
      workflows.set(official.workflowId, official);
    }
    const ordered = [...workflows.values()].sort((left, right) => right.createdAt - left.createdAt);
    const activeWorkflowId = persisted.activeWorkflowId && workflows.has(persisted.activeWorkflowId)
      ? persisted.activeWorkflowId
      : bundled.find((workflow) => workflows.has(workflow.workflowId))?.workflowId ?? ordered[0]?.workflowId;
    return {
      ...(activeWorkflowId ? { activeWorkflowId } : {}),
      workflows: ordered,
    };
  }

  private bundledWorkflows(): Promise<BundledWorkflowDefinition[]> {
    this.bundledWorkflowsPromise ??= this.loadWorkflows(this.options.bundledWorkflowsPath).catch((error) => {
      this.bundledWorkflowsPromise = undefined;
      throw error;
    });
    return this.bundledWorkflowsPromise;
  }

  private bundledWorkflowSummaries(): Promise<BundledWorkflowSummary[]> {
    this.bundledWorkflowSummariesPromise ??= this.loadWorkflowSummaries(this.options.bundledWorkflowsPath).catch((error) => {
      this.bundledWorkflowSummariesPromise = undefined;
      throw error;
    });
    return this.bundledWorkflowSummariesPromise;
  }

  private async initializeInternal(): Promise<void> {
    await this.prepare();
    this.router = await this.startRouterService({ channels: () => this.hubInstance.snapshot().channels });
    this.setRouterBaseUrl(this.router.baseUrl);
    this.bridge = await this.startBridgeService(this.hubInstance, {
      discoveryPath: this.paths.discoveryPath,
      bundledSkillsRoot: this.paths.bundledSkillsPath,
      updateConfiguredAgents: (agents) => this.updateConfiguredAgents(agents),
      studio: {
        handleMcpRequest: (token, route, body) =>
          this.teamChat.handleMcpRequest(token, route, body),
      },
    });
    this.hubInstance.setWorkflowMcpDiscoveryPath(this.bridge.discoveryPath);
    this.hubInstance.setWorkflowMcpManagedToken(this.bridge.token);
    await this.hubInstance.initialize();
    void this.teamChat.connect().catch(() => undefined);
  }

  async requirePrepared(): Promise<void> {
    await this.prepare();
    if (this.shutdownRequested) throw new Error("AgentRecall automation has stopped.");
    if (this.healthState.state === "error") {
      throw new Error(this.healthState.error ?? "AgentRecall automation could not load its saved state.");
    }
  }

  async requireReady(): Promise<void> {
    await this.initialize();
    if (this.shutdownRequested) throw new Error("AgentRecall automation has stopped.");
    if (this.healthState.state === "error") {
      throw new Error(this.healthState.error ?? "AgentRecall automation failed to initialize.");
    }
  }

  snapshot(): AppSnapshot {
    return this.currentSnapshot;
  }

  async updateConfiguredAgents(
    agents: ConfiguredAgent[],
    options: { detectDeletedManagedAgents?: boolean } = {},
  ): Promise<AppSnapshot> {
    const currentAgents = this.hubInstance.snapshot().configuredAgents;
    const nextAgentIds = new Set(agents.map((agent) => agent.id));
    const removedAgents = currentAgents.filter((agent) => !nextAgentIds.has(agent.id));
    const removedAgentIds = new Set(removedAgents.map((agent) => agent.id));
    const agentNames = new Map(removedAgents.map((agent) => [agent.id, agent.name || agent.id]));
    const [teamChatReferences, evaluationReferences] = await Promise.all([
      this.teamChat.configuredAgentReferences(removedAgentIds),
      this.evaluations.configuredAgentReferences(removedAgentIds),
    ]);
    const externalReferences: ConfiguredAgentReference[] = [...teamChatReferences, ...evaluationReferences]
      .map((reference) => ({
        ...reference,
        agentName: agentNames.get(reference.agentId) ?? reference.agentId,
      }));
    const references = [
      ...this.hubInstance.configuredAgentDeletionReferences(agents, options),
      ...externalReferences,
    ];
    if (references.length > 0) throw configuredAgentReferenceError(references);
    return this.hubInstance.updateConfiguredAgents(agents, options);
  }

  async deleteConfiguredAgent(agentId: string): Promise<AppSnapshot> {
    const normalizedAgentId = agentId.trim();
    const agents = this.hubInstance.snapshot().configuredAgents;
    if (!agents.some((agent) => agent.id === normalizedAgentId)) {
      throw new Error(`Agent was not found: ${normalizedAgentId}`);
    }
    return this.updateConfiguredAgents(
      agents.filter((agent) => agent.id !== normalizedAgentId),
      { detectDeletedManagedAgents: true },
    );
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  subscribeChanges(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private handleHubChange(change: AgentHubChange): void {
    if (change.kind === "snapshot") {
      this.currentSnapshot = change.snapshot;
      for (const listener of this.listeners) listener(change.snapshot);
      return;
    }

    const payload = change.patch ?? buildWorkflowPatch(this.currentSnapshot, change.payload);
    this.currentSnapshot = change.patch
      ? applyWorkflowPatch(this.currentSnapshot, change.patch, change.payload)
      : { ...this.currentSnapshot, ...change.payload };
    this.currentSnapshot = { ...this.currentSnapshot, detectedAt: change.detectedAt };
    if (Object.keys(payload).length === 0) return;
    const event: AutomationChange = {
      protocolVersion: AUTOMATION_CHANGE_PROTOCOL_VERSION,
      sequence: ++this.changeSequence,
      detectedAt: change.detectedAt,
      domain: "workflow",
      entityId: "workflow-state",
      operation: "patch",
      payload,
    };
    for (const listener of this.changeListeners) listener(event);
  }

  health(): AutomationHealth {
    return { ...this.healthState };
  }

  async runOneShotOnRuntime(runtimeChannelId: string, prompt: string): Promise<string> {
    await this.requireReady();
    const snapshot = this.hubInstance.snapshot();
    const requestedChannelId = runtimeChannelId.trim();
    const channel = requestedChannelId
      ? snapshot.channels.find((item) => item.id === requestedChannelId)
      : snapshot.channels.find((item) =>
        snapshot.runtimes.some((runtime) => runtime.id === item.agentId && runtime.available))
        ?? snapshot.channels[0];
    if (requestedChannelId && !channel) {
      throw new Error(`The selected Runtime no longer exists: ${requestedChannelId}`);
    }
    if (!channel) {
      throw new Error("No Runtime is configured. Add a Runtime before using AI Skill exploration.");
    }
    const agents = snapshot.configuredAgents.filter((agent) =>
      agent.channelId === channel.id && agent.runtimeAgentId === channel.agentId);
    const agent = agents.find((item) => item.managed) ?? agents[0];
    if (!agent) {
      throw new Error(`Runtime ${channel.label} does not have an execution Agent.`);
    }
    const result = await this.configuredAgentExecutor.runOneShot({
      configuredAgentId: agent.id,
      prompt,
    });
    return result.output;
  }

  resolveRuntimeApproval(request: {
    ownerId: string;
    requestId: string;
    decision: "approved" | "rejected";
  }): AppSnapshot {
    this.hubInstance.runtimeApprovals.resolveOrThrow(request);
    return this.currentSnapshot;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    await (this.initializePromise ?? this.preparePromise)?.catch(() => undefined);
    await this.teamChat.close();
    await this.hubInstance.shutdown();
    await this.bridge?.stop();
    await this.router?.stop();
    this.evaluations.close();
    this.registryInstance.close();
    this.unsubscribeHub();
    this.listeners.clear();
    this.healthState = { state: "stopped" };
  }
}
