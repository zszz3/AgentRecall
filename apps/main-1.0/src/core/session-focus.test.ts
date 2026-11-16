import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusLiveSessionTerminal, liveSessionPidForSession, setLiveSessionTerminalTitle } from "./session-focus";
import type { LiveSession, SessionSearchResult } from "./types";

const childProcessHooks = vi.hoisted(() => ({
  interceptExecFile: null as null | ((...args: unknown[]) => void),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (childProcessHooks.interceptExecFile) {
        childProcessHooks.interceptExecFile(...args);
        return {} as ReturnType<typeof actual.execFile>;
      }
      return Reflect.apply(actual.execFile, actual, args);
    },
  };
});

beforeEach(() => {
  childProcessHooks.interceptExecFile = null;
});

function session(overrides: Partial<SessionSearchResult>): SessionSearchResult {
  return {
    sessionKey: "codex-cli:codex-1",
    rawId: "codex-1",
    source: "codex-cli",
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    projectPath: "",
    filePath: "",
    originalTitle: "",
    firstQuestion: "",
    timestamp: 0,
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    displayTitle: "",
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 0,
    aiSummary: null,
    aiSummaryStale: false,
    ...overrides,
  };
}

describe("live session focus", () => {
  it("matches an open process by session family and raw id", () => {
    const liveSessions: LiveSession[] = [
      { family: "claude", rawId: "codex-1", pid: 10 },
      { family: "codex", rawId: "codex-1", pid: 20 },
    ];

    expect(liveSessionPidForSession(session({ source: "codex-cli", rawId: "codex-1" }), liveSessions)).toBe(20);
  });

  it("does not match unsupported sources against CodeBuddy live sessions", () => {
    const liveSessions: LiveSession[] = [{ family: "codebuddy", rawId: "same-id", pid: 30 }];

    expect(liveSessionPidForSession(session({ source: "opencode-cli", rawId: "same-id" }), liveSessions)).toBeNull();
  });

  it("does not use a remote process id for local terminal focus", () => {
    const liveSessions: LiveSession[] = [
      { family: "codex", rawId: "codex-1", pid: 301, environmentId: "ssh-devbox" },
    ];

    expect(liveSessionPidForSession(session({ rawId: "codex-1" }), liveSessions)).toBeNull();
    expect(liveSessionPidForSession(session({
      rawId: "codex-1",
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
    }), liveSessions)).toBeNull();
  });

  it("activates the terminal app that owns the live session process", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 /opt/homebrew/bin/codex resume codex-1\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") return "101 1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n";
      return "false\n";
    };

    await focusLiveSessionTerminal(303, { platform: "darwin", runner });

    expect(calls.at(-1)).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", 'tell application "iTerm" to activate'],
    });
    expect(calls.some((call) => call.args.join(" ") === "-axo pid=,ppid=,command=")).toBe(false);
  });

  it("falls back to app activation when tty lookup fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") throw new Error("tty unavailable");
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 /opt/homebrew/bin/codex resume codex-1\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") return "101 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n";
      return "";
    };

    await focusLiveSessionTerminal(303, { platform: "darwin", runner });

    expect(calls.at(-1)).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", 'tell application "Terminal" to activate'],
    });
  });

  it("uses PowerShell to focus the owning terminal window on Windows", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      return "";
    };

    await focusLiveSessionTerminal(404, {
      platform: "win32",
      title: "Fix '中文' \"title\"",
      projectPath: "D:\\work\\agent-session-search",
      sessionId: "sess-win-404",
      runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("powershell.exe");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    const script = calls[0].args.at(-1) ?? "";
    expect(script).toContain("$targetProcessId = 404");
    expect(script).toContain("SetForegroundWindow");
    expect(script).toContain("ShowWindowAsync");
    expect(script).toContain("PseudoConsoleWindow");
    expect(script).toContain("WT_SESSION=");
    expect(script).toContain("WindowsTerminal");
    expect(script).toContain("Select-MatchingWindow");
    expect(script).not.toContain("Fix '中文'");
  });

  it("hides the default PowerShell subprocess and validates pid on Windows", async () => {
    await expect(focusLiveSessionTerminal(0, { platform: "win32" })).rejects.toThrow("valid process id");

    const captured: Array<{ command: unknown; args: unknown; options: unknown }> = [];
    childProcessHooks.interceptExecFile = (command, args, options, callback) => {
      captured.push({ command, args, options });
      (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, "", "");
    };

    await focusLiveSessionTerminal(404, { platform: "win32" });

    expect(captured).toHaveLength(1);
    expect(captured[0].command).toBe("powershell.exe");
    expect(captured[0].options).toEqual(expect.objectContaining({ windowsHide: true }));
  });

  it.runIf(process.platform === "win32")(
    "parses cleanly, compiles Win32 WindowFocus helpers, and refuses unrelated windows on unknown pid",
    async () => {
      let generatedScript = "";
      await focusLiveSessionTerminal(999999999, {
        platform: "win32",
        title: "Adversarial ' \" $env:TEMP $(whoami) 中文标题",
        projectPath: "C:\\Work\\My Repo",
        sessionId: "11111111-2222-4333-8444-555555555555",
        runner: async (_command, args) => {
          generatedScript = args.at(-1) ?? "";
          return "";
        },
      });

      const runRealPs = (script: string): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (error, stdout, stderr) => {
            if (!error) return resolve(stdout);
            reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
          });
        });

      const signatureMatch = generatedScript.match(/\$signature = @'\r?\n([\s\S]*?)\r?\n'@/);
      expect(signatureMatch).not.toBeNull();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-focus-ps-"));
      const tempScript = path.join(tempDir, "focus-probe.ps1");
      try {
        fs.writeFileSync(tempScript, generatedScript, "utf8");
        const escapedPath = tempScript.replace(/'/g, "''");
        const probeResult = await runRealPs(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors)
$signature = @'
${signatureMatch![1]}
'@
if (-not ('WindowFocus' -as [type])) { Add-Type -TypeDefinition $signature }
$meta = [WindowFocus]::GetProcMeta($PID)
$wins = [WindowFocus]::FindWindows()
$nullConsole = [WindowFocus]::GetConsoleWindowInfo(0)
[PSCustomObject]@{
  ErrorCount = $errors.Count
  Cwd = $meta.Cwd
  WindowCount = $wins.Length
  NullConsoleIsNull = ($null -eq $nullConsole)
} | ConvertTo-Json -Compress
`);
        const parsed = JSON.parse(probeResult.trim()) as {
          ErrorCount: number;
          Cwd: string;
          WindowCount: number;
          NullConsoleIsNull: boolean;
        };
        expect(parsed.ErrorCount).toBe(0);
        expect(parsed.Cwd.toLowerCase()).toBe(process.cwd().toLowerCase());
        expect(parsed.WindowCount).toBeGreaterThanOrEqual(0);
        expect(parsed.NullConsoleIsNull).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      await expect(focusLiveSessionTerminal(999999999, { platform: "win32" })).rejects.toThrow(
        "Could not find a visible terminal window for this open session.",
      );
    },
  );

  it("sets a Terminal tab custom title by TTY without sending shell input", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 codex resume abc\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") {
        return "101 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n";
      }
      return "true\n";
    };

    await expect(setLiveSessionTerminalTitle(303, "修复登录", { platform: "darwin", runner })).resolves.toBe(true);
    const script = calls.at(-1)?.args.at(-1) ?? "";
    expect(script).toContain('set custom title of terminalTab to "修复登录"');
    expect(script).toContain("set title displays custom title of terminalTab to true");
    expect(script).not.toContain("write text");
  });

  it("sets an iTerm session name by TTY without sending shell input", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 codex resume abc\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") {
        return "101 1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n";
      }
      return "true\n";
    };

    await expect(setLiveSessionTerminalTitle(303, "New name", { platform: "darwin", runner })).resolves.toBe(true);
    const script = calls.at(-1)?.args.at(-1) ?? "";
    expect(script).toContain('set name of terminalSession to "New name"');
    expect(script).not.toContain("write text");
  });

  it("uses the target WezTerm instance socket and pane for an exact tab title update", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<string> => {
      calls.push({ command, args, env: options?.env });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 codex resume abc\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") {
        return "101 1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui\n";
      }
      if (args.join(" ") === "eww -p 303 -o command=") {
        return "codex resume abc WEZTERM_PANE=42 WEZTERM_UNIX_SOCKET=/tmp/wezterm-gui-123 PATH=/usr/bin\n";
      }
      return "";
    };

    await expect(setLiveSessionTerminalTitle(303, "New name", { platform: "darwin", runner })).resolves.toBe(true);
    expect(calls.at(-1)?.command).toBe("wezterm");
    expect(calls.at(-1)?.args).toEqual(["cli", "set-tab-title", "--pane-id", "42", "New name"]);
    expect(calls.at(-1)?.env?.WEZTERM_UNIX_SOCKET).toBe("/tmp/wezterm-gui-123");
  });

  it("does not update WezTerm when its owning GUI instance cannot be identified", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 codex resume abc\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") {
        return "101 1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui\n";
      }
      if (args.join(" ") === "eww -p 303 -o command=") return "codex resume abc WEZTERM_PANE=42 PATH=/usr/bin\n";
      return "";
    };

    await expect(setLiveSessionTerminalTitle(303, "New name", { platform: "darwin", runner })).resolves.toBe(false);
    expect(calls.some((call) => call.command === "wezterm")).toBe(false);
  });

  it("does not inject commands for unsupported live terminals", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      if (args.join(" ") === "-o tty= -p 303") return "ttys003\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 303") return "303 202 codex resume abc\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 202") return "202 101 -zsh\n";
      if (args.join(" ") === "-o pid=,ppid=,command= -p 101") {
        return "101 1 /Applications/Warp.app/Contents/MacOS/Warp\n";
      }
      return "";
    };

    await expect(setLiveSessionTerminalTitle(303, "New name", { platform: "darwin", runner })).resolves.toBe(false);
    expect(calls.every((call) => call.command !== "/usr/bin/osascript" && call.command !== "wezterm")).toBe(true);

    let windowsCalls = 0;
    await expect(
      setLiveSessionTerminalTitle(303, "New name", {
        platform: "win32",
        runner: async () => {
          windowsCalls += 1;
          return "";
        },
      }),
    ).resolves.toBe(false);
    expect(windowsCalls).toBe(0);
  });
});
