import {
  API_PROVIDER_PRESETS,
  mergeApiConfigWithProfileDefaults,
  mergeClaudeApiConfigWithProfileDefaults,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "../../core/api-config";
import {
  applyClaudeApiConfig,
  loadClaudeApiConfigDefaults,
  loadClaudeConfigSnapshot,
  probeClaudeModels,
  type ApplyClaudeProfileResult,
  type ClaudeConfigSnapshot,
  type ClaudeModelProbeResult,
} from "../../core/claude-profile";
import { CodexChatProxy, type CodexChatProxyOptions, type CodexChatProxyStatus } from "../../core/codex-chat-proxy";
import {
  applyCodexApiConfig,
  loadCodexConfigSnapshot,
  loadCodexProfileDefaults,
  probeCodexModels,
  resolveCodexProviderCredential,
  type ApplyCodexProfileResult,
  type CodexConfigSnapshot,
  type CodexModelProbeResult,
} from "../../core/codex-profile";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import { requestSummaryCompletion } from "../../core/session-summarizer";
import type {
  ClaudeModelProbeRequest,
  CodexModelProbeRequest,
  ConfigSnapshotRequest,
  ProviderKeyTarget,
} from "../../shared/ipc/providers";
import type {
  SummaryProviderConnectionRequest,
  SummaryProviderConnectionResult,
} from "../../shared/ipc/providers";

export interface ProviderKeyStore {
  get(target: ProviderKeyTarget, providerId: string): Promise<string>;
  set(target: ProviderKeyTarget, providerId: string, apiKey: string): Promise<void>;
}

export interface ProviderSettingsAccess {
  has(path: string): boolean;
  get(path: string): unknown;
  set(path: string, value: unknown): void;
}

export interface CodexChatProxyPort {
  start(): Promise<CodexChatProxyStatus>;
  stop(): Promise<void>;
  getStatus(): CodexChatProxyStatus;
}

export interface ProviderServiceOperations {
  loadCodexProfileDefaults: typeof loadCodexProfileDefaults;
  loadClaudeApiConfigDefaults: typeof loadClaudeApiConfigDefaults;
  loadClaudeConfigSnapshot: typeof loadClaudeConfigSnapshot;
  loadCodexConfigSnapshot: typeof loadCodexConfigSnapshot;
  probeCodexModels: typeof probeCodexModels;
  probeClaudeModels: typeof probeClaudeModels;
  resolveCodexProviderCredential: typeof resolveCodexProviderCredential;
  requestSummaryCompletion: typeof requestSummaryCompletion;
  applyCodexApiConfig: typeof applyCodexApiConfig;
  applyClaudeApiConfig: typeof applyClaudeApiConfig;
  createCodexChatProxy(options: CodexChatProxyOptions): CodexChatProxyPort;
}

export interface ProviderServiceDependencies {
  getSettings(): AppSettings;
  keys: ProviderKeyStore;
  settings: ProviderSettingsAccess;
  logError(message: string): void;
  operations?: Partial<ProviderServiceOperations>;
}

const defaultOperations: ProviderServiceOperations = {
  loadCodexProfileDefaults,
  loadClaudeApiConfigDefaults,
  loadClaudeConfigSnapshot,
  loadCodexConfigSnapshot,
  probeCodexModels,
  probeClaudeModels,
  resolveCodexProviderCredential,
  requestSummaryCompletion,
  applyCodexApiConfig,
  applyClaudeApiConfig,
  createCodexChatProxy: (options) => new CodexChatProxy(options),
};

export class ProviderService {
  private readonly operations: ProviderServiceOperations;
  private chatProxy: CodexChatProxyPort | null = null;
  private chatProxySignature: string | null = null;

  constructor(private readonly dependencies: ProviderServiceDependencies) {
    this.operations = { ...defaultOperations, ...dependencies.operations };
  }

  async hydrateSettings(settings = this.dependencies.getSettings()): Promise<AppSettings> {
    const savedCodex = this.getSavedCodexConfigPatch();
    const savedClaude = this.getSavedClaudeConfigPatch();
    const summaryApiConfigMode = this.resolveSummaryApiConfigMode(settings);
    const [codexDefaults, claudeDefaults] = await Promise.all([
      this.operations.loadCodexProfileDefaults(savedCodex.customConfigDir || settings.apiConfig.customConfigDir || undefined),
      this.operations.loadClaudeApiConfigDefaults(savedClaude.customConfigDir || settings.claudeApiConfig.customConfigDir || undefined),
    ]);
    return this.addStoredKeys({
      ...settings,
      summaryApiConfigMode,
      apiConfig: mergeApiConfigWithProfileDefaults(
        settings.apiConfig,
        savedCodex,
        codexDefaults,
      ),
      claudeApiConfig: mergeClaudeApiConfigWithProfileDefaults(
        settings.claudeApiConfig,
        savedClaude,
        claudeDefaults,
      ),
      summaryApiConfig: mergeApiConfigWithProfileDefaults(
        settings.summaryApiConfig,
        this.getSavedSummaryConfigPatch(),
        undefined,
      ),
    });
  }

  async addStoredKeys(settings: AppSettings): Promise<AppSettings> {
    const next = { ...settings };
    if (next.apiConfig.activeProvider === "custom") {
      next.apiConfig = {
        ...next.apiConfig,
        customApiKey: await this.dependencies.keys.get("codex", next.apiConfig.customProviderId),
      };
    }
    if (next.claudeApiConfig.activeProvider === "custom") {
      next.claudeApiConfig = {
        ...next.claudeApiConfig,
        customApiKey: await this.dependencies.keys.get("claude", next.claudeApiConfig.customProviderId),
      };
    }
    if (next.summaryApiConfigMode === "custom" && next.summaryApiConfig.activeProvider === "custom") {
      next.summaryApiConfig = {
        ...next.summaryApiConfig,
        customApiKey: await this.dependencies.keys.get("summary", next.summaryApiConfig.customProviderId),
      };
    }
    return next;
  }

  removeStoredKeys(settings: AppSettings): AppSettings {
    return {
      ...settings,
      apiConfig: { ...settings.apiConfig, customApiKey: "" },
      claudeApiConfig: { ...settings.claudeApiConfig, customApiKey: "" },
      summaryApiConfig: { ...settings.summaryApiConfig, customApiKey: "" },
    };
  }

  async persistKeysFromUpdate(update: AppSettingsUpdate, next: AppSettings): Promise<void> {
    if (update.apiConfig && next.apiConfig.activeProvider === "custom" && next.apiConfig.customApiKey.trim()) {
      await this.dependencies.keys.set("codex", next.apiConfig.customProviderId, next.apiConfig.customApiKey);
    }
    if (update.claudeApiConfig && next.claudeApiConfig.activeProvider === "custom" && next.claudeApiConfig.customApiKey.trim()) {
      await this.dependencies.keys.set("claude", next.claudeApiConfig.customProviderId, next.claudeApiConfig.customApiKey);
    }
    if (
      update.summaryApiConfig
      && next.summaryApiConfigMode === "custom"
      && next.summaryApiConfig.activeProvider === "custom"
      && next.summaryApiConfig.customApiKey.trim()
    ) {
      await this.dependencies.keys.set("summary", next.summaryApiConfig.customProviderId, next.summaryApiConfig.customApiKey);
    }
  }

  async migrateLegacyKeys(): Promise<void> {
    const settings = this.dependencies.getSettings();
    await this.migrateLegacyKey("codex", settings.apiConfig);
    await this.migrateLegacyKey("claude", settings.claudeApiConfig);
    await this.migrateLegacyKey("summary", settings.summaryApiConfig);
    this.dependencies.settings.set("apiConfig.customApiKey", "");
    this.dependencies.settings.set("claudeApiConfig.customApiKey", "");
    this.dependencies.settings.set("summaryApiConfig.customApiKey", "");
    if (!this.dependencies.settings.has("summaryApiConfigMode")) {
      this.dependencies.settings.set("summaryApiConfigMode", this.resolveSummaryApiConfigMode(settings));
    }
  }

  getProviderKey(target: ProviderKeyTarget, providerId: string): Promise<string> {
    return this.dependencies.keys.get(target, providerId);
  }

  async resolveSummaryApiConfig(settings?: AppSettings): Promise<ApiConfig> {
    const resolvedSettings = settings ?? await this.hydrateSettings();
    if (resolvedSettings.summaryApiConfigMode === "custom") return resolvedSettings.summaryApiConfig;
    return this.withCodexCredential(resolvedSettings.apiConfig);
  }

  getCodexConfig(input: ConfigSnapshotRequest = {}): Promise<CodexConfigSnapshot> {
    const configDir = input.configDir?.trim() || this.dependencies.getSettings().apiConfig.customConfigDir || undefined;
    return this.operations.loadCodexConfigSnapshot(configDir);
  }

  getClaudeConfig(input: ConfigSnapshotRequest = {}): Promise<ClaudeConfigSnapshot> {
    const configDir = input.configDir?.trim() || this.dependencies.getSettings().claudeApiConfig.customConfigDir || undefined;
    return this.operations.loadClaudeConfigSnapshot(configDir);
  }

  async probeCodexModels(input: CodexModelProbeRequest): Promise<CodexModelProbeResult> {
    const settings = this.dependencies.getSettings();
    const keyTarget = input.keyTarget ?? "codex";
    const targetConfig = keyTarget === "summary" ? settings.summaryApiConfig : settings.apiConfig;
    const fallbackProviderId = targetConfig.customProviderId;
    const savedKey = (
      input.providerId
        ? await this.dependencies.keys.get(keyTarget, input.providerId)
        : ""
    ) || await this.dependencies.keys.get(keyTarget, fallbackProviderId);
    return this.operations.probeCodexModels({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey || savedKey,
      providerId: input.providerId,
      // Every target may fall back to the Codex config: the summary route inherits
      // Codex's credential unless it has been given one of its own.
      codexHome: input.codexHome
        || (keyTarget === "summary" ? settings.summaryApiConfig.customConfigDir : "")
        || settings.apiConfig.customConfigDir
        || undefined,
      apiKeySource: input.apiKey
        ? "API key field"
        : savedKey
          ? `AgentRecall ${keyTarget} key store`
          : undefined,
    });
  }

  async probeClaudeModels(input: ClaudeModelProbeRequest): Promise<ClaudeModelProbeResult> {
    const settings = this.dependencies.getSettings();
    const providerId = input.providerId || settings.claudeApiConfig.customProviderId;
    const savedKey = await this.dependencies.keys.get("claude", providerId);
    return this.operations.probeClaudeModels({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey || savedKey,
      apiFormat: input.apiFormat,
      apiKeyField: input.apiKeyField,
      claudeHome: input.claudeHome || settings.claudeApiConfig.customConfigDir || undefined,
      apiKeySource: input.apiKey ? "API key field" : savedKey ? "AgentRecall claude key store" : undefined,
    });
  }

  async testSummaryProviderConnection(
    input: SummaryProviderConnectionRequest,
  ): Promise<SummaryProviderConnectionResult> {
    const keyTarget = input.inheritCodex ? "codex" : "summary";
    const settings = this.dependencies.getSettings();
    const apiKey = input.apiKey.trim() || await this.dependencies.keys.get(keyTarget, input.providerId);
    const credential = input.inheritCodex
      ? await this.operations.resolveCodexProviderCredential({
          codexHome: input.codexHome || settings.apiConfig.customConfigDir || undefined,
          providerId: input.providerId,
          apiKey,
          apiKeySource: input.apiKey.trim()
            ? "API key field"
            : apiKey
              ? "AgentRecall codex key store"
              : undefined,
        })
      : { apiKey, source: input.apiKey.trim() ? "API key field" : apiKey ? "AgentRecall summary key store" : null };
    if (!credential.apiKey) throw new Error("API key is required to test the summary Provider.");
    const startedAt = Date.now();
    await this.operations.requestSummaryCompletion(
      {
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: credential.apiKey,
        model: input.model.trim(),
        apiFormat: input.apiFormat,
      },
      [{ role: "user", content: "Reply with exactly OK." }],
      AbortSignal.timeout(30_000),
    );
    return {
      elapsedMs: Math.max(0, Date.now() - startedAt),
      credentialSource: credential.source || "resolved credential",
    };
  }

  async applyCodexProfile(apiConfigInput: Partial<ApiConfig>): Promise<ApplyCodexProfileResult> {
    const apiConfig = await this.withCodexCredential(this.withPresetDefaults(apiConfigInput));
    if (!this.shouldUseChatProxy(apiConfig)) {
      await this.stopCodexChatProxy();
      return this.operations.applyCodexApiConfig({ apiConfig });
    }
    const proxyStatus = await this.ensureChatProxy(apiConfig);
    return this.operations.applyCodexApiConfig({ apiConfig, chatProxyBaseUrl: proxyStatus.baseUrl });
  }

  async applyClaudeProfile(apiConfigInput: Partial<ClaudeApiConfig>): Promise<ApplyClaudeProfileResult> {
    const normalized = { ...apiConfigInput };
    if (normalized.activeProvider === "custom" && !normalized.customApiKey?.trim()) {
      const providerId = normalizeClaudeApiConfig({ customProviderId: normalized.customProviderId }).customProviderId;
      normalized.customApiKey = await this.dependencies.keys.get("claude", providerId);
    }
    return this.operations.applyClaudeApiConfig({ apiConfig: normalized });
  }

  getCodexChatProxyStatus(): CodexChatProxyStatus | null {
    return this.chatProxy?.getStatus() ?? null;
  }

  async stopCodexChatProxy(): Promise<null> {
    const proxy = this.chatProxy;
    this.chatProxy = null;
    this.chatProxySignature = null;
    await proxy?.stop();
    return null;
  }

  async restoreCodexChatProxy(): Promise<void> {
    const settings = this.dependencies.getSettings();
    const apiConfig = await this.withCodexCredential(this.withPresetDefaults({
      ...settings.apiConfig,
      customApiKey: settings.apiConfig.activeProvider === "custom"
        ? await this.dependencies.keys.get("codex", settings.apiConfig.customProviderId)
        : "",
    }));
    if (!this.shouldUseChatProxy(apiConfig) || !apiConfig.customApiKey) return;
    try {
      await this.ensureChatProxy(apiConfig);
    } catch (error) {
      this.dependencies.logError(`Failed to restore Codex Chat proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async migrateLegacyKey(
    target: ProviderKeyTarget,
    config: ApiConfig | ClaudeApiConfig,
  ): Promise<void> {
    if (
      config.activeProvider === "custom"
      && config.customApiKey
      && !await this.dependencies.keys.get(target, config.customProviderId)
    ) {
      await this.dependencies.keys.set(target, config.customProviderId, config.customApiKey);
    }
  }

  private withPresetDefaults(config: Partial<ApiConfig>): ApiConfig {
    const normalized = normalizeApiConfig(config);
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === normalized.customProviderId);
    return normalizeApiConfig({
      ...normalized,
      customProviderId: normalized.customProviderId,
      customProviderName: config.customProviderName?.trim() || preset?.providerName || normalized.customProviderId,
      customBaseUrl: config.customBaseUrl?.trim() || preset?.baseUrl || "",
      customModel: config.customModel?.trim() || preset?.model || "",
      customApiFormat: config.customApiFormat ?? preset?.apiFormat ?? "openai_responses",
    });
  }

  private async withCodexCredential(apiConfig: ApiConfig): Promise<ApiConfig> {
    if (apiConfig.activeProvider !== "custom" || apiConfig.customApiKey) return apiConfig;
    const storedKey = await this.dependencies.keys.get("codex", apiConfig.customProviderId);
    if (storedKey) return { ...apiConfig, customApiKey: storedKey };
    const credential = await this.operations.resolveCodexProviderCredential({
      codexHome: apiConfig.customConfigDir || undefined,
      providerId: apiConfig.customProviderId,
    });
    return credential.apiKey ? { ...apiConfig, customApiKey: credential.apiKey } : apiConfig;
  }

  private shouldUseChatProxy(apiConfig: ApiConfig): boolean {
    return apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
  }

  private async ensureChatProxy(apiConfig: ApiConfig): Promise<CodexChatProxyStatus> {
    if (!apiConfig.customApiKey) throw new Error(`API key is required to start ${apiConfig.customProviderName} proxy.`);
    if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to start ${apiConfig.customProviderName} proxy.`);
    if (!apiConfig.customModel) throw new Error(`Model is required to start ${apiConfig.customProviderName} proxy.`);

    const targetSignature = JSON.stringify({
      upstreamBaseUrl: apiConfig.customBaseUrl.replace(/\/+$/, ""),
      model: apiConfig.customModel,
      apiKey: apiConfig.customApiKey,
    });
    const current = this.chatProxy?.getStatus();
    if (
      current?.running
      && this.chatProxySignature === targetSignature
      && current.upstreamBaseUrl === apiConfig.customBaseUrl.replace(/\/+$/, "")
      && current.model === apiConfig.customModel
    ) {
      return current;
    }

    await this.stopCodexChatProxy();
    const proxy = this.operations.createCodexChatProxy({
      upstreamBaseUrl: apiConfig.customBaseUrl,
      apiKey: apiConfig.customApiKey,
      model: apiConfig.customModel,
      listenHost: "127.0.0.1",
      listenPort: 15721,
    });
    const status = await proxy.start();
    this.chatProxy = proxy;
    this.chatProxySignature = targetSignature;
    return status;
  }

  private getSavedCodexConfigPatch(): Partial<ApiConfig> {
    return this.readSavedPatch<ApiConfig>("apiConfig", [
      "activeProvider",
      "customProviderId",
      "customConfigDir",
      "customProviderName",
      "customBaseUrl",
      "customApiKey",
      "customModel",
      "customApiFormat",
    ]);
  }

  private getSavedClaudeConfigPatch(): Partial<ClaudeApiConfig> {
    return this.readSavedPatch<ClaudeApiConfig>("claudeApiConfig", [
      "activeProvider",
      "customProviderId",
      "customConfigDir",
      "customProviderName",
      "customBaseUrl",
      "customApiKey",
      "customModel",
      "customHaikuModel",
      "customSonnetModel",
      "customOpusModel",
      "customApiFormat",
      "customApiKeyField",
    ]);
  }

  private getSavedSummaryConfigPatch(): Partial<ApiConfig> {
    return this.readSavedPatch<ApiConfig>("summaryApiConfig", [
      "activeProvider",
      "customProviderId",
      "customProviderName",
      "customBaseUrl",
      "customApiKey",
      "customModel",
      "customApiFormat",
    ]);
  }

  private readSavedPatch<T extends object>(prefix: string, keys: Array<keyof T>): Partial<T> {
    const saved: Partial<T> = {};
    for (const key of keys) {
      const path = `${prefix}.${String(key)}`;
      if (this.dependencies.settings.has(path)) saved[key] = this.dependencies.settings.get(path) as T[typeof key];
    }
    return saved;
  }

  private resolveSummaryApiConfigMode(settings: AppSettings): AppSettings["summaryApiConfigMode"] {
    if (this.dependencies.settings.has("summaryApiConfigMode")) {
      return settings.summaryApiConfigMode === "custom" ? "custom" : "inherit_codex";
    }
    return this.hasSavedSummaryConfig(settings) ? "custom" : "inherit_codex";
  }

  private hasSavedSummaryConfig(settings: AppSettings): boolean {
    return settings.summarySource === "custom"
      && settings.summaryApiConfig.activeProvider === "custom"
      && Boolean(settings.summaryApiConfig.customBaseUrl.trim() || settings.summaryApiConfig.customModel.trim());
  }
}
