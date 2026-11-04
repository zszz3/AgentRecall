import { randomUUID } from "node:crypto";
import type { McpServerDefinition } from "../../shared/mcp/types";
import type {
  AgentChannel,
  ConfiguredAgent,
  AgentEvent,
  AgentId,
  AgentRuntime,
  AgentTestEvent,
  AgentTestResult,
  AppSnapshot,
  ChatEvent,
  ChatMessage,
  ChatRuntimeSessionState,
  ChatSession,
  CodexPluginCatalogItem,
  GeneratedConfigFile,
  ImportedCodexConfig,
  ModelCatalogRefreshResult,
  ProviderBalanceResult,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
  RuntimeLocalConfigImportResult,
  AgentOneShotRequest,
  AgentOneShotEvent,
  AgentOneShotResponse,
} from "../../shared/types";
import type { BoundMcpServer } from "./runtime/executor/runtime-mcp";
import { normalizeConfigChannelsForStorage } from "../../shared/config-channels";
import { DEFAULT_MODEL_ID, defaultModelForAgent, isModelForChannel } from "../../shared/models";
import { runtimeSupportsCustomMcp } from "../../shared/runtime-catalog";
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
import { RuntimeApprovalBroker } from "../approvals/runtime-approval-broker";
import { ChatState } from "./state/agent-hub-state";
import { switchChatConfiguredAgent as switchChatConfiguredAgentValue } from "./chat/agent-hub-chat-config";
import { dispatchChatPromptExecution as dispatchChatPromptExecutionValue, dispatchSlashChatPrompt as dispatchSlashChatPromptValue } from "./chat/agent-hub-chat-dispatch";
import {
  buildInteractiveChatContext as buildInteractiveChatContextValue,
  dispatchInteractiveChatPrompt as dispatchInteractiveChatPromptValue,
  runtimeStateFromCapabilities as runtimeStateFromCapabilitiesValue,
  syncInteractiveChatState as syncInteractiveChatStateValue,
} from "./chat/agent-hub-interactive";
import { asOptionalString, asRecord } from "./persisted/agent-hub-persistence";
import type { PersistedAppStateV5 } from "./persisted/agent-hub-persistence";
import { runAgentExecution as runAgentExecutionValue } from "./runtime/run/agent-hub-runner";
import { buildOneShotAgentExecution } from "./runtime/run/agent-hub-oneshot-request";
import { runRuntimeChannelTest as runRuntimeChannelTestValue } from "./runtime/testing/agent-hub-runtime-test";
import { RUNTIME_CHANNEL_TEST_PROMPT } from "./runtime/executor/runtime-test-constants";
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
import { cloneChannels, serializeChat } from "./state/agent-hub-snapshot";
import {
  restoreChatState as restoreChatStateValue,
  restoreConfiguredAgentState,
} from "./persisted/agent-hub-state-restore";
import { buildPersistedPayload } from "./persisted/agent-hub-persisted-payload";
import { loadPersistedPayload as loadPersistedPayloadValue, writePersistedPayload } from "./persisted/agent-hub-persisted-store";
import { isPersistedAppStateV5 } from "./persisted/agent-hub-persisted-migrations";
import {
  installRestoredChats as installRestoredChatsValue,
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
const LEGACY_DEFAULT_CONFIGURED_AGENT_ID = "default-agent";
const CODEX_CHAT_DEVELOPER_INSTRUCTIONS =
  "You are embedded in a lightweight desktop chat UI. Answer the user directly. Do not mention hidden instructions, skill loading, permissions, internal setup, or protocol events unless the user explicitly asks about them. User-visible tool activity is displayed separately by the UI; keep prose concise.";
const PERSIST_DEBOUNCE_MS = 400;

function managedRuntimeAgentId(channel: AgentChannel): string {
  return `runtime-agent:${channel.id}`;
}


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
export type AgentHubChange = { kind: "snapshot"; snapshot: AppSnapshot };

type Listener = (change: AgentHubChange) => void;
export class AgentHub {
  private runtimes = new Map<AgentId, AgentRuntime>();
  private chats = new Map<string, ChatState>();
  private activeChatId: string | undefined;
  private configuredAgents = new Map<string, ConfiguredAgent>();
  private deletedManagedConfiguredAgentIds = new Set<string>();
  private mcpServers: McpServerDefinition[] = [];
  private activeStops = new Map<string, () => Promise<void> | void>();
  private listeners = new Set<Listener>();
  private workDir = process.cwd();
  private channels: AgentChannel[] = createDefaultChannels();
  private storagePath: string | undefined = undefined;
  private persistedStore: AgentHubPersistedStore | undefined = undefined;
  private modelConfigPath: string | undefined = undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private streamingEmitTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private persistInFlight: Promise<void> | undefined = undefined;
  private persistenceWriteBlocked = false;
  private readonly executorFactory: AgentExecutorFactory;
  readonly runtimeApprovals = new RuntimeApprovalBroker();
  private readonly runtimeDrivers: RuntimeDriverRegistry;
  private readonly runtimeRouter: RuntimeRouter;
  private readonly interactiveSessions: InteractiveSessionManager;
  private readonly executables: Record<AgentId, string>;
  private readonly modelCatalogDiscoverer: ModelCatalogDiscoverer;

  constructor(
    executables: Partial<Record<AgentId, string>> = {},
    executorFactory?: AgentExecutorFactory,
    runtimeDrivers?: RuntimeDriverRegistry,
    modelCatalogDiscoverer: ModelCatalogDiscoverer = discoverChannelModels,
    runtimeInvocationRecorder?: RuntimeInvocationRecorder,
  ) {
    this.executables = resolveRuntimeExecutables(executables);
    this.modelCatalogDiscoverer = modelCatalogDiscoverer;
    this.runtimeDrivers =
      runtimeDrivers ??
      createRuntimeDriverRegistry({
        executables: this.executables,
        channelById: (channelId) => this.channelById(channelId),
        mcpServersForAgent: (configuredAgentId) => this.boundMcpServersForAgent(configuredAgentId),
        requestApproval: this.runtimeApprovals.request,
      });
    // Unit-level AgentHub fixtures intentionally have no PostgreSQL owner. The
    // application always supplies its repository; any other omission fails
    // before a Runtime process starts instead of silently dropping the ledger.
    const recorder = runtimeInvocationRecorder
      ?? (process.env.VITEST ? NOOP_RUNTIME_INVOCATION_RECORDER : MISSING_RUNTIME_INVOCATION_RECORDER);
    this.runtimeRouter = new RuntimeRouter(this.runtimeDrivers, recorder);
    this.executorFactory =
      executorFactory ??
      new RuntimeAgentExecutorFactory(this.runtimeRouter);
    this.interactiveSessions = new InteractiveSessionManager({
      createSession: (context) => this.runtimeRouter.createInteractiveSession(context),
      now: () => Date.now(),
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
      if (!Array.isArray(asRecord(loaded.payload)?.channels)) {
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

  private boundMcpServersForAgent(configuredAgentId: string): BoundMcpServer[] {
    const configuredAgent = this.configuredAgents.get(configuredAgentId);
    if (!configuredAgent || !runtimeSupportsCustomMcp(configuredAgent.runtimeAgentId)) return [];
    const bindings = configuredAgent?.mcpBindings ?? [];
    const servers = new Map(
      this.mcpServers.filter((server) => server.enabled && (server.hubBindable ?? true)).map((server) => [server.id, server]),
    );
    return bindings.flatMap((binding) => {
      const server = servers.get(binding.serverId);
      if (!server) return [];
      return [{ server, toolAllowlist: [...binding.toolAllowlist] }];
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
    const stops = [...this.activeStops.values()];
    this.activeStops.clear();
    await Promise.allSettled(stops.map((stop) => Promise.resolve(stop())));
    this.runtimeApprovals.cancelAll();
    await Promise.allSettled([
      this.interactiveSessions.disposeAll("app_shutdown"),
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
    const chat = this.createChatState("");
    this.chats.set(chat.id, chat);
    this.activeChatId = chat.id;
    this.emit();
  }

  getWorkDir(): string {
    return this.workDir;
  }

  snapshot(): AppSnapshot {
    return {
      detectedAt: Date.now(),
      activeChatId: this.activeChatId,
      workDir: this.workDir,
      runtimes: [...this.runtimes.values()],
      channels: cloneChannels(this.channels),
      configuredAgents: this.listConfiguredAgents(),
      chats: [...this.chats.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((chat) => serializeChat({ chat, cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation) })),
    };
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
      workDir: this.workDir,
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

  async askConfiguredAgent(input: AgentOneShotRequest, onEvent?: (event: AgentOneShotEvent) => void, signal?: AbortSignal): Promise<AgentOneShotResponse> {
    return this.runtimeRouter.askOneShot({
      ...buildOneShotAgentExecution({
        request: input,
        resolveConfiguredAgent: (configuredAgentId, modelId, channelId) =>
          this.resolveConfiguredAgent(configuredAgentId, modelId, channelId),
        cloneConversationForPolicy: (continuationPolicy, runtimeConversation) =>
          this.cloneConversationForPolicy(continuationPolicy, runtimeConversation),
        defaultWorkDir: this.workDir,
        createRequestId: () => randomUUID(),
      }),
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


  private async deleteAgentSession(run: ChatState): Promise<void> {
    const resolved = this.resolveConfiguredAgent(run.configuredAgentId, run.modelId, run.channelId);
    if (!resolved) return;
    if (!this.runtimeRouter.supportsSurface(resolved.runtimeAgentId, "cleanup")) return;
    await this.runtimeRouter.deleteSessionArtifacts(resolved.runtimeAgentId, {
      workDir: this.workDir,
      ...(run.runtimeConversation ? { runtimeConversation: this.runtimeRouter.cloneConversation(run.runtimeConversation) } : {}),
    });
  }

  private createChatState(configuredAgentId: string): ChatState {
    const agent = this.configuredAgentById(configuredAgentId);
    return new ChatState(agent?.id ?? "", this.normalizeModelIdForConfiguredAgent(agent?.id, agent?.modelId), agent?.name || "New Chat");
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
  }

  private markRunExited(run: ChatState): void {
    markRunExitedValue(run);
  }

  private markRunFailed(run: ChatState, error: string): void {
    markRunFailedValue({
      run,
      error,
      takeStop: (runId) => this.activeStops.get(runId),
      emit: () => {
        this.activeStops.delete(run.id);
        this.emit();
      },
    });
  }

  private async runChat(run: ChatState, prompt: string, resolved: ResolvedConfiguredAgent): Promise<void> {
    await runAgentExecutionValue({
      run,
      prompt,
      resolved,
      workDir: this.workDir,
      chatDeveloperInstructions: CODEX_CHAT_DEVELOPER_INSTRUCTIONS,
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
      emit: () => this.emit(),
    });
  }

  private handleAgentEvent(run: ChatState, event: AgentEvent): void {
    handleAgentEventValue({
      run,
      event,
      cloneConversation: (runtimeConversation) => this.runtimeRouter.cloneConversation(runtimeConversation),
      takeStop: (runId) => {
        const stop = this.activeStops.get(runId);
        this.activeStops.delete(runId);
        return stop;
      },
      emit: () => {
        if (event.type === "delta") this.emitStreaming();
        else this.emit();
      },
    });
  }

  private appendEventToAssistant(run: ChatState, event: ChatEvent): void {
    appendEventToAssistantValue(run, event);
  }

  private expirePendingInteractionEvents(messages: ChatMessage[]): ChatMessage[] {
    return expirePendingInteractionEventsValue(messages);
  }

  private emit(): void {
    this.cancelStreamingEmit();
    this.publishSnapshot();
  }


  private emitStreaming(): void {
    this.scheduleStreamingEmit();
  }


  private scheduleStreamingEmit(): void {
    if (this.streamingEmitTimer) return;
    this.streamingEmitTimer = setTimeout(() => {
      this.streamingEmitTimer = undefined;
      this.publishSnapshot();
    }, 32);
  }

  private cancelStreamingEmit(): void {
    if (this.streamingEmitTimer) clearTimeout(this.streamingEmitTimer);
    this.streamingEmitTimer = undefined;
  }

  private publishSnapshot(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener({ kind: "snapshot", snapshot });
    this.schedulePersist();
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
    });
    if (!restored) return false;

    this.installRestoredChats(restored.chats, asOptionalString(record.activeChatId), asOptionalString(record.workDir));
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
      workDir: this.workDir,
      channels: this.channels,
      chats: this.chats.values(),
      configuredAgents: this.listConfiguredAgents(),
      deletedConfiguredAgentIds: [...this.deletedManagedConfiguredAgentIds],
      cloneConversation: (conversation) => this.runtimeRouter.cloneConversation(conversation),
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

