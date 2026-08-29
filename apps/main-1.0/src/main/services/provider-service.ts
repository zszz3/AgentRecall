import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  API_PROVIDER_PRESETS,
  CLAUDE_API_PROVIDER_PRESETS,
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
  resolveClaudeProviderCredential,
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
import { providerConfigDirectoryExists } from "../../core/provider-config-path";
import { requestSummaryCompletion } from "../../core/session-summarizer";
import { buildClaudeExecEndpoint, buildCodexExecEndpoint } from "../../core/summary-endpoint";
import type {
  ClaudeModelProbeRequest,
  CodexModelProbeRequest,
  ConfigSnapshotRequest,
  ProviderConnectionRequest,
  ProviderConnectionResult,
  ProviderKeyTarget,
  SummaryProviderConnectionRequest,
  SummaryProviderConnectionResult,
} from "../../shared/ipc/providers";

export interface ProviderKeyStore {
  get(target: ProviderKeyTarget, providerId: string): string;
  set(target: ProviderKeyTarget, providerId: string, apiKey: string): void;
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
  providerConfigDirectoryExists: typeof providerConfigDirectoryExists;
  loadCodexProfileDefaults: typeof loadCodexProfileDefaults;
  loadClaudeApiConfigDefaults: typeof loadClaudeApiConfigDefaults;
  loadClaudeConfigSnapshot: typeof loadClaudeConfigSnapshot;
  loadCodexConfigSnapshot: typeof loadCodexConfigSnapshot;
  probeCodexModels: typeof probeCodexModels;
  probeClaudeModels: typeof probeClaudeModels;
  resolveCodexProviderCredential: typeof resolveCodexProviderCredential;
  resolveClaudeProviderCredential: typeof resolveClaudeProviderCredential;
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

/**
 * True when a settings update explicitly carries a credential field, so an empty value
 * means "clear it" rather than "this update says nothing about the key".
 */
function carriesApiKey(update: { customApiKey?: string } | undefined): boolean {
  return Boolean(update) && typeof update?.customApiKey === "string";
}

type ProviderKeyTargetConfig = Pick<ApiConfig | ClaudeApiConfig, "activeProvider" | "customProviderId" | "customBaseUrl">;

function normalizedProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function storedKeyCanHydrateTarget(
  target: ProviderKeyTargetConfig,
  savedTarget: ProviderKeyTargetConfig,
  presets: ReadonlyArray<{ id: string; baseUrl: string }>,
): boolean {
  const targetBaseUrl = normalizedProviderBaseUrl(target.customBaseUrl);
  const fixedPreset = presets.find((preset) => preset.id !== "custom" && preset.id === target.customProviderId);
  if (fixedPreset && normalizedProviderBaseUrl(fixedPreset.baseUrl) === targetBaseUrl) return true;
  return Boolean(targetBaseUrl)
    && savedTarget.activeProvider === "custom"
    && savedTarget.customProviderId === target.customProviderId
    && normalizedProviderBaseUrl(savedTarget.customBaseUrl) === targetBaseUrl;
}

function providerRouteMatches(
  target: ProviderKeyTargetConfig,
  providerId: string,
  baseUrl: string,
): boolean {
  const normalizedBaseUrl = normalizedProviderBaseUrl(baseUrl);
  return Boolean(normalizedBaseUrl)
    && target.activeProvider === "custom"
    && target.customProviderId === providerId
    && normalizedProviderBaseUrl(target.customBaseUrl) === normalizedBaseUrl;
}

/** Human-readable provenance for the credential the connection test ended up using. */
function summaryKeySource(typedKey: string, resolvedKey: string, store: ProviderKeyTarget): string | undefined {
  if (typedKey) return "API key field";
  return resolvedKey ? `AgentRecall ${store} key store` : undefined;
}

/**
 * The Claude route may be configured with Gemini's native format, which the summary client cannot
 * speak. Saying so is better than testing a different format and reporting a success the real
 * summary run would not reproduce.
 */
function summaryConnectionApiFormat(
  apiFormat: SummaryProviderConnectionRequest["apiFormat"],
): "anthropic" | "openai_chat" | "openai_responses" {
  if (apiFormat === "gemini_native") {
    throw new Error("AI summary cannot use the Gemini native format. Choose Anthropic or an OpenAI-compatible format.");
  }
  return apiFormat;
}

const CLAUDE_CONNECTION_TEST_ARGS = [
  "--safe-mode",
  "--tools",
  "",
  "--no-session-persistence",
] as const;

const CODEX_CONNECTION_TEST_ARGS = [
  "-c", "features.shell_tool=false",
  "-c", "features.unified_exec=false",
  "-c", "features.apps=false",
  "-c", "features.remote_plugin=false",
  "-c", "features.multi_agent=false",
  "-c", "features.hooks=false",
  "-c", 'web_search="disabled"',
  "-c", "tools.view_image=false",
  "-c", "mcp_servers={}",
  "-c", "project_doc_max_bytes=0",
] as const;

const defaultOperations: ProviderServiceOperations = {
  providerConfigDirectoryExists,
  loadCodexProfileDefaults,
  loadClaudeApiConfigDefaults,
  loadClaudeConfigSnapshot,
  loadCodexConfigSnapshot,
  probeCodexModels,
  probeClaudeModels,
  resolveCodexProviderCredential,
  resolveClaudeProviderCredential,
  requestSummaryCompletion,
  applyCodexApiConfig,
  applyClaudeApiConfig,
  createCodexChatProxy: (options) => new CodexChatProxy(options),
};

export class ProviderService {
  private readonly operations: ProviderServiceOperations;
  private chatProxy: CodexChatProxyPort | null = null;
  private chatProxySignature: string | null = null;
  // Startup restore and settings saves can race into the proxy lifecycle; queue
  // every start/stop transition so the check-then-act always sees the result
  // of the previous one instead of creating duplicate proxies on the same port.
  private chatProxyLifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: ProviderServiceDependencies) {
    this.operations = { ...defaultOperations, ...dependencies.operations };
  }

  async hydrateSettings(settings = this.dependencies.getSettings()): Promise<AppSettings> {
    const savedCodex = this.getSavedCodexConfigPatch();
    const savedClaude = this.getSavedClaudeConfigPatch();
    const [codexConfigDir, claudeConfigDir] = await Promise.all([
      this.validSavedConfigDirectory(
        "apiConfig.customConfigDir",
        savedCodex.customConfigDir !== undefined ? savedCodex.customConfigDir : settings.apiConfig.customConfigDir,
        ".codex",
      ),
      this.validSavedConfigDirectory(
        "claudeApiConfig.customConfigDir",
        savedClaude.customConfigDir !== undefined ? savedClaude.customConfigDir : settings.claudeApiConfig.customConfigDir,
        ".claude",
      ),
    ]);
    const currentSettings = {
      ...settings,
      apiConfig: { ...settings.apiConfig, customConfigDir: codexConfigDir },
      claudeApiConfig: { ...settings.claudeApiConfig, customConfigDir: claudeConfigDir },
    };
    const summaryApiConfigMode = this.resolveSummaryApiConfigMode(settings);
    const [codexDefaults, claudeDefaults] = await Promise.all([
      this.operations.loadCodexProfileDefaults(codexConfigDir || undefined),
      this.operations.loadClaudeApiConfigDefaults(claudeConfigDir || undefined),
    ]);
    return this.addStoredKeys({
      ...currentSettings,
      summaryApiConfigMode,
      apiConfig: mergeApiConfigWithProfileDefaults(
        currentSettings.apiConfig,
        savedCodex,
        codexDefaults,
        true,
      ),
      claudeApiConfig: mergeClaudeApiConfigWithProfileDefaults(
        currentSettings.claudeApiConfig,
        savedClaude,
        claudeDefaults,
        true,
      ),
      summaryApiConfig: mergeApiConfigWithProfileDefaults(
        settings.summaryApiConfig,
        this.getSavedSummaryConfigPatch(),
        undefined,
      ),
    }, {
      codex: currentSettings.apiConfig,
      claude: currentSettings.claudeApiConfig,
    });
  }

  addStoredKeys(
    settings: AppSettings,
    savedTargets?: { codex: ApiConfig; claude: ClaudeApiConfig },
  ): AppSettings {
    const next = { ...settings };
    if (next.apiConfig.activeProvider === "custom") {
      next.apiConfig = {
        ...next.apiConfig,
        customApiKey: !savedTargets || storedKeyCanHydrateTarget(
          next.apiConfig,
          savedTargets.codex,
          API_PROVIDER_PRESETS,
        )
          ? this.dependencies.keys.get("codex", next.apiConfig.customProviderId)
          : "",
      };
    }
    if (next.claudeApiConfig.activeProvider === "custom") {
      next.claudeApiConfig = {
        ...next.claudeApiConfig,
        customApiKey: !savedTargets || storedKeyCanHydrateTarget(
          next.claudeApiConfig,
          savedTargets.claude,
          CLAUDE_API_PROVIDER_PRESETS,
        )
          ? this.dependencies.keys.get("claude", next.claudeApiConfig.customProviderId)
          : "",
      };
    }
    if (next.summaryApiConfigMode === "custom" && next.summaryApiConfig.activeProvider === "custom") {
      next.summaryApiConfig = {
        ...next.summaryApiConfig,
        customApiKey: this.dependencies.keys.get("summary", next.summaryApiConfig.customProviderId),
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

  persistKeysFromUpdate(update: AppSettingsUpdate, next: AppSettings): void {
    // The renderer always hydrates the key field before saving, so an update that carries
    // `customApiKey` is authoritative — including when the user deliberately cleared it.
    // Updates that omit the field leave the stored key alone.
    if (carriesApiKey(update.apiConfig) && next.apiConfig.activeProvider === "custom") {
      this.dependencies.keys.set("codex", next.apiConfig.customProviderId, next.apiConfig.customApiKey);
    }
    if (carriesApiKey(update.claudeApiConfig) && next.claudeApiConfig.activeProvider === "custom") {
      this.dependencies.keys.set("claude", next.claudeApiConfig.customProviderId, next.claudeApiConfig.customApiKey);
    }
    if (
      carriesApiKey(update.summaryApiConfig)
      && next.summaryApiConfigMode === "custom"
      && next.summaryApiConfig.activeProvider === "custom"
    ) {
      this.dependencies.keys.set("summary", next.summaryApiConfig.customProviderId, next.summaryApiConfig.customApiKey);
    }
  }

  migrateLegacyKeys(): void {
    const settings = this.dependencies.getSettings();
    this.migrateLegacyKey("codex", settings.apiConfig);
    this.migrateLegacyKey("claude", settings.claudeApiConfig);
    this.migrateLegacyKey("summary", settings.summaryApiConfig);
    this.dependencies.settings.set("apiConfig.customApiKey", "");
    this.dependencies.settings.set("claudeApiConfig.customApiKey", "");
    this.dependencies.settings.set("summaryApiConfig.customApiKey", "");
    if (!this.dependencies.settings.has("summaryApiConfigMode")) {
      this.dependencies.settings.set("summaryApiConfigMode", this.resolveSummaryApiConfigMode(settings));
    }
  }

  getProviderKey(target: ProviderKeyTarget, providerId: string): string {
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

  probeCodexModels(input: CodexModelProbeRequest): Promise<CodexModelProbeResult> {
    const settings = this.dependencies.getSettings();
    const keyTarget = input.keyTarget ?? "codex";
    const targetConfig = keyTarget === "summary" ? settings.summaryApiConfig : settings.apiConfig;
    const providerId = input.providerId || targetConfig.customProviderId;
    const explicitKey = input.apiKey.trim();
    const savedKey = !explicitKey && providerRouteMatches(targetConfig, providerId, input.baseUrl)
      ? this.dependencies.keys.get(keyTarget, providerId)
      : "";
    return this.operations.probeCodexModels({
      baseUrl: input.baseUrl,
      apiKey: explicitKey || savedKey,
      providerId,
      // The renderer always sends the directory it means, so these fallbacks only cover a probe
      // that omitted one. A summary probe must not fall through to the Codex tab's directory:
      // they are independent routes, and an empty summary directory means the machine's `~/.codex`.
      codexHome: input.codexHome
        || (keyTarget === "summary"
          ? settings.summaryApiConfig.customConfigDir || settings.summaryCodexConfigDir
          : settings.apiConfig.customConfigDir)
        || undefined,
      apiKeySource: explicitKey
        ? "API key field"
        : savedKey
          ? `AgentRecall ${keyTarget} key store`
          : undefined,
    });
  }

  probeClaudeModels(input: ClaudeModelProbeRequest): Promise<ClaudeModelProbeResult> {
    const settings = this.dependencies.getSettings();
    const keyTarget = input.keyTarget ?? "claude";
    const targetConfig = keyTarget === "summary" ? settings.summaryApiConfig : settings.claudeApiConfig;
    const providerId = input.providerId || targetConfig.customProviderId;
    const explicitKey = input.apiKey.trim();
    const savedKey = !explicitKey && providerRouteMatches(targetConfig, providerId, input.baseUrl)
      ? this.dependencies.keys.get(keyTarget, providerId)
      : "";
    return this.operations.probeClaudeModels({
      baseUrl: input.baseUrl,
      apiKey: explicitKey || savedKey,
      providerId,
      apiFormat: input.apiFormat,
      apiKeyField: input.apiKeyField,
      claudeHome: input.claudeHome
        || (keyTarget === "summary" ? settings.summaryClaudeConfigDir : settings.claudeApiConfig.customConfigDir)
        || undefined,
      apiKeySource: explicitKey
        ? "API key field"
        : savedKey
          ? `AgentRecall ${keyTarget} key store`
          : undefined,
    });
  }

  async testProviderConnection(input: ProviderConnectionRequest): Promise<ProviderConnectionResult> {
    const startedAt = Date.now();
    const settings = this.dependencies.getSettings();
    const prompt = [{ role: "user" as const, content: "Reply with exactly OK." }];

    if (input.target === "claude") {
      const normalized = normalizeClaudeApiConfig(input.apiConfig);
      const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === normalized.customProviderId);
      const apiConfig = normalizeClaudeApiConfig({
        ...normalized,
        customProviderName: input.apiConfig.customProviderName?.trim() || preset?.providerName || normalized.customProviderId,
        customBaseUrl: input.apiConfig.customBaseUrl?.trim() || preset?.baseUrl || "",
        customModel: input.apiConfig.customModel?.trim() || preset?.model || "",
        customApiFormat: input.apiConfig.customApiFormat ?? preset?.apiFormat ?? "anthropic",
        customApiKeyField: input.apiConfig.customApiKeyField ?? preset?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
      });
      const endpoint = buildClaudeExecEndpoint({
        ...settings,
        summaryClaudeModel: apiConfig.activeProvider === "custom" ? apiConfig.customModel : "",
        summaryClaudeConfigDir: apiConfig.customConfigDir,
      });
      endpoint.cliArgs = [...CLAUDE_CONNECTION_TEST_ARGS];
      let credentialSource = "Claude Code CLI authentication";
      let isolateConfigHome = false;
      if (apiConfig.activeProvider === "official") {
        const officialEnv = {
          ANTHROPIC_BASE_URL: "",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_MODEL: "",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
          ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "",
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "",
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "",
        };
        endpoint.env = { ...endpoint.env, ...officialEnv };
        endpoint.cliArgs.push("--settings", JSON.stringify({ env: officialEnv }));
      } else {
        if (!apiConfig.customBaseUrl.trim()) {
          throw new Error(`Base URL is required to test ${apiConfig.customProviderName}.`);
        }
        const requestedBaseUrl = apiConfig.customBaseUrl.trim().replace(/\/+$/, "");
        const providerKey = apiConfig.customApiKey.trim();
        if (providerKey) {
          const authEnv = {
            ANTHROPIC_BASE_URL: requestedBaseUrl,
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            [apiConfig.customApiKeyField]: providerKey,
          };
          endpoint.env = {
            ...endpoint.env,
            ...authEnv,
          };
          isolateConfigHome = true;
          credentialSource = "API key field";
        } else {
          const snapshot = await this.operations.loadClaudeConfigSnapshot(apiConfig.customConfigDir || undefined);
          const configuredBaseUrl = snapshot.route.customBaseUrl?.trim().replace(/\/+$/, "") ?? "";
          if (
            snapshot.route.activeProvider !== "custom"
            || configuredBaseUrl !== requestedBaseUrl
            || !snapshot.hasApiKey
          ) {
            throw new Error(
              `No readable API key was found for ${apiConfig.customProviderName}. Write this route to Claude Code settings before testing CLI-managed credentials.`,
            );
          }
          credentialSource = snapshot.credentialSource || credentialSource;
        }
      }
      const testCwd = await mkdtemp(path.join(tmpdir(), "agent-recall-provider-test-"));
      endpoint.cwd = testCwd;
      if (isolateConfigHome) endpoint.env = { ...endpoint.env, CLAUDE_CONFIG_DIR: testCwd };
      try {
        await this.operations.requestSummaryCompletion(
          endpoint,
          prompt,
          AbortSignal.timeout(30_000),
        );
        return {
          elapsedMs: Math.max(0, Date.now() - startedAt),
          credentialSource,
        };
      } finally {
        await rm(testCwd, { recursive: true, force: true });
      }
    }

    const apiConfig = this.withPresetDefaults(input.apiConfig);
    const endpoint = buildCodexExecEndpoint({
      ...settings,
      summaryCodexModel: apiConfig.activeProvider === "custom" ? apiConfig.customModel : "",
      summaryCodexConfigDir: apiConfig.customConfigDir,
    });
    let credentialSource = "Codex CLI authentication";
    let testProxy: CodexChatProxyPort | null = null;
    let isolateConfigHome = false;
    try {
      if (apiConfig.activeProvider === "official") {
        // Authentication still comes from CODEX_HOME, while routing/model/plugin config is ignored.
        endpoint.cliArgs = ["--ignore-user-config", ...CODEX_CONNECTION_TEST_ARGS];
      } else {
        if (!apiConfig.customBaseUrl.trim()) {
          throw new Error(`Base URL is required to test ${apiConfig.customProviderName}.`);
        }
        const providerKey = apiConfig.customApiKey.trim();
        if (providerKey) credentialSource = "API key field";
        const requestedBaseUrl = apiConfig.customBaseUrl.trim().replace(/\/+$/, "");
        if (!providerKey) {
          if (apiConfig.customApiFormat === "openai_chat") {
            throw new Error(
              `${apiConfig.customProviderName} uses the local Codex Chat proxy, but no API key was readable by AgentRecall.`,
            );
          }
          const snapshot = await this.operations.loadCodexConfigSnapshot(apiConfig.customConfigDir || undefined);
          const configuredProvider = snapshot.providers.find(
            (provider) => provider.id === apiConfig.customProviderId,
          );
          if (
            !configuredProvider
            || configuredProvider.baseUrl.trim().replace(/\/+$/, "") !== requestedBaseUrl
          ) {
            throw new Error(
              `No readable API key was found for ${apiConfig.customProviderName}. Write this route to Codex config before testing CLI-managed credentials.`,
            );
          }
          credentialSource = configuredProvider.credentialSource || credentialSource;
          endpoint.cliArgs = [
            ...CODEX_CONNECTION_TEST_ARGS,
            "-c", `model_provider=${JSON.stringify(apiConfig.customProviderId)}`,
          ];
        } else {
          // A reserved one-shot provider prevents an existing provider's mutually exclusive
          // `auth` block from being combined with the env-key authentication below.
          const providerId = "agent-recall-connection-test";
          let baseUrl = requestedBaseUrl;
          if (apiConfig.customApiFormat === "openai_chat") {
            testProxy = this.operations.createCodexChatProxy({
              upstreamBaseUrl: baseUrl,
              apiKey: providerKey,
              model: apiConfig.customModel,
              listenHost: "127.0.0.1",
              listenPort: 0,
            });
            baseUrl = (await testProxy.start()).baseUrl;
          }
          const prefix = `model_providers.${providerId}`;
          endpoint.cliArgs = [
            "--ignore-user-config",
            ...CODEX_CONNECTION_TEST_ARGS,
            "-c", `model_provider=${JSON.stringify(providerId)}`,
            "-c", `${prefix}.name=${JSON.stringify(apiConfig.customProviderName || providerId)}`,
            "-c", `${prefix}.base_url=${JSON.stringify(baseUrl)}`,
            "-c", `${prefix}.wire_api="responses"`,
            "-c", `${prefix}.requires_openai_auth=false`,
            "-c", `${prefix}.env_key="OPENAI_API_KEY"`,
          ];
          endpoint.env = { ...endpoint.env, OPENAI_API_KEY: providerKey };
          isolateConfigHome = true;
        }
      }
      const testCwd = await mkdtemp(path.join(tmpdir(), "agent-recall-provider-test-"));
      endpoint.cwd = testCwd;
      if (isolateConfigHome) endpoint.env = { ...endpoint.env, CODEX_HOME: testCwd };
      try {
        await this.operations.requestSummaryCompletion(
          endpoint,
          prompt,
          AbortSignal.timeout(30_000),
        );
        return {
          elapsedMs: Math.max(0, Date.now() - startedAt),
          credentialSource,
        };
      } finally {
        await rm(testCwd, { recursive: true, force: true });
      }
    } finally {
      await testProxy?.stop();
    }
  }

  async testSummaryProviderConnection(
    input: SummaryProviderConnectionRequest,
  ): Promise<SummaryProviderConnectionResult> {
    const startedAt = Date.now();
    if (input.source === "codex") {
      const settings = this.dependencies.getSettings();
      await this.operations.requestSummaryCompletion(
        buildCodexExecEndpoint({
          ...settings,
          summaryCodexModel: input.model.trim(),
          summaryCodexConfigDir: input.configDir ?? settings.summaryCodexConfigDir,
        }),
        [{ role: "user", content: "Reply with exactly OK." }],
        AbortSignal.timeout(30_000),
      );
      return {
        elapsedMs: Math.max(0, Date.now() - startedAt),
        credentialSource: "Codex CLI",
      };
    }

    const credential = await this.resolveSummaryConnectionCredential(input);
    if (!credential.apiKey) throw new Error("API key is required to test the summary Provider.");
    await this.operations.requestSummaryCompletion(
      {
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: credential.apiKey,
        model: input.model.trim(),
        apiFormat: summaryConnectionApiFormat(input.apiFormat),
      },
      [{ role: "user", content: "Reply with exactly OK." }],
      AbortSignal.timeout(30_000),
    );
    return {
      elapsedMs: Math.max(0, Date.now() - startedAt),
      credentialSource: credential.source || "resolved credential",
    };
  }

  /**
   * Each summary source keeps its credential somewhere different — the Codex and Claude sources
   * in the config directory they point at, the custom source in its own key slot (or the Codex
   * tab's, when it inherits) — so the lookup has to branch before the request is even built.
   */
  private resolveSummaryConnectionCredential(
    input: SummaryProviderConnectionRequest,
  ): Promise<{ apiKey: string; source: string | null }> {
    const settings = this.dependencies.getSettings();
    const typedKey = input.apiKey.trim();

    if (input.source === "claude") {
      const id = input.providerId?.trim() || "";
      const apiKey = typedKey || (
        id && providerRouteMatches(settings.summaryApiConfig, id, input.baseUrl)
          ? this.dependencies.keys.get("summary", id)
          : ""
      );
      return this.operations.resolveClaudeProviderCredential({
        claudeHome: input.configDir || settings.summaryClaudeConfigDir || undefined,
        providerId: input.providerId,
        baseUrl: input.baseUrl,
        apiKeyField: input.apiKeyField,
        apiKey,
        apiKeySource: summaryKeySource(typedKey, apiKey, "summary"),
      });
    }

    if (input.source === "codex") {
      const id = input.providerId?.trim() || "";
      const apiKey = typedKey || (
        id && providerRouteMatches(settings.summaryApiConfig, id, input.baseUrl)
          ? this.dependencies.keys.get("summary", id)
          : ""
      );
      return this.operations.resolveCodexProviderCredential({
        codexHome: input.configDir || settings.summaryCodexConfigDir || undefined,
        providerId: input.providerId,
        baseUrl: input.baseUrl,
        apiKey,
        apiKeySource: summaryKeySource(typedKey, apiKey, "summary"),
      });
    }

    const keyTarget = input.inherit ? "codex" : "summary";
    const targetConfig = input.inherit ? settings.apiConfig : settings.summaryApiConfig;
    const apiKey = typedKey || (
      providerRouteMatches(targetConfig, input.providerId, input.baseUrl)
        ? this.dependencies.keys.get(keyTarget, input.providerId)
        : ""
    );
    if (!input.inherit) {
      return Promise.resolve({ apiKey, source: summaryKeySource(typedKey, apiKey, "summary") ?? null });
    }
    return this.operations.resolveCodexProviderCredential({
      codexHome: input.codexHome || settings.apiConfig.customConfigDir || undefined,
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      apiKey,
      apiKeySource: summaryKeySource(typedKey, apiKey, "codex"),
    });
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

  applyClaudeProfile(apiConfigInput: Partial<ClaudeApiConfig>): Promise<ApplyClaudeProfileResult> {
    const apiConfig = { ...apiConfigInput };
    if (apiConfig.activeProvider === "custom" && !apiConfig.customApiKey?.trim()) {
      const normalized = normalizeClaudeApiConfig(apiConfig);
      const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === normalized.customProviderId);
      const baseUrl = apiConfig.customBaseUrl?.trim() || preset?.baseUrl || "";
      if (providerRouteMatches(this.dependencies.getSettings().claudeApiConfig, normalized.customProviderId, baseUrl)) {
        apiConfig.customApiKey = this.dependencies.keys.get("claude", normalized.customProviderId);
      }
    }
    return this.operations.applyClaudeApiConfig({ apiConfig });
  }

  getCodexChatProxyStatus(): CodexChatProxyStatus | null {
    return this.chatProxy?.getStatus() ?? null;
  }

  async stopCodexChatProxy(): Promise<null> {
    const run = this.chatProxyLifecycle.then(() => this.stopChatProxyNow());
    this.chatProxyLifecycle = run.catch(() => undefined);
    return run;
  }

  private async stopChatProxyNow(): Promise<null> {
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
        ? this.dependencies.keys.get("codex", settings.apiConfig.customProviderId)
        : "",
    }));
    if (!this.shouldUseChatProxy(apiConfig) || !apiConfig.customApiKey) return;
    try {
      await this.ensureChatProxy(apiConfig);
    } catch (error) {
      this.dependencies.logError(`Failed to restore Codex Chat proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private migrateLegacyKey(target: ProviderKeyTarget, config: ApiConfig | ClaudeApiConfig): void {
    if (
      config.activeProvider === "custom"
      && config.customApiKey
      && !this.dependencies.keys.get(target, config.customProviderId)
    ) {
      this.dependencies.keys.set(target, config.customProviderId, config.customApiKey);
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
    const storedKey = providerRouteMatches(
      this.dependencies.getSettings().apiConfig,
      apiConfig.customProviderId,
      apiConfig.customBaseUrl,
    )
      ? this.dependencies.keys.get("codex", apiConfig.customProviderId)
      : "";
    if (storedKey) return { ...apiConfig, customApiKey: storedKey };
    const credential = await this.operations.resolveCodexProviderCredential({
      codexHome: apiConfig.customConfigDir || undefined,
      providerId: apiConfig.customProviderId,
      baseUrl: apiConfig.customBaseUrl,
      preferConfiguredHelper: true,
    });
    return credential.apiKey ? { ...apiConfig, customApiKey: credential.apiKey } : apiConfig;
  }

  private shouldUseChatProxy(apiConfig: ApiConfig): boolean {
    return apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
  }

  private async ensureChatProxy(apiConfig: ApiConfig): Promise<CodexChatProxyStatus> {
    const run = this.chatProxyLifecycle.then(() => this.startOrReuseChatProxy(apiConfig));
    this.chatProxyLifecycle = run.catch(() => undefined);
    return run;
  }

  private async startOrReuseChatProxy(apiConfig: ApiConfig): Promise<CodexChatProxyStatus> {
    if (!apiConfig.customApiKey) throw new Error(`API key is required to start ${apiConfig.customProviderName} proxy.`);
    if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to start ${apiConfig.customProviderName} proxy.`);

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

    await this.stopChatProxyNow();
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
      // Without this the summary route cannot remember its own config directory, so the panel
      // could never tell an explicitly chosen directory from the default.
      "customConfigDir",
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

  private async validSavedConfigDirectory(
    settingPath: string,
    configuredPath: string | undefined,
    defaultDirectoryName: ".codex" | ".claude",
  ): Promise<string> {
    const value = configuredPath?.trim() ?? "";
    if (!value || await this.operations.providerConfigDirectoryExists(value, defaultDirectoryName)) return value;
    this.dependencies.settings.set(settingPath, "");
    return "";
  }

  private hasSavedSummaryConfig(settings: AppSettings): boolean {
    return settings.summarySource === "custom"
      && settings.summaryApiConfig.activeProvider === "custom"
      && Boolean(settings.summaryApiConfig.customBaseUrl.trim() || settings.summaryApiConfig.customModel.trim());
  }
}
