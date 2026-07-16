import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_API_PROVIDER_PRESETS,
  defaultClaudeApiConfig,
  normalizeClaudeApiConfig,
} from "./api-config";
import { applyClaudeApiConfig, loadClaudeApiConfigDefaults } from "./claude-profile";

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
    expect(normalizeClaudeApiConfig({ activeProvider: "custom", customProviderId: "missing" }).customProviderId).toBe("custom");
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
});
