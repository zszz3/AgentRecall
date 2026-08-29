import { access, readdir } from "node:fs/promises";
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
    credentialSource: "API key field",
    verified: true as const,
  };
}

function claudeApplyResult() {
  return {
    profile: "claude-official",
    claudeHome: "/tmp/claude",
    settingsPath: "/tmp/claude/settings.json",
    backupPaths: [],
    credentialSource: null,
    verified: true as const,
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

function createHarness(
  settings: AppSettings = cloneSettings(),
  extraOperations: Partial<ProviderServiceOperations> = {},
) {
  const keys = new Map<string, string>();
  const getKey = vi.fn((target: "codex" | "claude", providerId: string) => (
    keys.get(`${target}:${providerId}`) ?? ""
  ));
  const savedSettings = new Map<string, unknown>();
  const settingsWrites: Array<{ path: string; value: unknown }> = [];
  const proxies: Array<CodexChatProxyPort & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const operations: ProviderServiceOperations = {
    providerConfigDirectoryExists: vi.fn(async () => true),
    loadCodexProfileDefaults: vi.fn(async () => ({})),
    loadClaudeApiConfigDefaults: vi.fn(async () => ({})),
    loadClaudeConfigSnapshot: vi.fn(async () => ({
      claudeHome: "/tmp/claude",
      settingsPath: "/tmp/claude/settings.json",
      exists: false,
      route: {},
      credentialSource: null,
      hasApiKey: false,
    })),
    loadCodexConfigSnapshot: vi.fn(async () => ({
      codexHome: "/tmp/codex",
      configPath: "/tmp/codex/config.toml",
      exists: false,
      activeProviderId: "openai",
      activeModel: "",
      activeProvider: null,
      providers: [],
      credentialSource: null,
      hasApiKey: false,
    })),
    probeCodexModels: vi.fn(async () => ({
      models: ["model-a"],
      endpoint: "https://api.example/v1/models",
      endpoints: ["https://api.example/v1/models"],
      credentialSource: "API key field",
    })),
    probeClaudeModels: vi.fn(async () => ({
      models: ["claude-model-a"],
      endpoint: "https://api.example/v1/models",
      endpoints: ["https://api.example/v1/models"],
      credentialSource: "API key field",
    })),
    resolveCodexProviderCredential: vi.fn(async ({ apiKey }) => ({
      apiKey: apiKey || "",
      source: apiKey ? "API key field" : null,
    })),
    resolveClaudeProviderCredential: vi.fn(async ({ apiKey }) => ({
      apiKey: apiKey || "",
      source: apiKey ? "API key field" : null,
    })),
    requestSummaryCompletion: vi.fn(async () => "OK"),
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
  Object.assign(operations, extraOperations);
  const service = new ProviderService({
    getSettings: () => settings,
    keys: {
      get: getKey,
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
  return { service, settings, keys, getKey, savedSettings, settingsWrites, operations, proxies, logError };
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
  it("drops deleted saved config directories and reloads the machine-local profiles", async () => {
    const settings = cloneSettings();
    settings.apiConfig.customConfigDir = "/deleted/codex-home";
    settings.claudeApiConfig.customConfigDir = "/deleted/claude-home";
    const harness = createHarness(settings);
    vi.mocked(harness.operations.providerConfigDirectoryExists).mockResolvedValue(false);

    const hydrated = await harness.service.hydrateSettings();

    expect(hydrated.apiConfig.customConfigDir).toBe("");
    expect(hydrated.claudeApiConfig.customConfigDir).toBe("");
    expect(harness.operations.loadCodexProfileDefaults).toHaveBeenCalledWith(undefined);
    expect(harness.operations.loadClaudeApiConfigDefaults).toHaveBeenCalledWith(undefined);
    expect(harness.settingsWrites).toEqual([
      { path: "apiConfig.customConfigDir", value: "" },
      { path: "claudeApiConfig.customConfigDir", value: "" },
    ]);
  });

  it("lets active local profiles replace stale saved provider fields", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({
      customProviderName: "Saved Codex",
      customBaseUrl: "https://saved.example/v1",
      customModel: "saved-codex-model",
    });
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Saved Claude",
      customBaseUrl: "https://saved.example/anthropic",
      customModel: "saved-claude-model",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:custom", "stale-codex-key");
    harness.keys.set("claude:custom", "stale-claude-key");
    for (const [path, value] of [
      ["apiConfig.customProviderName", settings.apiConfig.customProviderName],
      ["apiConfig.customBaseUrl", settings.apiConfig.customBaseUrl],
      ["apiConfig.customModel", settings.apiConfig.customModel],
      ["claudeApiConfig.customProviderName", settings.claudeApiConfig.customProviderName],
      ["claudeApiConfig.customBaseUrl", settings.claudeApiConfig.customBaseUrl],
      ["claudeApiConfig.customModel", settings.claudeApiConfig.customModel],
    ] as const) harness.savedSettings.set(path, value);
    vi.mocked(harness.operations.loadCodexProfileDefaults).mockResolvedValue({
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Local Codex",
      customBaseUrl: "https://local.example/v1",
      customModel: "local-codex-model",
      customApiFormat: "openai_responses",
    });
    vi.mocked(harness.operations.loadClaudeApiConfigDefaults).mockResolvedValue({
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Local Claude",
      customBaseUrl: "https://local.example/anthropic",
      customModel: "local-claude-model",
      customApiFormat: "anthropic",
    });

    const hydrated = await harness.service.hydrateSettings();

    expect(hydrated.apiConfig).toMatchObject({
      customProviderName: "Local Codex",
      customBaseUrl: "https://local.example/v1",
      customApiKey: "",
      customModel: "local-codex-model",
    });
    expect(hydrated.claudeApiConfig).toMatchObject({
      customProviderName: "Local Claude",
      customBaseUrl: "https://local.example/anthropic",
      customApiKey: "",
      customModel: "local-claude-model",
    });
  });

  it("hydrates local profile defaults and injects separately stored keys", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "", customModel: "" });
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customBaseUrl: "https://api.deepseek.com/anthropic",
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
    expect(hydrated.summaryApiConfig.customApiKey).toBe("");
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
    settings.summarySource = "custom";
    settings.summaryApiConfigMode = "custom";
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
    settings.summaryApiConfigMode = "custom";
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
      { path: "summaryApiConfig.customApiKey", value: "" },
      { path: "summaryApiConfigMode", value: "inherit_codex" },
    ]);
  });

  it("uses a saved Codex key only for its exact route while allowing an explicit key", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({
      customProviderId: "deepseek",
      customBaseUrl: "https://api.example/v1",
    });
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "saved-key");

    await harness.service.probeCodexModels({
      baseUrl: "https://api.example/v1/",
      apiKey: "",
      providerId: "deepseek",
    });
    await harness.service.probeCodexModels({
      baseUrl: "https://other.example/v1",
      apiKey: "",
      providerId: "deepseek",
    });
    await harness.service.probeCodexModels({
      baseUrl: "https://other.example/v1",
      apiKey: "explicit-key",
      providerId: "deepseek",
    });

    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://api.example/v1/",
      apiKey: "saved-key",
      providerId: "deepseek",
      codexHome: undefined,
      apiKeySource: "AgentRecall codex key store",
    });
    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://other.example/v1",
      apiKey: "",
      providerId: "deepseek",
      codexHome: undefined,
      apiKeySource: undefined,
    });
    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(3, {
      baseUrl: "https://other.example/v1",
      apiKey: "explicit-key",
      providerId: "deepseek",
      codexHome: undefined,
      apiKeySource: "API key field",
    });
  });

  it("uses a saved Claude key only for its exact route while allowing an explicit key", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "gateway",
      customBaseUrl: "https://api.example/anthropic",
    };
    const harness = createHarness(settings);
    harness.keys.set("claude:gateway", "saved-key");

    await harness.service.probeClaudeModels({
      baseUrl: "https://api.example/anthropic/",
      apiKey: "",
      providerId: "gateway",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });
    await harness.service.probeClaudeModels({
      baseUrl: "https://other.example/anthropic",
      apiKey: "",
      providerId: "gateway",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });
    await harness.service.probeClaudeModels({
      baseUrl: "https://other.example/anthropic",
      apiKey: "explicit-key",
      providerId: "gateway",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      apiKey: "saved-key",
      providerId: "gateway",
      apiKeySource: "AgentRecall claude key store",
    }));
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      apiKey: "",
      providerId: "gateway",
      apiKeySource: undefined,
    }));
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(3, expect.objectContaining({
      apiKey: "explicit-key",
      providerId: "gateway",
      apiKeySource: "API key field",
    }));
  });

  it("loads defaults and snapshots from each saved custom config directory", async () => {
    const settings = cloneSettings();
    settings.apiConfig.customConfigDir = "/tmp/custom-codex";
    settings.claudeApiConfig.customConfigDir = "/tmp/custom-claude";
    const harness = createHarness(settings);

    await harness.service.hydrateSettings();
    await harness.service.getCodexConfig();
    await harness.service.getClaudeConfig({ configDir: "/tmp/override-claude" });

    expect(harness.operations.loadCodexProfileDefaults).toHaveBeenCalledWith("/tmp/custom-codex");
    expect(harness.operations.loadClaudeApiConfigDefaults).toHaveBeenCalledWith("/tmp/custom-claude");
    expect(harness.operations.loadCodexConfigSnapshot).toHaveBeenCalledWith("/tmp/custom-codex");
    expect(harness.operations.loadClaudeConfigSnapshot).toHaveBeenCalledWith("/tmp/override-claude");
  });

  it("keeps inherited and independent summary credentials isolated", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({
      customProviderId: "dms",
      customBaseUrl: "https://api.example/v1",
      customApiKey: "",
    });
    settings.summaryApiConfig = customCodexConfig({
      customProviderId: "dms",
      customBaseUrl: "https://api.example/v1",
      customApiKey: "",
    });
    const harness = createHarness(settings);
    harness.keys.set("codex:dms", "codex-key");
    harness.keys.set("summary:dms", "summary-key");

    await harness.service.probeCodexModels({
      baseUrl: "https://api.example/v1",
      apiKey: "",
      providerId: "dms",
      keyTarget: "codex",
    });
    await harness.service.probeCodexModels({
      baseUrl: "https://api.example/v1",
      apiKey: "",
      providerId: "dms",
      keyTarget: "summary",
    });

    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      apiKey: "codex-key",
      apiKeySource: "AgentRecall codex key store",
    }));
    // The summary target keeps its own stored key but still gets to fall back to the
    // Codex config, which is what used to make its "Detect models" button fail outright.
    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      apiKey: "summary-key",
      apiKeySource: "AgentRecall summary key store",
    }));
  });

  it("probes the summary Claude route with its own key store and directory", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "claude-tab-provider",
      customConfigDir: "/tmp/claude-tab",
      customBaseUrl: "https://claude.example",
    };
    settings.summaryClaudeConfigDir = "/tmp/summary-claude";
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "summary-provider",
      customBaseUrl: "https://summary.example",
    };
    const harness = createHarness(settings);
    harness.keys.set("claude:claude-tab-provider", "claude-tab-key");
    harness.keys.set("summary:summary-provider", "summary-key");

    await harness.service.probeClaudeModels({
      baseUrl: "https://summary.example",
      apiKey: "",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
      keyTarget: "summary",
    });
    await harness.service.probeClaudeModels({
      baseUrl: "https://claude.example",
      apiKey: "",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });

    // Reading the Claude tab's key or directory for a summary probe would make the panel report
    // a route the summary run never uses.
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      apiKey: "summary-key",
      claudeHome: "/tmp/summary-claude",
      apiKeySource: "AgentRecall summary key store",
    }));
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      apiKey: "claude-tab-key",
      claudeHome: "/tmp/claude-tab",
    }));
  });

  it("treats an empty summary Claude directory as the machine's own ~/.claude", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = { ...settings.claudeApiConfig, customConfigDir: "/tmp/claude-tab" };
    settings.summaryClaudeConfigDir = "";
    const harness = createHarness(settings);

    await harness.service.probeClaudeModels({
      baseUrl: "https://summary.example",
      apiKey: "",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
      keyTarget: "summary",
    });

    // Falling through to the Claude tab's directory would silently turn "follow this machine"
    // into "follow the other tab".
    expect(harness.operations.probeClaudeModels).toHaveBeenCalledWith(expect.objectContaining({
      claudeHome: undefined,
    }));
  });
});

describe("Provider connection tests", () => {
  it("uses each official CLI in an empty, tool-free probe without reading an API key", async () => {
    const settings = cloneSettings();
    settings.codexBinary = "custom-codex";
    settings.claudeBinary = "custom-claude";
    const harness = createHarness(settings);
    const testCwds: string[] = [];
    vi.mocked(harness.operations.requestSummaryCompletion).mockImplementation(async (endpoint) => {
      expect(endpoint.cwd).toContain("agent-recall-provider-test-");
      expect(await readdir(endpoint.cwd!)).toEqual([]);
      testCwds.push(endpoint.cwd!);
      return "OK";
    });

    const codex = await harness.service.testProviderConnection({
      target: "codex",
      apiConfig: { activeProvider: "official", customConfigDir: "/tmp/provider-codex" },
    });
    const claude = await harness.service.testProviderConnection({
      target: "claude",
      apiConfig: { activeProvider: "official", customConfigDir: "/tmp/provider-claude" },
    });

    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(harness.operations.resolveClaudeProviderCredential).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        apiFormat: "codex_exec",
        command: "custom-codex",
        env: { CODEX_HOME: "/tmp/provider-codex" },
        cliArgs: expect.arrayContaining([
          "--ignore-user-config",
          "features.shell_tool=false",
          "features.unified_exec=false",
          "features.apps=false",
          "features.remote_plugin=false",
          "features.multi_agent=false",
          "features.hooks=false",
          'web_search="disabled"',
          "tools.view_image=false",
          "mcp_servers={}",
          "project_doc_max_bytes=0",
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(harness.operations.requestSummaryCompletion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiFormat: "claude_exec",
        command: "custom-claude",
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/provider-claude", ANTHROPIC_BASE_URL: "" }),
        cliArgs: expect.arrayContaining(["--safe-mode", "--tools", "", "--no-session-persistence", "--settings"]),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(codex.credentialSource).toBe("Codex CLI authentication");
    expect(claude.credentialSource).toBe("Claude Code CLI authentication");
    const claudeEndpoint = vi.mocked(harness.operations.requestSummaryCompletion).mock.calls[1]?.[0];
    expect(claudeEndpoint?.cliArgs?.slice(0, 4)).toEqual([
      "--safe-mode",
      "--tools",
      "",
      "--no-session-persistence",
    ]);
    const settingsIndex = claudeEndpoint?.cliArgs?.indexOf("--settings") ?? -1;
    const settingsOverride = JSON.parse(claudeEndpoint?.cliArgs?.[settingsIndex + 1] ?? "{}") as Record<string, unknown>;
    expect(settingsOverride).not.toHaveProperty("apiKeyHelper");
    for (const testCwd of testCwds) {
      await expect(access(testCwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("removes the isolated probe directory when a CLI request fails", async () => {
    const harness = createHarness();
    let testCwd = "";
    vi.mocked(harness.operations.requestSummaryCompletion).mockImplementation(async (endpoint) => {
      testCwd = endpoint.cwd!;
      throw new Error("probe failed");
    });

    await expect(harness.service.testProviderConnection({
      target: "codex",
      apiConfig: { activeProvider: "official" },
    })).rejects.toThrow("probe failed");

    expect(testCwd).toContain("agent-recall-provider-test-");
    await expect(access(testCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tests an unsaved Codex route only with the explicitly authorized draft key", async () => {
    const harness = createHarness();
    harness.keys.set("codex:gateway", "stored-key-must-not-be-used");

    const result = await harness.service.testProviderConnection({
      target: "codex",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-codex",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/v1/",
        customApiKey: "typed-key",
        customModel: "gpt-test",
        customApiFormat: "openai_responses",
      },
    });

    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion).mock.calls[0][0];
    expect(endpoint).toEqual(expect.objectContaining({
      apiFormat: "codex_exec",
      modelArg: "gpt-test",
      env: {
        CODEX_HOME: endpoint.cwd,
        OPENAI_API_KEY: "typed-key",
      },
      cliArgs: expect.arrayContaining([
        "--ignore-user-config",
        "features.shell_tool=false",
        "features.unified_exec=false",
        "model_provider=\"agent-recall-connection-test\"",
        "model_providers.agent-recall-connection-test.base_url=\"https://gateway.example/v1\"",
        "model_providers.agent-recall-connection-test.requires_openai_auth=false",
        "model_providers.agent-recall-connection-test.env_key=\"OPENAI_API_KEY\"",
      ]),
    }));
    expect(endpoint.cliArgs?.join(" ")).not.toContain("typed-key");
    expect(harness.getKey).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("API key field");
  });

  it("does not authorize stored keys when the connection-test draft key is empty", async () => {
    const harness = createHarness();
    harness.keys.set("codex:gateway", "stored-codex-key");
    harness.keys.set("claude:gateway", "stored-claude-key");

    await expect(harness.service.testProviderConnection({
      target: "codex",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/v1",
        customApiKey: "",
        customModel: "gpt-test",
        customApiFormat: "openai_responses",
      },
    })).rejects.toThrow(/Write this route to Codex config/);
    await expect(harness.service.testProviderConnection({
      target: "claude",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/anthropic",
        customApiKey: "",
        customModel: "claude-test",
        customApiFormat: "anthropic",
        customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
      },
    })).rejects.toThrow(/Write this route to Claude Code settings/);

    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });

  it("requires a readable draft key for the local Codex Chat proxy even when the disk route matches", async () => {
    const harness = createHarness();
    harness.keys.set("codex:gateway", "stored-key-must-not-be-used");
    vi.mocked(harness.operations.loadCodexConfigSnapshot).mockResolvedValue({
      codexHome: "/tmp/provider-codex",
      configPath: "/tmp/provider-codex/config.toml",
      exists: true,
      activeProviderId: "gateway",
      activeModel: "gpt-test",
      activeProvider: null,
      providers: [{
        id: "gateway",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        wireApi: "chat",
        envKey: "",
        requiresOpenaiAuth: false,
        hasApiKey: true,
        credentialSource: "config.toml gateway.auth",
      }],
      credentialSource: "config.toml gateway.auth",
      hasApiKey: true,
    });

    await expect(harness.service.testProviderConnection({
      target: "codex",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-codex",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/v1",
        customApiKey: "",
        customModel: "gpt-test",
        customApiFormat: "openai_chat",
      },
    })).rejects.toThrow(/uses the local Codex Chat proxy, but no API key was readable/);

    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.loadCodexConfigSnapshot).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });

  it("preserves an existing Codex provider's CLI-managed authentication", async () => {
    const harness = createHarness();
    harness.keys.set("codex:gateway", "stored-key-must-not-be-used");
    vi.mocked(harness.operations.loadCodexConfigSnapshot).mockResolvedValue({
      codexHome: "/tmp/provider-codex",
      configPath: "/tmp/provider-codex/config.toml",
      exists: true,
      activeProviderId: "gateway",
      activeModel: "gpt-test",
      activeProvider: null,
      providers: [{
        id: "gateway",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        wireApi: "responses",
        envKey: "",
        requiresOpenaiAuth: false,
        hasApiKey: true,
        credentialSource: "config.toml gateway.auth",
      }],
      credentialSource: "config.toml gateway.auth",
      hasApiKey: true,
    });

    const result = await harness.service.testProviderConnection({
      target: "codex",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-codex",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/v1",
        customApiKey: "",
        customModel: "gpt-test",
        customApiFormat: "openai_responses",
      },
    });

    expect(harness.operations.requestSummaryCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CODEX_HOME: "/tmp/provider-codex" },
        cliArgs: expect.arrayContaining([
          "features.shell_tool=false",
          "features.unified_exec=false",
          "features.apps=false",
          "features.remote_plugin=false",
          "features.multi_agent=false",
          "features.hooks=false",
          'web_search="disabled"',
          "tools.view_image=false",
          "mcp_servers={}",
          "project_doc_max_bytes=0",
          'model_provider="gateway"',
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion).mock.calls[0][0];
    expect(endpoint.cliArgs).not.toContain("--ignore-user-config");
    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("config.toml gateway.auth");
  });

  it("does not send official CLI authentication to a new third-party route", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.resolveCodexProviderCredential).mockResolvedValue({
      apiKey: "unrelated-key",
      source: "auth.json OPENAI_API_KEY",
    });

    await expect(harness.service.testProviderConnection({
      target: "codex",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "unwritten",
        customProviderName: "Unwritten",
        customBaseUrl: "https://unwritten.example/v1",
        customApiKey: "",
        customModel: "gpt-test",
        customApiFormat: "openai_responses",
      },
    })).rejects.toThrow(/Write this route to Codex config/);
    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });

  it("lets an exact Claude disk route resolve credentials that are not readable from its settings file", async () => {
    const harness = createHarness();
    harness.keys.set("claude:gateway", "stored-key-must-not-be-used");
    vi.mocked(harness.operations.loadClaudeConfigSnapshot).mockResolvedValue({
      claudeHome: "/tmp/provider-claude",
      settingsPath: "/tmp/provider-claude/settings.json",
      exists: true,
      route: {
        activeProvider: "custom",
        customBaseUrl: "https://gateway.example/anthropic",
      },
      credentialSource: "settings.json apiKeyHelper",
      hasApiKey: true,
    });

    const result = await harness.service.testProviderConnection({
      target: "claude",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-claude",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/anthropic/",
        customApiKey: "",
        customModel: "claude-test",
        customApiFormat: "anthropic",
        customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
      },
    });

    expect(harness.operations.requestSummaryCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiFormat: "claude_exec",
        modelArg: "claude-test",
        env: { CLAUDE_CONFIG_DIR: "/tmp/provider-claude" },
        cliArgs: ["--safe-mode", "--tools", "", "--no-session-persistence"],
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.resolveClaudeProviderCredential).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("settings.json apiKeyHelper");
  });

  it("isolates an explicitly authorized Claude draft key from user settings, helpers, OAuth, and arguments", async () => {
    const harness = createHarness();
    harness.keys.set("claude:gateway", "stored-key-must-not-be-used");

    const result = await harness.service.testProviderConnection({
      target: "claude",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-claude",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/anthropic/",
        customApiKey: "typed-key",
        customModel: "claude-test",
        customApiFormat: "anthropic",
        customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
      },
    });

    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion).mock.calls[0][0];
    expect(endpoint.env).toEqual({
      CLAUDE_CONFIG_DIR: endpoint.cwd,
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "typed-key",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(endpoint.cliArgs).toEqual(["--safe-mode", "--tools", "", "--no-session-persistence"]);
    expect(endpoint.cliArgs?.join(" ")).not.toContain("typed-key");
    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.resolveClaudeProviderCredential).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("API key field");
  });

  it("does not treat an OAuth-only Claude login as a third-party API key", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.loadClaudeConfigSnapshot).mockResolvedValue({
      claudeHome: "/tmp/provider-claude",
      settingsPath: "/tmp/provider-claude/settings.json",
      exists: true,
      route: {
        activeProvider: "custom",
        customBaseUrl: "https://gateway.example/anthropic",
      },
      credentialSource: null,
      hasApiKey: false,
    });

    await expect(harness.service.testProviderConnection({
      target: "claude",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "gateway",
        customConfigDir: "/tmp/provider-claude",
        customProviderName: "Gateway",
        customBaseUrl: "https://gateway.example/anthropic",
        customApiKey: "",
        customModel: "claude-test",
        customApiFormat: "anthropic",
        customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
      },
    })).rejects.toThrow(/No readable API key/);
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });

  it("does not inject an unrelated Claude resolver key into an unwritten route", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.resolveClaudeProviderCredential).mockResolvedValue({
      apiKey: "unrelated-key",
      source: "environment ANTHROPIC_API_KEY",
    });

    await expect(harness.service.testProviderConnection({
      target: "claude",
      apiConfig: {
        activeProvider: "custom",
        customProviderId: "unwritten",
        customProviderName: "Unwritten",
        customBaseUrl: "https://unwritten.example/anthropic",
        customApiKey: "",
        customModel: "claude-test",
        customApiFormat: "anthropic",
        customApiKeyField: "ANTHROPIC_API_KEY",
      },
    })).rejects.toThrow(/Write this route to Claude Code settings/);
    expect(harness.operations.resolveClaudeProviderCredential).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });
});

describe("summary connection tests", () => {
  it("tests the Codex source through the same CLI path as real summaries", async () => {
    const settings = cloneSettings();
    settings.codexBinary = "custom-codex";
    settings.summaryCodexConfigDir = "";
    const harness = createHarness(settings);

    const result = await harness.service.testSummaryProviderConnection({
      source: "codex",
      baseUrl: "https://unused.example/v1",
      apiKey: "",
      model: "gpt-test",
      apiFormat: "openai_responses",
    });

    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(harness.operations.requestSummaryCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiFormat: "codex_exec",
        command: "custom-codex",
        model: "gpt-test",
        modelArg: "gpt-test",
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.credentialSource).toBe("Codex CLI");
  });

  it("does not reuse a summary key after the Base URL changes", async () => {
    const settings = cloneSettings();
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customBaseUrl: "https://old.example/v1",
    };
    const harness = createHarness(settings);
    harness.keys.set("summary:custom", "old-route-key");

    await expect(harness.service.testSummaryProviderConnection({
      source: "custom",
      baseUrl: "https://new.example/v1",
      apiKey: "",
      model: "summary-model",
      providerId: "custom",
      apiFormat: "openai_chat",
    })).rejects.toThrow(/API key is required/);
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
  });
});

describe("ProviderService Codex Chat proxy lifecycle", () => {
  it("keeps helper-backed apply from promoting a generic resolver fallback into the API key field", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.resolveCodexProviderCredential).mockImplementation(async (input) => (
      input.preferConfiguredHelper
        ? { apiKey: "", source: "config.toml deepseek.auth.command" }
        : { apiKey: "unrelated-login-key", source: "auth.json OPENAI_API_KEY" }
    ));

    await harness.service.applyCodexProfile(customCodexConfig({
      customApiKey: "",
      customApiFormat: "openai_responses",
    }));

    expect(harness.operations.resolveCodexProviderCredential).toHaveBeenCalledWith({
      codexHome: undefined,
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      preferConfiguredHelper: true,
    });
    expect(harness.operations.applyCodexApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({ customApiKey: "" }),
    });
  });

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

  it("starts the chat proxy with a securely stored key when the form is blank", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({ customApiKey: "" });
    const harness = createHarness(settings);
    harness.keys.set("codex:deepseek", "stored-key");

    await harness.service.applyCodexProfile(settings.apiConfig);

    expect(harness.operations.createCodexChatProxy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "stored-key" }));
    expect(harness.operations.applyCodexApiConfig).toHaveBeenCalledWith(expect.objectContaining({
      apiConfig: expect.objectContaining({ customApiKey: "stored-key" }),
    }));
  });

  it("does not inject a stored Codex key after the route Base URL changes", async () => {
    const settings = cloneSettings();
    settings.apiConfig = customCodexConfig({
      customProviderId: "custom",
      customBaseUrl: "https://old.example/v1",
      customApiKey: "",
      customApiFormat: "openai_responses",
    });
    const harness = createHarness(settings);
    harness.keys.set("codex:custom", "old-route-key");

    await harness.service.applyCodexProfile({
      ...settings.apiConfig,
      customBaseUrl: "https://new.example/v1",
    });

    expect(harness.operations.applyCodexApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new.example/v1",
        customApiKey: "",
      }),
    });
    expect(harness.operations.resolveCodexProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "custom",
      baseUrl: "https://new.example/v1",
    }));
  });
});

describe("ProviderService Claude profile", () => {
  it("delegates normalized Claude profile application through the owned operation", async () => {
    const harness = createHarness();
    const config: Partial<ClaudeApiConfig> = { activeProvider: "official" };
    await harness.service.applyClaudeProfile(config);
    expect(harness.operations.applyClaudeApiConfig).toHaveBeenCalledWith({ apiConfig: config });
  });

  it("exposes the current Claude settings.json route as a config snapshot", async () => {
    const harness = createHarness();
    await expect(harness.service.getClaudeConfig()).resolves.toMatchObject({
      settingsPath: "/tmp/claude/settings.json",
      exists: false,
      route: {},
    });
    expect(harness.operations.loadClaudeConfigSnapshot).toHaveBeenCalledTimes(1);
  });

  it("applies Claude with its separately stored key when the form is blank", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "dms",
      customBaseUrl: "https://dms.example/anthropic",
      customApiKey: "",
    };
    const harness = createHarness(settings);
    harness.keys.set("claude:dms", "claude-key");

    await harness.service.applyClaudeProfile(settings.claudeApiConfig);

    expect(harness.operations.applyClaudeApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({ customApiKey: "claude-key" }),
    });
  });

  it("does not inject a stored Claude key after the route Base URL changes", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customBaseUrl: "https://old.example/anthropic",
      customApiKey: "",
    };
    const harness = createHarness(settings);
    harness.keys.set("claude:custom", "old-route-key");

    await harness.service.applyClaudeProfile({
      ...settings.claudeApiConfig,
      customBaseUrl: "https://new.example/anthropic",
    });

    expect(harness.operations.applyClaudeApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new.example/anthropic",
        customApiKey: "",
      }),
    });
  });
});

describe("Codex Chat proxy lifecycle", () => {
  it("starts the proxy only once under concurrent restore calls", async () => {
    const settings = cloneSettings();
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "example-chat",
      customProviderName: "Example Chat",
      customBaseUrl: "https://api.example/v1",
      customModel: "chat-model",
      customApiFormat: "openai_chat",
    };
    const status = {
      running: true,
      host: "127.0.0.1",
      port: 15721,
      baseUrl: "http://127.0.0.1:15721/v1",
      upstreamBaseUrl: "https://api.example/v1",
      model: "chat-model",
    };
    const createCodexChatProxy = vi.fn(() => ({
      start: async () => status,
      stop: async () => undefined,
      getStatus: () => status,
    }));
    const { service, keys } = createHarness(settings, { createCodexChatProxy });
    keys.set("codex:example-chat", "sk-test-key");

    await Promise.all([service.restoreCodexChatProxy(), service.restoreCodexChatProxy()]);

    expect(createCodexChatProxy).toHaveBeenCalledTimes(1);
  });
});
