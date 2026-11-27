import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "./session-sources";
import type { SessionSearchResult } from "./types";
import { spawnDetached } from "./platform/shell-quoting";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  openMigrationResumeInTerminal,
  getRemoteMigrationCliVersionCommand,
  getResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
  stampExperienceCardsEnabledAt,
  normalizeWslPollingIntervalMs,
  remoteMigrationSettings,
} from "./platform";

describe("app settings", () => {
  it("builds agy --resume commands for Antigravity CLI sessions across POSIX and Windows shells", () => {
    const session = {
      source: "antigravity-cli",
      rawId: "b31a44b1-8807-416b-b0ac-c0f3471cb886",
      projectPath: "/repo/my app",
    } as SessionSearchResult;
    expect(getResumeCommand(session, defaultSettings, { platform: "darwin" })).toBe(
      "cd '/repo/my app' && agy --resume b31a44b1-8807-416b-b0ac-c0f3471cb886",
    );
    expect(getResumeCommand(session, defaultSettings, { platform: "darwin", skipPermissions: true })).toBe(
      "cd '/repo/my app' && agy --resume b31a44b1-8807-416b-b0ac-c0f3471cb886 --dangerously-skip-permissions",
    );
    expect(getResumeCommand({ ...session, projectPath: "" }, defaultSettings, { platform: "darwin" })).toBe(
      "agy --resume b31a44b1-8807-416b-b0ac-c0f3471cb886",
    );
    expect(
      getResumeCommand(
        { ...session, projectPath: "C:\\workspace\\repo" },
        { ...defaultSettings, defaultTerminal: "PowerShell" },
        { platform: "win32" },
      ),
    ).toBe("cd 'C:\\workspace\\repo'; agy --resume b31a44b1-8807-416b-b0ac-c0f3471cb886");
  });

  it("inspects agy and passes one quoted handoff prompt to the chosen terminal", async () => {
    const homeDir = path.resolve("test home");
    const dir = path.join(homeDir, ".gemini", "antigravity-cli", "handoffs");
    const prompt = `Read the migrated session handoff file at ${path.join(dir, "session.md")} and continue this conversation. Acknowledge once loaded and wait for my next instruction.`;
    const args = ["--add-dir", dir, "-i", prompt];
    const settings = { ...defaultSettings, antigravityCliBinary: "test-agy" };
    const probe = vi.fn(async () => "agy 1.3.5-preview.1");
    await inspectMigrationCli("antigravity", settings, probe);
    expect(probe).toHaveBeenCalledWith("test-agy", ["--version"]);
    for (const terminal of ["Cmd", "PowerShell", "Terminal", "iTerm", "Warp"] as const) {
      const platform = terminal === "Cmd" || terminal === "PowerShell" ? "win32" : "darwin";
      const snapshot = { ...settings, defaultTerminal: terminal };
      const spec = getMigrationResumeProcessSpec("antigravity", "session", "", snapshot, { platform, homeDir });
      expect(spec.args).toEqual(args);
      const quote = terminal === "Cmd" ? '"' : "'";
      const quoted = `${quote}${prompt}${quote}`;
      expect(spec.displayCommand).toContain(quoted);
      expect(getSafeMigrationResumeCommand("antigravity", "session", "", snapshot, { platform, homeDir })).toContain(quoted);
      const launch = vi.fn(async (_command: string, _args: string[]) => {});
      await openMigrationResumeInTerminal("antigravity", "session", "", snapshot, {
        platform, homeDir, runProcess: launch, spawnDetached: launch, resolveMacApplicationName: async () => "iTerm2",
      });
      const command = launch.mock.calls[0][1].at(-1)!;
      if (terminal === "Cmd") {
        const encoded = command.match(/-EncodedCommand (\S+)/)![1];
        expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(`--add-dir '${dir}' -i '${prompt}'`);
      } else {
        expect(command).toContain(platform === "darwin" ? quoted.replaceAll("\\", "\\\\") : quoted);
      }
    }
    const spawnDetached = vi.fn(async () => {});
    await openMigrationResumeInTerminal("antigravity", "session", "", settings, { platform: "linux", homeDir, spawnDetached });
    expect(spawnDetached).toHaveBeenCalledWith("x-terminal-emulator", ["-e", "test-agy", ...args], undefined);
  });

  it("keeps the WSL polling fallback within safe bounds", () => {
    expect(normalizeWslPollingIntervalMs(1)).toBe(5_000);
    expect(normalizeWslPollingIntervalMs(60_001.4)).toBe(60_001);
    expect(normalizeWslPollingIntervalMs(9_000_000)).toBe(3_600_000);
    expect(mergeAppSettings(defaultSettings, { wslPollingIntervalMs: 1 }).wslPollingIntervalMs).toBe(5_000);
  });
  it("keeps NVM as the fallback for migration CLI probes over SSH", () => {
    const command = getRemoteMigrationCliVersionCommand("codex", ["--version"]);
    expect(command).toContain('if [ -s "$HOME/.nvm/nvm.sh" ]');
    expect(command).toContain("codex --version");
  });

  it("gates ZCode migration on the local database instead of a CLI version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-zcode-inspect-"));
    try {
      await expect(inspectMigrationCli("zcode", defaultSettings, undefined, { homeDir: root }))
        .rejects.toThrow(/ZCode database not found/);

      const dbDir = path.join(root, ".zcode", "cli", "db");
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(path.join(dbDir, "db.sqlite"), "");
      await expect(inspectMigrationCli("zcode", defaultSettings, undefined, { homeDir: root }))
        .rejects.toThrow(/ZCode task index not found/);

      const taskIndexDir = path.join(root, ".zcode", "v2");
      mkdirSync(taskIndexDir, { recursive: true });
      writeFileSync(path.join(taskIndexDir, "tasks-index.sqlite"), "");
      await expect(inspectMigrationCli("zcode", defaultSettings, undefined, { homeDir: root })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("runs SSH migration probes and interactive resumes through the user's login shell", () => {
    const probeCommand = getRemoteMigrationCliVersionCommand("codex", ["--version"]);
    expect(probeCommand).toContain('exec "$SHELL" -lic');
    const shellBranch = probeCommand.slice(
      probeCommand.indexOf('exec "$SHELL" -lic'),
      probeCommand.indexOf("; fi;"),
    );
    expect(shellBranch).toContain('. "$HOME/.nvm/nvm.sh"');

    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo",
    } as SessionSearchResult;
    const remoteSettings = {
      ...defaultSettings,
      codexBinary: "/local-only/codex",
      claudeBinary: "/local-only/claude",
    };
    const command = getResumeCommand(session, remoteSettings, {
      platform: "darwin",
      sshArgs: ["-tt", "--", "alice@example.com"],
    });

    expect(command).not.toContain("/local-only/codex");
    expect(command).toContain("ssh -tt -- 'alice@example.com'");
    expect(command).toContain('exec "$SHELL" -lic');
    expect(command).toContain("cd /repo && codex resume codex-1");

    const claudeCommand = getResumeCommand({
      ...session,
      source: "claude-cli",
      rawId: "claude-1",
    }, remoteSettings, {
      platform: "darwin",
      sshArgs: ["-tt", "--", "alice@example.com"],
    });
    expect(claudeCommand).not.toContain("/local-only/claude");
    expect(claudeCommand).toContain("claude --resume claude-1");

    const windowsCommand = getResumeCommand(session, {
      ...remoteSettings,
      defaultTerminal: "Cmd",
    }, {
      platform: "win32",
      sshArgs: ["-tt", "--", "alice@example.com"],
    });
    expect(windowsCommand).toContain('ssh -tt -- "alice@example.com"');
    expect(windowsCommand).toContain('$SHELL');
    expect(windowsCommand).toContain("^&^&");
  });

  it("indexes Gemini CLI, DeepSeek Harness, Pi and ZCode by default and leaves the rest opt-in", () => {
    const enabled = OPTIONAL_SESSION_SOURCE_DESCRIPTORS
      .map((descriptor) => descriptor.optionalSetting)
      .filter((key, index, keys) => keys.indexOf(key) === index && defaultSettings[key]);
    expect(enabled).toEqual(["includeZcode", "includePi", "includeGeminiCli", "includeDeepSeekCli"]);
    expect(mergeAppSettings(defaultSettings, { includeGeminiCli: false }).includeGeminiCli).toBe(false);
  });

  it.each(["includeWorkBuddy", "includeQwenCode"] as const)(
    "keeps %s indexing opt-in while accepting an explicit enable",
    (key) => {
      expect(defaultSettings[key]).toBe(false);
      expect(mergeAppSettings(defaultSettings, { [key]: true })[key]).toBe(true);
    },
  );

  it("keeps Dynamic Island alerts disabled by default while allowing opt-in", () => {
    expect(defaultSettings.islandEnabled).toBe(false);
    expect(mergeAppSettings(defaultSettings, {}).islandEnabled).toBe(false);
    expect(mergeAppSettings(defaultSettings, { islandEnabled: true }).islandEnabled).toBe(true);
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

  it("seeds the summary effort from the retired memory setting and drops the legacy keys", () => {
    const legacy: Record<string, unknown> = {
      ...defaultSettings,
      openVikingExtractionReasoningEffort: "ultra",
      openVikingMemoryEnabled: true,
    };
    delete legacy.summaryReasoningEffort;

    const merged = mergeAppSettings(legacy as unknown as typeof defaultSettings, {});

    expect(merged.summaryReasoningEffort).toBe("ultra");
    expect(Object.keys(merged).filter((key) => key.startsWith("openViking"))).toEqual([]);
  });

  it("keeps experience cards off by default and stamps the time they are turned on", () => {
    expect(defaultSettings.experienceCardsEnabled).toBe(false);
    const now = new Date("2026-11-12T08:00:00.000Z");
    const enable = (previous: typeof defaultSettings, at: Date) =>
      stampExperienceCardsEnabledAt(previous, mergeAppSettings(previous, { experienceCardsEnabled: true }), at);
    const enabled = enable(defaultSettings, now);
    expect(enabled).toMatchObject({ experienceCardsEnabled: true, experienceCardsEnabledAt: now.toISOString() });
    // Saving again while on must not move the start of extraction forward.
    expect(enable(enabled, new Date("2026-11-13T00:00:00.000Z")).experienceCardsEnabledAt).toBe(now.toISOString());
    const disabled = mergeAppSettings(enabled, { experienceCardsEnabled: false });
    expect(enable(disabled, new Date("2026-11-20T00:00:00.000Z")).experienceCardsEnabledAt).toBe("2026-11-20T00:00:00.000Z");
  });

  it("normalizes the AgentRecall model and drops the Runtime channels it replaced", () => {
    const legacy = { ...defaultSettings, skillAiRuntimeId: "api-1", experienceCardsChannelId: "api-1" };

    const merged = mergeAppSettings(legacy, {
      agentModel: { provider: " custom ", model: " qwen3 ", baseUrl: "http://127.0.0.1:11434/v1/", api: "openai-completions" },
    });

    expect(merged.agentModel).toEqual({ provider: "custom", model: "qwen3", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" });
    expect(merged).not.toHaveProperty("skillAiRuntimeId");
    expect(merged).not.toHaveProperty("experienceCardsChannelId");
    expect(mergeAppSettings(defaultSettings, { agentModel: { api: "gemini" } as never }).agentModel)
      .toEqual({ provider: "", model: "", baseUrl: "", api: "openai-completions" });
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

describe("remote migration CLI settings", () => {
  it("uses target PATH names instead of persisted local paths", () => {
    const settings = remoteMigrationSettings({
      ...defaultSettings,
      claudeBinary: "C:\\Program Files\\Claude\\claude.exe",
      codexBinary: "C:\\Program Files\\Codex\\codex.exe",
      codeBuddyBinary: "C:\\CodeBuddy\\codebuddy.exe",
      codeWizBinary: "C:\\CodeWiz\\codewiz.exe",
      cursorBinary: "C:\\Cursor\\cursor-agent.exe",
      tclaudeBinary: "C:\\Tencent\\tclaude.exe",
      tcodexBinary: "C:\\Tencent\\tcodex.exe",
      deepseekBinary: "C:\\DeepSeek\\dsh.exe",
    });
    expect(settings).toMatchObject({
      claudeBinary: "claude", codexBinary: "codex", codeBuddyBinary: "codebuddy",
      codeWizBinary: "codewiz", cursorBinary: "cursor-agent", tclaudeBinary: "tclaude",
      tcodexBinary: "tcodex", deepseekBinary: "dsh",
    });
  });
});


it("keeps named provider data out of generic settings reads and writes", () => {
  const withLibrary = { ...defaultSettings, providerLibrary: { version: 1, entries: [] } };
  expect(mergeAppSettings(defaultSettings, withLibrary)).not.toHaveProperty("providerLibrary");
  expect(mergeAppSettings(withLibrary, { evalEnabled: true })).not.toHaveProperty("providerLibrary");
});

it("hides background Windows CLI probes while keeping interactive resume terminal launches visible", async () => {
  const { EventEmitter } = await import("node:events");
  const execFileCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: (command: string, args: string[], options: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      execFileCalls.push({ command, args, options });
      cb(null, "C:\\tools\\codex.exe\r\n", "");
    },
    spawn: (command: string, args: string[], options: unknown) => {
      spawnCalls.push({ command, args, options });
      type MockEmitter = InstanceType<typeof EventEmitter>;
      const child = new EventEmitter() as MockEmitter & {
        stdout: MockEmitter & { setEncoding?: (enc: string) => void };
        stderr: MockEmitter & { setEncoding?: (enc: string) => void };
        unref: () => void;
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.unref = () => undefined;
      queueMicrotask(() => {
        if (command === "powershell.exe") {
          child.stdout.emit("data", "codex 0.141.0\n");
          child.emit("close", 0);
        } else {
          child.emit("spawn");
        }
      });
      return child;
    },
  }));

  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const mockedPlatform = await import("./platform");
    await mockedPlatform.inspectMigrationCli("codex", mockedPlatform.defaultSettings);
    await mockedPlatform.openResumeInTerminal(
      {
        source: "codex-cli",
        rawId: "codex-1",
        projectPath: "",
      } as SessionSearchResult,
      mockedPlatform.defaultSettings,
    );

    expect(execFileCalls[0]).toMatchObject({
      command: "where.exe",
      args: ["codex"],
      options: expect.objectContaining({ windowsHide: true }),
    });
    expect(spawnCalls[0]).toMatchObject({
      command: "powershell.exe",
      options: expect.objectContaining({ windowsHide: true }),
    });
    // Console shells cannot be spawned detached (they would get no console), so the visible
    // terminal is created by a hidden PowerShell `Start-Process` launcher.
    expect(spawnCalls).toHaveLength(1);
    const launcher = execFileCalls[1];
    expect(launcher).toMatchObject({ command: "powershell.exe", options: expect.objectContaining({ windowsHide: true }) });
    const script = Buffer.from(launcher.args[launcher.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    expect(script).toContain("Start-Process -FilePath 'pwsh.exe'");
    expect(script).toContain("codex resume codex-1");
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});

it.runIf(process.platform === "win32")("starts Windows console shells in their own console with arguments intact", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-recall-console-launch-"));
  const output = path.join(dir, "out.txt");
  try {
    // A space-separated command with an apostrophe crosses both the PowerShell and MSVC quoting layers.
    await spawnDetached("cmd.exe", ["/d", "/c", `echo it's launched> ${output}`], dir);
    // The shell runs as an independent process with no completion signal; poll its output file.
    const deadline = Date.now() + 10_000;
    while (!existsSync(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(output, "utf8").trim()).toBe("it's launched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
