import type { AppSnapshot } from "../../automation/engine/shared/types";
import { AgentHub } from "../../automation/engine/main/hub/agent-hub";
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
import { mcpToolDefinitions } from "../../automation/engine/mcp/server";
import type { AutomationHealth } from "../../shared/ipc/automation";
import { resolveAutomationPaths, type AutomationPaths } from "./automation-paths";
import { EvaluationService } from "./evaluation-service";
import { TeamChatService } from "../team-chat/team-chat-service";
import { PGliteTeamChatStore } from "../team-chat/pglite-team-chat-store";

export interface AutomationServiceOptions {
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  bundledWorkflowsPath: string;
  workflowMcpServerPath: string;
  localTeamChatDataPath?: string;
  readTeamChatConnectionUrl: () => string;
  writeTeamChatConnectionUrl: (url: string) => void;
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

export class NativeAutomationService {
  readonly paths: AutomationPaths;
  private readonly hubInstance: AgentHub;
  private readonly registryInstance: McpRegistryStore;
  private readonly agentsInstance: McpAgentManagementService;
  private readonly evaluationsInstance: EvaluationService;
  private readonly teamChatsInstance: TeamChatService;
  private readonly loadWorkflows: (rootPath: string) => Promise<BundledWorkflowDefinition[]>;
  private readonly startBridgeService: typeof startMcpBridge;
  private readonly startRouterService: typeof startCodexChatRouter;
  private readonly setRouterBaseUrl: typeof setCodexChatRouterBaseUrl;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly unsubscribeHub: () => void;
  private currentSnapshot: AppSnapshot;
  private bridge: McpBridgeServer | undefined;
  private router: CodexChatRouterServer | undefined;
  private initializePromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private healthState: AutomationHealth = { state: "idle" };

  constructor(
    private readonly options: AutomationServiceOptions,
    dependencies: AutomationServiceDependencies = {},
  ) {
    this.paths = resolveAutomationPaths(options.userDataPath);
    this.hubInstance = dependencies.hub ?? new AgentHub();
    this.registryInstance = dependencies.registry ?? new McpRegistryStore(this.paths.databasePath);
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
    this.evaluationsInstance = dependencies.evaluations ?? new EvaluationService({
      store: new EvaluationStore(this.paths.databasePath),
      agents: () => this.hubInstance.snapshot().configuredAgents,
      executeAgent: (configuredAgentId, prompt) =>
        configuredAgentExecutor.runOneShot({ configuredAgentId, prompt }),
    });
    this.teamChatsInstance = dependencies.teamChats ?? new TeamChatService({
      readConnectionUrl: options.readTeamChatConnectionUrl,
      writeConnectionUrl: options.writeTeamChatConnectionUrl,
      localStoreFactory: options.localTeamChatDataPath
        ? () => new PGliteTeamChatStore(options.localTeamChatDataPath!)
        : undefined,
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
      workflowCreateAvailable: () => mcpToolDefinitions().some((tool) => tool.name === "workflow_create"),
      runtimeForAgent: (agentId) => this.hubInstance.snapshot().configuredAgents
        .find((agent) => agent.id === agentId)?.runtimeAgentId,
    });
    this.currentSnapshot = this.hubInstance.snapshot();
    this.unsubscribeHub = this.hubInstance.onChange((snapshot) => {
      this.currentSnapshot = snapshot;
      for (const listener of this.listeners) listener(snapshot);
    });
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.healthState = { state: "initializing" };
    this.initializePromise = this.initializeInternal().then(
      () => { this.healthState = { state: "ready" }; },
      (error) => {
        this.healthState = {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      },
    );
    return this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    await this.hubInstance.loadModelChannels(this.paths.channelsPath);
    await this.hubInstance.loadPersistedState(this.paths.databasePath);
    this.hubInstance.setMcpServers(await this.registryInstance.list());
    this.hubInstance.ensureBundledWorkflows(await this.loadWorkflows(this.options.bundledWorkflowsPath));

    this.router = await this.startRouterService({ channels: () => this.hubInstance.snapshot().channels });
    this.setRouterBaseUrl(this.router.baseUrl);
    this.bridge = await this.startBridgeService(this.hubInstance, {
      discoveryPath: this.paths.discoveryPath,
      bundledSkillsRoot: this.paths.bundledSkillsPath,
    });
    this.hubInstance.setWorkflowMcpDiscoveryPath(this.bridge.discoveryPath);
    await this.hubInstance.initialize();
    void this.teamChatsInstance.connect().catch(() => undefined);
    void this.hubInstance.refreshDiscoverableModelCatalogs().catch((error) => {
      console.warn("Failed to refresh AgentRecall automation model catalogs:", error);
    });
  }

  async requireReady(): Promise<void> {
    await this.initialize();
    if (this.healthState.state === "error") {
      throw new Error(this.healthState.error ?? "AgentRecall automation failed to initialize.");
    }
    if (this.healthState.state === "stopped") throw new Error("AgentRecall automation has stopped.");
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

  hub(): AgentHub {
    return this.hubInstance;
  }

  mcpRegistry(): McpRegistryStore {
    return this.registryInstance;
  }

  mcpAgents(): McpAgentManagementService {
    return this.agentsInstance;
  }

  evaluations(): EvaluationService {
    return this.evaluationsInstance;
  }

  teamChat(): TeamChatService {
    return this.teamChatsInstance;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    await this.teamChatsInstance.close();
    await this.hubInstance.shutdown();
    await this.bridge?.stop();
    await this.router?.stop();
    this.evaluationsInstance.close();
    this.registryInstance.close();
    this.unsubscribeHub();
    this.listeners.clear();
    this.healthState = { state: "stopped" };
  }
}
