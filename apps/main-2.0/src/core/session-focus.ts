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
  title?: string;
  projectPath?: string;
  sessionId?: string;
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
  if (session.environmentKind !== "local") return null;
  const family = sessionSourceDescriptor(session.source).liveFamily;
  if (!family) return null;
  return liveSessions.find(
    (liveSession) => !liveSession.environmentId && liveSession.family === family && liveSession.rawId === session.rawId,
  )?.pid ?? null;
}

export async function focusLiveSessionTerminal(pid: number, options: FocusLiveSessionOptions = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Cannot focus a terminal window without a valid process id.");
  }
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runProcess;
  if (platform === "win32") {
    await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", buildWindowsFocusScript(pid, options)]);
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

function buildWindowsFocusScript(pid: number, options: FocusLiveSessionOptions = {}): string {
  const hintTitleB64 = Buffer.from((options.title?.trim() ?? "").slice(0, 512), "utf8").toString("base64");
  const hintProjectB64 = Buffer.from((options.projectPath?.trim() ?? "").slice(0, 512), "utf8").toString("base64");
  const hintSessionB64 = Buffer.from((options.sessionId?.trim() ?? "").slice(0, 256), "utf8").toString("base64");
  return `$targetProcessId = ${pid}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$hintTitle = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${hintTitleB64}'))
$hintProject = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${hintProjectB64}'))
$hintSessionId = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${hintSessionB64}'))
$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class WinFocusWindowInfo {
  public IntPtr Handle;
  public uint Pid;
  public string Title;
  public string ClassName;
}

public sealed class WinProcMeta {
  public string Cwd;
  public string WtSession;
  public string WeztermPane;
  public string TermProgram;
}

public sealed class WinConsoleMeta {
  public IntPtr Handle;
  public bool IsVisible;
  public string ClassName;
  public string Title;
}

public static class WindowFocus {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AttachConsole(uint dwProcessId);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetConsoleWindow();

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetConsoleTitle(StringBuilder lpConsoleTitle, uint nSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

  public static void FocusWindow(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return;
    if (IsIconic(hWnd)) {
      ShowWindowAsync(hWnd, 9);
    }
    IntPtr fg = GetForegroundWindow();
    uint curTid = GetCurrentThreadId();
    uint dummy;
    uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
    uint targetTid = GetWindowThreadProcessId(hWnd, out dummy);
    bool attachedFg = fgTid != 0 && fgTid != curTid && AttachThreadInput(curTid, fgTid, true);
    bool attachedTarget = targetTid != 0 && targetTid != curTid && targetTid != fgTid && AttachThreadInput(curTid, targetTid, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attachedTarget) AttachThreadInput(curTid, targetTid, false);
      if (attachedFg) AttachThreadInput(curTid, fgTid, false);
    }
  }

  public static WinFocusWindowInfo[] FindWindows() {
    var list = new List<WinFocusWindowInfo>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      int titleLen = GetWindowTextLength(hWnd);
      var titleBuf = new StringBuilder(Math.Max(titleLen + 2, 2));
      if (titleLen > 0) GetWindowText(hWnd, titleBuf, titleBuf.Capacity);
      var classBuf = new StringBuilder(256);
      GetClassName(hWnd, classBuf, classBuf.Capacity);
      list.Add(new WinFocusWindowInfo {
        Handle = hWnd,
        Pid = pid,
        Title = titleBuf.ToString(),
        ClassName = classBuf.ToString(),
      });
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static WinConsoleMeta GetConsoleWindowInfo(int pid) {
    if (pid <= 0) return null;
    FreeConsole();
    if (!AttachConsole((uint)pid)) return null;
    try {
      IntPtr hConsole = GetConsoleWindow();
      string className = "";
      bool visible = false;
      if (hConsole != IntPtr.Zero) {
        var classBuf = new StringBuilder(256);
        GetClassName(hConsole, classBuf, classBuf.Capacity);
        className = classBuf.ToString();
        visible = IsWindowVisible(hConsole) || IsIconic(hConsole);
      }
      var titleBuf = new StringBuilder(512);
      uint len = GetConsoleTitle(titleBuf, (uint)titleBuf.Capacity);
      return new WinConsoleMeta {
        Handle = hConsole,
        IsVisible = visible,
        ClassName = className,
        Title = len > 0 ? titleBuf.ToString() : "",
      };
    } finally {
      FreeConsole();
    }
  }

  private static IntPtr ReadPtr(IntPtr hProc, IntPtr addr) {
    byte[] buf = new byte[IntPtr.Size];
    IntPtr read;
    if (!ReadProcessMemory(hProc, addr, buf, buf.Length, out read) || read.ToInt32() != buf.Length) return IntPtr.Zero;
    return IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(buf, 0)) : new IntPtr(BitConverter.ToInt32(buf, 0));
  }

  private static string ReadUnicodeString(IntPtr hProc, IntPtr addr) {
    int uniSize = IntPtr.Size == 8 ? 16 : 8;
    byte[] uni = new byte[uniSize];
    IntPtr read;
    if (!ReadProcessMemory(hProc, addr, uni, uni.Length, out read) || read.ToInt32() != uni.Length) return null;
    ushort len = BitConverter.ToUInt16(uni, 0);
    if (len == 0 || len > 8192) return null;
    IntPtr strPtr = IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(uni, 8)) : new IntPtr(BitConverter.ToInt32(uni, 4));
    if (strPtr == IntPtr.Zero) return null;
    byte[] chars = new byte[len];
    if (!ReadProcessMemory(hProc, strPtr, chars, len, out read) || read.ToInt32() != len) return null;
    return Encoding.Unicode.GetString(chars).TrimEnd('\\0');
  }

  public static WinProcMeta GetProcMeta(int pid) {
    if (pid <= 0) return null;
    IntPtr hProc = OpenProcess(0x1010, false, pid);
    if (hProc == IntPtr.Zero) return null;
    try {
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
      int retLen;
      if (NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out retLen) != 0) return null;
      if (pbi.PebBaseAddress == IntPtr.Zero) return null;
      int paramsOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
      IntPtr procParams = ReadPtr(hProc, new IntPtr(pbi.PebBaseAddress.ToInt64() + paramsOffset));
      if (procParams == IntPtr.Zero) return null;
      int cwdOffset = IntPtr.Size == 8 ? 0x38 : 0x24;
      int envOffset = IntPtr.Size == 8 ? 0x80 : 0x48;
      string cwd = ReadUnicodeString(hProc, new IntPtr(procParams.ToInt64() + cwdOffset));
      if (cwd != null && cwd.Length > 3) cwd = cwd.TrimEnd('\\\\');
      IntPtr envPtr = ReadPtr(hProc, new IntPtr(procParams.ToInt64() + envOffset));
      string wtSession = null;
      string weztermPane = null;
      string termProgram = null;
      if (envPtr != IntPtr.Zero) {
        var chunks = new List<byte>();
        for (int offset = 0; offset < 65536; offset += 512) {
          byte[] chunk = new byte[512];
          IntPtr read;
          if (!ReadProcessMemory(hProc, new IntPtr(envPtr.ToInt64() + offset), chunk, chunk.Length, out read) || read.ToInt32() <= 0) break;
          int n = read.ToInt32();
          bool ended = false;
          for (int i = 0; i + 1 < n; i += 2) {
            chunks.Add(chunk[i]);
            chunks.Add(chunk[i + 1]);
            if (chunks.Count >= 4 && chunks[chunks.Count - 4] == 0 && chunks[chunks.Count - 3] == 0 && chunks[chunks.Count - 2] == 0 && chunks[chunks.Count - 1] == 0) {
              ended = true;
              break;
            }
          }
          if (ended) break;
        }
        if (chunks.Count >= 2) {
          string envText = Encoding.Unicode.GetString(chunks.ToArray());
          string[] vars = envText.Split(new char[] { '\\0' }, StringSplitOptions.RemoveEmptyEntries);
          foreach (string entry in vars) {
            if (wtSession == null && entry.StartsWith("WT_SESSION=", StringComparison.OrdinalIgnoreCase)) wtSession = entry.Substring(11);
            else if (weztermPane == null && entry.StartsWith("WEZTERM_PANE=", StringComparison.OrdinalIgnoreCase)) weztermPane = entry.Substring(13);
            else if (termProgram == null && entry.StartsWith("TERM_PROGRAM=", StringComparison.OrdinalIgnoreCase)) termProgram = entry.Substring(13);
          }
        }
      }
      return new WinProcMeta {
        Cwd = cwd,
        WtSession = wtSession,
        WeztermPane = weztermPane,
        TermProgram = termProgram,
      };
    } finally {
      CloseHandle(hProc);
    }
  }
}
'@
if (-not ('WindowFocus' -as [type])) {
  Add-Type -TypeDefinition $signature
}
$currentSessionId = (Get-Process -Id $PID).SessionId
$procsByPid = @{}
$parentsByPid = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.ProcessId -ne $null) {
    $p = [int]$_.ProcessId
    $procsByPid[$p] = $_
    if ($_.ParentProcessId -ne $null) {
      $parentsByPid[$p] = [int]$_.ParentProcessId
    }
  }
}
$allWinProcs = @{}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $allWinProcs[[uint32]$_.Id] = $_
}
$enumeratedWindows = @()
foreach ($w in [WindowFocus]::FindWindows()) {
  $proc = $allWinProcs[[uint32]$w.Pid]
  $procName = if ($proc) { $proc.ProcessName } else { "" }
  $sessId = if ($proc) { $proc.SessionId } else { -1 }
  $enumeratedWindows += [PSCustomObject]@{
    Handle = $w.Handle
    Pid = [int]$w.Pid
    Title = $w.Title
    ClassName = $w.ClassName
    ProcessName = $procName
    SessionId = $sessId
  }
}
$visited = @{}
$ancestorChain = New-Object System.Collections.Generic.List[int]
$currentProcessId = [int]$targetProcessId
while ($currentProcessId -gt 0 -and -not $visited.ContainsKey($currentProcessId)) {
  $visited[$currentProcessId] = $true
  $ancestorChain.Add($currentProcessId)
  if (-not $parentsByPid.ContainsKey($currentProcessId)) { break }
  $currentProcessId = [int]$parentsByPid[$currentProcessId]
}
$consoleMeta = [WindowFocus]::GetConsoleWindowInfo([int]$targetProcessId)
$consoleClass = if ($consoleMeta) { $consoleMeta.ClassName } else { "" }
$consoleTitle = if ($consoleMeta) { $consoleMeta.Title.Trim() } else { "" }
$procCwd = ""
$wtSession = ""
$weztermPane = ""
$termProgram = ""
foreach ($ancPid in $ancestorChain) {
  $meta = [WindowFocus]::GetProcMeta($ancPid)
  if ($meta) {
    if (-not $procCwd -and $meta.Cwd) { $procCwd = $meta.Cwd }
    if (-not $wtSession -and $meta.WtSession) { $wtSession = $meta.WtSession }
    if (-not $weztermPane -and $meta.WeztermPane) { $weztermPane = $meta.WeztermPane }
    if (-not $termProgram -and $meta.TermProgram) { $termProgram = $meta.TermProgram }
  }
  if ($procCwd -and ($wtSession -or $weztermPane -or $termProgram)) { break }
}
$focusCues = New-Object System.Collections.Generic.List[object]
$genericTitles = '^(?:Windows PowerShell|PowerShell|Command Prompt|cmd(?:\\.exe)?|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|bash|zsh)$'
if ($hintTitle.Length -ge 2) { $focusCues.Add([PSCustomObject]@{ Text = $hintTitle; Weight = 100 }) }
if ($hintSessionId.Length -ge 6) { $focusCues.Add([PSCustomObject]@{ Text = $hintSessionId; Weight = 100 }) }
if ($consoleTitle.Length -ge 3 -and $consoleTitle -notmatch $genericTitles) {
  $focusCues.Add([PSCustomObject]@{ Text = $consoleTitle; Weight = 80 })
}
foreach ($pathCue in @($hintProject, $procCwd)) {
  if ($pathCue.Length -ge 3) {
    $focusCues.Add([PSCustomObject]@{ Text = $pathCue; Weight = 50 })
    $leaf = [System.IO.Path]::GetFileName($pathCue.TrimEnd('\\', '/'))
    if ($leaf.Length -ge 2 -and $leaf -notmatch '^(?:users|home|src|tmp|temp|windows|system32)$') {
      $focusCues.Add([PSCustomObject]@{ Text = $leaf; Weight = 25 })
    }
  }
}
function Get-CueScore([string]$text) {
  if (-not $text) { return 0 }
  $normText = $text.Replace('\\', '/')
  $score = 0
  foreach ($cue in $focusCues) {
    $normCue = ($cue.Text -as [string]).Replace('\\', '/')
    if ($normText.IndexOf($normCue, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $score += $cue.Weight
    }
  }
  return $score
}
function Select-MatchingWindow([object[]]$candidates) {
  if (-not $candidates -or $candidates.Count -eq 0) { return $null }
  $bestScore = 0
  $winners = New-Object System.Collections.Generic.List[object]
  foreach ($win in $candidates) {
    $score = Get-CueScore ($win.Title -as [string])
    if ($score -gt $bestScore) {
      $bestScore = $score
      $winners.Clear()
      $winners.Add($win)
    } elseif ($score -gt 0 -and $score -eq $bestScore) {
      $winners.Add($win)
    }
  }
  if ($bestScore -gt 0 -and $winners.Count -eq 1) { return $winners[0] }
  return $null
}
# A Windows Terminal window title only shows its active tab. A session in a background tab is
# found through the tabs' UI Automation names, then that tab is selected before focusing.
function Select-MatchingWtTab([object[]]$wtWins) {
  if (-not $wtWins -or $wtWins.Count -eq 0) { return $null }
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
  } catch {
    # UI Automation is unavailable (e.g. Server Core); window-title matching already ran.
    return $null
  }
  $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $bestScore = 0
  $winners = New-Object System.Collections.Generic.List[object]
  foreach ($win in $wtWins) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($win.Handle)
    if (-not $root) { continue }
    foreach ($tab in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)) {
      $score = Get-CueScore ($tab.Current.Name -as [string])
      if ($score -gt $bestScore) {
        $bestScore = $score
        $winners.Clear()
        $winners.Add([PSCustomObject]@{ Window = $win; Tab = $tab })
      } elseif ($score -gt 0 -and $score -eq $bestScore) {
        $winners.Add([PSCustomObject]@{ Window = $win; Tab = $tab })
      }
    }
  }
  if ($bestScore -gt 0 -and $winners.Count -eq 1) { return $winners[0] }
  return $null
}
function Focus-WtTab([object]$match) {
  $selection = $null
  if ($match.Tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
    $selection.Select()
  }
  [WindowFocus]::FocusWindow($match.Window.Handle)
}
$ancestorNames = @($ancestorChain | ForEach-Object {
  $pInfo = $procsByPid[$_]
  if ($pInfo -and $pInfo.Name) { $pInfo.Name -replace '\.exe$', '' }
})
foreach ($ancPid in $ancestorChain) {
  $proc = $allWinProcs[[uint32]$ancPid]
  $ancWins = @($enumeratedWindows | Where-Object { $_.Pid -eq $ancPid })
  if ($ancWins.Count -gt 1) {
    $matchedAnc = Select-MatchingWindow $ancWins
    if ($matchedAnc) {
      [WindowFocus]::FocusWindow($matchedAnc.Handle)
      exit 0
    }
    break
  }
  if ($ancWins.Count -eq 1) {
    $isWtHost = $ancWins[0].ProcessName -match '^(?:WindowsTerminal|wt)$'
    if ($isWtHost) {
      $allWt = @($enumeratedWindows | Where-Object { $_.SessionId -eq $currentSessionId -and ($_.ProcessName -match '^(?:WindowsTerminal|wt)$') })
      if ($allWt.Count -gt 1) {
        $matchedWt = Select-MatchingWindow $allWt
        if ($matchedWt) {
          [WindowFocus]::FocusWindow($matchedWt.Handle)
          exit 0
        }
        $matchedTab = Select-MatchingWtTab $allWt
        if ($matchedTab) {
          Focus-WtTab $matchedTab
          exit 0
        }
        throw "Could not find a visible terminal window for this open session."
      }
    }
    [WindowFocus]::FocusWindow($ancWins[0].Handle)
    exit 0
  }
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    [WindowFocus]::FocusWindow($proc.MainWindowHandle)
    exit 0
  }
}
if ($consoleMeta -and $consoleMeta.Handle -ne [IntPtr]::Zero -and $consoleMeta.IsVisible -and $consoleClass -ne 'PseudoConsoleWindow') {
  [WindowFocus]::FocusWindow($consoleMeta.Handle)
  exit 0
}
$isWtConfirmed = [bool]$wtSession -or ($consoleClass -eq 'PseudoConsoleWindow') -or (@($ancestorNames | Where-Object { $_ -match '^(?:WindowsTerminal|wt|OpenConsole)$' }).Count -gt 0)
if ($isWtConfirmed) {
  $wtWindows = @($enumeratedWindows | Where-Object { $_.SessionId -eq $currentSessionId -and ($_.ProcessName -match '^(?:WindowsTerminal|wt)$') })
  $matchedWt = Select-MatchingWindow $wtWindows
  if ($matchedWt) {
    [WindowFocus]::FocusWindow($matchedWt.Handle)
    exit 0
  }
  $matchedTab = Select-MatchingWtTab $wtWindows
  if ($matchedTab) {
    Focus-WtTab $matchedTab
    exit 0
  }
  if ($wtWindows.Count -eq 1) {
    [WindowFocus]::FocusWindow($wtWindows[0].Handle)
    exit 0
  }
}
$isWezConfirmed = [bool]$weztermPane -or (@($ancestorNames | Where-Object { $_ -match '^wezterm(?:-gui)?$' }).Count -gt 0)
if ($isWezConfirmed) {
  $wezWindows = @($enumeratedWindows | Where-Object { $_.SessionId -eq $currentSessionId -and ($_.ProcessName -match '^wezterm-gui$') })
  $matchedWez = Select-MatchingWindow $wezWindows
  if ($matchedWez) {
    [WindowFocus]::FocusWindow($matchedWez.Handle)
    exit 0
  }
  if ($wezWindows.Count -eq 1) {
    [WindowFocus]::FocusWindow($wezWindows[0].Handle)
    exit 0
  }
}
$isIdeConfirmed = ($termProgram -eq 'vscode') -or (@($ancestorNames | Where-Object { $_ -match '^(?:Code|Cursor|Trae|Windsurf|Code - Insiders)$' }).Count -gt 0)
if ($isIdeConfirmed) {
  $ideWindows = @($enumeratedWindows | Where-Object { $_.SessionId -eq $currentSessionId -and ($_.ProcessName -match '^(?:Code|Cursor|Trae|Windsurf|Code - Insiders)$') })
  $matchedIde = Select-MatchingWindow $ideWindows
  if ($matchedIde) {
    [WindowFocus]::FocusWindow($matchedIde.Handle)
    exit 0
  }
  if ($ideWindows.Count -eq 1 -and -not $isWtConfirmed) {
    [WindowFocus]::FocusWindow($ideWindows[0].Handle)
    exit 0
  }
}
throw "Could not find a visible terminal window for this open session."`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runProcess(command: string, args: string[], options: CommandRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
