import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanAgentModelImports } from "./agent-model-imports";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

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

/** CC Switch keeps every app's providers in one SQLite table, each row's settings in that app's own shape. */
async function putCcSwitch(rows: Array<{ app: string; name: string; settings: object | string }>) {
  const file = path.join(home, ".cc-switch", "cc-switch.db");
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("create table providers (id text, app_type text, name text, settings_config text, sort_index integer, created_at integer)");
  const insert = db.prepare("insert into providers values (?, ?, ?, ?, ?, ?)");
  rows.forEach((row, index) => insert.run(`p${index}`, row.app, row.name, typeof row.settings === "string" ? row.settings : JSON.stringify(row.settings), index, index));
  db.close();
}

function summary(imports: Awaited<ReturnType<typeof scanAgentModelImports>>["imports"]) {
  return imports.map(({ service, apiKey }) => ({ name: service.name, host: service.host, sources: service.sources, apiKey, choices: service.choices }));
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

  it("imports the keyed providers CC Switch keeps for each app and merges them with the same service elsewhere", async () => {
    await putCcSwitch([
      { app: "claude", name: "default", settings: { env: { ANTHROPIC_BASE_URL: "https://gw.example.com/", ANTHROPIC_AUTH_TOKEN: "gw-key", ANTHROPIC_MODEL: "claude-x", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-h" } } },
      { app: "claude", name: "Claude Official", settings: { env: {} } },
      { app: "codex", name: "ChatGPT login", settings: { auth: { auth_mode: "chatgpt", OPENAI_API_KEY: null }, config: 'model = "gpt-x"\n' } },
      { app: "codex", name: "Relay", settings: { auth: { OPENAI_API_KEY: "relay-key" }, config: 'model = "gpt-r"\nmodel_provider = "relay"\n\n[model_providers.relay]\nbase_url = "https://relay.example.com/v1"\nwire_api = "chat"\n' } },
      { app: "codex", name: "Team", settings: { auth: { OPENAI_API_KEY: "team-key" }, config: 'model = "gpt-t"\nmodel_provider = "team"\n\n[model_providers.team]\nbase_url = "https://team.example.com/v1"\nhttp_headers = { "X-Team" = "a" }\n' } },
      { app: "gemini", name: "Gemini key", settings: { env: { GEMINI_API_KEY: "g-key", GEMINI_MODEL: "gemini-2.5-pro" } } },
      { app: "gemini", name: "Gemini relay", settings: { env: { GEMINI_API_KEY: "gr-key", GOOGLE_GEMINI_BASE_URL: "https://gem.example.com" } } },
      { app: "opencode", name: "Moon", settings: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://moon.example.com/v1", apiKey: "moon-key" }, models: { "moon-1": {} } } },
      { app: "opencode", name: "Env key", settings: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://env.example.com/v1", apiKey: "{env:ENV_KEY}" }, models: { e1: {} } } },
      { app: "pi", name: "Pi relay", settings: { baseUrl: "https://relay.example.com/v1", apiKey: "relay-key", api: "openai-responses", models: [{ id: "gpt-r" }] } },
      { app: "hermes", name: "Broken", settings: "{not json" },
    ]);
    await put(".codex/config.toml", 'model = "gpt-r"\nmodel_provider = "relay"\n\n[model_providers.relay]\nname = "Relay in Codex"\nbase_url = "https://relay.example.com/v1"\nwire_api = "chat"\nexperimental_bearer_token = "relay-key"\n');

    const result = await scanAgentModelImports(home, {});

    expect(result.problems).toEqual([
      { source: "cc-switch", message: '"Team" needs custom request headers or query parameters, which AgentRecall does not send, so it was not imported.' },
      { source: "cc-switch", message: 'The CC Switch settings of "Broken" are not valid JSON.' },
    ]);
    const custom = (model: string, baseUrl: string, api: string) => ({ provider: "custom", model, baseUrl, api });
    expect(summary(result.imports)).toEqual([
      { name: "Gemini key", host: "generativelanguage.googleapis.com", sources: ["cc-switch"], apiKey: "g-key", choices: [{ config: { provider: "google", model: "gemini-2.5-pro", baseUrl: "", api: "openai-completions" }, label: "gemini-2.5-pro" }] },
      // CC Switch names the live configuration it took over "default", which says nothing about the service.
      { name: "gw.example.com", host: "gw.example.com", sources: ["cc-switch"], apiKey: "gw-key", choices: ["claude-x", "claude-h"].map((model) => ({ config: custom(model, "https://gw.example.com", "anthropic-messages"), label: model })) },
      { name: "Moon", host: "moon.example.com", sources: ["cc-switch"], apiKey: "moon-key", choices: [{ config: custom("moon-1", "https://moon.example.com", "anthropic-messages"), label: "moon-1" }] },
      {
        name: "Relay in Codex",
        host: "relay.example.com",
        sources: ["codex", "cc-switch"],
        apiKey: "relay-key",
        choices: [
          { config: custom("gpt-r", "https://relay.example.com/v1", "openai-completions"), label: "gpt-r · Chat Completions" },
          { config: custom("gpt-r", "https://relay.example.com/v1", "openai-responses"), label: "gpt-r · Responses" },
        ],
      },
    ]);
  });

  it("imports Pi-format providers from Pi and StepCode without running key commands", async () => {
    const piDirectory = path.join(home, "pi-agent");
    await put("pi-agent/models.json", {
      providers: {
        relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: "RELAY_KEY", models: [{ id: "r1" }] },
        command: { baseUrl: "https://cmd.example.com", api: "anthropic-messages", apiKey: "!security find-generic-password -w", models: [{ id: "c1" }] },
        unset: { baseUrl: "https://unset.example.com/v1", api: "openai-completions", apiKey: "UNSET_KEY", models: [{ id: "u1" }] },
      },
    });
    await put("pi-agent/auth.json", { deepseek: { type: "api_key", key: "ds-key" }, anthropic: { type: "oauth", access: "token" } });
    await put(".stepcode/models.json", {
      providers: {
        "stepcode-chat": { baseUrl: "https://step.example.com/v1", api: "openai-completions", models: [{ id: "s1" }, { id: "s2" }] },
        // magpie routes agents through its own local gateway; AgentRecall would only reach magpie, not the service.
        magpie: { name: "magpie", baseUrl: "http://127.0.0.1:3425/v1", api: "openai-completions", apiKey: "magpie-local", models: [{ id: "group/x" }] },
      },
    });
    await put(".stepcode/auth.json", { "stepcode-chat": { type: "api_key", key: "step-key" }, step: { type: "oauth", access: "token" } });
    await put(".local/share/opencode/auth.json", { deepseek: { type: "api", key: "ds-key" }, "fireworks-ai": { type: "api", key: "fw-key" }, zai: { type: "api", key: "z-key" }, anthropic: { type: "oauth", access: "token" } });

    const result = await scanAgentModelImports(home, { PI_CODING_AGENT_DIR: piDirectory, RELAY_KEY: "relay-key" });

    expect(result.problems).toEqual([]);
    expect(result.imports.map(({ service, apiKey }) => [service.sources, apiKey, service.choices.map((choice) => choice.config.provider === "custom" ? `${choice.config.baseUrl} ${choice.config.model}` : `${choice.config.provider} ${choice.config.model}`)])).toEqual([
      [["pi", "opencode"], "ds-key", ["deepseek deepseek-flash"]],
      // OpenCode's provider ids are models.dev's; only those whose address matches the listed provider are imported.
      [["opencode"], "fw-key", [expect.stringMatching(/^fireworks /)]],
      [["pi"], "relay-key", ["https://relay.example.com/v1 r1"]],
      [["stepcode"], "step-key", ["https://step.example.com/v1 s1", "https://step.example.com/v1 s2"]],
    ]);
  });
});
