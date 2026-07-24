import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentChannel } from "../../shared/types";
import { RUNTIME_IDS } from "../../shared/runtime-catalog";
import { setCodexChatRouterBaseUrl } from "../bridges/codex-chat-router";
import {
  codexAppServerConfigArgs,
  createDefaultChannels,
  generateCodexConfigs,
  importCodexConfigs,
  loadModelChannels,
  loadCodexDefaultConfig,
  loadClaudeDefaultConfig,
  normalizeChannels,
  parseCodexDefaultConfig,
  parseCodexModelCatalog,
  parseCodexProfileConfig,
  parseClaudeDefaultConfig,
  saveModelChannels,
} from "./model-config";

describe("model channel config", () => {
  test("creates a Hermes Default channel for a fresh installation", () => {
    expect(createDefaultChannels().find((channel) => channel.agentId === "hermes")).toEqual({
      id: "hermes-default",
      agentId: "hermes",
      label: "Hermes Default",
      presetId: "hermes-default",
      models: [{ id: "default", label: "Default" }],
    });
    expect(createDefaultChannels().find((channel) => channel.agentId === "opencode")).toEqual({
      id: "opencode-default",
      agentId: "opencode",
      label: "OpenCode Default",
      presetId: "opencode-default",
      models: [{ id: "default", label: "Default" }],
    });
    expect(createDefaultChannels().find((channel) => channel.agentId === "openclaw")).toEqual({
      id: "openclaw-default",
      agentId: "openclaw",
      label: "OpenClaw Default",
      presetId: "openclaw-default",
      models: [{ id: "default", label: "Default" }],
    });
  });

  test("round-trips custom channels for every registered runtime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-runtime-channels-"));
    const configPath = path.join(dir, "model-channels.json");
    const channels: AgentChannel[] = RUNTIME_IDS.map((agentId) => ({
      id: `${agentId}-custom`,
      agentId,
      label: `${agentId} custom`,
      models: [{ id: "default", label: "Default" }],
    }));

    await saveModelChannels(configPath, channels);
    const restored = await loadModelChannels(configPath);

    expect(restored.map((channel) => channel.id)).toEqual(channels.map((channel) => channel.id));
    expect(restored.map((channel) => channel.agentId)).toEqual(RUNTIME_IDS);
  });

  test("preserves CC Switch compatible runtime provider fields", () => {
    const [channel] = normalizeChannels([
      {
        id: "claude-custom",
        agentId: "claude",
        label: "Claude Custom",
        models: [{ id: "default", label: "Default" }],
        apiFormat: "anthropic",
        apiKeyField: "ANTHROPIC_API_KEY",
        isFullUrl: true,
        customUserAgent: "multi-agent-chat/test",
        environment: { ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-opus" },
        requestOverrides: {
          headers: { "x-provider": "test" },
          body: { service_tier: "priority" },
        },
      },
    ]);

    expect(channel).toMatchObject({
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_API_KEY",
      isFullUrl: true,
      customUserAgent: "multi-agent-chat/test",
      environment: { ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-opus" },
      requestOverrides: {
        headers: { "x-provider": "test" },
        body: { service_tier: "priority" },
      },
    });
  });

  test("parses visible Codex models from the debug catalog", () => {
    const models = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hidden", priority: 1 },
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            priority: 2,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
              { effort: "xhigh", description: "Deep" },
            ],
          },
          { slug: "gpt-5.4-mini", display_name: "GPT-5.4 Mini", visibility: "list", priority: 3 },
        ],
      }),
    );

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        reasoningEfforts: ["low", "medium", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    ]);
  });

  test("adds the current Codex models to persisted official channels with stale provider metadata", () => {
    const [channel] = normalizeChannels([
      {
        id: "codex-official",
        agentId: "codex",
        label: "Codex Official",
        modelProvider: "custom",
        models: [
          { id: "default", label: "Default" },
          { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
          { id: "gpt-5.5", label: "GPT-5.5" },
        ],
      },
    ]);

    expect(channel?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "low",
      }),
      expect.objectContaining({ id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }),
      expect.objectContaining({ id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }),
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]));
  });

  test("collapses persisted Claude provider role models to the primary model", () => {
    const [channel] = normalizeChannels([
      {
        id: "claude-code-deepseek",
        agentId: "claude",
        label: "Claude Code DeepSeek",
        presetId: "claude-code-deepseek",
        providerName: "DeepSeek",
        modelProvider: "deepseek-anthropic",
        baseUrl: "https://api.deepseek.com/anthropic",
        environment: {
          ANTHROPIC_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
        },
        models: [
          { id: "default", label: "Default" },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        ],
      },
    ]);

    expect(channel?.models).toEqual([
      { id: "default", label: "Default" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ]);
  });

  test("generates Codex profile configs for every model in a channel", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-config-"));
    const channels: AgentChannel[] = [
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        modelProvider: "openai",
        providerName: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        wireApi: "responses",
        modelReasoningEffort: "high",
        plugins: [
          { id: "documents@openai-primary-runtime", enabled: true },
          { id: "browser-use@openai-bundled", enabled: false },
        ],
        models: [
          { id: "default", label: "Default" },
          { id: "gpt-5.5", label: "GPT-5.5" },
        ],
      },
      {
        id: "claude-code",
        agentId: "claude",
        label: "Claude Code",
        models: [{ id: "default", label: "Default" }],
      },
    ];

    const generated = await generateCodexConfigs(channels, dir);

    expect(generated.map((item) => item.profileName)).toEqual([
      "multi-agent-codex-openai-default",
      "multi-agent-codex-openai-gpt-5-6-sol",
      "multi-agent-codex-openai-gpt-5-6-terra",
      "multi-agent-codex-openai-gpt-5-6-luna",
      "multi-agent-codex-openai-gpt-5-5",
    ]);

    const gpt55Path = path.join(dir, "multi-agent-codex-openai-gpt-5-5.config.toml");
    const content = await readFile(gpt55Path, "utf8");
    expect(content).toContain('model_provider = "openai"');
    expect(content).toContain('model = "gpt-5.5"');
    expect(content).toContain('model_reasoning_effort = "high"');
    expect(content).toContain('[plugins."documents@openai-primary-runtime"]');
    expect(content).toContain("enabled = true");
    expect(content).toContain('[plugins."browser-use@openai-bundled"]');
    expect(content).toContain("enabled = false");
    expect(content).not.toContain("[model_providers.openai]");
    expect(content).not.toContain('base_url = "https://api.openai.com/v1"');
  });

  test("does not override Codex built-in providers for app-server", () => {
    const channel: AgentChannel = {
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      modelProvider: "openai",
      providerName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      wireApi: "responses",
      modelReasoningEffort: "high",
      httpHeaders: { Authorization: "Bearer $TOKEN" },
      plugins: [
        { id: "documents@openai-primary-runtime", enabled: true },
        { id: "browser-use@openai-bundled", enabled: false },
      ],
      models: [
        { id: "default", label: "Default" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
    };

    expect(codexAppServerConfigArgs(channel, "gpt-5.5")).toEqual([
      "-c",
      'model_provider="openai"',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'plugins."documents@openai-primary-runtime".enabled=true',
      "-c",
      'plugins."browser-use@openai-bundled".enabled=false',
    ]);
    expect(codexAppServerConfigArgs(channel, "gpt-5.5")).not.toContain("--profile");
    expect(codexAppServerConfigArgs(channel, "gpt-5.5").join("\n")).not.toContain("model_providers.openai");
  });

  test("uses an agent reasoning effort override for Codex app-server", () => {
    const channel: AgentChannel = {
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      modelProvider: "openai",
      modelReasoningEffort: "high",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
    };

    const args = codexAppServerConfigArgs(channel, "gpt-5.6-sol", "xhigh");

    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args).not.toContain('model_reasoning_effort="high"');
  });

  test("builds app-server provider overrides for custom providers", () => {
    const channel: AgentChannel = {
      id: "codex-bridge",
      agentId: "codex",
      label: "Codex Bridge",
      modelProvider: "bridge",
      providerName: "Bridge",
      baseUrl: "https://bridge.example/v1",
      wireApi: "responses",
      modelReasoningEffort: "high",
      httpHeaders: { Authorization: "Bearer $TOKEN" },
      models: [
        { id: "default", label: "Default" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
    };

    expect(codexAppServerConfigArgs(channel, "gpt-5.5")).toEqual([
      "-c",
      'model_provider="bridge"',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'model_providers.bridge.name="Bridge"',
      "-c",
      'model_providers.bridge.base_url="https://bridge.example/v1"',
      "-c",
      'model_providers.bridge.wire_api="responses"',
      "-c",
      "model_providers.bridge.requires_openai_auth=true",
      "-c",
      'model_providers.bridge.env_key="OPENAI_API_KEY"',
      "-c",
      'model_providers.bridge.http_headers={ "Authorization" = "Bearer $TOKEN" }',
    ]);
  });

  test("builds isolated app-server args for concurrent Codex provider channels", () => {
    const openaiChannel: AgentChannel = {
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      modelProvider: "openai",
      providerName: "OpenAI",
      models: [
        { id: "default", label: "Default" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ],
    };
    const deepseekChannel: AgentChannel = {
      id: "codex-deepseek",
      agentId: "codex",
      label: "Codex DeepSeek",
      modelProvider: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      wireApi: "responses",
      httpHeaders: { Authorization: "Bearer $DEEPSEEK_API_KEY" },
      models: [
        { id: "default", label: "Default" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      ],
    };

    const openaiArgs = codexAppServerConfigArgs(openaiChannel, "gpt-5.5");
    const deepseekArgs = codexAppServerConfigArgs(deepseekChannel, "deepseek-v4-pro");

    expect(openaiArgs).toEqual(["-c", 'model_provider="openai"', "-c", 'model="gpt-5.5"']);
    expect(openaiArgs.join("\n")).not.toContain("model_providers.openai");
    expect(openaiArgs.join("\n")).not.toContain("deepseek");

    expect(deepseekArgs).toEqual([
      "-c",
      'model_provider="deepseek"',
      "-c",
      'model="deepseek-v4-pro"',
      "-c",
      'model_providers.deepseek.name="DeepSeek"',
      "-c",
      'model_providers.deepseek.base_url="https://api.deepseek.com"',
      "-c",
      'model_providers.deepseek.wire_api="responses"',
      "-c",
      "model_providers.deepseek.requires_openai_auth=true",
      "-c",
      'model_providers.deepseek.env_key="OPENAI_API_KEY"',
      "-c",
      'model_providers.deepseek.http_headers={ "Authorization" = "Bearer $DEEPSEEK_API_KEY" }',
    ]);
    expect(deepseekArgs.join("\n")).not.toContain('model_provider="openai"');
    expect(deepseekArgs.join("\n")).not.toContain("gpt-5.5");
  });

  test("routes custom Codex providers through the local chat router when available", () => {
    const previousRouterUrl = process.env.AGENT_RECALL_CODEX_ROUTER_BASE_URL;
    setCodexChatRouterBaseUrl("http://127.0.0.1:15721/v1");
    const channel: AgentChannel = {
      id: "codex-deepseek",
      agentId: "codex",
      label: "Codex DeepSeek",
      modelProvider: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      wireApi: "responses",
      httpHeaders: { Authorization: "Bearer $DEEPSEEK_API_KEY" },
      models: [
        { id: "default", label: "Default" },
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      ],
    };

    try {
      expect(codexAppServerConfigArgs(channel, "deepseek-v4-flash")).toEqual([
        "-c",
        'model_provider="deepseek"',
        "-c",
        'model="deepseek-v4-flash"',
        "-c",
        'model_providers.deepseek.name="DeepSeek"',
        "-c",
        'model_providers.deepseek.base_url="http://127.0.0.1:15721/v1/codex-deepseek"',
        "-c",
        'model_providers.deepseek.wire_api="responses"',
        "-c",
        "model_providers.deepseek.requires_openai_auth=true",
        "-c",
        'model_providers.deepseek.env_key="OPENAI_API_KEY"',
      ]);
    } finally {
      if (previousRouterUrl === undefined) {
        delete process.env.AGENT_RECALL_CODEX_ROUTER_BASE_URL;
      } else {
        process.env.AGENT_RECALL_CODEX_ROUTER_BASE_URL = previousRouterUrl;
      }
    }
  });

  test("parses an existing Codex profile into an importable channel", () => {
    const imported = parseCodexProfileConfig(
      "/Users/example/.codex/config_bridge.config.toml",
      `
model = "gpt-5.5"
model_provider = "bridge"
model_reasoning_effort = "high"

[model_providers.bridge]
name = "Bridge"
base_url = "https://bridge.example/v1"
wire_api = "responses"
http_headers = { "Authorization" = "Bearer $TOKEN", "X-Test" = "1" }

[plugins."documents@openai-primary-runtime"]
enabled = true

[plugins."browser-use@openai-bundled"]
enabled = false
`,
    );

    expect(imported).toEqual({
      sourcePath: "/Users/example/.codex/config_bridge.config.toml",
      channel: expect.objectContaining({
        id: "codex-config-bridge",
        agentId: "codex",
        label: "Codex config_bridge",
        profileName: "config_bridge",
        modelProvider: "bridge",
        providerName: "Bridge",
        baseUrl: "https://bridge.example/v1",
        wireApi: "responses",
        modelReasoningEffort: "high",
        httpHeaders: {
          Authorization: "Bearer $TOKEN",
          "X-Test": "1",
        },
        plugins: [
          { id: "documents@openai-primary-runtime", enabled: true },
          { id: "browser-use@openai-bundled", enabled: false },
        ],
        models: [
          { id: "default", label: "Default" },
          { id: "gpt-5.5", label: "gpt-5.5" },
        ],
      }),
    });
  });

  test("imports Codex profiles from a Codex home directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-import-"));
    await writeFile(
      path.join(dir, "config.toml"),
      'model_provider = "openai"\n[plugins."documents@openai-primary-runtime"]\nenabled = true\n',
      "utf8",
    );
    await writeFile(path.join(dir, "bridge.config.toml"), 'model_provider = "bridge"\nmodel = "gpt-5.4"\n', "utf8");
    await writeFile(path.join(dir, "config_custom_openai.toml"), 'model_provider = "custom-openai"\n[plugins."browser-use@openai-bundled"]\nenabled = false\n', "utf8");
    await writeFile(path.join(dir, "ignored.toml"), 'model = "gpt-5.5"\n', "utf8");

    const imported = await importCodexConfigs(dir);

    expect(imported.map((item) => item.channel.id)).toEqual([
      "codex-bridge",
      "codex-config",
      "codex-config-custom-openai",
    ]);
    expect(imported.find((item) => item.channel.id === "codex-bridge")?.channel).toMatchObject({
      id: "codex-bridge",
      profileName: "bridge",
      modelProvider: "bridge",
      models: [
        { id: "default", label: "Default" },
        { id: "gpt-5.4", label: "gpt-5.4" },
      ],
    });
    expect(imported.find((item) => item.channel.id === "codex-config")?.channel.plugins).toEqual([
      { id: "documents@openai-primary-runtime", enabled: true },
    ]);
    expect(imported.find((item) => item.channel.id === "codex-config-custom-openai")?.channel.plugins).toEqual([
      { id: "browser-use@openai-bundled", enabled: false },
    ]);
  });

  test("parses the user-level Codex default config and auth key", () => {
    expect(
      parseCodexDefaultConfig(
        `
model_provider = "bridge"
model = "gpt-5.5"
model_reasoning_effort = "high"
model_catalog_json = "{\\"models\\":[]}"
experimental_features = ["provider-routing", "plugins"]

[model_providers.bridge]
name = "Bridge"
base_url = "https://bridge.example/v1"
wire_api = "responses"
http_headers = { "X-Test" = "1" }

[plugins."documents@openai-primary-runtime"]
enabled = true
`,
        JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
      ),
    ).toEqual({
      modelProvider: "bridge",
      providerName: "Bridge",
      baseUrl: "https://bridge.example/v1",
      wireApi: "responses",
      httpHeaders: { "X-Test": "1" },
      apiKey: "sk-test",
      modelId: "gpt-5.5",
      modelCatalogJson: '{"models":[]}',
      modelReasoningEffort: "high",
      plugins: [{ id: "documents@openai-primary-runtime", enabled: true }],
    });
  });

  test("returns null-filled default config when config.toml is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-default-missing-config-"));
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }), "utf8");

    await expect(loadCodexDefaultConfig(dir)).resolves.toEqual({
      modelProvider: null,
      providerName: null,
      baseUrl: null,
      wireApi: null,
      httpHeaders: null,
      apiKey: "sk-test",
      modelId: null,
      modelCatalogJson: null,
      modelReasoningEffort: null,
      plugins: null,
    });
  });

  test("returns null api key when auth.json is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-default-missing-auth-"));
    await writeFile(path.join(dir, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.5"\n', "utf8");

    await expect(loadCodexDefaultConfig(dir)).resolves.toEqual({
      modelProvider: "openai",
      providerName: null,
      baseUrl: null,
      wireApi: null,
      httpHeaders: null,
      apiKey: null,
      modelId: "gpt-5.5",
      modelCatalogJson: null,
      modelReasoningEffort: null,
      plugins: null,
    });
  });

  test("returns null-filled default config when config or auth parsing fails", () => {
    expect(parseCodexDefaultConfig('model_provider = "bridge', '{"OPENAI_API_KEY":"sk-test"')).toEqual({
      modelProvider: null,
      providerName: null,
      baseUrl: null,
      wireApi: null,
      httpHeaders: null,
      apiKey: null,
      modelId: null,
      modelCatalogJson: null,
      modelReasoningEffort: null,
      plugins: null,
    });

    expect(parseCodexDefaultConfig('model_provider = "openai"\n', '{"OPENAI_API_KEY":')).toEqual({
      modelProvider: "openai",
      providerName: null,
      baseUrl: null,
      wireApi: null,
      httpHeaders: null,
      apiKey: null,
      modelId: null,
      modelCatalogJson: null,
      modelReasoningEffort: null,
      plugins: null,
    });
  });

  test("parses built-in OpenAI Codex default config without a provider section", () => {
    expect(parseCodexDefaultConfig('model_provider = "openai"\nmodel = "gpt-5.5"\n', undefined)).toEqual({
      modelProvider: "openai",
      providerName: null,
      baseUrl: null,
      wireApi: null,
      httpHeaders: null,
      apiKey: null,
      modelId: "gpt-5.5",
      modelCatalogJson: null,
      modelReasoningEffort: null,
      plugins: null,
    });
  });

  test("loads Claude Code default provider values from settings and environment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-default-"));
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({
      model: "claude-sonnet-4-6",
      env: {
        ANTHROPIC_BASE_URL: "https://settings.example/anthropic",
        ANTHROPIC_AUTH_TOKEN: "settings-token",
      },
    }), "utf8");

    await expect(loadClaudeDefaultConfig(dir, { ANTHROPIC_AUTH_TOKEN: "env-token" })).resolves.toEqual({
      baseUrl: "https://settings.example/anthropic",
      apiKey: "env-token",
      modelId: "claude-sonnet-4-6",
    });
  });

  test("returns empty Claude Code defaults for invalid settings", () => {
    expect(parseClaudeDefaultConfig("{", {})).toEqual({ baseUrl: null, apiKey: null, modelId: null });
  });
});
