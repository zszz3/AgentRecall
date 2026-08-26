import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionSearchResult } from "./types";
import {
  defaultSettings,
  getRemoteMigrationCliVersionCommand,
  getResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
} from "./platform";

describe("app settings", () => {
  it("loads NVM before probing a migration CLI over SSH", () => {
    expect(getRemoteMigrationCliVersionCommand("codex", ["--version"])).toBe(
      'bash -lc \'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; codex --version\'',
    );
  });

  it.skipIf(process.platform === "win32")("probes bare migration CLI names through the user shell PATH", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-migration-cli-"));
    const appBin = path.join(root, "app-bin");
    const userBin = path.join(root, "user-bin");
    const shell = path.join(root, "test-shell");
    const previous = {
      path: process.env.PATH,
      shell: process.env.SHELL,
      userBin: process.env.AGENT_RECALL_TEST_CLI_BIN,
    };
    try {
      mkdirSync(appBin);
      mkdirSync(userBin);
      writeFileSync(path.join(appBin, "claude"), "#!/bin/sh\nexit 9\n");
      writeFileSync(path.join(userBin, "claude"), "#!/bin/sh\nprintf '2.1.233 (Claude Code)\\n'\n");
      // Startup files print unrelated paths around the lookup result.
      writeFileSync(
        shell,
        "#!/bin/sh\nprintf 'Restored session from /Users/example/.zsh_history\\n'\n"
          + "printf '%s/claude\\n' \"$AGENT_RECALL_TEST_CLI_BIN\"\nprintf '/opt/homebrew/bin/node\\n'\n",
      );
      chmodSync(path.join(appBin, "claude"), 0o755);
      chmodSync(path.join(userBin, "claude"), 0o755);
      chmodSync(shell, 0o755);
      process.env.PATH = appBin;
      process.env.SHELL = shell;
      process.env.AGENT_RECALL_TEST_CLI_BIN = userBin;

      await expect(inspectMigrationCli("claude", defaultSettings)).resolves.toBeUndefined();
    } finally {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previous.shell;
      if (previous.userBin === undefined) delete process.env.AGENT_RECALL_TEST_CLI_BIN;
      else process.env.AGENT_RECALL_TEST_CLI_BIN = previous.userBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps WorkBuddy indexing opt-in while accepting an explicit enable", () => {
    expect(defaultSettings.includeWorkBuddy).toBe(false);
    expect(mergeAppSettings(defaultSettings, { includeWorkBuddy: true }).includeWorkBuddy).toBe(true);
  });

  it("keeps Qwen Code indexing opt-in while accepting an explicit enable", () => {
    expect(defaultSettings.includeQwenCode).toBe(false);
    expect(mergeAppSettings(defaultSettings, { includeQwenCode: true }).includeQwenCode).toBe(true);
  });

  it("keeps StepCode opt-in and resumes Codex and Claude sessions through the StepCode wrapper", () => {
    expect(defaultSettings.includeStepcode).toBe(false);
    const session = {
      source: "stepcode-codex",
      rawId: "native-codex-session",
      projectPath: "/repo",
      environmentId: "local",
      environmentKind: "local",
    } as SessionSearchResult;

    expect(getResumeCommand(session, {
      ...defaultSettings,
      includeStepcode: true,
      stepcodeBinary: "/opt/stepcode",
    }, { platform: "darwin" })).toBe(
      "cd /repo && /opt/stepcode codex resume native-codex-session",
    );

    expect(getResumeCommand({
      ...session,
      source: "stepcode-claude",
      rawId: "native-claude-session",
    }, {
      ...defaultSettings,
      includeStepcode: true,
      stepcodeBinary: "/opt/stepcode",
    }, { platform: "darwin" })).toBe(
      "cd /repo && /opt/stepcode claude --resume native-claude-session",
    );
  });

  it("starts every summary source on the machine's own config directory", () => {
    expect(defaultSettings.summarySource).toBe("codex");
    expect(defaultSettings.summaryCodexConfigDir).toBe("");
    expect(defaultSettings.summaryClaudeConfigDir).toBe("");
    expect(defaultSettings.summaryCodexModel).toBe("");
    expect(defaultSettings.summaryClaudeModel).toBe("");
  });

  it("keeps the Codex and Claude summary directories independent of each other", () => {
    const merged = mergeAppSettings(defaultSettings, { summaryClaudeConfigDir: "~/alt-claude" });
    expect(merged.summaryClaudeConfigDir).toBe("~/alt-claude");
    // Pointing the Claude source somewhere must not drag the Codex source along with it, or the
    // two sources stop being independent the moment the user switches between them.
    expect(merged.summaryCodexConfigDir).toBe("");
    expect(merged.apiConfig.customConfigDir).toBe(defaultSettings.apiConfig.customConfigDir);
    expect(merged.claudeApiConfig.customConfigDir).toBe(defaultSettings.claudeApiConfig.customConfigDir);
  });

  it("keeps an unrecognized reasoning effort out of the summary request", () => {
    expect(mergeAppSettings(defaultSettings, { summaryReasoningEffort: "high" }).summaryReasoningEffort)
      .toBe("high");
    // "" is the real "let the model decide" choice, so anything unknown has to land there rather
    // than on an arbitrary level the upstream may reject.
    expect(mergeAppSettings(defaultSettings, { summaryReasoningEffort: "" }).summaryReasoningEffort).toBe("");
    expect(
      mergeAppSettings(defaultSettings, { summaryReasoningEffort: "turbo" as never }).summaryReasoningEffort,
    ).toBe("");
  });

  it("adopts the OpenViking effort once so an existing install keeps the level it had", () => {
    const legacy = { ...defaultSettings, openVikingExtractionReasoningEffort: "ultra" as const };
    delete (legacy as Partial<typeof legacy>).summaryReasoningEffort;

    const merged = mergeAppSettings(legacy as typeof defaultSettings, {});

    expect(merged.summaryReasoningEffort).toBe("ultra");
    // Seeding is one-way: the two settings are separate features and must not track each other
    // afterwards, or changing the memory-extraction effort would silently rewrite summaries.
    expect(
      mergeAppSettings(merged, { openVikingExtractionReasoningEffort: "low" }).summaryReasoningEffort,
    ).toBe("ultra");
  });

  it("trims the summary directories so a stray space is not read as a custom path", () => {
    const merged = mergeAppSettings(defaultSettings, {
      summaryCodexConfigDir: "  ",
      summaryClaudeModel: "  claude-opus-4-8  ",
    });
    expect(merged.summaryCodexConfigDir).toBe("");
    expect(merged.summaryClaudeModel).toBe("claude-opus-4-8");
  });
});
