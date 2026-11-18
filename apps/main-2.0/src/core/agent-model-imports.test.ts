import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanAgentModelImports } from "./agent-model-imports";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "agent-model-imports-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function put(relative: string, content: string | object) {
  const file = path.join(home, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
}

function zcodeProvider(providerId: string, providerName: string, apiKey: string, settings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { providerId, providerName, ...extra, config: { access: { type: "api-key", apiKey }, ...settings } };
}

async function putZcode(providerRules: unknown[], disabledModels: Array<{ providerId: string; modelId: string }> = []) {
  await put(".zcode/v2/provider_config.json", {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: {
        providerModelRules: disabledModels.map((rule) => ({ ...rule, config: { enabled: false } })),
        manualProviderModelRules: [],
      },
    },
  });
}

describe("scanAgentModelImports", () => {
  it("imports what ZCode, DeepSeek Harness, Codex and Claude Code use and merges one key on one host", async () => {
    await putZcode([
      zcodeProvider("gw", "Gateway", "gw-key", { api: { type: "anthropic-messages", baseUrl: "https://gw.example.com/v1/" }, modelOrder: ["claude-x"] }),
      zcodeProvider("deepseek", "DeepSeek", "ds-key", { modelOrder: ["deepseek-flash", "deepseek-v4-pro"] }, { templateId: "deepseek" }),
      zcodeProvider("off", "Off", "off-key", { api: { type: "openai-chat-completions", baseUrl: "https://off.example.com/v1" }, modelOrder: ["m"] }, { enabled: false }),
      { providerId: "glm", providerName: "GLM", config: { access: { type: "zhipu-account", apiKey: "account-token" }, api: { type: "openai-chat-completions", baseUrl: "https://glm.example.com/v4" }, modelOrder: ["glm"] } },
      zcodeProvider("team", "Team gateway", "team-key", { api: { type: "openai-chat-completions", baseUrl: "https://team.example.com/v1", headers: { "X-Team": "a" } }, modelOrder: ["m"] }),
      zcodeProvider("kimi", "Kimi", "kimi-key", { modelOrder: ["kimi-k3"] }, { templateId: "moonshot-kimi" }),
    ], [{ providerId: "deepseek", modelId: "deepseek-v4-pro" }]);
    await put(".zcode/v2/runtime/provider/darwin-arm64/3.16.3/endpoint-abc/zcode-builtin.json", {
      config: {
        providerConfigRules: {
          templateRules: [{
            templateId: "deepseek",
            templateNameMap: { "en-US": "DeepSeek" },
            config: { api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" }, builtinModelIds: ["deepseek-flash"] },
          }],
        },
      },
    });
    await put(".dsh/profiles/desktop/cordis.patch.yml", [
      "- id: llm-deepseek",
      "  config:",
      "    apiKeyEnv: DEEPSEEK_API_KEY",
      "    models: [{ id: deepseek-flash }, { id: deepseek-v4-pro }]",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      gw:",
      "        api: anthropic-messages",
      "        baseURL: https://gw.example.com",
      "        models: [{ id: claude-x }, { id: claude-y }]",
      "      relay:",
      "        displayName: Relay",
      "        api: openai-completions",
      "        baseURL: https://relay.example.com/v1",
      "        apiKeyEnv: RELAY_KEY",
      "        models: [{ id: gpt-x }]",
    ].join("\n"));
    await put(".dsh/profiles/acp/cordis.patch.yml", "[]\n");
    await put(".dsh/.credentials.yaml", "version: 1\nrefs:\n  DEEPSEEK_API_KEY: ds-key\n  GW_API_KEY: gw-key\n");
    await put(".codex/config.toml", [
      'model = "gpt-x"',
      'model_provider = "relay"',
      "",
      "[model_providers.relay]",
      'name = "Relay in Codex"',
      'base_url = "https://relay.example.com/v1"',
      'wire_api = "chat"',
      'experimental_bearer_token = "relay-key"',
    ].join("\n"));
    await put(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: "gw-key", ANTHROPIC_MODEL: "claude-z" } });

    const result = await scanAgentModelImports(home, { RELAY_KEY: "relay-key" });

    expect(result.problems).toEqual([
      { source: "zcode", message: '"Team gateway" needs custom request headers, which AgentRecall does not send, so it was not imported.' },
      { source: "zcode", message: 'The built-in settings of "Kimi" were not found, so it was not imported.' },
    ]);
    expect(result.imports.map((item) => ({ ...item.service, id: undefined, apiKey: item.apiKey }))).toEqual([
      {
        id: undefined,
        apiKey: "ds-key",
        name: "DeepSeek",
        host: "api.deepseek.com",
        sources: ["zcode", "dsh"],
        // The listed DeepSeek provider replaces the same model behind ZCode's Anthropic-format endpoint.
        choices: ["deepseek-flash", "deepseek-v4-pro"].map((model) => ({
          config: { provider: "deepseek", model, baseUrl: "", api: "openai-completions" },
          label: model,
        })),
      },
      {
        id: undefined,
        apiKey: "gw-key",
        name: "Gateway",
        host: "gw.example.com",
        sources: ["zcode", "dsh", "claude-code"],
        choices: ["claude-x", "claude-y", "claude-z"].map((model) => ({
          config: { provider: "custom", model, baseUrl: "https://gw.example.com", api: "anthropic-messages" },
          label: model,
        })),
      },
      {
        id: undefined,
        apiKey: "relay-key",
        name: "Relay",
        host: "relay.example.com",
        sources: ["dsh", "codex"],
        choices: [{ config: { provider: "custom", model: "gpt-x", baseUrl: "https://relay.example.com/v1", api: "openai-completions" }, label: "gpt-x" }],
      },
    ]);
    const services = JSON.stringify(result.imports.map((item) => item.service));
    for (const key of ["gw-key", "ds-key", "relay-key", "off-key", "account-token", "team-key", "kimi-key"]) expect(services).not.toContain(key);
    expect(new Set(result.imports.map((item) => item.service.id)).size).toBe(3);
  });

  it("names each endpoint of a model several endpoints serve and moves catalog endpoints to their provider", async () => {
    await putZcode([
      zcodeProvider("chat", "Relay", "relay-key", { api: { type: "openai-chat-completions", baseUrl: "https://relay.example.com/v1" }, modelOrder: ["m1"] }),
      zcodeProvider("messages", "Relay messages", "relay-key", { api: { type: "anthropic-messages", baseUrl: "https://relay.example.com" }, modelOrder: ["m1"] }),
      zcodeProvider("alt", "Relay alt", "relay-key", { api: { type: "openai-chat-completions", baseUrl: "https://relay.example.com/alt/v1" }, modelOrder: ["m1"] }),
      zcodeProvider("direct", "DeepSeek direct", "ds-key", { api: { type: "openai-chat-completions", baseUrl: "https://API.deepseek.com/" }, modelOrder: ["deepseek-flash"] }),
    ]);

    const { imports } = await scanAgentModelImports(home, {});

    expect(imports.map(({ service }) => [service.name, service.choices.map((choice) => choice.label)])).toEqual([
      ["DeepSeek direct", ["deepseek-flash"]],
      ["Relay", ["m1 · Chat Completions · /v1", "m1 · Anthropic Messages", "m1 · Chat Completions · /alt/v1"]],
    ]);
    expect(imports[0].service.choices[0].config).toEqual({ provider: "deepseek", model: "deepseek-flash", baseUrl: "", api: "openai-completions" });
  });

  it("reports unreadable settings of one agent and still imports the others", async () => {
    await put(".zcode/v2/provider_config.json", "{not json");
    await put(".dsh/profiles/desktop/cordis.patch.yml", "- id: [unclosed");
    await put(".codex/config.toml", 'model = "gpt-5.5"\n');
    await put(".codex/auth.json", { OPENAI_API_KEY: "openai-key" });

    const result = await scanAgentModelImports(home, {});

    expect(result.problems).toEqual([
      { source: "zcode", message: "ZCode provider_config.json is not valid JSON." },
      { source: "dsh", message: "DeepSeek Harness profiles/desktop/cordis.patch.yml is not valid YAML." },
    ]);
    expect(result.imports.map((item) => [item.service.name, item.service.host, item.service.sources, item.apiKey, item.service.choices.map((choice) => choice.config)])).toEqual([
      ["OpenAI", "api.openai.com", ["codex"], "openai-key", [{ provider: "openai", model: "gpt-5.5", baseUrl: "", api: "openai-completions" }]],
    ]);
  });

  it("leaves out a Codex service whose requests need headers it would not get", async () => {
    await put(".codex/config.toml", [
      'model = "gpt-x"',
      'model_provider = "azure"',
      "",
      "[model_providers.azure]",
      'name = "Azure"',
      'base_url = "https://team.openai.azure.com/openai"',
      'experimental_bearer_token = "azure-key"',
      'query_params = { "api-version" = "2025-04-01-preview" }',
    ].join("\n"));

    expect(await scanAgentModelImports(home, {})).toEqual({
      imports: [],
      problems: [{ source: "codex", message: '"Azure" needs custom request headers or query parameters, which AgentRecall does not send, so it was not imported.' }],
    });
  });
});
