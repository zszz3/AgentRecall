import { execFile } from "node:child_process";
import { sessionSourceDescriptor } from "./session-sources";
import { normalizeTerminalTitle } from "./terminal-title";
import type { LiveSession, SessionSearchResult } from "./types";

interface CommandRunOptions {
  env?: NodeJS.ProcessEnv;
}

type CommandRunner = (command: string, args: string[], options?: CommandRunOptions) => Promise<string>;

export interface FocusLiveSessionOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}

interface ProcessRecord {
  pid: number;
  ppid: number;
  command: string;
}

interface TerminalTarget {
  appName: string;
}

interface WezTermTarget {
  paneId: string;
  unixSocket: string;
}

export function liveSessionPidForSession(session: SessionSearchResult, liveSessions: LiveSession[]): number | null {
  const family = sessionSourceDescriptor(session.source).liveFamily;
  if (!family) return null;
  return liveSessions.find((liveSession) => liveSession.family === family && liveSession.rawId === session.rawId)?.pid ?? null;
}

export async function focusLiveSessionTerminal(pid: number, options: FocusLiveSessionOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runProcess;
  if (platform === "win32") {
    await runner("powershell.exe", ["-NoProfile", "-Command", buildWindowsFocusScript(pid)]);
    return;
  }

  if (platform !== "darwin") {
    throw new Error("Bringing an existing terminal to front is currently supported on macOS and Windows only.");
  }

  const tty = await ttyForPid(pid, runner);
  const target = await findTerminalTarget(pid, runner);
  if (!target) throw new Error("Could not find the terminal app for this open session.");

  if (tty && (target.appName === "Terminal" || target.appName === "iTerm")) {
    try {
      const focused = await runner("/usr/bin/osascript", ["-e", buildTtyFocusScript(target.appName, tty)]);
      if (focused.trim() === "true") return;
    } catch {
      // Fall back to app activation below if tab-level focusing is unavailable.
    }
  }

  await runner("/usr/bin/osascript", ["-e", `tell application "${escapeAppleScript(target.appName)}" to activate`]);
}

export async function setLiveSessionTerminalTitle(
  pid: number,
  title: string,
  options: FocusLiveSessionOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runProcess;
  if (platform !== "darwin") return false;

  const tty = await ttyForPid(pid, runner);
  const target = await findTerminalTarget(pid, runner);
  if (!tty || !target) return false;

  const normalizedTitle = normalizeTerminalTitle(title);
  if (target.appName === "Terminal" || target.appName === "iTerm") {
    const output = await runner("/usr/bin/osascript", [
      "-e",
      buildTtyTitleScript(target.appName, tty, normalizedTitle),
    ]);
    return output.trim() === "true";
  }

  if (target.appName === "WezTerm") {
    const wezTermTarget = await wezTermTargetForPid(pid, runner);
    if (!wezTermTarget) return false;
    await runner(
      "wezterm",
      ["cli", "set-tab-title", "--pane-id", wezTermTarget.paneId, normalizedTitle],
      { env: { ...process.env, WEZTERM_UNIX_SOCKET: wezTermTarget.unixSocket } },
    );
    return true;
  }

  return false;
}

async function ttyForPid(pid: number, runner: CommandRunner): Promise<string | null> {
  try {
    return normalizeTty(await runner("/bin/ps", ["-o", "tty=", "-p", String(pid)]));
  } catch {
    return null;
  }
}

async function findTerminalTarget(pid: number, runner: CommandRunner): Promise<TerminalTarget | null> {
  const visited = new Set<number>();
  let current: ProcessRecord | null = await processRecordForPid(pid, runner);

  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    const target = terminalTargetFromCommand(current.command);
    if (target) return target;
    current = await processRecordForPid(current.ppid, runner);
  }

  return null;
}

async function processRecordForPid(pid: number, runner: CommandRunner): Promise<ProcessRecord | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const output = await runner("/bin/ps", ["-o", "pid=,ppid=,command=", "-p", String(pid)]);
    return parseProcessRecords(output)[0] ?? null;
  } catch {
    return null;
  }
}

function terminalTargetFromCommand(command: string): TerminalTarget | null {
  const lower = command.toLowerCase();
  const executable = normalizedExecutableName(command.split(/\s+/)[0]);

  if (lower.includes("/terminal.app/") || executable === "terminal") return { appName: "Terminal" };
  if (lower.includes("/iterm.app/") || lower.includes("/iterm2.app/") || executable === "iterm" || executable === "iterm2") {
    return { appName: "iTerm" };
  }
  if (lower.includes("/ghostty.app/") || executable === "ghostty") return { appName: "Ghostty" };
  if (lower.includes("/wezterm.app/") || executable === "wezterm-gui" || executable === "wezterm") return { appName: "WezTerm" };
  if (lower.includes("/warp.app/") || executable === "warp") return { appName: "Warp" };

  return null;
}

function parseProcessRecords(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3]?.trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !command) continue;
    records.push({ pid, ppid, command });
  }
  return records;
}

function normalizeTty(output: string): string | null {
  const tty = output.trim();
  if (!tty || tty === "??") return null;
  return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

function buildTtyFocusScript(appName: "Terminal" | "iTerm", tty: string): string {
  const escapedTty = escapeAppleScript(tty);
  if (appName === "Terminal") {
    return `set targetTty to "${escapedTty}"
tell application "Terminal"
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      if tty of terminalTab is targetTty then
        activate
        set selected tab of terminalWindow to terminalTab
        set index of terminalWindow to 1
        return "true"
      end if
    end repeat
  end repeat
  activate
end tell
return "false"`;
  }

  return `set targetTty to "${escapedTty}"
tell application "iTerm"
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      repeat with terminalSession in sessions of terminalTab
        if tty of terminalSession is targetTty then
          activate
          select terminalTab
          select terminalSession
          set index of terminalWindow to 1
          return "true"
        end if
      end repeat
    end repeat
  end repeat
  activate
end tell
return "false"`;
}

function buildTtyTitleScript(appName: "Terminal" | "iTerm", tty: string, title: string): string {
  const escapedTty = escapeAppleScript(tty);
  const escapedTitle = escapeAppleScript(title);
  if (appName === "Terminal") {
    return `set targetTty to "${escapedTty}"
tell application "Terminal"
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      if tty of terminalTab is targetTty then
        set custom title of terminalTab to "${escapedTitle}"
        set title displays custom title of terminalTab to true
        return "true"
      end if
    end repeat
  end repeat
end tell
return "false"`;
  }

  return `set targetTty to "${escapedTty}"
tell application "iTerm"
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      repeat with terminalSession in sessions of terminalTab
        if tty of terminalSession is targetTty then
          set name of terminalSession to "${escapedTitle}"
          return "true"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "false"`;
}

async function wezTermTargetForPid(pid: number, runner: CommandRunner): Promise<WezTermTarget | null> {
  try {
    const output = await runner("/bin/ps", ["eww", "-p", String(pid), "-o", "command="]);
    const paneId = output.match(/(?:^|\s)WEZTERM_PANE=(\d+)(?=\s|$)/)?.[1];
    const unixSocket = output.match(/(?:^|\s)WEZTERM_UNIX_SOCKET=([^\s]+)(?=\s|$)/)?.[1];
    return paneId && unixSocket ? { paneId, unixSocket } : null;
  } catch {
    return null;
  }
}

function normalizedExecutableName(token: string | undefined): string {
  if (!token) return "";
  return token.replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop()?.toLowerCase() || "";
}

function buildWindowsFocusScript(pid: number): string {
  return `$targetProcessId = ${pid}
$signature = @"
using System;
using System.Runtime.InteropServices;
public static class WindowFocus {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$parentsByPid = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.ProcessId -ne $null -and $_.ParentProcessId -ne $null) {
    $parentsByPid[[int]$_.ProcessId] = [int]$_.ParentProcessId
  }
}
$visited = @{}
$currentProcessId = [int]$targetProcessId
while ($currentProcessId -gt 0 -and -not $visited.ContainsKey($currentProcessId)) {
  $visited[$currentProcessId] = $true
  $process = Get-Process -Id $currentProcessId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    [WindowFocus]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    exit 0
  }
  if (-not $parentsByPid.ContainsKey($currentProcessId)) { break }
  $currentProcessId = [int]$parentsByPid[$currentProcessId]
}
throw "Could not find a visible terminal window for this open session."`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runProcess(command: string, args: string[], options: CommandRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
