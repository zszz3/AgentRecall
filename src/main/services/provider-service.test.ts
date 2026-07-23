import { describe, expect, it, vi } from "vitest";
import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { CodexChatProxyOptions, CodexChatProxyStatus } from "../../core/codex-chat-proxy";
import { defaultSettings, type AppSettings } from "../../core/platform";
import {
  ProviderService,
  type CodexChatProxyPort,
  type ProviderServiceOperations,
} from "./provider-service";

function cloneSettings(): AppSettings {
  return structuredClone(defaultSettings);
}

function codexApplyResult() {
  return {
    profile: "generated",
    codexHome: "/tmp/codex",
    authSource: null,
    configSource: null,
    authTarget: "/tmp/codex/auth.json",
    configTarget: "/tmp/codex/config.toml",
    backupPaths: [],
  };
}

function claudeApplyResult() {
  return {
    profile: "claude-official",
    claudeHome: "/tmp/claude",
    settingsPath: "/tmp/claude/settings.json",
    backupPaths: [],
  };
}

function proxyStatus(options: CodexChatProxyOptions): CodexChatProxyStatus {
  return {
    running: true,
    host: options.listenHost ?? "127.0.0.1",
    port: options.listenPort ?? 15721,
    baseUrl: `http://${options.listenHost ?? "127.0.0.1"}:${options.listenPort ?? 15721}/v1`,
    upstreamBaseUrl: options.upstreamBaseUrl.replace(/\/+$/, ""),
    model: options.model,
  };
}

function createHarness(settings: AppSettings = cloneSettings()) {
  const keys = new Map<string, string>();
  const savedSettings = new Map<string, unknown>();
  const settingsWrites: Array<{ path: string; value: unknown }> = [];
  const proxies: Array<CodexChatProxyPort & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const operations: ProviderServiceOperations = {
    loadCodexProfileDefaults: vi.fn(async () => ({})),
    loadClaudeApiConfigDefaults: vi.fn(async () => ({})),
    loadCodexConfigSnapshot: vi.fn(async () => ({
      codexHome: "/tmp/codex",
      configPath: "/tmp/codex/config.toml",
      exists: false,
      activeProviderId: "openai",
      activeModel: "",
      activeProvider: null,
      providers: [],
    })),
    probeCodexModels: vi.fn(async () => ({ models: ["model-a"], endpoint: "https://api.example/v1/models" })),
    applyCodexApiConfig: vi.fn(async () => codexApplyResult()),
    applyClaudeApiConfig: vi.fn(async () => claudeApplyResult()),
    createCodexChatProxy: vi.fn((options) => {
      const status = proxyStatus(options);
      const proxy = {
        start: vi.fn(async () => status),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(() => status),
      };
      proxies.push(proxy);
      return proxy;
    }),
  };
  const logError = vi.fn();
  const service = new ProviderService({
    getSettings: () => settings,
    keys: {
      get: (target, providerId) => keys.get(`${target}:${providerId}`) ?? "",
      set: (target, providerId, apiKey) => keys.set(`${target}:${providerId}`, apiKey),
    },
    settings: {
      has: (path) => savedSettings.has(path),
      get: (path) => savedSettings.get(path),
      set: (path, value) => {
        savedSettings.set(path, value);
        settingsWrites.push({ path, value });
      },
    },
    logError,
    operations,
  });
  return { service, settings, keys, savedSettings, settingsWrites, operations, proxies, logError };
}

function customCodexConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    ...defaultSettings.apiConfig,
    activeProvider: "custom",
    customProviderId: "deepseek",
    customProviderName: "DeepSeek",
    customBaseUrl: "https://api.deepseek.com",
    customApiKey: "secret-key",
    customModel: "deepseek-v4-flash",
    customApiFormat: "openai_chat",
    ...overrides,
  };
}

describe("ProviderService settings and keys", () => {
  it("hydrates local profile defaults and injects separately stored keys", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "", customModel: "" });
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customApiKey: "",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "codex-key");
    harness.keys.set("claude:deepseek", "claude-key");
    harness.keys.set("summary:custom", "summary-key");
    vi.mocked(harness.operations.loadCodexProfileDefaults).mockResolvedValue({ customModel: "profile-model" });

    const hydrated = await harness.service.hydrateSettings();

    expect(hydrated.apiConfig.customModel).toBe("profile-model");
    expect(hydrated.apiConfig.customApiKey).toBe("codex-key");
    expect(hydrated.claudeApiConfig.customApiKey).toBe("claude-key");
    expect(hydrated.summaryApiConfig.customApiKey).toBe("summary-key");
  });

  it("hydrates a saved custom summary provider so summary/search use it", async () => {
    const settings = cloneSettings();
    // The in-memory settings already reflect the persisted custom summary provider.
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customBaseUrl: "https://summary.example/v1",
      customModel: "summary-model",
      customApiKey: "",
      customApiFormat: "openai_responses",
    };
    const harness = createHarness(settings);
    // The saved patch marks the summary fields as user-customized so profile defaults
    // do not clobber them.
    harness.savedSettings.set("summaryApiConfig.activeProvider", "custom");
    harness.savedSettings.set("summaryApiConfig.customBaseUrl", "https://summary.example/v1");
    harness.savedSettings.set("summaryApiConfig.customModel", "summary-model");
    harness.keys.set("summary:custom", "summary-key");
    // A Codex profile default that must NOT override the user's saved summary values.
    vi.mocked(harness.operations.loadCodexProfileDefaults).mockResolvedValue({ customModel: "profile-model" });

    const hydrated = await harness.service.hydrateSettings();

    expect(hydrated.summaryApiConfig.activeProvider).toBe("custom");
    expect(hydrated.summaryApiConfig.customBaseUrl).toBe("https://summary.example/v1");
    expect(hydrated.summaryApiConfig.customModel).toBe("summary-model");
    expect(hydrated.summaryApiConfig.customApiFormat).toBe("openai_responses");
    expect(hydrated.summaryApiConfig.customApiKey).toBe("summary-key");
  });

  it("persists updated custom keys while keeping them out of the settings document", () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "codex-key" });
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customApiKey: "claude-key",
    };
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customApiKey: "summary-key",
    };
    const harness = createHarness(settings);

    harness.service.persistKeysFromUpdate({
      apiConfig: settings.apiConfig,
      claudeApiConfig: settings.claudeApiConfig,
      summaryApiConfig: settings.summaryApiConfig,
    }, settings);
    const safeSettings = harness.service.removeStoredKeys(settings);

    expect(harness.keys).toEqual(new Map([
      ["codex:deepseek", "codex-key"],
      ["claude:deepseek", "claude-key"],
      ["summary:custom", "summary-key"],
    ]));
    expect(safeSettings.apiConfig.customApiKey).toBe("");
    expect(safeSettings.claudeApiConfig.customApiKey).toBe("");
    expect(safeSettings.summaryApiConfig.customApiKey).toBe("");
    expect(settings.apiConfig.customApiKey).toBe("codex-key");
  });

  it("migrates legacy settings keys once without overwriting saved secrets", () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "legacy-codex" });
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customApiKey: "legacy-claude",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "already-saved");

    harness.service.migrateLegacyKeys();

    expect(harness.keys.get("codex:deepseek")).toBe("already-saved");
    expect(harness.keys.get("claude:deepseek")).toBe("legacy-claude");
    expect(harness.settingsWrites).toEqual([
      { path: "apiConfig.customApiKey", value: "" },
      { path: "claudeApiConfig.customApiKey", value: "" },
    ]);
  });

  it("uses the selected saved key for model probing unless an explicit key is supplied", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customProviderId: "deepseek" });
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "saved-key");

    await harness.service.probeCodexModels({
      baseUrl: "https://api.example/v1",
      apiKey: "",
      providerId: "deepseek",
    });
    await harness.service.probeCodexModels({
      baseUrl: "https://api.example/v1",
      apiKey: "explicit-key",
      providerId: "deepseek",
    });

    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://api.example/v1",
      apiKey: "saved-key",
      providerId: "deepseek",
    });
    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://api.example/v1",
      apiKey: "explicit-key",
      providerId: "deepseek",
    });
  });
});

describe("ProviderService Codex Chat proxy lifecycle", () => {
  it("reuses an identical proxy and replaces it only when its effective config changes", async () => {
    const harness = createHarness();
    const config = customCodexConfig();

    await harness.service.applyCodexProfile(config);
    await harness.service.applyCodexProfile(config);

    expect(harness.operations.createCodexChatProxy).toHaveBeenCalledOnce();
    expect(harness.proxies[0].start).toHaveBeenCalledOnce();
    expect(harness.operations.applyCodexApiConfig).toHaveBeenLastCalledWith({
      apiConfig: config,
      chatProxyBaseUrl: "http://127.0.0.1:15721/v1",
    });

    await harness.service.applyCodexProfile({ ...config, customModel: "another-model" });
    expect(harness.proxies).toHaveLength(2);
    expect(harness.proxies[0].stop).toHaveBeenCalledOnce();
    expect(harness.service.getCodexChatProxyStatus()?.model).toBe("another-model");
  });

  it("stops the proxy before applying the official Codex provider", async () => {
    const harness = createHarness();
    await harness.service.applyCodexProfile(customCodexConfig());

    await harness.service.applyCodexProfile({ activeProvider: "official" });

    expect(harness.proxies[0].stop).toHaveBeenCalledOnce();
    expect(harness.service.getCodexChatProxyStatus()).toBeNull();
    expect(harness.operations.applyCodexApiConfig).toHaveBeenLastCalledWith({
      apiConfig: expect.objectContaining({ activeProvider: "official" }),
    });
  });

  it("reports startup restoration failures without rejecting application startup", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "" });
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "saved-key");
    vi.mocked(harness.operations.createCodexChatProxy).mockImplementation((options) => ({
      start: vi.fn(async () => { throw new Error("port unavailable"); }),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => proxyStatus(options)),
    }));

    await expect(harness.service.restoreCodexChatProxy()).resolves.toBeUndefined();
    expect(harness.logError).toHaveBeenCalledWith("Failed to restore Codex Chat proxy: port unavailable");
  });
});

describe("ProviderService Claude profile", () => {
  it("delegates normalized Claude profile application through the owned operation", async () => {
    const harness = createHarness();
    const config: Partial<ClaudeApiConfig> = { activeProvider: "official" };
    await harness.service.applyClaudeProfile(config);
    expect(harness.operations.applyClaudeApiConfig).toHaveBeenCalledWith({ apiConfig: config });
  });
});
