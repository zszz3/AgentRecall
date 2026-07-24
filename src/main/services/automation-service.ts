import type { AppSnapshot } from "../../automation/contracts";
import { AgentHub } from "../../automation/engine/main/hub/agent-hub";
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
import { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import { ConfiguredAgentExecutionService } from "../../automation/engine/main/platform/configured-agent-execution-service";
import {
  loadBundledWorkflows,
  type BundledWorkflowDefinition,
} from "../../automation/engine/main/workflows/bundled-workflows";
import { workflowMcpToolDecision } from "../../automation/engine/shared/workflow-mcp-policy";
import type { AutomationHealth } from "../../shared/ipc/automation";
import { resolveAutomationPaths, type AutomationPaths } from "./automation-paths";
import { EvaluationService } from "./evaluation-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { TeamChatService } from "../team-chat/team-chat-service";
import { PostgresTeamChatStore } from "../team-chat/postgres-team-chat-store";
import { McpAutomationModule } from "./mcp-automation-module";

export interface AutomationServiceOptions {
  database: PostgresDatabase;
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  bundledWorkflowsPath: string;
  workflowMcpServerPath: string;
}

interface AutomationServiceDependencies {
  hub?: AgentHub;
  registry?: McpRegistryStore;
  agents?: McpAgentManagementService;
  evaluations?: EvaluationService;
  teamChats?: TeamChatService;
  loadBundledWorkflows?: (rootPath: string) => Promise<BundledWorkflowDefinition[]>;
  startBridge?: typeof startMcpBridge;
  startRouter?: typeof startCodexChatRouter;
  setRouterBaseUrl?: typeof setCodexChatRouterBaseUrl;
}

type SnapshotListener = (snapshot: AppSnapshot) => void;

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
  private readonly hubInstance: AgentHub;
  private readonly registryInstance: McpRegistryStore;
  private readonly agentsInstance: McpAgentManagementService;
  private readonly loadWorkflows: (rootPath: string) => Promise<BundledWorkflowDefinition[]>;
  private readonly startBridgeService: typeof startMcpBridge;
  private readonly startRouterService: typeof startCodexChatRouter;
  private readonly setRouterBaseUrl: typeof setCodexChatRouterBaseUrl;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly unsubscribeHub: () => void;
  private currentSnapshot: AppSnapshot;
  private bridge: McpBridgeServer | undefined;
  private router: CodexChatRouterServer | undefined;
  private preparePromise: Promise<void> | undefined;
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
    this.registryInstance = dependencies.registry ?? new McpRegistryStore(options.database);
    this.loadWorkflows = dependencies.loadBundledWorkflows ?? loadBundledWorkflows;
    this.startBridgeService = dependencies.startBridge ?? startMcpBridge;
    this.startRouterService = dependencies.startRouter ?? startCodexChatRouter;
    this.setRouterBaseUrl = dependencies.setRouterBaseUrl ?? setCodexChatRouterBaseUrl;
    const configuredAgentExecutor = new ConfiguredAgentExecutionService({
      agents: () => this.hubInstance.snapshot().configuredAgents,
      channels: () => this.hubInstance.snapshot().channels,
      defaultWorkDir: () => this.hubInstance.getWorkDir(),
      execute: (request, onEvent, signal) => this.hubInstance.askConfiguredAgent(request, onEvent, signal),
    });
    this.evaluations = dependencies.evaluations ?? new EvaluationService({
      store: new EvaluationStore(options.database),
      agents: () => this.hubInstance.snapshot().configuredAgents,
      executeAgent: (configuredAgentId, prompt) =>
        configuredAgentExecutor.runOneShot({ configuredAgentId, prompt }),
    });
    this.teamChat = dependencies.teamChats ?? new TeamChatService({
      storeFactory: () => new PostgresTeamChatStore(options.database),
      configuredAgents: () => this.hubInstance.snapshot().configuredAgents,
      executeAgent: (input, onEvent, signal) => configuredAgentExecutor.runConversation(input, onEvent, signal),
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
    this.mcp = new McpAutomationModule({
      registry: this.registryInstance,
      agents: this.agentsInstance,
      runtime: this.hubInstance,
    });
    this.currentSnapshot = this.hubInstance.snapshot();
    this.unsubscribeHub = this.hubInstance.onChange((snapshot) => {
      this.currentSnapshot = snapshot;
      for (const listener of this.listeners) listener(snapshot);
    });
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
    await this.hubInstance.loadPersistedState(
      new PostgresAppStore(this.options.database, this.paths.fileStoragePath),
    );
    this.hubInstance.setMcpServers(await this.registryInstance.list());
    this.hubInstance.ensureBundledWorkflows(await this.loadWorkflows(this.options.bundledWorkflowsPath));
  }

  private async initializeInternal(): Promise<void> {
    await this.prepare();
    this.router = await this.startRouterService({ channels: () => this.hubInstance.snapshot().channels });
    this.setRouterBaseUrl(this.router.baseUrl);
    this.bridge = await this.startBridgeService(this.hubInstance, {
      discoveryPath: this.paths.discoveryPath,
      bundledSkillsRoot: this.paths.bundledSkillsPath,
    });
    this.hubInstance.setWorkflowMcpDiscoveryPath(this.bridge.discoveryPath);
    this.hubInstance.setWorkflowMcpManagedToken(this.bridge.token);
    await this.hubInstance.initialize();
    void this.teamChat.connect().catch(() => undefined);
    void this.hubInstance.refreshDiscoverableModelCatalogs().catch((error) => {
      console.warn("Failed to refresh AgentRecall automation model catalogs:", error);
    });
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

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  health(): AutomationHealth {
    return { ...this.healthState };
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
