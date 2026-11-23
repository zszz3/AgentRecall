import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_GATEWAY_PORT,
  type GatewayAgentId,
  type GatewayConfig,
  type GatewayProviderEntry,
  type GatewayRequestRecord,
  type GatewayRouteTarget,
  type GatewaySaveProviderInput,
  type GatewaySnapshot,
  type GatewayStatus,
  type GatewayWiringActionResult,
} from "../../shared/ipc/model-gateway";
import {
  inspectGatewayAgents,
  restoreAgentFromGateway,
  wireAgentToGateway,
  type GatewayWiringContext,
} from "../../core/gateway-agent-wiring";
import { LocalModelGateway, type GatewayLiveEvent, type ResolvedGatewayRoute } from "../../core/model-gateway";
import type { ScannedAgentModelImports } from "../../core/agent-model-imports";
import type { IslandSignalEvent } from "../../core/island-monitor";
import type { SessionSource } from "../../core/types";

const MAX_REQUEST_LOG = 100;

export interface GatewaySettingsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface GatewayKeyStore {
  get(providerId: string): Promise<string>;
  set(providerId: string, apiKey: string): Promise<void>;
}

export interface ModelGatewayServiceDependencies {
  homeDir: string;
  userDataPath: string;
  env?: NodeJS.ProcessEnv;
  settings: GatewaySettingsStore;
  keys: GatewayKeyStore;
  scanImports?: () => Promise<ScannedAgentModelImports>;
  onIslandEvent?: (event: IslandSignalEvent) => void;
  onSnapshotChanged?: (snapshot: GatewaySnapshot) => void;
  fetchImpl?: typeof fetch;
  logError?: (message: string) => void;
}

function defaultGatewayConfig(): GatewayConfig {
  return {
    enabled: false,
    port: DEFAULT_GATEWAY_PORT,
    primary: null,
    fallbacks: [],
    agentModels: {},
    providers: [],
  };
}

function sessionSourceForGatewayAgent(agentId: GatewayAgentId | "external"): SessionSource {
  if (agentId === "claude-code") return "claude-cli";
  if (agentId === "codex") return "codex-cli";
  if (agentId === "deepseek-harness") return "deepseek-cli";
  if (agentId === "pi") return "pi-cli";
  if (agentId === "opencode") return "opencode-cli";
  return "claude-cli";
}

export class ModelGatewayService {
  private gateway: LocalModelGateway | null = null;
  private lastError: string | null = null;
  private requests: GatewayRequestRecord[] = [];
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private cachedToken: string | null = null;

  constructor(private readonly deps: ModelGatewayServiceDependencies) {}

  async startIfEnabled(): Promise<GatewaySnapshot> {
    const config = this.readConfig();
    if (config.enabled) {
      await this.startServer(config.port);
    }
    return this.getSnapshot();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.runSerialized(async () => {
      await this.stopServer();
    });
  }

  async getSnapshot(): Promise<GatewaySnapshot> {
    const config = this.readConfig();
    const status = this.currentStatus(config);
    const agents = await inspectGatewayAgents(this.wiringContext(config, status));
    return {
      config,
      status,
      agents,
      requests: [...this.requests],
    };
  }

  async setEnabled(enabled: boolean, port?: number): Promise<GatewaySnapshot> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const nextPort = port ?? config.port;
      const portChanged = nextPort !== config.port;
      const next: GatewayConfig = { ...config, enabled, port: nextPort };
      this.writeConfig(next);

      if (!enabled) {
        await this.stopServer();
      } else if (!this.gateway || portChanged) {
        await this.stopServer();
        await this.startServer(nextPort);
      }

      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return snapshot;
    });
  }

  async saveProvider(input: GatewaySaveProviderInput): Promise<GatewaySnapshot> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const id = input.id?.trim() || `gwp-${randomUUID().slice(0, 8)}`;
      const existing = config.providers.find((item) => item.id === id);

      let resolvedKey = input.apiKey?.trim() ?? "";
      if (!resolvedKey && input.importId && this.deps.scanImports) {
        const scanned = await this.deps.scanImports();
        const found = scanned.imports.find((item) => item.service.id === input.importId);
        if (!found) throw new Error("所选导入服务已失效，请刷新列表后重试。");
        resolvedKey = found.apiKey;
      }

      if (resolvedKey) {
        await this.deps.keys.set(id, resolvedKey);
      }
      const hasApiKey = Boolean(resolvedKey) || Boolean(await this.deps.keys.get(id));
      const models = [...new Set([input.defaultModel, ...(input.models ?? [])].map((m) => m.trim()).filter(Boolean))];
      const entry: GatewayProviderEntry = {
        id,
        name: input.name.trim(),
        protocol: input.protocol,
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
        defaultModel: input.defaultModel.trim(),
        models,
        enabled: input.enabled ?? existing?.enabled ?? true,
        hasApiKey,
      };

      const providers = existing
        ? config.providers.map((item) => (item.id === id ? entry : item))
        : [...config.providers, entry];

      // Automatically promote the first added provider to primary route so the gateway works out of the box.
      const primary = config.primary ?? { providerId: entry.id, model: entry.defaultModel };
      this.writeConfig({ ...config, providers, primary });
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return snapshot;
    });
  }

  async removeProvider(providerId: string): Promise<GatewaySnapshot> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const providers = config.providers.filter((item) => item.id !== providerId);
      const primary = config.primary?.providerId === providerId
        ? (providers[0] ? { providerId: providers[0].id, model: providers[0].defaultModel } : null)
        : config.primary;
      const fallbacks = config.fallbacks.filter((item) => item.providerId !== providerId);
      const agentModels: Partial<Record<GatewayAgentId, GatewayRouteTarget>> = {};
      for (const [agent, target] of Object.entries(config.agentModels)) {
        if (target && target.providerId !== providerId) {
          agentModels[agent as GatewayAgentId] = target;
        }
      }
      this.writeConfig({ ...config, providers, primary, fallbacks, agentModels });
      try {
        await this.deps.keys.set(providerId, "");
      } catch {
        // Metadata removal already succeeded; ignore key cleanup failure.
      }
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return snapshot;
    });
  }

  async setRouting(primary: GatewayRouteTarget | null, fallbacks: GatewayRouteTarget[]): Promise<GatewaySnapshot> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      this.writeConfig({ ...config, primary, fallbacks });
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return snapshot;
    });
  }

  async setAgentModel(agentId: GatewayAgentId, target: GatewayRouteTarget | null): Promise<GatewaySnapshot> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const agentModels = { ...config.agentModels };
      if (target) agentModels[agentId] = target;
      else delete agentModels[agentId];
      this.writeConfig({ ...config, agentModels });
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return snapshot;
    });
  }

  async wireAgent(agentId: GatewayAgentId): Promise<GatewayWiringActionResult> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const status = this.currentStatus(config);
      const message = await wireAgentToGateway(agentId, this.wiringContext(config, status));
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return { snapshot, message };
    });
  }

  async restoreAgent(agentId: GatewayAgentId): Promise<GatewayWiringActionResult> {
    return this.runSerialized(async () => {
      const config = this.readConfig();
      const status = this.currentStatus(config);
      const message = await restoreAgentFromGateway(agentId, this.wiringContext(config, status));
      const snapshot = await this.getSnapshot();
      this.deps.onSnapshotChanged?.(snapshot);
      return { snapshot, message };
    });
  }

  async clearRequests(): Promise<GatewaySnapshot> {
    this.requests = [];
    const snapshot = await this.getSnapshot();
    this.deps.onSnapshotChanged?.(snapshot);
    return snapshot;
  }

  private async startServer(port: number): Promise<void> {
    this.lastError = null;
    const gw = new LocalModelGateway({
      port,
      localToken: this.localToken(),
      resolveRoutes: ({ agentId, requestedModel }) => this.resolveRoutes(agentId, requestedModel),
      listModels: async () => this.listExposedModels(),
      onRequestRecord: (record) => {
        this.requests = [record, ...this.requests].slice(0, MAX_REQUEST_LOG);
        void this.getSnapshot().then((snap) => this.deps.onSnapshotChanged?.(snap));
      },
      onLiveEvent: (event) => this.forwardLiveEventToIsland(event),
      onIslandHookEvent: async (payload) => this.forwardExternalHookEvent(payload),
      fetchImpl: this.deps.fetchImpl,
    });
    try {
      await gw.start();
      this.gateway = gw;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.logError?.(`Failed to start local model gateway: ${this.lastError}`);
      throw error;
    }
  }

  private async stopServer(): Promise<void> {
    const gw = this.gateway;
    this.gateway = null;
    this.lastError = null;
    if (gw) await gw.stop();
  }

  private async resolveRoutes(
    agentId: GatewayAgentId | "external",
    requestedModel: string,
  ): Promise<ResolvedGatewayRoute[]> {
    const config = this.readConfig();
    const enabledProviders = new Map(
      config.providers.filter((item) => item.enabled).map((item) => [item.id, item]),
    );
    const orderedTargets: GatewayRouteTarget[] = [];

    // 1. Explicit `providerId/model` syntax in the request overrides defaults.
    if (requestedModel.includes("/")) {
      const slash = requestedModel.indexOf("/");
      const maybeProvider = requestedModel.slice(0, slash);
      const maybeModel = requestedModel.slice(slash + 1);
      if (enabledProviders.has(maybeProvider) && maybeModel) {
        orderedTargets.push({ providerId: maybeProvider, model: maybeModel });
      }
    }

    // 2. Per-agent route override.
    if (agentId !== "external" && config.agentModels[agentId]) {
      orderedTargets.push(config.agentModels[agentId]!);
    }

    // 3. Primary route + configured fallbacks.
    if (config.primary) orderedTargets.push(config.primary);
    orderedTargets.push(...config.fallbacks);

    // 4. Deduplicate and resolve stored keys.
    const seen = new Set<string>();
    const resolved: ResolvedGatewayRoute[] = [];
    for (const target of orderedTargets) {
      const key = `${target.providerId}\n${target.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = enabledProviders.get(target.providerId);
      if (!provider) continue;
      const apiKey = await this.deps.keys.get(provider.id);
      resolved.push({
        providerId: provider.id,
        providerName: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        apiKey,
        model: target.model || provider.defaultModel,
      });
    }
    return resolved;
  }

  private listExposedModels(): Array<{ id: string; ownedBy: string }> {
    const config = this.readConfig();
    const models: Array<{ id: string; ownedBy: string }> = [];
    for (const provider of config.providers) {
      if (!provider.enabled) continue;
      for (const model of provider.models.length > 0 ? provider.models : [provider.defaultModel]) {
        models.push({ id: `${provider.id}/${model}`, ownedBy: provider.name });
      }
    }
    return models;
  }

  private forwardLiveEventToIsland(event: GatewayLiveEvent): void {
    if (!this.deps.onIslandEvent) return;
    const source = sessionSourceForGatewayAgent(event.agentId);
    const sessionId = event.sessionId || `gw-${event.agentId}`;
    if (event.phase === "start") {
      this.deps.onIslandEvent({
        source,
        sessionId,
        status: "running",
        signalSource: "gateway",
        model: event.model,
        summary: `网关请求中 · ${event.model}`,
        timestamp: event.timestamp,
      });
    } else if (event.phase === "complete") {
      // Tool calls mean the agent will execute tools and send another step; keep status as running.
      this.deps.onIslandEvent({
        source,
        sessionId,
        status: event.hasToolCall ? "running" : "completed",
        signalSource: "gateway",
        model: event.model,
        summary: event.hasToolCall ? "等待本地工具执行…" : (event.summary || "模型回复完成"),
        tokens: event.tokens ?? null,
        timestamp: event.timestamp,
      });
    } else {
      this.deps.onIslandEvent({
        source,
        sessionId,
        status: "error",
        signalSource: "gateway",
        model: event.model,
        summary: event.summary || "网关上游请求失败",
        timestamp: event.timestamp,
      });
    }
  }

  private forwardExternalHookEvent(payload: unknown): void {
    if (!this.deps.onIslandEvent || !payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    const rawStatus = record.status;
    if (rawStatus !== "running" && rawStatus !== "waiting_input" && rawStatus !== "completed" && rawStatus !== "error") {
      throw new Error("Invalid island hook status.");
    }
    const agent = typeof record.agent === "string" ? record.agent : "claude-code";
    const source = sessionSourceForGatewayAgent(
      (agent === "claude-code" || agent === "codex" || agent === "deepseek-harness" || agent === "pi" || agent === "opencode")
        ? agent
        : "external",
    );
    const sessionId = typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId.trim()
      : `hook-${Date.now()}`;
    this.deps.onIslandEvent({
      source,
      sessionId,
      status: rawStatus,
      signalSource: "hook",
      projectPath: typeof record.projectPath === "string" ? record.projectPath : null,
      title: typeof record.title === "string" ? record.title : null,
      summary: typeof record.summary === "string" ? record.summary : null,
    });
  }

  private currentStatus(config: GatewayConfig): GatewayStatus {
    if (this.gateway) return this.gateway.getStatus(this.lastError);
    return {
      running: false,
      host: "127.0.0.1",
      port: config.port,
      baseUrl: `http://127.0.0.1:${config.port}`,
      localToken: this.localToken(),
      error: this.lastError,
      startedAt: null,
      totalRequests: this.requests.length,
      activeRequests: 0,
    };
  }

  private wiringContext(config: GatewayConfig, status: GatewayStatus): GatewayWiringContext {
    return {
      homeDir: this.deps.homeDir,
      userDataPath: this.deps.userDataPath,
      env: this.deps.env,
      gatewayBaseUrl: status.baseUrl,
      localToken: status.localToken,
      defaultModel: config.primary?.model || config.providers[0]?.defaultModel || "default",
      agentModels: config.agentModels,
    };
  }

  private localToken(): string {
    if (this.cachedToken) return this.cachedToken;
    const stored = this.deps.settings.get("modelGatewayLocalToken");
    if (typeof stored === "string" && stored.trim().length >= 12) {
      this.cachedToken = stored.trim();
      return this.cachedToken;
    }
    const generated = `ar-gw-${randomBytes(12).toString("hex")}`;
    this.deps.settings.set("modelGatewayLocalToken", generated);
    this.cachedToken = generated;
    return generated;
  }

  private readConfig(): GatewayConfig {
    const raw = this.deps.settings.get("modelGatewayConfig");
    if (!raw || typeof raw !== "object") return defaultGatewayConfig();
    const record = raw as Partial<GatewayConfig>;
    return {
      enabled: Boolean(record.enabled),
      port: typeof record.port === "number" && record.port >= 1024 && record.port <= 65535
        ? Math.round(record.port)
        : DEFAULT_GATEWAY_PORT,
      primary: record.primary ?? null,
      fallbacks: Array.isArray(record.fallbacks) ? record.fallbacks : [],
      agentModels: record.agentModels && typeof record.agentModels === "object" ? record.agentModels : {},
      providers: Array.isArray(record.providers) ? record.providers : [],
    };
  }

  private writeConfig(config: GatewayConfig): void {
    this.deps.settings.set("modelGatewayConfig", config);
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing && this.gateway === null) {
      return Promise.reject(new Error("Model gateway is shutting down."));
    }
    const pending = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = pending.catch(() => undefined);
    return pending;
  }
}
