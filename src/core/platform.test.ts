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
  getResumeCommand,
  getResumeProcessSpec,
  mergeAppSettings,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  normalizeTerminal,
  resolveMacApplicationName,
  terminalOptionsFor,
} from "./platform";
import type { SessionSearchResult } from "./types";

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

  it("builds a cmd-compatible cd prefix on Windows", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\my repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "win32" })).toBe(
      'cd /d "C:\\my repo" && claude --resume abc',
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

  it("keeps local Windows non-ssh quoting unchanged for cmd metacharacters", () => {
    const session = {
      source: "claude-cli",
      rawId: "abc",
      projectPath: "C:\\repo %USERNAME% & tools",
    } as SessionSearchResult;

    expect(getResumeCommand(session, defaultSettings, { platform: "win32" })).toBe(
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

    const command = getResumeCommand(session, defaultSettings, {
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

    const command = getResumeCommand(session, defaultSettings, {
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
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";
    try {
      const args = buildGhosttyOpenArgs(session, defaultSettings);
      expect(args.slice(0, 5)).toEqual(["-na", "Ghostty.app", "--args", "-e", "/bin/zsh"]);
      expect(args[5]).toBe("-ic");
      expect(args[6]).toBe("cd /repo && claude --resume abc");
      expect(args.some((arg) => arg.includes("--initial-command"))).toBe(false);
    } finally {
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }
  });
});

describe("terminal options per platform", () => {
  it("returns Windows terminals on win32", () => {
    expect(terminalOptionsFor("win32")).toEqual(["WindowsTerminal", "PowerShell", "Cmd", "WezTerm"]);
  });
  it("returns macOS terminals elsewhere", () => {
    expect(terminalOptionsFor("darwin")).toEqual(["Terminal", "iTerm", "Ghostty", "WezTerm", "Warp"]);
  });
  it("defaults to WindowsTerminal on win32 and Terminal on macOS", () => {
    expect(defaultTerminalFor("win32")).toBe("WindowsTerminal");
    expect(defaultTerminalFor("darwin")).toBe("Terminal");
  });
  it("normalizes a cross-platform value to the platform default", () => {
    expect(normalizeTerminal("Terminal", "win32")).toBe("WindowsTerminal");
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
