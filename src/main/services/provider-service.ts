import {
  apiProviderPreset,
  mergeApiConfigWithProfileDefaults,
  mergeClaudeApiConfigWithProfileDefaults,
  normalizeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "../../core/api-config";
import { applyClaudeApiConfig, loadClaudeApiConfigDefaults, type ApplyClaudeProfileResult } from "../../core/claude-profile";
import { CodexChatProxy, type CodexChatProxyOptions, type CodexChatProxyStatus } from "../../core/codex-chat-proxy";
import {
  applyCodexApiConfig,
  loadCodexConfigSnapshot,
  loadCodexProfileDefaults,
  probeCodexModels,
  type ApplyCodexProfileResult,
  type CodexConfigSnapshot,
  type CodexModelProbeResult,
} from "../../core/codex-profile";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { CodexModelProbeRequest, ProviderKeyTarget } from "../../shared/ipc/providers";

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
  loadCodexConfigSnapshot: typeof loadCodexConfigSnapshot;
  probeCodexModels: typeof probeCodexModels;
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
  loadCodexConfigSnapshot,
  probeCodexModels,
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
    const [codexDefaults, claudeDefaults] = await Promise.all([
      this.operations.loadCodexProfileDefaults(),
      this.operations.loadClaudeApiConfigDefaults(),
    ]);
    return this.addStoredKeys({
      ...settings,
      apiConfig: mergeApiConfigWithProfileDefaults(
        settings.apiConfig,
        this.getSavedCodexConfigPatch(),
        codexDefaults,
      ),
      claudeApiConfig: mergeClaudeApiConfigWithProfileDefaults(
        settings.claudeApiConfig,
        this.getSavedClaudeConfigPatch(),
        claudeDefaults,
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
    if (next.summaryApiConfig.activeProvider === "custom") {
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
    if (update.apiConfig && next.apiConfig.activeProvider === "custom") {
      await this.dependencies.keys.set("codex", next.apiConfig.customProviderId, next.apiConfig.customApiKey);
    }
    if (update.claudeApiConfig && next.claudeApiConfig.activeProvider === "custom") {
      await this.dependencies.keys.set("claude", next.claudeApiConfig.customProviderId, next.claudeApiConfig.customApiKey);
    }
    if (update.summaryApiConfig && next.summaryApiConfig.activeProvider === "custom") {
      await this.dependencies.keys.set("summary", next.summaryApiConfig.customProviderId, next.summaryApiConfig.customApiKey);
    }
  }

  async migrateLegacyKeys(): Promise<void> {
    const settings = this.dependencies.getSettings();
    await this.migrateLegacyKey("codex", settings.apiConfig);
    await this.migrateLegacyKey("claude", settings.claudeApiConfig);
    this.dependencies.settings.set("apiConfig.customApiKey", "");
    this.dependencies.settings.set("claudeApiConfig.customApiKey", "");
  }

  getProviderKey(target: ProviderKeyTarget, providerId: string): Promise<string> {
    return this.dependencies.keys.get(target, providerId);
  }

  getCodexConfig(): Promise<CodexConfigSnapshot> {
    return this.operations.loadCodexConfigSnapshot();
  }

  async probeCodexModels(input: CodexModelProbeRequest): Promise<CodexModelProbeResult> {
    const settings = this.dependencies.getSettings();
    const savedKey = (
      input.providerId
        ? await this.dependencies.keys.get("codex", input.providerId)
        : ""
    ) || await this.dependencies.keys.get("codex", settings.apiConfig.customProviderId);
    return this.operations.probeCodexModels({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey || savedKey,
      providerId: input.providerId,
    });
  }

  async applyCodexProfile(apiConfigInput: Partial<ApiConfig>): Promise<ApplyCodexProfileResult> {
    const apiConfig = this.withPresetDefaults(apiConfigInput);
    if (!this.shouldUseChatProxy(apiConfig)) {
      await this.stopCodexChatProxy();
      return this.operations.applyCodexApiConfig({ apiConfig });
    }
    const proxyStatus = await this.ensureChatProxy(apiConfig);
    return this.operations.applyCodexApiConfig({ apiConfig, chatProxyBaseUrl: proxyStatus.baseUrl });
  }

  applyClaudeProfile(apiConfig: Partial<ClaudeApiConfig>): Promise<ApplyClaudeProfileResult> {
    return this.operations.applyClaudeApiConfig({ apiConfig });
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
    const apiConfig = this.withPresetDefaults({
      ...settings.apiConfig,
      customApiKey: settings.apiConfig.activeProvider === "custom"
        ? await this.dependencies.keys.get("codex", settings.apiConfig.customProviderId)
        : "",
    });
    if (!this.shouldUseChatProxy(apiConfig) || !apiConfig.customApiKey) return;
    try {
      await this.ensureChatProxy(apiConfig);
    } catch (error) {
      this.dependencies.logError(`Failed to restore Codex Chat proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async migrateLegacyKey(
    target: "codex" | "claude",
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
    const preset = apiProviderPreset(normalized.customProviderId);
    return normalizeApiConfig({
      ...normalized,
      customProviderId: preset.id,
      customProviderName: config.customProviderName?.trim() || preset.providerName,
      customBaseUrl: config.customBaseUrl?.trim() || preset.baseUrl,
      customModel: config.customModel?.trim() || preset.model,
      customApiFormat: config.customApiFormat ?? preset.apiFormat,
    });
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

  private readSavedPatch<T extends object>(prefix: string, keys: Array<keyof T>): Partial<T> {
    const saved: Partial<T> = {};
    for (const key of keys) {
      const path = `${prefix}.${String(key)}`;
      if (this.dependencies.settings.has(path)) saved[key] = this.dependencies.settings.get(path) as T[typeof key];
    }
    return saved;
  }
}
