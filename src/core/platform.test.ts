import { describe, expect, it } from "vitest";
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
  getResumeCommand,
  getResumeProcessSpec,
  inspectMigrationCli,
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

describe("platform application resolution", () => {
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

  it("keeps local Windows Cmd quoting unchanged for cmd metacharacters", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\repo %USERNAME% & tools",
    } as SessionSearchResult;
    const settings = { ...defaultSettings, defaultTerminal: "Cmd" as const };

    expect(getResumeCommand(session, settings, { platform: "win32" })).toBe(
      'cd /d "C:\\repo %USERNAME% & tools" && claude --resume abc',
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
  it("maps each migration target to its configured binary", () => {
    const settings = {
      ...defaultSettings,
      claudeBinary: "/opt/Claude CLI/claude",
      codexBinary: "/opt/Codex CLI/codex",
      codeBuddyBinary: "/opt/CodeBuddy CLI/codebuddy",
    };

    expect(migrationBinary("claude", settings)).toBe("/opt/Claude CLI/claude");
    expect(migrationBinary("codex", settings)).toBe("/opt/Codex CLI/codex");
    expect(migrationBinary("codebuddy", settings)).toBe("/opt/CodeBuddy CLI/codebuddy");
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

  it("rejects old, empty, and unparseable migration CLI versions", async () => {
    await expect(
      inspectMigrationCli("claude", defaultSettings, async () => "2.1.185"),
    ).rejects.toThrow("Claude CLI 2.1.185 is too old");
    await expect(
      inspectMigrationCli("codex", defaultSettings, async () => "   "),
    ).rejects.toThrow("Codex CLI returned no version information");
    await expect(
      inspectMigrationCli("codebuddy", defaultSettings, async () => "version banana"),
    ).rejects.toThrow("CodeBuddy CLI returned an unparseable version");
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

  it("accepts the current and newer supported migration CLI versions", async () => {
    await expect(
      inspectMigrationCli("claude", defaultSettings, async () => "Claude Code 2.1.186"),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("codex", defaultSettings, async () => "codex 0.150.0"),
    ).resolves.toBeUndefined();
    await expect(
      inspectMigrationCli("codebuddy", defaultSettings, async () => "CodeBuddy 2.109.2"),
    ).resolves.toBeUndefined();
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
