import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_PROVIDER_PRESETS, defaultApiConfig, mergeApiConfigWithProfileDefaults, normalizeApiConfig } from "./api-config";
import { applyCodexApiConfig, codexProfileForApiConfig, loadCodexProfileDefaults } from "./codex-profile";

async function withCodexHome<T>(run: (codexHome: string) => Promise<T>): Promise<T> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "agent-session-search-codex-"));
  try {
    return await run(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

describe("codex profile switching", () => {
  it("applies CodexZH into active Codex config without requiring profile template files", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "openai"',
          'model = "gpt-5"',
          "",
          "[mcp_servers.echo]",
          'command = "echo"',
          "",
        ].join("\n"),
      );

      const result = await applyCodexApiConfig({
        codexHome,
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "codexzh",
          customProviderName: "codexzh",
          customBaseUrl: "https://api.codexzh.com/v1",
          customApiKey: "sk-new",
          customModel: "gpt-5.5",
          customApiFormat: "openai_responses",
        },
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "codexzh"');
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain("[model_providers.codexzh]");
      expect(config).toContain('base_url = "https://api.codexzh.com/v1"');
      expect(config).toContain('experimental_bearer_token = "sk-new"');
      expect(config).toContain("[mcp_servers.echo]");
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe("{\"OPENAI_API_KEY\":\"old\"}\n");
      await expect(readFile(path.join(codexHome, "backups/auth.json.before-codexzh-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        "{\"OPENAI_API_KEY\":\"old\"}\n",
      );
      await expect(readFile(path.join(codexHome, "backups/config.toml.before-codexzh-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        ['model_provider = "openai"', 'model = "gpt-5"', "", "[mcp_servers.echo]", 'command = "echo"', ""].join("\n"),
      );
      expect(result.profile).toBe("codexzh");
      expect(result.backupPaths).toHaveLength(2);
    });
  });

  it("overlays CodexZH form fields onto the active config without replacing auth.json", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"official-login\"}\n");
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "codex"',
          'model = "gpt-5"',
          "",
          "[model_providers.codex]",
          'name = "OpenAI"',
          'base_url = "https://api.openai.com/v1"',
          'wire_api = "responses"',
          "",
          "[mcp_servers.echo]",
          'command = "echo"',
          "",
        ].join("\n"),
      );

      await applyCodexApiConfig({
        codexHome,
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "codexzh",
          customProviderName: "  CodexZH  ",
          customBaseUrl: " https://api.codexzh.com/v1 ",
          customApiKey: " sk-new ",
          customModel: " gpt-5.5 ",
          customApiFormat: "openai_responses",
        },
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "codexzh"');
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain("[model_providers.codexzh]");
      expect(config).toContain('name = "CodexZH"');
      expect(config).toContain('base_url = "https://api.codexzh.com/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('experimental_bearer_token = "sk-new"');
      expect(config).toContain("[model_providers.codex]");
      expect(config).toContain("[mcp_servers.echo]");
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe("{\"OPENAI_API_KEY\":\"official-login\"}\n");
    });
  });

  it("maps the app provider choice to local Codex profile names", () => {
    expect(codexProfileForApiConfig({ activeProvider: "official" })).toBe("codex");
    expect(codexProfileForApiConfig({ activeProvider: "custom", customProviderId: "codexzh" })).toBe("generated");
    expect(codexProfileForApiConfig({ activeProvider: "custom", customProviderId: "deepseek" })).toBe("generated");
  });

  it("restores official Codex defaults without requiring profile template files", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "deepseek"',
          'model = "deepseek-v4-flash"',
          'model_reasoning_effort = "high"',
          'experimental_bearer_token = "old-top-level-token"',
          "",
          "[model_providers.deepseek]",
          'name = "deepseek"',
          'base_url = "https://api.deepseek.com"',
          'wire_api = "responses"',
          'experimental_bearer_token = "sk-deepseek"',
          "",
          "[mcp_servers.echo]",
          'command = "echo"',
          "",
        ].join("\n"),
      );

      await applyCodexApiConfig({
        codexHome,
        apiConfig: { activeProvider: "official" },
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).not.toContain('model_provider = "openai"');
      expect(config).not.toContain('model_provider = "deepseek"');
      expect(config).not.toContain('model = "deepseek-v4-flash"');
      expect(config).not.toContain('model_reasoning_effort = "high"');
      expect(config).not.toContain('experimental_bearer_token = "old-top-level-token"');
      expect(config).not.toContain('experimental_bearer_token = "sk-deepseek"');
      expect(config).toContain("[model_providers.deepseek]");
      expect(config).toContain("[mcp_servers.echo]");
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe("{\"OPENAI_API_KEY\":\"old\"}\n");
    });
  });

  it("loads Codex route defaults from active config.toml", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "codexzh"',
          'model = "gpt-5.5"',
          "",
          "[model_providers.codexzh]",
          'name = "codexzh"',
          'base_url = "https://api.codexzh.com/v1"',
          'wire_api = "responses"',
          "",
        ].join("\n"),
      );
      await writeFile(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"profile-key"}\n');

      await expect(loadCodexProfileDefaults(codexHome)).resolves.toMatchObject({
        activeProvider: "custom",
        customProviderName: "codexzh",
        customBaseUrl: "https://api.codexzh.com/v1",
        customModel: "gpt-5.5",
        customApiFormat: "openai_responses",
      });
      await expect(loadCodexProfileDefaults(codexHome)).resolves.not.toHaveProperty("customApiKey");
    });
  });

  it("fills missing non-secret API settings from profile defaults without overriding saved fields", () => {
    expect(
      mergeApiConfigWithProfileDefaults(
        { ...defaultApiConfig, customBaseUrl: "https://saved.example/v1" },
        { customBaseUrl: "https://saved.example/v1" },
        {
          activeProvider: "custom",
          customBaseUrl: "https://profile.example/v1",
          customApiKey: "profile-key",
          customModel: "gpt-5.5",
          customApiFormat: "openai_responses",
        },
      ),
    ).toMatchObject({
      activeProvider: "custom",
      customBaseUrl: "https://saved.example/v1",
      customApiKey: "",
      customModel: "gpt-5.5",
      customApiFormat: "openai_responses",
    });
  });

  it("keeps common provider presets from cc-switch available", () => {
    expect(API_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "codexzh",
      "deepseek",
      "zhipu_glm",
      "longcat",
      "kimi",
      "xiaomi_mimo",
    ]);
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")).toMatchObject({
      providerName: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiFormat: "openai_chat",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "zhipu_glm")).toMatchObject({
      providerName: "zhipu_glm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.1",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "longcat")).toMatchObject({
      providerName: "longcat",
      baseUrl: "https://api.longcat.chat/openai/v1",
      model: "LongCat-Flash-Chat",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "kimi")).toMatchObject({
      providerName: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "xiaomi_mimo")).toMatchObject({
      providerName: "xiaomi_mimo",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
  });

  it("normalizes preset ids and falls back to CodexZH", () => {
    expect(normalizeApiConfig({ activeProvider: "custom", customProviderId: "deepseek" }).customProviderId).toBe("deepseek");
    expect(normalizeApiConfig({ activeProvider: "custom", customProviderId: "missing" }).customProviderId).toBe("codexzh");
  });

  it("merges common providers into the active Codex config without overwriting unrelated sections", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "old"',
          'model = "old-model"',
          'model_reasoning_effort = "medium"',
          "",
          "[model_providers.old]",
          'name = "Old"',
          'base_url = "https://old.example/v1"',
          'wire_api = "responses"',
          "",
          "[mcp_servers.echo]",
          'command = "echo"',
          "",
        ].join("\n"),
      );

      const result = await applyCodexApiConfig({
        codexHome,
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "deepseek",
          customProviderName: "deepseek",
          customBaseUrl: "https://api.deepseek.com",
          customApiKey: "sk-deepseek",
          customModel: "deepseek-v4-flash",
          customApiFormat: "openai_chat",
        },
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "deepseek"');
      expect(config).toContain('model = "deepseek-v4-flash"');
      expect(config).toContain('model_reasoning_effort = "medium"');
      expect(config).toContain("[model_providers.old]");
      expect(config).toContain("[model_providers.deepseek]");
      expect(config).toContain('base_url = "https://api.deepseek.com"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('experimental_bearer_token = "sk-deepseek"');
      expect(config).toContain("[mcp_servers.echo]");
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe("{\"OPENAI_API_KEY\":\"old\"}\n");
      expect(result.profile).toBe("deepseek");
      await expect(readFile(path.join(codexHome, "backups/auth.json.before-deepseek-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        "{\"OPENAI_API_KEY\":\"old\"}\n",
      );
    });
  });

  it("routes Chat Completions providers through the local Codex proxy when available", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(
        path.join(codexHome, "config.toml"),
        [
          'model_provider = "openai"',
          'model = "gpt-5.5"',
          "",
          "[mcp_servers.echo]",
          'command = "echo"',
          "",
        ].join("\n"),
      );

      await applyCodexApiConfig({
        codexHome,
        chatProxyBaseUrl: "http://127.0.0.1:15721/v1",
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "zhipu_glm",
          customProviderName: "zhipu_glm",
          customBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
          customApiKey: "sk-glm",
          customModel: "glm-5.1",
          customApiFormat: "openai_chat",
        },
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "zhipu_glm"');
      expect(config).toContain('model = "glm-5.1"');
      expect(config).toContain('base_url = "http://127.0.0.1:15721/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('experimental_bearer_token = "sk-glm"');
      expect(config).toContain("[mcp_servers.echo]");
    });
  });
});
