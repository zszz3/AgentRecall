import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mergeApiConfigWithProfileDefaults, mergeClaudeApiConfigWithProfileDefaults } from "./api-config";
import {
  buildGhosttyOpenArgs,
  buildRevealCommand,
  buildWindowsResumeLaunchPlan,
  buildWindowsLaunchPlan,
  defaultApiConfig,
  defaultClaudeApiConfig,
  defaultSettings,
  defaultTerminalFor,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  getResumeCommand,
  getResumeProcessSpec,
  inspectMigrationCli,
  mergeProcessEnvOverrides,
  mergeAppSettings,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  normalizeTerminal,
  migrationBinary,
  openMigrationResumeInTerminal,
  resolveMacApplicationName,
  terminalOptionsFor,
} from "./platform";
import type { SessionSearchResult } from "./types";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): T | Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  const restore = () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function withShell<T>(shell: string, fn: () => T | Promise<T>): T | Promise<T> {
  const originalShell = process.env.SHELL;
  process.env.SHELL = shell;
  const restore = () => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function encodedCmdPowerShell(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `setlocal DisableDelayedExpansion & powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded} & endlocal`;
}

function decodeEncodedCmdPowerShell(command: string): string {
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+) & endlocal$/)?.[1];
  if (!encoded) throw new Error(`Missing encoded PowerShell payload: ${command}`);
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("platform application resolution", () => {
  it("hides subagent sessions by default and preserves the default for older saved settings", () => {
    expect(defaultSettings.hideSubagentSessions).toBe(true);
    expect(defaultSettings.autoCheckUpdates).toBe(true);
    const {
      hideSubagentSessions: _missingSubagentsInOlderSettings,
      autoCheckUpdates: _missingUpdatesInOlderSettings,
      ...olderSettings
    } = defaultSettings;
    expect(mergeAppSettings(defaultSettings, olderSettings).hideSubagentSessions).toBe(true);
    expect(mergeAppSettings(defaultSettings, olderSettings).autoCheckUpdates).toBe(true);
  });

  it("returns the first macOS application name that resolves", async () => {
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1].includes('"iTerm"')) throw new Error("not found");
    };

    await expect(resolveMacApplicationName(["iTerm", "iTerm2"], runner)).resolves.toBe("iTerm2");
    expect(calls).toHaveLength(2);
  });

  it("returns null when none of the macOS application names resolve", async () => {
    const runner = async () => {
      throw new Error("not found");
    };

    await expect(resolveMacApplicationName(["iTerm", "iTerm2"], runner)).resolves.toBeNull();
  });
});

describe("resume commands", () => {
  it("uses CodeBuddy CLI resume syntax for CodeBuddy sessions", () => {
    const session = {
      source: "codebuddy-cli",
      rawId: "codebuddy-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "darwin" })).toBe(
      "cd /repo && codebuddy --resume codebuddy-1",
    );
  });

  it("uses claude resume syntax with the tclaude binary for tclaude sessions", () => {
    const session = {
      source: "tclaude-cli",
      rawId: "tclaude-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "darwin" })).toBe(
      "cd /repo && tclaude --resume tclaude-1",
    );
  });

  it("uses codex resume syntax with the tcodex binary for tcodex sessions", () => {
    const session = {
      source: "tcodex-cli",
      rawId: "tcodex-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "darwin" })).toBe(
      "cd /repo && tcodex resume tcodex-1",
    );
  });

  it("builds a cmd-compatible cd prefix when Windows terminal is Cmd", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\my repo",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "Cmd" as const };

    expect(getResumeCommand(session, settings, { platform: "win32" })).toBe(
      'cd /d "C:\\my repo" && claude --resume abc',
    );
  });

  it("does not treat newly indexed local sources as Codex resume sessions", () => {
    const session = {
      source: "opencode-cli",
      rawId: "opencode-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(() => getResumeCommand(session, defaultSettings, { platform: "darwin" })).toThrow(
      "Resume is not supported for OpenCode sessions yet.",
    );
  });

  it("builds a PowerShell-compatible resume command when the terminal is PowerShell", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\my repo",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "PowerShell" as const };

    const command = getResumeCommand(session, settings, { platform: "win32" });
    expect(command).toBe("cd 'C:\\my repo'; claude --resume abc");
    expect(command).not.toContain("cd /d");
    expect(command).not.toContain("&&");
  });

  it("quotes a PowerShell path with single quotes by doubling embedded quotes", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\o'brien repo",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "PowerShell" as const };

    expect(getResumeCommand(session, settings, { platform: "win32" })).toBe(
      "cd 'C:\\o''brien repo'; claude --resume abc",
    );
  });

  it("encodes local Windows Cmd resume values containing environment syntax", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\repo %USERNAME% & tools",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "Cmd" as const };

    const command = getResumeCommand(session, settings, { platform: "win32" });
    expect(command).toMatch(/^setlocal DisableDelayedExpansion & powershell\.exe -NoLogo -NoProfile -EncodedCommand [A-Za-z0-9+/=]+ & endlocal$/);
    expect(decodeEncodedCmdPowerShell(command)).toBe(
      "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath 'C:\\repo %USERNAME% & tools'; & claude --resume abc",
    );
  });

  it("omits the cd prefix when withCwd is false", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\my repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "win32", withCwd: false })).toBe(
      "claude --resume abc",
    );
  });

  it("wraps a remote Codex resume command in ssh with a POSIX remote cd", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo with spaces",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "darwin", sshTarget: "dev@example.com" })).toBe(
      "ssh -- 'dev@example.com' 'cd '\\''/repo with spaces'\\'' && codex resume codex-1'",
    );
  });

  it("honors Claude skip permissions inside remote ssh resume commands", () => {
    const session = {
      source: "claude-cli",
      rawId: "claude-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(
      getResumeCommand(session, defaultSettings, {
        platform: "darwin",
        skipPermissions: true,
        sshTarget: "dev.example.com",
      }),
    ).toBe("ssh -- dev.example.com 'cd /repo && claude --resume claude-1 --dangerously-skip-permissions'");
  });

  it("quotes unsafe remote resume arguments as single shell tokens", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex 1; rm -rf /",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "darwin", sshTarget: "dev.example.com" })).toBe(
      "ssh -- dev.example.com 'cd /repo && codex resume '\\''codex 1; rm -rf /'\\'''",
    );
  });

  it("uses POSIX remote cd for ssh resume commands even when displaying for Windows", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo with spaces",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "Cmd" as const };

    const command = getResumeCommand(session, settings, {
      platform: "win32",
      sshTarget: "dev@example.com",
    });

    expect(command).toBe('ssh -- "dev@example.com" "cd \'/repo with spaces\' ^&^& codex resume codex-1"');
    expect(command).not.toContain("ssh -- 'dev@example.com'");
    expect(command).not.toContain("cd /d");
  });

  it("renders manual ssh args before the separator in copyable display commands", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(
      getResumeCommand(session, defaultSettings, {
        platform: "darwin",
        sshArgs: ["-i", "/keys/dev key", "-p", "2222", "--", "alice@example.com"],
      }),
    ).toBe("ssh -i '/keys/dev key' -p 2222 -- 'alice@example.com' 'cd /repo && codex resume codex-1'");
  });

  it("escapes Windows ssh display arguments for cmd without changing remote POSIX text", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex %USERNAME% $HOME",
      projectPath: "/repo %USERNAME% $HOME",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "Cmd" as const };

    const command = getResumeCommand(session, settings, {
      platform: "win32",
      sshTarget: "dev@example.com",
    });

    expect(command).toBe(
      'ssh -- "dev@example.com" "cd \'/repo ^%USERNAME^% $HOME\' ^&^& codex resume \'codex ^%USERNAME^% $HOME\'"',
    );
    expect(command).not.toContain("%USERNAME%");
    expect(command).toContain("$HOME");
  });
});

describe("Ghostty resume launch args", () => {
  it("runs the resume command via -e and the shell, not the unsupported --initial-command flag", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "/repo",
    } as SessionSearchResult;
    withShell("/bin/zsh", () => {
      const args = buildGhosttyOpenArgs(session, defaultSettings);
      expect(args.slice(0, 5)).toEqual(["-na", "Ghostty.app", "--args", "-e", "/bin/zsh"]);
      expect(args[5]).toBe("-ic");
      expect(args[6]).toBe("cd /repo && claude --resume abc");
      expect(args.some((arg) => arg.includes("--initial-command"))).toBe(false);
    });
  });
});

describe("terminal options per platform", () => {
  it("returns Windows terminals on win32", () => {
    expect(terminalOptionsFor("win32")).toEqual(["WindowsTerminal", "PowerShell", "Cmd", "WezTerm"]);
  });
  it("returns macOS terminals elsewhere", () => {
    expect(terminalOptionsFor("darwin")).toEqual(["Terminal", "iTerm", "Ghostty", "WezTerm", "Warp"]);
  });
  it("defaults to PowerShell on win32 and Terminal on macOS", () => {
    expect(defaultTerminalFor("win32")).toBe("PowerShell");
    expect(defaultTerminalFor("darwin")).toBe("Terminal");
  });
  it("normalizes a cross-platform value to the platform default", () => {
    expect(normalizeTerminal("WindowsTerminal", "darwin")).toBe("Terminal");
    expect(normalizeTerminal("Cmd", "darwin")).toBe("Terminal");
    expect(normalizeTerminal("PowerShell", "win32")).toBe("PowerShell");
  });
});

describe("API settings", () => {
  it("normalizes Codex API provider config fields", () => {
    expect(
      normalizeApiConfig({
        activeProvider: "custom",
        customProviderName: "  codexzh  ",
        customBaseUrl: " https://api.example.com/v1 ",
        customApiKey: " sk-test ",
        customModel: " gpt-5.5 ",
        customApiFormat: "openai_responses",
      }),
    ).toEqual({
      activeProvider: "custom",
      customProviderId: "codexzh",
      customProviderName: "codexzh",
      customBaseUrl: "https://api.example.com/v1",
      customApiKey: "sk-test",
      customModel: "gpt-5.5",
      customApiFormat: "openai_responses",
    });
  });

  it("deep merges API config updates without dropping saved fields", () => {
    const previous = {
      ...defaultSettings,
      apiConfig: {
        activeProvider: "custom" as const,
        customProviderId: "codexzh" as const,
        customProviderName: "codexzh",
        customBaseUrl: "https://api.example.com/v1",
        customApiKey: "sk-test",
        customModel: "gpt-5.5",
        customApiFormat: "openai_chat" as const,
      },
    };

    expect(mergeAppSettings(previous, { apiConfig: { customModel: "gpt-5.5-mini" } })).toMatchObject({
      apiConfig: {
        ...previous.apiConfig,
        customModel: "gpt-5.5-mini",
      },
    });
  });

  it("normalizes Claude Code API provider config fields", () => {
    expect(
      normalizeClaudeApiConfig({
        activeProvider: "custom",
        customProviderId: "deepseek",
        customProviderName: "  deepseek  ",
        customBaseUrl: " https://api.deepseek.com/anthropic ",
        customApiKey: " sk-test ",
        customModel: " deepseek-v4-pro ",
        customHaikuModel: " deepseek-v4-flash ",
        customSonnetModel: " deepseek-v4-pro ",
        customOpusModel: " deepseek-v4-pro ",
      }),
    ).toEqual({
      activeProvider: "custom",
      customProviderId: "deepseek",
      customProviderName: "deepseek",
      customBaseUrl: "https://api.deepseek.com/anthropic",
      customApiKey: "sk-test",
      customModel: "deepseek-v4-pro",
      customHaikuModel: "deepseek-v4-flash",
      customSonnetModel: "deepseek-v4-pro",
      customOpusModel: "deepseek-v4-pro",
      customApiFormat: "anthropic",
      customApiKeyField: "ANTHROPIC_AUTH_TOKEN",
    });
  });

  it("defaults API config to the official Codex provider", () => {
    expect(defaultSettings.apiConfig).toEqual(defaultApiConfig);
    expect(defaultSettings.claudeApiConfig).toEqual(defaultClaudeApiConfig);
  });

  it("enables session search MCP by default while preserving an explicit opt-out", () => {
    expect(defaultSettings.sessionSearchMcpEnabled).toBe(true);
    expect(mergeAppSettings(defaultSettings, { sessionSearchMcpEnabled: false }).sessionSearchMcpEnabled).toBe(false);
  });

  it("keeps Supabase skill sync disabled by default and normalizes saved credentials", () => {
    expect(defaultSettings.skillSyncEnabled).toBe(false);
    expect(defaultSettings.skillSyncSupabaseUrl).toBe("");
    expect(defaultSettings.skillSyncSupabaseAnonKey).toBe("");

    expect(
      mergeAppSettings(defaultSettings, {
        skillSyncEnabled: true,
        skillSyncSupabaseUrl: " https://example.supabase.co/ ",
        skillSyncSupabaseAnonKey: " anon-key ",
      }),
    ).toMatchObject({
      skillSyncEnabled: true,
      skillSyncSupabaseUrl: "https://example.supabase.co",
      skillSyncSupabaseAnonKey: "anon-key",
    });
  });

  it("keeps explicitly saved empty API keys empty instead of refilling profile defaults", () => {
    expect(
      mergeApiConfigWithProfileDefaults(
        { ...defaultApiConfig, customApiKey: "" },
        { customApiKey: "" },
        { customBaseUrl: "https://profile.example/v1", customApiKey: "sk-from-profile", customModel: "profile-model" },
      ),
    ).toMatchObject({ customApiKey: "" });
    expect(
      mergeClaudeApiConfigWithProfileDefaults(
        { ...defaultClaudeApiConfig, customApiKey: "" },
        { customApiKey: "" },
        {
          customBaseUrl: "https://profile.example/anthropic",
          customApiKey: "sk-from-profile",
          customModel: "profile-model",
          customHaikuModel: "profile-haiku",
          customSonnetModel: "profile-sonnet",
          customOpusModel: "profile-opus",
        },
      ),
    ).toMatchObject({ customApiKey: "" });
  });

  it("preserves disabled optional internal sources", () => {
    expect(
      mergeAppSettings(
        { ...defaultSettings, includeClaudeInternal: true, includeCodexInternal: true },
        { includeClaudeInternal: false, includeCodexInternal: false },
      ),
    ).toMatchObject({
      includeClaudeInternal: false,
      includeCodexInternal: false,
    });
  });

  it("does not auto-fill API keys from profile defaults when the user has not saved one in the app", () => {
    expect(
      mergeApiConfigWithProfileDefaults(
        { ...defaultApiConfig, customApiKey: "" },
        {},
        { customApiKey: "sk-from-profile" },
      ).customApiKey,
    ).toBe("");
    expect(
      mergeClaudeApiConfigWithProfileDefaults(
        { ...defaultClaudeApiConfig, customApiKey: "" },
        {},
        { customApiKey: "sk-from-profile" },
      ).customApiKey,
    ).toBe("");
  });
});

describe("buildWindowsLaunchPlan", () => {
  const cmd = "claude --resume abc";
  const cwd = "C:\\my repo";

  it("Windows Terminal first, then powershell shells, then cmd", () => {
    const plan = buildWindowsLaunchPlan("WindowsTerminal", cmd, cwd);
    expect(plan.map((p) => p.file)).toEqual(["wt.exe", "pwsh.exe", "powershell.exe", "cmd.exe"]);
    expect(plan[0].args).toEqual(["-d", cwd, "cmd.exe", "/d", "/k", cmd]);
  });

  it("PowerShell prefers pwsh then powershell then cmd", () => {
    const plan = buildWindowsLaunchPlan("PowerShell", cmd, cwd);
    expect(plan.map((p) => p.file)).toEqual(["pwsh.exe", "powershell.exe", "cmd.exe"]);
    expect(plan[0].args).toEqual(["-NoLogo", "-NoProfile", "-NoExit", "-Command", cmd]);
    expect(plan[0].cwd).toBe(cwd);
  });

  it("Cmd uses cmd.exe /K", () => {
    const plan = buildWindowsLaunchPlan("Cmd", cmd, cwd);
    expect(plan.map((p) => p.file)).toEqual(["cmd.exe"]);
    expect(plan[0].args).toEqual(["/d", "/k", cmd]);
    expect(plan[0].cwd).toBe(cwd);
  });

  it("omits wt start-dir flag when cwd is empty", () => {
    const plan = buildWindowsLaunchPlan("WindowsTerminal", cmd, "");
    expect(plan[0].args).toEqual(["cmd.exe", "/d", "/k", cmd]);
  });

  it("does not set shell cwd when cwd is empty", () => {
    const plan = buildWindowsLaunchPlan("WindowsTerminal", cmd, "");
    expect(plan.map((p) => p.cwd)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("resume terminal launch plans", () => {
  it("keeps local Windows resume launches rooted in the local project path", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: process.cwd(),
    } as SessionSearchResult;

    const plan = buildWindowsResumeLaunchPlan(session, defaultSettings, {
      terminal: "WindowsTerminal",
      platform: "win32",
    });

    expect(plan[0].args).toEqual(["-d", process.cwd(), "cmd.exe", "/d", "/k", "codex resume codex-1"]);
    expect(plan[1].cwd).toBe(process.cwd());
  });

  it("does not use the remote project path as a local Windows terminal cwd", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/remote repo",
    } as SessionSearchResult;

    const plan = buildWindowsResumeLaunchPlan(session, defaultSettings, {
      terminal: "WindowsTerminal",
      platform: "win32",
      sshArgs: ["-i", "/keys/dev key", "-p", "2222", "--", "alice@example.com"],
    });

    expect(plan[0].args).toEqual([
      "cmd.exe",
      "/d",
      "/k",
      'ssh -i "/keys/dev key" -p "2222" -- "alice@example.com" "cd \'/remote repo\' ^&^& codex resume codex-1"',
    ]);
    expect(plan.map((launch) => launch.cwd)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("uses a PowerShell-safe remote resume command without cmd caret escapes", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/remote repo",
    } as SessionSearchResult;

    const plan = buildWindowsResumeLaunchPlan(session, defaultSettings, {
      terminal: "WindowsTerminal",
      platform: "win32",
      sshArgs: ["-i", "/keys/dev key", "-p", "2222", "--", "alice@example.com"],
    });
    const pwshCommand = plan.find((launch) => launch.file === "pwsh.exe")?.args.at(-1);
    const powershellCommand = plan.find((launch) => launch.file === "powershell.exe")?.args.at(-1);

    expect(pwshCommand).toBe(
      "ssh -i '/keys/dev key' -p 2222 -- 'alice@example.com' 'cd ''/remote repo'' && codex resume codex-1'",
    );
    expect(pwshCommand).not.toContain("^&^&");
    expect(pwshCommand).toContain("cd ''/remote repo'' && codex resume codex-1");
    expect(powershellCommand).toBe(pwshCommand);
  });

  it("offers a WezTerm launch on Windows that wraps the command in cmd.exe", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: process.cwd(),
    } as SessionSearchResult;

    const plan = buildWindowsResumeLaunchPlan(session, defaultSettings, {
      terminal: "WezTerm",
      platform: "win32",
    });

    expect(plan[0].file).toBe("wezterm.exe");
    expect(plan[0].args).toEqual(["start", "--cwd", process.cwd(), "--", "cmd.exe", "/d", "/k", "codex resume codex-1"]);
    expect(plan.map((launch) => launch.file)).toEqual([
      "wezterm.exe",
      "wt.exe",
      "pwsh.exe",
      "powershell.exe",
      "cmd.exe",
    ]);
  });

  it("keeps the launch command in cmd syntax even when the user prefers PowerShell", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "/remote repo",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "PowerShell" as const };

    const plan = buildWindowsResumeLaunchPlan(session, settings, {
      platform: "win32",
      sshArgs: ["--", "alice@example.com"],
    });

    const cmdLaunch = plan.find((launch) => launch.file === "cmd.exe");
    expect(cmdLaunch?.args.at(-1)).toContain("^&^&");
  });
});

describe("reveal in file manager", () => {
  it("reveals (selects) the item in Finder on macOS", () => {
    expect(buildRevealCommand("/Users/me/skills/foo", "darwin")).toEqual({
      file: "/usr/bin/open",
      args: ["-R", "/Users/me/skills/foo"],
      ignoreExitCode: false,
    });
  });

  it("uses explorer /select with backslashes and tolerates its non-zero exit on Windows", () => {
    expect(buildRevealCommand("C:/Users/me/skills/foo", "win32")).toEqual({
      file: "explorer.exe",
      args: ["/select,C:\\Users\\me\\skills\\foo"],
      ignoreExitCode: true,
    });
  });

  it("falls back to xdg-open on Linux", () => {
    expect(buildRevealCommand("/home/me/skills/foo", "linux")).toEqual({
      file: "xdg-open",
      args: ["/home/me/skills/foo"],
      ignoreExitCode: false,
    });
  });
});

describe("resume process specs", () => {
  it("uses the concrete Claude Internal binary for ordinary resume", () => {
    const session = {
      source: "claude-internal",
      rawId: "internal-claude-1",
      projectPath: "/repo",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, claudeInternalBinary: "/opt/Internal CLI/claude-internal" };

    expect(getResumeProcessSpec(session, settings, { platform: "darwin" })).toMatchObject({
      command: "/opt/Internal CLI/claude-internal",
      args: ["--resume", "internal-claude-1"],
      cwd: "/repo",
      env: undefined,
      displayCommand: "cd /repo && '/opt/Internal CLI/claude-internal' --resume internal-claude-1",
    });
  });

  it("keeps ordinary Codex Internal resume in its scoped CODEX_HOME", () => {
    const session = {
      source: "codex-internal",
      rawId: "internal-codex-1",
      projectPath: "/repo with spaces",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, codexBinary: "/opt/Codex CLI/codex" };
    const options = { platform: "darwin" as const, homeDir: "/Users/internal user" };

    expect(getResumeProcessSpec(session, settings, options)).toEqual({
      command: "/opt/Codex CLI/codex",
      args: ["resume", "internal-codex-1"],
      cwd: "/repo with spaces",
      env: { CODEX_HOME: "/Users/internal user/.codex-internal" },
      displayCommand:
        "cd '/repo with spaces' && CODEX_HOME='/Users/internal user/.codex-internal' '/opt/Codex CLI/codex' resume internal-codex-1",
    });
  });

  it("scopes ordinary Codex Internal display commands in POSIX, PowerShell, and Cmd", () => {
    const session = {
      source: "codex-internal",
      rawId: "internal id",
      projectPath: "C:\\repo & tools",
    } as SessionSearchResult;
    const homeDir = "C:\\Users\\Internal User";
    const options = { platform: "win32" as const, homeDir };
    const powershell = getResumeCommand(session, { ...defaultSettings, defaultTerminal: "PowerShell" }, options);
    const cmd = getResumeCommand(session, { ...defaultSettings, defaultTerminal: "Cmd" }, options);
    const posix = getResumeCommand(
      { ...session, projectPath: "/repo with spaces" },
      defaultSettings,
      { platform: "linux", homeDir: "/home/internal user" },
    );

    expect(posix).toBe(
      "cd '/repo with spaces' && CODEX_HOME='/home/internal user/.codex-internal' codex resume 'internal id'",
    );
    expect(powershell).toContain("try { $env:CODEX_HOME = 'C:\\Users\\Internal User\\.codex-internal'");
    expect(powershell).toContain("codex resume 'internal id'");
    expect(cmd).toContain('setlocal & set "CODEX_HOME=C:\\Users\\Internal User\\.codex-internal"');
    expect(cmd).toContain('cd /d "C:\\repo & tools" && codex resume "internal id" & endlocal');
  });

  it("keeps dangerous ordinary Codex Internal values encoded in the Windows launch chain", () => {
    const session = {
      source: "codex-internal",
      rawId: "id-%PATH%-!TEMP!-&|<>^\"",
      projectPath: "C:\\repo\\%PATH%\\!TEMP! & source",
    } as SessionSearchResult;
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Tools\\%PATH%\\!TEMP!\\codex & helper.exe",
    };
    const plan = buildWindowsResumeLaunchPlan(session, settings, {
      terminal: "Cmd",
      platform: "win32",
      homeDir: "C:\\Users\\%PATH%\\!TEMP!",
    });

    const command = plan[0].args.at(-1) ?? "";
    expect(command).toMatch(/^setlocal DisableDelayedExpansion & powershell\.exe -NoLogo -NoProfile -EncodedCommand [A-Za-z0-9+/=]+ & endlocal$/);
    expect(decodeEncodedCmdPowerShell(command)).toBe(
      "$ErrorActionPreference = 'Stop'; $env:CODEX_HOME = 'C:\\Users\\%PATH%\\!TEMP!\\.codex-internal'; & 'C:\\Tools\\%PATH%\\!TEMP!\\codex & helper.exe' resume 'id-%PATH%-!TEMP!-&|<>^\"'",
    );
  });

  it("builds Codex resume as binary args with cwd instead of shell text", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo with spaces",
    } as SessionSearchResult;

    expect(getResumeProcessSpec(session, defaultSettings, { platform: "darwin" })).toMatchObject({
      command: "codex",
      args: ["resume", "codex-1"],
      cwd: "/repo with spaces",
      displayCommand: "cd '/repo with spaces' && codex resume codex-1",
    });
  });

  it("builds Claude resume as binary args", () => {
    const session = {
      source: "claude-cli",
      rawId: "claude-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeProcessSpec(session)).toMatchObject({
      command: "claude",
      args: ["--resume", "claude-1"],
      cwd: "/repo",
    });
  });

  it("builds remote resume as ssh argv without a local cwd", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo with spaces",
    } as SessionSearchResult;

    expect(getResumeProcessSpec(session, defaultSettings, { platform: "darwin", sshTarget: "dev@example.com" })).toEqual(
      {
        command: "ssh",
        args: ["--", "dev@example.com", "cd '/repo with spaces' && codex resume codex-1"],
        cwd: undefined,
        displayCommand: "ssh -- 'dev@example.com' 'cd '\\''/repo with spaces'\\'' && codex resume codex-1'",
      },
    );
  });

  it("preserves manual ssh args separately in remote process specs", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(
      getResumeProcessSpec(session, defaultSettings, {
        platform: "darwin",
        sshArgs: ["-i", "/keys/dev key", "-p", "2222", "--", "alice@example.com"],
      }),
    ).toEqual({
      command: "ssh",
      args: ["-i", "/keys/dev key", "-p", "2222", "--", "alice@example.com", "cd /repo && codex resume codex-1"],
      cwd: undefined,
      displayCommand: "ssh -i '/keys/dev key' -p 2222 -- 'alice@example.com' 'cd /repo && codex resume codex-1'",
    });
  });

  it("quotes unsafe remote process spec arguments in the ssh inner command", () => {
    const session = {
      source: "codex-cli",
      rawId: "codex 1; rm -rf /",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeProcessSpec(session, defaultSettings, { platform: "darwin", sshTarget: "dev.example.com" })).toEqual(
      {
        command: "ssh",
        args: ["--", "dev.example.com", "cd /repo && codex resume 'codex 1; rm -rf /'"],
        cwd: undefined,
        displayCommand: "ssh -- dev.example.com 'cd /repo && codex resume '\\''codex 1; rm -rf /'\\'''",
      },
    );
  });
});

describe("migration cli process specs", () => {
  it("keeps the safe formatter independent from the primary formatter chain", () => {
    const source = readFileSync(new URL("./platform.ts", import.meta.url), "utf8");
    const safeFormatter = source.slice(
      source.indexOf("export function getSafeMigrationResumeCommand"),
      source.indexOf("// Ghostty has no", source.indexOf("export function getSafeMigrationResumeCommand")),
    );
    expect(safeFormatter).not.toContain("getMigrationResumeProcessSpec");
    expect(safeFormatter).not.toContain("buildMigrationResumeShellCommand");
    expect(safeFormatter).not.toContain("buildMigrationResumeCommands");
  });
  it("builds an independent safe resume command for all migration targets", () => {
    const settings = {
      ...defaultSettings,
      claudeBinary: "/cli/claude safe",
      codexBinary: "/cli/codex safe",
      codeBuddyBinary: "/cli/codebuddy safe",
      tclaudeBinary: "/cli/tclaude safe",
      tcodexBinary: "/cli/tcodex safe",
      claudeInternalBinary: "/cli/claude-internal safe",
    };

    for (const target of ["claude", "codex", "codebuddy", "tclaude", "tcodex", "claude-internal", "codex-internal"] as const) {
      const command = getSafeMigrationResumeCommand(target, "id with space", "/repo with space", settings, {
        platform: "linux",
        homeDir: "/home/me",
      });
      expect(command).toContain("cd '/repo with space' &&");
      expect(command).toContain("'id with space'");
      expect(command).toContain(["codex", "tcodex", "codex-internal"].includes(target) ? " resume " : " --resume ");
    }
  });

  it("keeps Codex Internal CODEX_HOME scoped in safe POSIX, PowerShell, and Cmd commands", () => {
    const posix = getSafeMigrationResumeCommand("codex-internal", "id", "/repo", defaultSettings, {
      platform: "linux", homeDir: "/home/me",
    });
    const powershell = getSafeMigrationResumeCommand("codex-internal", "id", "C:\\repo", {
      ...defaultSettings, defaultTerminal: "PowerShell",
    }, { platform: "win32", homeDir: "C:\\Users\\me" });
    const cmd = getSafeMigrationResumeCommand("codex-internal", "id", "C:\\repo", {
      ...defaultSettings, defaultTerminal: "Cmd",
    }, { platform: "win32", homeDir: "C:\\Users\\me" });

    expect(posix).toContain("CODEX_HOME=/home/me/.codex-internal");
    expect(powershell).toContain("try { $env:CODEX_HOME = 'C:\\Users\\me\\.codex-internal'");
    expect(cmd).toContain('setlocal & set "CODEX_HOME=C:\\Users\\me\\.codex-internal"');
  });

  it("encodes dangerous safe-fallback Cmd command, argv, and cwd values as literal PowerShell payload", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Tools\\%PATH%\\!TEMP!\\codex \"quoted\" &|<>^\r\n.exe",
    };
    const projectPath = "C:\\repo\\%PATH%\\!TEMP! &|<>^\"\r\nsource";
    const sessionId = "id-%PATH%-!TEMP!-&|<>^\"\r\nnext";
    const command = getSafeMigrationResumeCommand("codex", sessionId, projectPath, settings, { platform: "win32" });

    expect(command).toMatch(/^setlocal DisableDelayedExpansion & powershell\.exe -NoLogo -NoProfile -EncodedCommand [A-Za-z0-9+/=]+ & endlocal$/);
    expect(command).not.toContain("%PATH%");
    expect(command).not.toContain("!TEMP!");
    expect(decodeEncodedCmdPowerShell(command)).toBe(
      "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath 'C:\\repo\\%PATH%\\!TEMP! &|<>^\"\r\nsource'; & 'C:\\Tools\\%PATH%\\!TEMP!\\codex \"quoted\" &|<>^\r\n.exe' 'resume' 'id-%PATH%-!TEMP!-&|<>^\"\r\nnext'",
    );
  });

  it("encodes dangerous Codex Internal CODEX_HOME only inside the PowerShell child payload", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Tools\\codex.exe",
    };
    const command = getSafeMigrationResumeCommand("codex-internal", "id", "C:\\repo", settings, {
      platform: "win32",
      homeDir: "C:\\Users\\%PATH%\\!TEMP!\\\"quoted\" &|<>^\r\nme",
    });

    expect(command).toMatch(/^setlocal DisableDelayedExpansion & powershell\.exe -NoLogo -NoProfile -EncodedCommand [A-Za-z0-9+/=]+ & endlocal$/);
    expect(command).not.toContain("CODEX_HOME=");
    expect(decodeEncodedCmdPowerShell(command)).toBe(
      "$ErrorActionPreference = 'Stop'; $env:CODEX_HOME = 'C:\\Users\\%PATH%\\!TEMP!\\\"quoted\" &|<>^\r\nme\\.codex-internal'; Set-Location -LiteralPath 'C:\\repo'; & 'C:\\Tools\\codex.exe' 'resume' 'id'",
    );
  });
  it("maps each migration target to its configured binary", () => {
    const settings = {
      ...defaultSettings,
      claudeBinary: "/opt/Claude CLI/claude",
      codexBinary: "/opt/Codex CLI/codex",
      codeBuddyBinary: "/opt/CodeBuddy CLI/codebuddy",
      cursorBinary: "/opt/Cursor CLI/cursor-agent",
      tclaudeBinary: "/opt/Tencent CLI/tclaude",
      tcodexBinary: "/opt/Tencent CLI/tcodex",
      claudeInternalBinary: "/opt/Internal CLI/claude-internal",
    };

    expect(migrationBinary("claude", settings)).toBe("/opt/Claude CLI/claude");
    expect(migrationBinary("codex", settings)).toBe("/opt/Codex CLI/codex");
    expect(migrationBinary("codebuddy", settings)).toBe("/opt/CodeBuddy CLI/codebuddy");
    expect(migrationBinary("cursor", settings)).toBe("/opt/Cursor CLI/cursor-agent");
    expect(migrationBinary("tclaude", settings)).toBe("/opt/Tencent CLI/tclaude");
    expect(migrationBinary("tcodex", settings)).toBe("/opt/Tencent CLI/tcodex");
    expect(migrationBinary("claude-internal", settings)).toBe("/opt/Internal CLI/claude-internal");
    expect(migrationBinary("codex-internal", settings)).toBe("/opt/Codex CLI/codex");
  });

  it("uses Codex resume args for the Codex family and Claude resume args for the other targets", () => {
    const settings = {
      ...defaultSettings,
      claudeBinary: "/cli/claude",
      codexBinary: "/cli/codex",
      codeBuddyBinary: "/cli/codebuddy",
      cursorBinary: "/cli/cursor-agent",
      tclaudeBinary: "/cli/tclaude",
      tcodexBinary: "/cli/tcodex",
      claudeInternalBinary: "/cli/claude-internal",
    };

    for (const target of ["codex", "tcodex", "codex-internal"] as const) {
      expect(getMigrationResumeProcessSpec(target, "id", "/repo", settings, { homeDir: "/home/me" }).args).toEqual([
        "resume",
        "id",
      ]);
    }
    for (const target of ["claude", "tclaude", "claude-internal", "codebuddy", "cursor"] as const) {
      expect(getMigrationResumeProcessSpec(target, "id", "/repo", settings).args).toEqual(["--resume", "id"]);
    }
  });

  it("builds a POSIX migration resume process spec with safe display quoting", () => {
    const settings = {
      ...defaultSettings,
      claudeBinary: "/opt/Claude CLI/claude",
    };

    expect(
      getMigrationResumeProcessSpec("claude", "session 1", "/repo with spaces", settings),
    ).toEqual({
      command: "/opt/Claude CLI/claude",
      args: ["--resume", "session 1"],
      cwd: "/repo with spaces",
      displayCommand: "cd '/repo with spaces' && '/opt/Claude CLI/claude' --resume 'session 1'",
    });
  });

  it("preserves cwd with trailing spaces and single quotes in POSIX migration display commands", () => {
    const settings = {
      ...defaultSettings,
      codexBinary: "/opt/Codex CLI/codex",
    };

    expect(
      getMigrationResumeProcessSpec("codex", "session 1", "/repo it's me/ ", settings),
    ).toEqual({
      command: "/opt/Codex CLI/codex",
      args: ["resume", "session 1"],
      cwd: "/repo it's me/ ",
      displayCommand: "cd '/repo it'\\''s me/ ' && '/opt/Codex CLI/codex' resume 'session 1'",
    });
  });

  it("builds Windows Cmd and PowerShell migration display commands safely for custom binaries", () => {
    withPlatform("win32", () => {
      const cmdSettings = {
        ...defaultSettings,
        defaultTerminal: "Cmd" as const,
        codexBinary: "C:\\Program Files\\Codex CLI\\codex.exe",
      };
      const psSettings = {
        ...defaultSettings,
        defaultTerminal: "PowerShell" as const,
        claudeBinary: "C:\\Program Files\\Claude CLI\\claude.exe",
      };

      expect(getMigrationResumeProcessSpec("codex", "session-1", "C:\\repo with spaces", cmdSettings)).toMatchObject({
        command: "C:\\Program Files\\Codex CLI\\codex.exe",
        args: ["resume", "session-1"],
        cwd: "C:\\repo with spaces",
        displayCommand: 'cd /d "C:\\repo with spaces" && "C:\\Program Files\\Codex CLI\\codex.exe" resume session-1',
      });

      expect(getMigrationResumeProcessSpec("claude", "session-1", "C:\\repo with spaces", psSettings)).toMatchObject({
        command: "C:\\Program Files\\Claude CLI\\claude.exe",
        args: ["--resume", "session-1"],
        cwd: "C:\\repo with spaces",
        displayCommand:
          "cd 'C:\\repo with spaces'; & 'C:\\Program Files\\Claude CLI\\claude.exe' --resume session-1",
      });
    });
  });

  it.each(["darwin", "linux"] as const)("scopes Codex Internal CODEX_HOME in its %s process spec and POSIX display command", (platform) => {
    const settings = { ...defaultSettings, codexBinary: "/opt/Codex CLI/codex" };

    expect(
      getMigrationResumeProcessSpec(
        "codex-internal",
        "session 'one'; echo nope",
        "/repo it's safe",
        settings,
        { homeDir: "/Users/a user", platform },
      ),
    ).toEqual({
      command: "/opt/Codex CLI/codex",
      args: ["resume", "session 'one'; echo nope"],
      cwd: "/repo it's safe",
      env: { CODEX_HOME: "/Users/a user/.codex-internal" },
      displayCommand:
        "cd '/repo it'\\''s safe' && CODEX_HOME='/Users/a user/.codex-internal' '/opt/Codex CLI/codex' resume 'session '\\''one'\\''; echo nope'",
    });
    expect(getMigrationResumeProcessSpec("codex", "id", "/repo", settings, { homeDir: "/Users/a user" }).env).toBeUndefined();
  });

  it("restores or removes CODEX_HOME after the Codex Internal PowerShell command", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "PowerShell" as const,
      codexBinary: "C:\\Program Files\\Codex CLI\\codex.exe",
    };

    expect(
      getMigrationResumeProcessSpec("codex-internal", "id 'quoted'", "C:\\repo & tools", settings, {
        homeDir: "C:\\Users\\A User",
        platform: "win32",
      }).displayCommand,
    ).toBe(
      "$__assHadCodexHome = Test-Path Env:CODEX_HOME; $__assCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = 'C:\\Users\\A User\\.codex-internal'; cd 'C:\\repo & tools'; & 'C:\\Program Files\\Codex CLI\\codex.exe' resume 'id ''quoted''' } finally { if ($__assHadCodexHome) { $env:CODEX_HOME = $__assCodexHome } else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } }",
    );
  });

  it("uses cmd setlocal/endlocal for Codex Internal without leaking CODEX_HOME", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Program Files\\Codex CLI\\codex.exe",
    };

    expect(
      getMigrationResumeProcessSpec("codex-internal", "id & next", "C:\\repo with spaces", settings, {
        homeDir: "C:\\Users\\A User",
        platform: "win32",
      }).displayCommand,
    ).toBe(
      'setlocal & set "CODEX_HOME=C:\\Users\\A User\\.codex-internal" & cd /d "C:\\repo with spaces" && "C:\\Program Files\\Codex CLI\\codex.exe" resume "id & next" & endlocal',
    );
  });

  it("encodes ordinary Cmd migration values so percent and delayed expansion cannot rewrite them", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Tools\\%PATH%\\!TEMP!\\codex & helper.exe",
    };
    const projectPath = "C:\\repo\\%PATH%\\!TEMP! & source";
    const sessionId = "id-%PATH%-!TEMP!-&|<>^\"";
    const expectedScript =
      "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath 'C:\\repo\\%PATH%\\!TEMP! & source'; & 'C:\\Tools\\%PATH%\\!TEMP!\\codex & helper.exe' resume 'id-%PATH%-!TEMP!-&|<>^\"'";

    expect(
      getMigrationResumeProcessSpec("codex", sessionId, projectPath, settings, { platform: "win32" }).displayCommand,
    ).toBe(encodedCmdPowerShell(expectedScript));
  });

  it("encodes Codex Internal Cmd values while keeping CODEX_HOME child-scoped", () => {
    const settings = {
      ...defaultSettings,
      defaultTerminal: "Cmd" as const,
      codexBinary: "C:\\Tools\\%PATH%\\!TEMP!\\codex ^ internal.exe",
    };
    const expectedScript =
      "$ErrorActionPreference = 'Stop'; $env:CODEX_HOME = 'C:\\Users\\%PATH%\\!TEMP!\\.codex-internal'; Set-Location -LiteralPath 'C:\\repo\\%PATH%\\!TEMP! | source'; & 'C:\\Tools\\%PATH%\\!TEMP!\\codex ^ internal.exe' resume 'id-%PATH%-!TEMP!-<next>'";

    expect(
      getMigrationResumeProcessSpec(
        "codex-internal",
        "id-%PATH%-!TEMP!-<next>",
        "C:\\repo\\%PATH%\\!TEMP! | source",
        settings,
        { homeDir: "C:\\Users\\%PATH%\\!TEMP!", platform: "win32" },
      ).displayCommand,
    ).toBe(encodedCmdPowerShell(expectedScript));
  });

  it("rejects old, empty, and unparseable migration CLI versions", async () => {
    await expect(
      inspectMigrationCli("claude", defaultSettings, async () => "2.1.185 (Claude Code)"),
    ).rejects.toThrow("Claude CLI 2.1.185 is too old");
    await expect(
      inspectMigrationCli("codex", defaultSettings, async () => "   "),
    ).rejects.toThrow("Codex CLI returned no version information");
    await expect(
      inspectMigrationCli("codebuddy", defaultSettings, async () => "version banana"),
    ).rejects.toThrow("CodeBuddy CLI returned an unparseable version");
  });

  it("does not echo potentially sensitive unparseable version output", async () => {
    const failure = inspectMigrationCli("codex", defaultSettings, async () => "API_TOKEN=do-not-leak");
    await expect(failure).rejects.toThrow("Codex CLI returned an unparseable version for codex from codex --version");
    await expect(failure).rejects.not.toThrow("do-not-leak");
  });

  it("identifies the required version label in empty and too-old errors", async () => {
    await expect(inspectMigrationCli("claude", defaultSettings, async () => " ")).rejects.toThrow("Claude Code");
    await expect(
      inspectMigrationCli("claude", defaultSettings, async () => "2.1.185 (Claude Code)"),
    ).rejects.toThrow("Claude Code");
  });

  it("formats missing binary and non-zero runner failures clearly", async () => {
    await expect(
      inspectMigrationCli(
        "claude",
        defaultSettings,
        async () => {
          throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        },
      ),
    ).rejects.toThrow("Claude CLI binary not found");
    await expect(
      inspectMigrationCli(
        "codex",
        defaultSettings,
        async () => {
          throw Object.assign(new Error("exit 1"), { code: 1, stderr: "codex --version failed" });
        },
      ),
    ).rejects.toThrow("Codex CLI --version failed for");
  });

  it("does not echo version command stdout or stderr when the command fails", async () => {
    const failure = inspectMigrationCli("codex", defaultSettings, async () => {
      throw Object.assign(new Error("exit 1"), {
        stdout: "API_TOKEN=stdout-secret",
        stderr: "API_TOKEN=stderr-secret",
      });
    });
    await expect(failure).rejects.toThrow(new Error("Codex CLI --version failed for codex."));
    await expect(failure).rejects.not.toThrow("stdout-secret");
    await expect(failure).rejects.not.toThrow("stderr-secret");
  });

  it("accepts the current and newer supported migration CLI versions", async () => {
    await expect(
      inspectMigrationCli("claude", defaultSettings, async () => "2.1.186 (Claude Code)"),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("codex", defaultSettings, async () => "codex 0.150.0"),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("codebuddy", defaultSettings, async () => "2.109.2"),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("cursor", defaultSettings, async () => "2025.12.17-996666f"),
    ).resolves.toBeUndefined();
  });

  it("validates every wrapper and upstream version rule regardless of line order or extra text", async () => {
    await expect(
      inspectMigrationCli("tclaude", defaultSettings, async () => [
        "diagnostic build 99.88.77",
        "@anthropic-ai/claude-code 2.1.154",
        "@tencent/tclaude 0.0.9",
      ].join("\n")),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("tcodex", defaultSettings, async () => [
        "@openai/codex 0.142.4",
        "extra 300.0.0",
        "@tencent/tcodex 0.0.13",
      ].join("\n")),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("claude-internal", defaultSettings, async () => [
        "claude: 2.1.154",
        "claude-internal: 1.1.9",
      ].join("\n")),
    ).resolves.toBeUndefined();
    await expect(inspectMigrationCli("codex-internal", defaultSettings, async () => "codex-cli 0.141.0")).resolves.toBeUndefined();
  });

  it.each([
    ["codex", "codex 0.141.0junk"],
    ["codex", "codex-cli 0.141.0-not-a-release"],
    ["codex", "codex 0.141"],
    ["tclaude", "@tencent/tclaude 0.0.9garbage\n@anthropic-ai/claude-code 2.1.154"],
    ["tclaude", "@tencent/tclaude 0.0.9\n@anthropic-ai/claude-code 2.1.154-preview"],
    ["claude-internal", "claude-internal: 1.1.9junk\nclaude: 2.1.154"],
    ["claude-internal", "claude-internal: 1.1.9\nclaude: 2.1.154-preview"],
  ] as const)("rejects non-release version text for %s", async (target, output) => {
    await expect(inspectMigrationCli(target, defaultSettings, async () => output)).rejects.toThrow(/version/i);
  });

  it("rejects a new wrapper with an old upstream and reports missing required lines", async () => {
    await expect(
      inspectMigrationCli("tclaude", defaultSettings, async () => [
        "@tencent/tclaude 9.0.0",
        "@anthropic-ai/claude-code 2.1.153",
      ].join("\n")),
    ).rejects.toThrow("@anthropic-ai/claude-code 2.1.153 is too old for tclaude");
    await expect(
      inspectMigrationCli("tcodex", defaultSettings, async () => "@tencent/tcodex 0.0.13"),
    ).rejects.toThrow("@openai/codex version");
    await expect(
      inspectMigrationCli("claude-internal", defaultSettings, async () => "claude: 2.1.154"),
    ).rejects.toThrow("claude-internal version");
  });

  it("passes a scoped CODEX_HOME only to Codex Internal version inspection", async () => {
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    const runner = async (command: string, args: string[], env?: Record<string, string>) => {
      calls.push({ command, args, env });
      return "Codex CLI 0.141.0";
    };

    await inspectMigrationCli("codex-internal", defaultSettings, runner, { homeDir: "/Users/a user" });
    await inspectMigrationCli("codex", defaultSettings, runner, { homeDir: "/Users/a user" });

    expect(calls).toEqual([
      { command: "codex", args: ["--version"], env: { CODEX_HOME: "/Users/a user/.codex-internal" } },
      { command: "codex", args: ["--version"], env: undefined },
    ]);
  });

  it("uses Windows path semantics for the Codex Internal version environment", async () => {
    const calls: Array<{ env?: Record<string, string> }> = [];
    await inspectMigrationCli(
      "codex-internal",
      defaultSettings,
      async (_command, _args, env) => {
        calls.push({ env });
        return "codex-cli 0.141.0";
      },
      { homeDir: "C:\\Users\\A User", platform: "win32" },
    );
    expect(calls).toEqual([{ env: { CODEX_HOME: "C:\\Users\\A User\\.codex-internal" } }]);
  });

  it("merges child process env overrides without dropping the parent environment", () => {
    const previous = process.env.AGENT_SESSION_SEARCH_ENV_CONTRACT;
    process.env.AGENT_SESSION_SEARCH_ENV_CONTRACT = "parent";
    try {
      const merged = mergeProcessEnvOverrides({ CODEX_HOME: "/custom/home" });
      expect(merged.AGENT_SESSION_SEARCH_ENV_CONTRACT).toBe("parent");
      expect(merged.CODEX_HOME).toBe("/custom/home");
      expect(merged).not.toBe(process.env);
    } finally {
      if (previous === undefined) delete process.env.AGENT_SESSION_SEARCH_ENV_CONTRACT;
      else process.env.AGENT_SESSION_SEARCH_ENV_CONTRACT = previous;
    }
  });

});

describe("migration resume terminal launch", () => {
  it("reuses the terminal launcher without fabricating a session object", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const settings = { ...defaultSettings, defaultTerminal: "Terminal" as const, codexBinary: "/opt/Codex CLI/codex" };

    await withPlatform("darwin", async () => {
      await openMigrationResumeInTerminal("codex", "session 1", "/repo with spaces", settings, {
        runProcess: async (command, args) => {
          calls.push({ command, args });
        },
      });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/usr/bin/osascript");
    expect(calls[0].args[0]).toBe("-e");
    expect(calls[0].args[1]).toContain("do script \"cd '/repo with spaces' && '/opt/Codex CLI/codex' resume 'session 1'\"");
  });

  it("opens a Ghostty migration resume command through open -na", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const settings = { ...defaultSettings, defaultTerminal: "Ghostty" as const, claudeBinary: "/opt/Claude CLI/claude" };

    await withShell("/bin/zsh", () =>
      withPlatform("darwin", async () => {
        await openMigrationResumeInTerminal("claude", "session-ghostty", "/repo", settings, {
          runProcess: async (command, args) => {
            calls.push({ command, args });
          },
        });
      })
    );

    expect(calls).toEqual([
      {
        command: "/usr/bin/open",
        args: ["-na", "Ghostty.app", "--args", "-e", "/bin/zsh", "-ic", "cd /repo && '/opt/Claude CLI/claude' --resume session-ghostty"],
      },
    ]);
  });

  it("opens a WezTerm migration resume command with the project cwd", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const settings = { ...defaultSettings, defaultTerminal: "WezTerm" as const, codeBuddyBinary: "/opt/CodeBuddy CLI/codebuddy" };

    await withShell("/bin/zsh", () =>
      withPlatform("darwin", async () => {
        await openMigrationResumeInTerminal("codebuddy", "session-wez", "/repo with spaces", settings, {
          runProcess: async (command, args) => {
            calls.push({ command, args });
          },
        });
      })
    );

    expect(calls).toEqual([
      {
        command: "/usr/bin/open",
        args: ["-na", "WezTerm.app", "--args", "start", "--", "/bin/zsh", "-ic", "cd '/repo with spaces' && '/opt/CodeBuddy CLI/codebuddy' --resume session-wez"],
      },
    ]);
  });

  it("executes a Warp migration resume command with the target binary and cwd", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const settings = { ...defaultSettings, defaultTerminal: "Warp" as const, codexBinary: "/opt/Codex CLI/codex" };

    await withPlatform("darwin", async () => {
      await openMigrationResumeInTerminal("codex", "session-warp", "/repo with spaces", settings, {
        runProcess: async (command, args) => {
          calls.push({ command, args });
        },
      });
    });

    expect(calls).toEqual([
      {
        command: "/usr/bin/osascript",
        args: [
          "-e",
          expect.stringContaining("tell application \"Warp\""),
        ],
      },
    ]);
    expect(calls[0].args[1]).toContain("cd '/repo with spaces' && '/opt/Codex CLI/codex' resume session-warp");
    expect(calls[0].args[1]).not.toContain("-a \"Warp\"");
  });

  it("launches the Windows terminal plan without spawning a real process", async () => {
    const launches: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const settings = { ...defaultSettings, defaultTerminal: "WezTerm" as const, codexBinary: "C:\\Program Files\\Codex CLI\\codex.exe" };

    await withPlatform("win32", async () => {
      await openMigrationResumeInTerminal("codex", "session-win", process.cwd(), settings, {
        platform: "win32",
        spawnDetached: async (file, args, cwd) => {
          launches.push({ file, args, cwd });
        },
      });
    });

    expect(launches[0]).toEqual({
      file: "wezterm.exe",
      args: [
        "start",
        "--cwd",
        process.cwd(),
        "--",
        "cmd.exe",
        "/d",
        "/k",
        '"C:\\Program Files\\Codex CLI\\codex.exe" resume session-win',
      ],
      cwd: undefined,
    });
  });
});
