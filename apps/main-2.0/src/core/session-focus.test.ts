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

  it("does not use a remote process id for local terminal focus", () => {
    const liveSessions: LiveSession[] = [
      { family: "codex", rawId: "codex-1", pid: 301, environmentId: "ssh-devbox" },
    ];

    expect(liveSessionPidForSession(session({ rawId: "codex-1" }), liveSessions)).toBeNull();
    expect(
      liveSessionPidForSession(
        session({
          rawId: "codex-1",
          environmentId: "ssh-devbox",
          environmentKind: "ssh",
        }),
        liveSessions,
      ),
    ).toBeNull();
  });

  it("activates the terminal app that owns the live session process on macOS", async () => {
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
  });

  it("uses PowerShell with ConPTY/WindowsTerminal fallback and safe matching on Windows", async () => {
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

  it("returns false cleanly for terminal title updates on Windows", async () => {
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
});
