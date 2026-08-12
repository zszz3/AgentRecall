import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_API_PROVIDER_PRESETS,
  defaultClaudeApiConfig,
  normalizeClaudeApiConfig,
} from "./api-config";
import { applyClaudeApiConfig, loadClaudeApiConfigDefaults, loadClaudeConfigSnapshot, probeClaudeModels } from "./claude-profile";

async function withClaudeHome<T>(run: (claudeHome: string) => Promise<T>): Promise<T> {
  const claudeHome = await mkdtemp(path.join(tmpdir(), "agent-recall-claude-"));
  try {
    return await run(claudeHome);
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
}

async function readSettings(claudeHome: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("Claude Code provider switching", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps common Claude provider presets from cc-switch available", () => {
    expect(CLAUDE_API_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "custom",
      "deepseek",
      "zhipu_glm",
      "longcat",
      "kimi",
      "xiaomi_mimo",
    ]);
    expect(CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")).toMatchObject({
      providerName: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-pro",
      haikuModel: "deepseek-v4-flash",
      sonnetModel: "deepseek-v4-pro",
      opusModel: "deepseek-v4-pro",
      apiFormat: "anthropic",
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });
  });

  it("normalizes Claude provider config while preserving unknown custom routes", () => {
    expect(normalizeClaudeApiConfig(null)).toEqual(defaultClaudeApiConfig);
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: "deepseek" }).customProviderId).toBe("deepseek");
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: "internal-gateway" }).customProviderId).toBe("internal-gateway");
    // Quoted TOML section names make spaces legal, so only characters that would break the
    // section name we generate fall back to the "custom" id.
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: "My Proxy" }).customProviderId).toBe("My Proxy");
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: 'bad"id' }).customProviderId).toBe("custom");
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: "  " }).customProviderId).toBe("custom");
  });

  it("loads current Claude Code route defaults from settings.json", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
              ANTHROPIC_AUTH_TOKEN: "sk-kimi",
              ANTHROPIC_MODEL: "kimi-k2.6",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.6",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.6",
              ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.6",
            },
          },
          null,
          2,
        ),
      );

      await expect(loadClaudeApiConfigDefaults(claudeHome)).resolves.toMatchObject({
        activeProvider: "custom",
        customProviderId: "kimi",
        customProviderName: "kimi",
        customBaseUrl: "https://api.moonshot.cn/anthropic",
        customApiKey: "sk-kimi",
        customModel: "kimi-k2.6",
        customHaikuModel: "kimi-k2.6",
        customSonnetModel: "kimi-k2.6",
        customOpusModel: "kimi-k2.6",
        customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
      });
    });
  });

  it("uses the same process environment route as the Runtime local config", async () => {
    await withClaudeHome(async (claudeHome) => {
      await expect(loadClaudeApiConfigDefaults(claudeHome, {
        ANTHROPIC_BASE_URL: "https://runtime.example/anthropic",
        ANTHROPIC_AUTH_TOKEN: "runtime-key",
        ANTHROPIC_MODEL: "runtime-model",
      })).resolves.toMatchObject({
        activeProvider: "custom",
        customBaseUrl: "https://runtime.example/anthropic",
        customApiKey: "runtime-key",
        customModel: "runtime-model",
      });
    });
  });

  it("loads a Claude config snapshot with the manual route and settings path", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
            ANTHROPIC_AUTH_TOKEN: "sk-manual",
            ANTHROPIC_MODEL: "custom-model",
          },
        }),
      );

      const snapshot = await loadClaudeConfigSnapshot(claudeHome);
      expect(snapshot.claudeHome).toBe(claudeHome);
      expect(snapshot.settingsPath).toBe(path.join(claudeHome, "settings.json"));
      expect(snapshot.exists).toBe(true);
      expect(snapshot.route).toMatchObject({
        activeProvider: "custom",
        customProviderName: "api.example.com",
        customBaseUrl: "https://api.example.com/anthropic",
        customApiKey: "",
        customModel: "custom-model",
      });
      expect(snapshot.hasApiKey).toBe(true);
      expect(snapshot.credentialSource).toBe("settings.json env.ANTHROPIC_AUTH_TOKEN");
    });
  });

  it("loads an empty Claude config snapshot when settings.json is missing", async () => {
    await withClaudeHome(async (claudeHome) => {
      const snapshot = await loadClaudeConfigSnapshot(claudeHome);
      expect(snapshot.exists).toBe(false);
      expect(snapshot.route).toEqual({});
    });
  });

  it("loads unknown Claude Code routes as editable custom providers", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: "https://proxy.example.com",
              ANTHROPIC_AUTH_TOKEN: "sk-pool",
            },
            model: "opus[1m]",
          },
          null,
          2,
        ),
      );

      await expect(loadClaudeApiConfigDefaults(claudeHome)).resolves.toMatchObject({
        activeProvider: "custom",
        customProviderId: "custom",
        customProviderName: "proxy.example.com",
        customBaseUrl: "https://proxy.example.com",
        customApiKey: "sk-pool",
        customModel: "opus[1m]",
      });
    });
  });

  it("does not treat a top-level Claude model as a custom route by itself", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "opus" }, null, 2));

      await expect(loadClaudeApiConfigDefaults(claudeHome)).resolves.toMatchObject({
        activeProvider: "official",
      });
    });
  });

  it("ignores malformed Claude settings when only loading defaults", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(path.join(claudeHome, "settings.json"), "{nope");

      await expect(loadClaudeApiConfigDefaults(claudeHome)).resolves.toEqual({});
    });
  });

  it("applies a Claude preset by updating provider env while preserving the rest of settings.json", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_API_KEY: "old-key",
              ANTHROPIC_BASE_URL: "https://old.example",
              CLAUDE_CODE_EFFORT_LEVEL: "max",
            },
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
            },
            statusLine: { type: "command", command: "agent-recall-claude-statusline" },
          },
          null,
          2,
        ),
      );
      await chmod(path.join(claudeHome, "settings.json"), 0o600);

      const result = await applyClaudeApiConfig({
        claudeHome,
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "deepseek",
          customApiKey: "sk-deepseek",
        },
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      const settings = await readSettings(claudeHome);
      expect(settings.hooks).toEqual({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      });
      expect(settings.statusLine).toEqual({ type: "command", command: "agent-recall-claude-statusline" });
      expect(settings.env).toMatchObject({
        CLAUDE_CODE_EFFORT_LEVEL: "max",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      });
      expect(settings.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      await expect(readFile(path.join(claudeHome, "backups/settings.json.before-deepseek-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toContain(
        "old-key",
      );
      expect((await stat(path.join(claudeHome, "settings.json"))).mode & 0o777).toBe(0o600);
      expect(result.profile).toBe("deepseek");
    });
  });

  it("applies the official Claude profile by clearing route env keys only", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_AUTH_TOKEN: "old-key",
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
              ANTHROPIC_MODEL: "deepseek-v4-pro",
              CLAUDE_CODE_EFFORT_LEVEL: "max",
            },
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
            },
          },
          null,
          2,
        ),
      );

      const result = await applyClaudeApiConfig({
        claudeHome,
        apiConfig: { activeProvider: "official" },
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      const settings = await readSettings(claudeHome);
      expect(settings.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "max" });
      expect(settings.hooks).toEqual({
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      });
      expect(result.profile).toBe("claude-official");
    });
  });

  it("detects models with the credential already stored in Claude settings", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_API_KEY: "stored-key" } }),
      );

      const result = await probeClaudeModels(
        {
          claudeHome,
          baseUrl: "https://api.example.com/anthropic",
          apiKey: "",
          apiFormat: "anthropic",
          apiKeyField: "ANTHROPIC_API_KEY",
        },
        async (_url, init) => {
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer stored-key",
            "x-api-key": "stored-key",
            "anthropic-version": "2023-06-01",
          });
          return { ok: true, status: 200, async json() { return { models: ["claude-sonnet-4.6"] }; } };
        },
      );

      expect(result).toMatchObject({
        models: ["claude-sonnet-4.6"],
        credentialSource: "settings.json env.ANTHROPIC_API_KEY",
      });
    });
  });

  it("writes and verifies a custom route in the selected Claude config directory", async () => {
    await withClaudeHome(async (claudeHome) => {
      await writeFile(
        path.join(claudeHome, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "stored-key" }, hooks: { Stop: [] } }),
      );

      const result = await applyClaudeApiConfig({
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "internal-gateway",
          customConfigDir: claudeHome,
          customProviderName: "Internal Gateway",
          customBaseUrl: "https://api.example.com/anthropic",
          customApiKey: "",
          customModel: "claude-sonnet-4.6",
          customHaikuModel: "claude-haiku-4.5",
          customSonnetModel: "claude-sonnet-4.6",
          customOpusModel: "claude-opus-4.6",
          customApiFormat: "anthropic",
          customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
        },
      });

      expect(result).toMatchObject({
        profile: "internal-gateway",
        claudeHome,
        credentialSource: "settings.json env.ANTHROPIC_AUTH_TOKEN",
        verified: true,
      });
      const settings = await readSettings(claudeHome);
      expect(settings.hooks).toEqual({ Stop: [] });
      expect(settings.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: "stored-key",
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        ANTHROPIC_MODEL: "claude-sonnet-4.6",
      });
    });
  });
});
