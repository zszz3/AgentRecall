import type { AppSnapshot, ConfiguredAgent } from "../../automation/contracts";
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
  type McpBridgeGateway,
} from "../../automation/engine/main/bridges/mcp-bridge";
import { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type {
  BuiltinSessionSearchServer,
  BuiltinEvalMcpServer,
  BuiltinSkillMcpServer,
  ManagedMcp,
} from "../../automation/engine/main/mcp-builtin-server";
import { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import { ConfiguredAgentExecutionService } from "../../automation/engine/main/platform/configured-agent-execution-service";
import type { AutomationHealth } from "../../shared/ipc/automation";
import { resolveAutomationPaths, type AutomationPaths } from "./automation-paths";
import { EvaluationService, type EvaluationServiceDependencies } from "./evaluation-service";
import type { PostgresDatabase } from "../../core/postgres/database";
import { PostgresRuntimeInvocationRepository } from "../../core/postgres/runtime-invocation-repository";
import { McpAutomationModule } from "./mcp-automation-module";
import type {
  McpExternalClientConnections,
  McpExternalClientUpdate,
  McpGatewayCallRequest,
  McpGatewayGetRequest,
  McpGatewaySearchRequest,
} from "../../automation/engine/shared/mcp/types";

export interface AutomationServiceOptions {
  database: PostgresDatabase;
  userDataPath: string;
  homePath: string;
  appDataPath: string;
  mcpClients?: {
    snapshot(): McpExternalClientConnections;
    setEnabled(request: McpExternalClientUpdate): McpExternalClientConnections;
  };
  gatewayDirect?: Pick<McpBridgeGateway, "listSkills" | "getSkill" | "searchSessions" | "getSession" | "searchResources" | "getResource">;
  builtinSessionSearch?: BuiltinSessionSearchServer;
  builtinSkills?: BuiltinSkillMcpServer;
  builtinEval?: BuiltinEvalMcpServer;
  /**
   * Evaluation graph hooks owned by the host: reading an installed skill's
   * instructions, and linking a finished run to the session it produced. Left
   * unset, an experiment still runs — it just injects no skill and records no
   * session link.
   */
  readEvaluationSkill?: EvaluationServiceDependencies["readSkill"];
  resolveEvaluationSession?: EvaluationServiceDependencies["resolveSession"];
  readEvaluationTrajectory?: EvaluationServiceDependencies["readTrajectory"];
  readEvaluationSessionArtifact?: EvaluationServiceDependencies["readSessionArtifact"];
  readEvaluationFolderArtifact?: EvaluationServiceDependencies["readFolderArtifact"];
  readEvaluationArtifactFiles?: EvaluationServiceDependencies["readArtifactFiles"];
  readEvaluationStageTrace?: EvaluationServiceDependencies["readStageTrace"];
  readEvaluationStageTexts?: EvaluationServiceDependencies["readStageTexts"];
  runEvaluationJudgeScript?: EvaluationServiceDependencies["runJudgeScript"];
  chooseEvaluationDatasetDirectory?: EvaluationServiceDependencies["chooseDatasetDirectory"];
}

interface AutomationServiceDependencies {
  hub?: AgentHub;
  registry?: McpRegistryStore;
  evaluations?: EvaluationService;
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

export class NativeAutomationService {
  readonly paths: AutomationPaths;
  readonly runtime: RuntimeAutomationModule;
  readonly mcp: McpAutomationModule;
  readonly evaluations: EvaluationService;
  private readonly hubInstance: AgentHub;
  private readonly runtimeInvocations: PostgresRuntimeInvocationRepository;
  private readonly appStore: PostgresAppStore;
  private readonly configuredAgentExecutor: ConfiguredAgentExecutionService;
  private readonly registryInstance: McpRegistryStore;
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
    this.runtimeInvocations = new PostgresRuntimeInvocationRepository(options.database);
    this.hubInstance = dependencies.hub ?? new AgentHub(
      {},
      undefined,
      undefined,
      undefined,
      this.runtimeInvocations,
    );
    this.appStore = new PostgresAppStore(options.database, this.paths.fileStoragePath);
    this.registryInstance = dependencies.registry ?? new McpRegistryStore(options.database);
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
      executeAgent: (input, signal) =>
        this.configuredAgentExecutor.runOneShot(
          {
            configuredAgentId: input.configuredAgentId,
            prompt: input.prompt,
            invocation: {
              surface: "evaluation",
              role: input.role,
              ownerReference: input.ownerReference,
            },
            ...(input.developerInstructions
              ? { developerInstructions: input.developerInstructions }
              : {}),
          },
          undefined,
          signal,
        ),
      ...(options.readEvaluationSkill ? { readSkill: options.readEvaluationSkill } : {}),
      ...(options.resolveEvaluationSession
        ? { resolveSession: options.resolveEvaluationSession }
        : {}),
      ...(options.readEvaluationTrajectory
        ? { readTrajectory: options.readEvaluationTrajectory }
        : {}),
      ...(options.readEvaluationSessionArtifact
        ? { readSessionArtifact: options.readEvaluationSessionArtifact }
        : {}),
      ...(options.readEvaluationFolderArtifact
        ? { readFolderArtifact: options.readEvaluationFolderArtifact }
        : {}),
      ...(options.readEvaluationArtifactFiles
        ? { readArtifactFiles: options.readEvaluationArtifactFiles }
        : {}),
      ...(options.readEvaluationStageTrace
        ? { readStageTrace: options.readEvaluationStageTrace }
        : {}),
      ...(options.readEvaluationStageTexts
        ? { readStageTexts: options.readEvaluationStageTexts }
        : {}),
      ...(options.runEvaluationJudgeScript
        ? { runJudgeScript: options.runEvaluationJudgeScript }
        : {}),
      ...(options.chooseEvaluationDatasetDirectory
        ? { chooseDatasetDirectory: options.chooseEvaluationDatasetDirectory }
        : {}),
    });
    this.runtime = this.hubInstance;
    this.mcp = new McpAutomationModule({
      registry: this.registryInstance,
      runtime: this.hubInstance,
      ...(options.mcpClients ? { clients: options.mcpClients } : {}),
      builtins: [options.builtinSessionSearch, options.builtinSkills, options.builtinEval]
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
    this.hubInstance.setMcpServers(await this.registryInstance.list());
  }

  private async initializeInternal(): Promise<void> {
    await this.prepare();
    await this.runtimeInvocations.recoverPending(Date.now());
    this.router = await this.startRouterService({ channels: () => this.hubInstance.snapshot().channels });
    this.setRouterBaseUrl(this.router.baseUrl);
    this.bridge = await this.startBridgeService({
      discoveryPath: this.paths.discoveryPath,
      gateway: {
        searchTools: (body) => this.mcp.searchGatewayTools(gatewaySearchRequest(body)),
        getTool: (body) => this.mcp.getGatewayTool(gatewayGetRequest(body)),
        callTool: (body) => this.mcp.callGatewayTool(gatewayCallRequest(body)),
        listSkills: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "list_skills");
          return this.options.gatewayDirect?.listSkills(body) ?? { ok: false, error: "Skill Gateway is unavailable." };
        },
        getSkill: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "get_skill");
          return this.options.gatewayDirect?.getSkill(body) ?? { ok: false, error: "Skill Gateway is unavailable." };
        },
        searchResources: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "list_skills");
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "search_resources");
          if (!this.options.gatewayDirect) throw new Error("Resource search is unavailable.");
          return this.options.gatewayDirect.searchResources(body);
        },
        getResource: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "get_skill");
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-skills", "get_resource");
          if (!this.options.gatewayDirect) throw new Error("Resource reading is unavailable.");
          return this.options.gatewayDirect.getResource(body);
        },
        searchSessions: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-session-search", "search_sessions");
          return this.options.gatewayDirect?.searchSessions(body) ?? { ok: false, error: "Session Gateway is unavailable." };
        },
        getSession: async (body) => {
          await this.mcp.assertGatewayDirectToolEnabled("agent-recall-session-search", "get_session");
          return this.options.gatewayDirect?.getSession(body) ?? { ok: false, error: "Session Gateway is unavailable." };
        },
      },
    });
    await this.hubInstance.initialize();
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
    const evaluationReferences = await this.evaluations.configuredAgentReferences(removedAgentIds);
    const externalReferences: ConfiguredAgentReference[] = evaluationReferences
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

  private handleHubChange(change: AgentHubChange): void {
    this.currentSnapshot = change.snapshot;
    for (const listener of this.listeners) listener(change.snapshot);
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
      invocation: {
        surface: "skill",
        role: "discovery",
        ownerReference: { channelId: channel.id },
      },
    });
    return result.output;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    await (this.initializePromise ?? this.preparePromise)?.catch(() => undefined);
    await this.evaluations.close();
    await this.hubInstance.shutdown();
    await this.bridge?.stop();
    await this.router?.stop();
    this.registryInstance.close();
    this.unsubscribeHub();
    this.listeners.clear();
    this.healthState = { state: "stopped" };
  }
}

function gatewayRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gateway arguments must be an object.");
  return value as Record<string, unknown>;
}

function gatewaySearchRequest(value: unknown): McpGatewaySearchRequest {
  const record = gatewayRecord(value);
  const request: McpGatewaySearchRequest = {};
  if (typeof record.sourceId === "string" && record.sourceId.trim()) request.sourceId = record.sourceId.trim();
  if (typeof record.limit === "number" && Number.isFinite(record.limit)) request.limit = record.limit;
  if (typeof record.cursor === "string" && record.cursor.trim()) request.cursor = record.cursor.trim();
  return request;
}

function gatewayGetRequest(value: unknown): McpGatewayGetRequest {
  const record = gatewayRecord(value);
  if (typeof record.toolRef !== "string" || !record.toolRef.trim()) throw new Error("toolRef is required.");
  return { toolRef: record.toolRef.trim() };
}

function gatewayCallRequest(value: unknown): McpGatewayCallRequest {
  const record = gatewayRecord(value);
  const request: McpGatewayCallRequest = gatewayGetRequest(record);
  if (record.arguments !== undefined) request.arguments = gatewayRecord(record.arguments);
  return request;
}
