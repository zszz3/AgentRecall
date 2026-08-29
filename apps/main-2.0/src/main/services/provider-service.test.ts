import { access, readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../../core/platform";
import { ProviderService, type ProviderServiceOperations } from "./provider-service";

function cloneSettings(): AppSettings {
  return structuredClone(defaultSettings);
}

function createHarness(
  settings: AppSettings = cloneSettings(),
  extraOperations: Partial<ProviderServiceOperations> = {},
) {
  const keys = new Map<string, string>();
  const getKey = vi.fn(async (target: "codex" | "claude", providerId: string) => (
    keys.get(`${target}:${providerId}`) ?? ""
  ));
  const savedSettings = new Map<string, unknown>();
  const operations: Partial<ProviderServiceOperations> = {
    providerConfigDirectoryExists: vi.fn(async () => true),
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
      credentialSource: null,
      hasApiKey: false,
    })),
    loadClaudeConfigSnapshot: vi.fn(async () => ({
      claudeHome: "/tmp/claude",
      settingsPath: "/tmp/claude/settings.json",
      exists: false,
      route: {},
      credentialSource: null,
      hasApiKey: false,
    })),
    probeCodexModels: vi.fn(async () => ({
      models: ["codex-model-a"],
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
    applyCodexApiConfig: vi.fn(async () => ({
      profile: "generated",
      codexHome: "/tmp/codex",
      authSource: null,
      configSource: null,
      authTarget: "/tmp/codex/auth.json",
      configTarget: "/tmp/codex/config.toml",
      backupPaths: [],
      credentialSource: "config.toml deepseek.auth.command",
      verified: true as const,
    })),
    applyClaudeApiConfig: vi.fn(async () => ({
      profile: "custom",
      claudeHome: "/tmp/claude",
      settingsPath: "/tmp/claude/settings.json",
      backupPaths: [],
      credentialSource: "API key field",
      verified: true as const,
    })),
  };
  Object.assign(operations, extraOperations);
  const service = new ProviderService({
    getSettings: () => settings,
    keys: {
      get: getKey,
      set: async (target, providerId, apiKey) => {
        keys.set(`${target}:${providerId}`, apiKey);
      },
    },
    settings: {
      has: (path) => savedSettings.has(path),
      get: (path) => savedSettings.get(path),
      set: (path, value) => {
        savedSettings.set(path, value);
      },
    },
    logError: vi.fn(),
    operations,
  });
  return { service, settings, keys, getKey, savedSettings, operations };
}

describe("ProviderService local config directories", () => {
  it("drops deleted saved config directories and reloads the machine-local profiles", async () => {
    const settings = cloneSettings();
    settings.apiConfig.customConfigDir = "/deleted/codex-home";
    settings.claudeApiConfig.customConfigDir = "/deleted/claude-home";
    const harness = createHarness(settings);
    vi.mocked(harness.operations.providerConfigDirectoryExists!).mockResolvedValue(false);

    const hydrated = await harness.service.hydrateSettings();

    expect(hydrated.apiConfig.customConfigDir).toBe("");
    expect(hydrated.claudeApiConfig.customConfigDir).toBe("");
    expect(harness.operations.loadCodexProfileDefaults).toHaveBeenCalledWith(undefined);
    expect(harness.operations.loadClaudeApiConfigDefaults).toHaveBeenCalledWith(undefined);
    expect(harness.savedSettings.get("apiConfig.customConfigDir")).toBe("");
    expect(harness.savedSettings.get("claudeApiConfig.customConfigDir")).toBe("");
  });

  it("lets active local profiles replace stale saved provider fields", async () => {
    const settings = cloneSettings();
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Saved Codex",
      customBaseUrl: "https://saved.example/v1",
      customModel: "saved-codex-model",
    };
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
    vi.mocked(harness.operations.loadCodexProfileDefaults!).mockResolvedValue({
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: "Local Codex",
      customBaseUrl: "https://local.example/v1",
      customModel: "local-codex-model",
      customApiFormat: "openai_responses",
    });
    vi.mocked(harness.operations.loadClaudeApiConfigDefaults!).mockResolvedValue({
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
});

describe("summary Claude route isolation", () => {
  it("probes with the summary key store and the summary config directory", async () => {
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

    // Reading the Claude tab's key or directory here would make the summary panel report a
    // route the summary run never uses.
    expect(harness.operations.probeClaudeModels).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "summary-key",
      claudeHome: "/tmp/summary-claude",
      apiKeySource: "AgentRecall summary key store",
    }));
  });

  it("leaves the Claude tab probe on the Claude key store and directory", async () => {
    const settings = cloneSettings();
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "claude-tab-provider",
      customConfigDir: "/tmp/claude-tab",
      customBaseUrl: "https://claude.example",
    };
    settings.summaryClaudeConfigDir = "/tmp/summary-claude";
    const harness = createHarness(settings);
    harness.keys.set("claude:claude-tab-provider", "claude-tab-key");
    harness.keys.set("summary:claude-tab-provider", "summary-key");

    await harness.service.probeClaudeModels({
      baseUrl: "https://claude.example",
      apiKey: "",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(harness.operations.probeClaudeModels).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "claude-tab-key",
      claudeHome: "/tmp/claude-tab",
    }));
  });

  it("treats an empty summary directory as the machine's own ~/.claude", async () => {
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

    // Falling through to the Claude tab's directory would silently make "follow this machine"
    // mean "follow the other tab".
    expect(harness.operations.probeClaudeModels).toHaveBeenCalledWith(expect.objectContaining({
      claudeHome: undefined,
    }));
  });

  it("keeps the summary Codex probe off the Codex tab's directory", async () => {
    const settings = cloneSettings();
    settings.apiConfig = { ...settings.apiConfig, customConfigDir: "/tmp/codex-tab" };
    settings.summaryCodexConfigDir = "/tmp/summary-codex";
    const harness = createHarness(settings);

    await harness.service.probeCodexModels({
      baseUrl: "https://summary.example",
      apiKey: "",
      keyTarget: "summary",
    });

    expect(harness.operations.probeCodexModels).toHaveBeenCalledWith(expect.objectContaining({
      codexHome: "/tmp/summary-codex",
    }));
  });
});

describe("provider model probe credential routes", () => {
  it("uses stored Codex and Claude keys only for exact routes", async () => {
    const settings = cloneSettings();
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "gateway",
      customBaseUrl: "https://api.example/v1",
    };
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "gateway",
      customBaseUrl: "https://api.example/anthropic",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:gateway", "codex-key");
    harness.keys.set("claude:gateway", "claude-key");

    await harness.service.probeCodexModels({
      baseUrl: "https://other.example/v1",
      apiKey: "",
      providerId: "gateway",
    });
    await harness.service.probeClaudeModels({
      baseUrl: "https://other.example/anthropic",
      apiKey: "",
      providerId: "gateway",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });
    await harness.service.probeCodexModels({
      baseUrl: "https://other.example/v1",
      apiKey: "explicit-codex",
      providerId: "gateway",
    });
    await harness.service.probeClaudeModels({
      baseUrl: "https://other.example/anthropic",
      apiKey: "explicit-claude",
      providerId: "gateway",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      apiKey: "",
      providerId: "gateway",
      apiKeySource: undefined,
    }));
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      apiKey: "",
      providerId: "gateway",
      apiKeySource: undefined,
    }));
    expect(harness.operations.probeCodexModels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      apiKey: "explicit-codex",
      apiKeySource: "API key field",
    }));
    expect(harness.operations.probeClaudeModels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      apiKey: "explicit-claude",
      apiKeySource: "API key field",
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
    vi.mocked(harness.operations.requestSummaryCompletion!).mockImplementation(async (endpoint) => {
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
    const claudeEndpoint = vi.mocked(harness.operations.requestSummaryCompletion!).mock.calls[1]?.[0];
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
    vi.mocked(harness.operations.requestSummaryCompletion!).mockImplementation(async (endpoint) => {
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
    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion!).mock.calls[0][0];
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
    vi.mocked(harness.operations.loadCodexConfigSnapshot!).mockResolvedValue({
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
    vi.mocked(harness.operations.loadCodexConfigSnapshot!).mockResolvedValue({
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
    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion!).mock.calls[0][0];
    expect(endpoint.cliArgs).not.toContain("--ignore-user-config");
    expect(harness.getKey).not.toHaveBeenCalled();
    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("config.toml gateway.auth");
  });

  it("does not send official CLI authentication to a new third-party route", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.resolveCodexProviderCredential!).mockResolvedValue({
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
    vi.mocked(harness.operations.loadClaudeConfigSnapshot!).mockResolvedValue({
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

    const endpoint = vi.mocked(harness.operations.requestSummaryCompletion!).mock.calls[0][0];
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
    vi.mocked(harness.operations.loadClaudeConfigSnapshot!).mockResolvedValue({
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
    vi.mocked(harness.operations.resolveClaudeProviderCredential!).mockResolvedValue({
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

describe("ProviderService Codex profile", () => {
  it("keeps helper-backed apply from promoting a generic resolver fallback into the API key field", async () => {
    const harness = createHarness();
    vi.mocked(harness.operations.resolveCodexProviderCredential!).mockImplementation(async (input) => (
      input.preferConfiguredHelper
        ? { apiKey: "", source: "config.toml deepseek.auth.command" }
        : { apiKey: "unrelated-login-key", source: "auth.json OPENAI_API_KEY" }
    ));

    await harness.service.applyCodexProfile({
      ...defaultSettings.apiConfig,
      activeProvider: "custom",
      customProviderId: "deepseek",
      customProviderName: "DeepSeek",
      customBaseUrl: "https://api.deepseek.com",
      customApiKey: "",
      customModel: "deepseek-v4-flash",
      customApiFormat: "openai_responses",
    });

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

  it("does not inject stored keys into changed Codex or Claude routes", async () => {
    const settings = cloneSettings();
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customBaseUrl: "https://old.example/v1",
      customApiKey: "",
      customApiFormat: "openai_responses",
    };
    settings.claudeApiConfig = {
      ...settings.claudeApiConfig,
      activeProvider: "custom",
      customProviderId: "custom",
      customBaseUrl: "https://old.example/anthropic",
      customApiKey: "",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:custom", "old-codex-key");
    harness.keys.set("claude:custom", "old-claude-key");

    await harness.service.applyCodexProfile({
      ...settings.apiConfig,
      customBaseUrl: "https://new.example/v1",
    });
    await harness.service.applyClaudeProfile({
      ...settings.claudeApiConfig,
      customBaseUrl: "https://new.example/anthropic",
    });

    expect(harness.operations.applyCodexApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new.example/v1",
        customApiKey: "",
      }),
    });
    expect(harness.operations.applyClaudeApiConfig).toHaveBeenCalledWith({
      apiConfig: expect.objectContaining({
        customBaseUrl: "https://new.example/anthropic",
        customApiKey: "",
      }),
    });
  });
});

describe("summary connection test credentials", () => {
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

  it("resolves the Claude source against its own directory and key slot", async () => {
    const settings = cloneSettings();
    settings.summaryClaudeConfigDir = "/tmp/summary-claude";
    settings.claudeApiConfig = { ...settings.claudeApiConfig, customConfigDir: "/tmp/claude-tab" };
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "claude-provider",
      customBaseUrl: "https://summary.example/v1",
    };
    const harness = createHarness(settings);
    harness.keys.set("summary:claude-provider", "summary-key");
    vi.mocked(harness.operations.resolveClaudeProviderCredential!).mockResolvedValue({
      apiKey: "summary-key",
      source: "AgentRecall summary key store",
    });

    const result = await harness.service.testSummaryProviderConnection({
      source: "claude",
      baseUrl: "https://summary.example/v1",
      apiKey: "",
      model: "claude-opus-4-8",
      providerId: "claude-provider",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(harness.operations.resolveClaudeProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      claudeHome: "/tmp/summary-claude",
      apiKey: "summary-key",
    }));
    expect(result.credentialSource).toBe("AgentRecall summary key store");
  });

  it("borrows the Codex tab's credential only when the custom source inherits", async () => {
    const settings = cloneSettings();
    settings.apiConfig = {
      ...settings.apiConfig,
      activeProvider: "custom",
      customProviderId: "shared-provider",
      customBaseUrl: "https://summary.example/v1",
      customConfigDir: "/tmp/codex-tab",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:shared-provider", "codex-tab-key");
    harness.keys.set("summary:shared-provider", "summary-key");
    vi.mocked(harness.operations.resolveCodexProviderCredential!).mockResolvedValue({
      apiKey: "codex-tab-key",
      source: "AgentRecall codex key store",
    });

    await harness.service.testSummaryProviderConnection({
      source: "custom",
      baseUrl: "https://summary.example/v1",
      apiKey: "",
      model: "summary-model",
      providerId: "shared-provider",
      apiFormat: "openai_chat",
      inherit: true,
    });

    expect(harness.operations.resolveCodexProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      codexHome: "/tmp/codex-tab",
      apiKey: "codex-tab-key",
    }));
  });

  it("uses the summary key slot for a custom source that does not inherit", async () => {
    const settings = cloneSettings();
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "shared-provider",
      customBaseUrl: "https://summary.example/v1",
    };
    const harness = createHarness(settings);
    harness.keys.set("codex:shared-provider", "codex-tab-key");
    harness.keys.set("summary:shared-provider", "summary-key");

    const result = await harness.service.testSummaryProviderConnection({
      source: "custom",
      baseUrl: "https://summary.example/v1",
      apiKey: "",
      model: "summary-model",
      providerId: "shared-provider",
      apiFormat: "openai_chat",
    });

    // A non-inheriting custom route resolves its key directly, without consulting the Codex tab.
    expect(harness.operations.resolveCodexProviderCredential).not.toHaveBeenCalled();
    expect(result.credentialSource).toBe("AgentRecall summary key store");
    expect(harness.operations.requestSummaryCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "summary-key", model: "summary-model" }),
      expect.anything(),
      expect.anything(),
    );
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

  it("refuses the Gemini native format instead of testing a different one", async () => {
    const settings = cloneSettings();
    settings.summaryApiConfig = {
      ...settings.summaryApiConfig,
      activeProvider: "custom",
      customProviderId: "gemini-provider",
      customBaseUrl: "https://summary.example/v1",
    };
    const harness = createHarness(settings);
    harness.keys.set("summary:gemini-provider", "summary-key");
    vi.mocked(harness.operations.resolveClaudeProviderCredential!).mockResolvedValue({
      apiKey: "summary-key",
      source: "AgentRecall summary key store",
    });

    await expect(harness.service.testSummaryProviderConnection({
      source: "claude",
      baseUrl: "https://summary.example/v1",
      apiKey: "",
      model: "gemini-3-pro",
      providerId: "gemini-provider",
      apiFormat: "gemini_native",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    })).rejects.toThrow(/Gemini native format/);
    expect(harness.operations.requestSummaryCompletion).not.toHaveBeenCalled();
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
