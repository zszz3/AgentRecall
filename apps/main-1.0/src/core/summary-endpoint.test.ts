import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, type AppSettings } from "./platform";
import {
  buildClaudeExecEndpoint,
  buildCodexExecEndpoint,
  resolveSummaryEndpointFromSettings,
} from "./summary-endpoint";

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return { ...structuredClone(defaultSettings), ...overrides };
}

describe("summary exec endpoints", () => {
  it("follows the machine's own config directory when no directory is set", () => {
    const codex = buildCodexExecEndpoint(settingsWith({}));
    const claude = buildClaudeExecEndpoint(settingsWith({}));

    // Injecting CODEX_HOME/CLAUDE_CONFIG_DIR here would override whatever the user exported in
    // their own shell, which is the opposite of what "follow the machine" promises.
    expect(codex.env).toBeUndefined();
    expect(claude.env).toBeUndefined();
    expect(codex.modelArg).toBeUndefined();
    expect(claude.modelArg).toBeUndefined();
  });

  it("points each CLI at its own directory without touching the other", () => {
    const settings = settingsWith({
      summaryCodexConfigDir: "/tmp/summary-codex",
      summaryClaudeConfigDir: "/tmp/summary-claude",
    });

    expect(buildCodexExecEndpoint(settings).env).toEqual({ CODEX_HOME: "/tmp/summary-codex" });
    expect(buildClaudeExecEndpoint(settings).env).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/summary-claude" });
  });

  it("expands a leading ~ so a hand-typed path reaches the right directory", () => {
    const codex = buildCodexExecEndpoint(settingsWith({ summaryCodexConfigDir: "~/alt-codex" }));
    const claude = buildClaudeExecEndpoint(settingsWith({ summaryClaudeConfigDir: "~/alt-claude" }));

    expect(codex.env).toEqual({ CODEX_HOME: path.join(os.homedir(), "alt-codex") });
    expect(claude.env).toEqual({ CLAUDE_CONFIG_DIR: path.join(os.homedir(), "alt-claude") });
  });

  it("treats a whitespace-only directory as following the machine", () => {
    expect(buildCodexExecEndpoint(settingsWith({ summaryCodexConfigDir: "   " })).env).toBeUndefined();
    expect(buildClaudeExecEndpoint(settingsWith({ summaryClaudeConfigDir: "   " })).env).toBeUndefined();
  });

  it("passes each source its own model and reasoning level", () => {
    const settings = settingsWith({
      summaryCodexModel: "gpt-5.6-sol",
      summaryClaudeModel: "claude-opus-4-8",
      summaryReasoningEffort: "high",
    });

    const codex = buildCodexExecEndpoint(settings);
    expect(codex.modelArg).toBe("gpt-5.6-sol");
    expect(codex.reasoningEffort).toBe("high");

    // The Claude CLI has no reasoning switch, so sending one would be inventing a flag.
    const claude = buildClaudeExecEndpoint(settings);
    expect(claude.modelArg).toBe("claude-opus-4-8");
    expect(claude.reasoningEffort).toBeUndefined();
  });

  it("sends no reasoning parameter when the user leaves it on the model default", () => {
    expect(buildCodexExecEndpoint(settingsWith({ summaryReasoningEffort: "" })).reasoningEffort).toBeUndefined();
  });
});

describe("resolveSummaryEndpointFromSettings", () => {
  it("routes each source to its own CLI and directory", () => {
    const settings = settingsWith({
      summaryCodexConfigDir: "/tmp/summary-codex",
      summaryClaudeConfigDir: "/tmp/summary-claude",
    });

    const codex = resolveSummaryEndpointFromSettings({ ...settings, summarySource: "codex" });
    expect(codex?.apiFormat).toBe("codex_exec");
    expect(codex?.env).toEqual({ CODEX_HOME: "/tmp/summary-codex" });

    const claude = resolveSummaryEndpointFromSettings({ ...settings, summarySource: "claude" });
    expect(claude?.apiFormat).toBe("claude_exec");
    expect(claude?.env).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/summary-claude" });
  });

  it("keeps a custom route on HTTP and out of both config directories", () => {
    const endpoint = resolveSummaryEndpointFromSettings(settingsWith({
      summarySource: "custom",
      summaryApiConfigMode: "custom",
      summaryCodexConfigDir: "/tmp/summary-codex",
      summaryClaudeConfigDir: "/tmp/summary-claude",
      summaryReasoningEffort: "low",
      summaryApiConfig: {
        ...defaultSettings.summaryApiConfig,
        activeProvider: "custom",
        customBaseUrl: "https://summary.example/v1",
        customModel: "summary-model",
        customApiKey: "summary-key",
      },
    }));

    expect(endpoint?.baseUrl).toBe("https://summary.example/v1");
    expect(endpoint?.model).toBe("summary-model");
    expect(endpoint?.reasoningEffort).toBe("low");
    // A custom route never spawns a CLI, so it must not inherit either CLI's directory.
    expect(endpoint?.env).toBeUndefined();
    expect(endpoint?.command).toBeUndefined();
  });

  it("reports an incomplete custom route instead of quietly producing one", () => {
    const endpoint = resolveSummaryEndpointFromSettings(settingsWith({
      summarySource: "custom",
      summaryApiConfigMode: "custom",
      summaryApiConfig: {
        ...defaultSettings.summaryApiConfig,
        activeProvider: "custom",
        customBaseUrl: "https://summary.example/v1",
        customModel: "",
      },
    }));

    expect(endpoint).toBeNull();
  });

  it("borrows the Codex tab's route when the custom source is set to inherit", () => {
    const endpoint = resolveSummaryEndpointFromSettings(settingsWith({
      summarySource: "custom",
      summaryApiConfigMode: "inherit_codex",
      apiConfig: {
        ...defaultSettings.apiConfig,
        activeProvider: "custom",
        customBaseUrl: "https://codex-tab.example/v1",
        customModel: "codex-tab-model",
        customApiKey: "codex-tab-key",
      },
    }));

    expect(endpoint?.baseUrl).toBe("https://codex-tab.example/v1");
    expect(endpoint?.model).toBe("codex-tab-model");
  });
});
