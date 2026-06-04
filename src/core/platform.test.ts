import { describe, expect, it } from "vitest";
import {
  buildGhosttyOpenArgs,
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
    expect(terminalOptionsFor("win32")).toEqual(["WindowsTerminal", "PowerShell", "Cmd"]);
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
});
