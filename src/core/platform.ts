import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  defaultApiConfig,
  defaultClaudeApiConfig,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "./api-config";
import { DEFAULT_GLOBAL_SHORTCUT, normalizeGlobalShortcut, type GlobalShortcut } from "./shortcuts";
import {
  type TerminalChoice,
  defaultTerminalFor,
  normalizeTerminal,
  terminalOptionsFor,
} from "./terminal-options";
import type { SessionSearchResult, SessionSource } from "./types";

export { type TerminalChoice, defaultTerminalFor, normalizeTerminal, terminalOptionsFor } from "./terminal-options";
export {
  defaultApiConfig,
  defaultClaudeApiConfig,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ApiFormat,
  type ApiProviderChoice,
  type ClaudeApiConfig,
  type ClaudeApiFormat,
} from "./api-config";

type ProcessRunner = (command: string, args: string[]) => Promise<void>;

export interface ResumeProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  displayCommand: string;
}

interface ResumeOptions {
  withCwd?: boolean;
  skipPermissions?: boolean;
  platform?: NodeJS.Platform;
  sshTarget?: string;
  sshArgs?: string[];
}

type ResumeOpenOptions = Pick<ResumeOptions, "skipPermissions" | "platform" | "sshTarget" | "sshArgs">;

export interface AppSettings {
  defaultTerminal: TerminalChoice;
  globalShortcut: GlobalShortcut;
  claudeBinary: string;
  codexBinary: string;
  codeBuddyBinary: string;
  includeClaudeInternal: boolean;
  includeCodexInternal: boolean;
  includeCodeBuddyCli: boolean;
  hideCodexQuota: boolean;
  hideClaudeQuota: boolean;
  apiConfig: ApiConfig;
  claudeApiConfig: ClaudeApiConfig;
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, "apiConfig" | "claudeApiConfig">> & {
  apiConfig?: Partial<ApiConfig>;
  claudeApiConfig?: Partial<ClaudeApiConfig>;
};

export const defaultSettings: AppSettings = {
  defaultTerminal: defaultTerminalFor(),
  globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  claudeBinary: "claude",
  codexBinary: "codex",
  codeBuddyBinary: "codebuddy",
  includeClaudeInternal: false,
  includeCodexInternal: false,
  includeCodeBuddyCli: false,
  hideCodexQuota: false,
  hideClaudeQuota: false,
  apiConfig: defaultApiConfig,
  claudeApiConfig: defaultClaudeApiConfig,
};

export function mergeAppSettings(previous: AppSettings, updates: AppSettingsUpdate): AppSettings {
  const merged = { ...previous, ...updates };
  return {
    ...merged,
    defaultTerminal: normalizeTerminal(merged.defaultTerminal),
    globalShortcut: normalizeGlobalShortcut(merged.globalShortcut),
    apiConfig: normalizeApiConfig({ ...previous.apiConfig, ...(updates.apiConfig ?? {}) }),
    claudeApiConfig: normalizeClaudeApiConfig({ ...previous.claudeApiConfig, ...(updates.claudeApiConfig ?? {}) }),
  };
}

const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];

export function sourceFamily(source: SessionSource): "claude" | "codex" | "codebuddy" {
  if (source === "codebuddy-cli") return "codebuddy";
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}

function buildResumeProcessArgs(
  session: SessionSearchResult,
  settings: AppSettings,
  skipPermissions: boolean,
): { command: string; args: string[] } {
  const family = sourceFamily(session.source);
  if (family === "claude") {
    const args = ["--resume", session.rawId];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    return { command: settings.claudeBinary, args };
  }
  if (family === "codebuddy") {
    return { command: settings.codeBuddyBinary, args: ["--resume", session.rawId] };
  }

  const args = ["resume", session.rawId];
  if (skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  return { command: settings.codexBinary, args };
}

// Which shell the displayed/copied command is meant to be pasted into. The
// remote (ssh) command body always runs on a POSIX login shell; the local
// terminal can be cmd.exe or PowerShell on Windows.
type ShellKind = "posix" | "cmd" | "powershell";

function localShellKind(platform: NodeJS.Platform, settings: AppSettings): ShellKind {
  if (platform !== "win32") return "posix";
  return normalizeTerminal(settings.defaultTerminal, "win32") === "PowerShell" ? "powershell" : "cmd";
}

function shellTokenQuote(s: string, shell: ShellKind): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  if (shell === "cmd") return winQuote(s);
  if (shell === "powershell") return powershellQuote(s);
  return shellQuote(s);
}

function buildCdPrefix(projectPath: string, shell: ShellKind): string {
  // PowerShell has no `cd /d` and chains statements with `;`; cmd uses `&&`.
  if (shell === "cmd") return `cd /d ${winQuote(projectPath)} && `;
  if (shell === "powershell") return `cd ${powershellQuote(projectPath)}; `;
  return `cd ${shellQuote(projectPath)} && `;
}

function buildResumeShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: Required<Pick<ResumeOptions, "withCwd" | "skipPermissions">> & { shell: ShellKind },
): string {
  const { command, args } = buildResumeProcessArgs(session, settings, opts.skipPermissions);
  const quotedCommand = shellTokenQuote(command, opts.shell);
  // PowerShell treats a quoted leading token as a string literal, so the call
  // operator `&` is required to actually run a quoted executable path.
  const invocation = opts.shell === "powershell" && quotedCommand !== command ? `& ${quotedCommand}` : quotedCommand;
  let cmd = [invocation, ...args.map((token) => shellTokenQuote(token, opts.shell))].join(" ");
  if (opts.withCwd && session.projectPath) {
    cmd = `${buildCdPrefix(session.projectPath, opts.shell)}${cmd}`;
  }
  return cmd;
}

export function getResumeCommand(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: ResumeOptions = {},
): string {
  const { withCwd = true, skipPermissions = false, platform = process.platform } = opts;
  const sshArgs = resolveSshArgs(opts);
  const shell = localShellKind(platform, settings);
  if (sshArgs) {
    // The remote command body always targets a POSIX shell; only the outer ssh
    // invocation is quoted for the local terminal (cmd carets vs PowerShell).
    const innerCommand = buildResumeShellCommand(session, settings, { withCwd, skipPermissions, shell: "posix" });
    if (shell === "powershell") return formatPowershellSshDisplay(sshArgs, innerCommand);
    return formatSshDisplayCommand(sshArgs, innerCommand, platform);
  }
  return buildResumeShellCommand(session, settings, { withCwd, skipPermissions, shell });
}

function formatPowershellSshDisplay(sshArgs: string[], innerCommand: string): string {
  return ["ssh", ...sshArgs.map(powershellSshArgQuote), powershellQuote(innerCommand)].join(" ");
}

export interface WindowsLaunch {
  file: string;
  args: string[];
  cwd?: string;
}

// Ordered candidate launches. The caller tries each until one spawns (ENOENT -> next).
export function buildWindowsLaunchPlan(terminal: TerminalChoice, command: string, cwd: string): WindowsLaunch[] {
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", command];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...inner] : inner };
  };
  const pwsh = (): WindowsLaunch => ({ file: "pwsh.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", command], cwd: cwd || undefined });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", command],
    cwd: cwd || undefined,
  });
  const cmd = (): WindowsLaunch => ({ file: "cmd.exe", args: ["/d", "/k", command], cwd: cwd || undefined });
  const wezterm = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", command];
    return { file: "wezterm.exe", args: cwd ? ["start", "--cwd", cwd, "--", ...inner] : ["start", "--", ...inner] };
  };

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  if (terminal === "WezTerm") return [wezterm(), wt(), pwsh(), powershell(), cmd()];
  // WindowsTerminal (default): wt first, then fall back through shells.
  return [wt(), pwsh(), powershell(), cmd()];
}

function buildWindowsShellSpecificLaunchPlan(
  terminal: TerminalChoice,
  cmdCommand: string,
  powershellCommand: string,
  cwd: string,
): WindowsLaunch[] {
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...inner] : inner };
  };
  const pwsh = (): WindowsLaunch => ({
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand],
    cwd: cwd || undefined,
  });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand],
    cwd: cwd || undefined,
  });
  const cmd = (): WindowsLaunch => ({ file: "cmd.exe", args: ["/d", "/k", cmdCommand], cwd: cwd || undefined });
  const wezterm = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wezterm.exe", args: cwd ? ["start", "--cwd", cwd, "--", ...inner] : ["start", "--", ...inner] };
  };

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  if (terminal === "WezTerm") return [wezterm(), wt(), pwsh(), powershell(), cmd()];
  return [wt(), pwsh(), powershell(), cmd()];
}

export function buildWindowsResumeLaunchPlan(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { terminal?: TerminalChoice } = {},
): WindowsLaunch[] {
  const platform = opts.platform ?? "win32";
  const sshArgs = resolveSshArgs(opts);
  // The launch plan wraps this string in `cmd.exe /d /k`, so it must always be
  // cmd-syntax even when the user's preferred terminal is PowerShell (that
  // variant is supplied separately as `powershellCommand`).
  const cmdCommand = getResumeCommand(session, { ...settings, defaultTerminal: "Cmd" }, {
    withCwd: Boolean(sshArgs),
    skipPermissions: opts.skipPermissions,
    platform,
    sshTarget: opts.sshTarget,
    sshArgs: opts.sshArgs,
  });
  const terminal = normalizeTerminal(opts.terminal ?? settings.defaultTerminal, "win32");
  const cwd = sshArgs ? "" : existingDirectory(session.projectPath);
  if (!sshArgs) return buildWindowsLaunchPlan(terminal, cmdCommand, cwd);
  return buildWindowsShellSpecificLaunchPlan(
    terminal,
    cmdCommand,
    getResumePowerShellCommand(session, settings, { ...opts, sshArgs }),
    cwd,
  );
}

async function openResumeInWindowsTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  const plan = buildWindowsResumeLaunchPlan(session, settings, opts);

  let lastError: Error | null = null;
  for (const launch of plan) {
    try {
      await spawnDetached(launch.file, launch.args, launch.cwd);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (code === "ENOENT") continue; // terminal not installed; try the next candidate
      throw lastError;
    }
  }
  throw new Error(`No Windows terminal could be launched. ${lastError?.message ?? ""}`.trim());
}

function existingDirectory(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return existsSync(value) ? value : "";
  } catch {
    return "";
  }
}

function spawnDetached(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function getResumeProcessSpec(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: { skipPermissions?: boolean; platform?: NodeJS.Platform; sshTarget?: string; sshArgs?: string[] } = {},
): ResumeProcessSpec {
  const { skipPermissions = false, platform = process.platform } = opts;
  const { command, args } = buildResumeProcessArgs(session, settings, skipPermissions);
  const sshArgs = resolveSshArgs(opts);

  if (sshArgs) {
    const innerCommand = buildResumeShellCommand(session, settings, {
      withCwd: true,
      skipPermissions,
      shell: "posix",
    });
    return {
      command: "ssh",
      args: [...sshArgs, innerCommand],
      cwd: undefined,
      displayCommand: getResumeCommand(session, settings, {
        withCwd: true,
        skipPermissions,
        platform,
        sshTarget: opts.sshTarget,
        sshArgs: opts.sshArgs,
      }),
    };
  }

  return {
    command,
    args,
    cwd: session.projectPath || undefined,
    displayCommand: getResumeCommand(session, settings, { withCwd: true, skipPermissions, platform }),
  };
}

// Ghostty has no `--initial-command` option, so the previous flag was silently
// ignored and the window opened without resuming. The documented way to run a
// command is the special `-e <command>` argument; run it through the user's
// shell so the `cd … &&` chain plus PATH/aliases resolve, mirroring WezTerm.
export function buildGhosttyOpenArgs(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): string[] {
  const shell = process.env.SHELL || "/bin/zsh";
  return ["-na", "Ghostty.app", "--args", "-e", shell, "-ic", getResumeCommand(session, settings, { ...opts, withCwd: true })];
}

export async function openResumeInTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  const sshArgs = resolveSshArgs(opts);
  const command = getResumeCommand(session, settings, { ...opts, withCwd: true });
  if (process.platform === "win32") {
    await openResumeInWindowsTerminal(session, settings, opts);
    return;
  }
  if (process.platform !== "darwin") {
    // Linux / other: best-effort POSIX shell.
    await runProcess("sh", ["-lc", command]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveMacApplicationName(ITERM_APPLICATION_NAMES);
    if (!appName) {
      throw new Error("iTerm is not installed or is not registered with macOS. Install iTerm2 or use Resume in Terminal.");
    }

    await runAppleScript(`set wasRunning to application "${escapeAppleScript(appName)}" is running
tell application "${escapeAppleScript(appName)}"
  activate
  if wasRunning then
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window
        create tab with default profile
      end tell
    end if
  else
    delay 0.3
  end if
  tell current session of current window
    write text "${escapeAppleScript(command)}"
  end tell
end tell`);
    return;
  }

  if (settings.defaultTerminal === "Ghostty") {
    await runProcess("/usr/bin/open", buildGhosttyOpenArgs(session, settings, opts));
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    const args = ["-na", "WezTerm.app", "--args", "start"];
    if (!sshArgs && session.projectPath) args.push("--cwd", session.projectPath);
    args.push(
      "--",
      process.env.SHELL || "/bin/zsh",
      "-ic",
      getResumeCommand(session, settings, { ...opts, withCwd: Boolean(sshArgs) }),
    );
    await runProcess("/usr/bin/open", args);
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    if (sshArgs) {
      await runAppleScript(`tell application "Warp"
  activate
  delay 0.2
  tell application "System Events" to keystroke "${escapeAppleScript(command)}" & return
end tell`);
    } else {
      await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
    }
    return;
  }

  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(command)}"
end tell`);
}

export async function openResumeInSpecificTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  terminal: AppSettings["defaultTerminal"],
  opts: ResumeOpenOptions = {},
): Promise<void> {
  await openResumeInTerminal(session, { ...settings, defaultTerminal: terminal }, opts);
}

export async function resolveMacApplicationName(names: string[], runner: ProcessRunner = runProcess): Promise<string | null> {
  for (const name of names) {
    try {
      await runner("/usr/bin/osascript", ["-e", `id of application "${escapeAppleScript(name)}"`]);
      return name;
    } catch {
      // Try the next commonly registered app name.
    }
  }
  return null;
}

export async function openNativeApp(source: SessionSource): Promise<void> {
  const family = sourceFamily(source);
  const appName = family === "claude" ? "Claude" : family === "codebuddy" ? "CodeBuddy CN" : "Codex";
  if (process.platform === "darwin") {
    await runProcess("/usr/bin/open", ["-a", appName]);
  }
}

export interface RevealCommand {
  file: string;
  args: string[];
  // explorer.exe returns a non-zero exit code even when it succeeds, so its
  // exit status must not be treated as a failure.
  ignoreExitCode: boolean;
}

export function buildRevealCommand(targetPath: string, platform: NodeJS.Platform = process.platform): RevealCommand {
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-R", targetPath], ignoreExitCode: false };
  if (platform === "win32") {
    // `explorer.exe <path>` opens the item; `/select,<path>` reveals it inside
    // its parent folder (matching `open -R`). Explorer needs backslashes.
    const winPath = targetPath.replace(/\//g, "\\");
    return { file: "explorer.exe", args: [`/select,${winPath}`], ignoreExitCode: true };
  }
  return { file: "xdg-open", args: [targetPath], ignoreExitCode: false };
}

export async function revealInFileManager(targetPath: string): Promise<void> {
  if (!targetPath) return;
  const { file, args, ignoreExitCode } = buildRevealCommand(targetPath);
  if (ignoreExitCode) {
    await runProcessIgnoringExit(file, args);
    return;
  }
  await runProcess(file, args);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveSshArgs(opts: Pick<ResumeOptions, "sshTarget" | "sshArgs">): string[] | undefined {
  if (opts.sshArgs) return opts.sshArgs;
  if (opts.sshTarget) return ["--", opts.sshTarget];
  return undefined;
}

function formatSshDisplayCommand(sshArgs: string[], innerCommand: string, platform: NodeJS.Platform): string {
  const quoteArg = platform === "win32" ? winSshArgQuote : shellQuote;
  return ["ssh", ...sshArgs.map(quoteArg), quoteArg(innerCommand)].join(" ");
}

function getResumePowerShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { sshArgs: string[] },
): string {
  const innerCommand = buildResumeShellCommand(session, settings, {
    withCwd: true,
    skipPermissions: opts.skipPermissions ?? false,
    shell: "posix",
  });
  return formatPowershellSshDisplay(opts.sshArgs, innerCommand);
}

function powershellSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s) || /^\d+$/.test(s)) return s;
  return powershellQuote(s);
}

function powershellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function winSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s)) return s;
  return winSshQuote(s);
}

function winQuote(s: string): string {
  // cmd.exe quoting: wrap in double quotes, double any embedded quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

function winSshQuote(s: string): string {
  // This display command is fed to cmd.exe by WindowsTerminal/Cmd launch paths;
  // caret escaping keeps cmd from expanding local variables or treating separators as syntax.
  return `"${s.replace(/"/g, '""').replace(/[\^%&|<>]/g, (ch) => `^${ch}`)}"`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script: string): Promise<void> {
  return runProcess("/usr/bin/osascript", ["-e", script]);
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}

// Spawns a process whose non-zero exit code is expected (e.g. explorer.exe),
// only rejecting when the binary itself cannot be launched.
function runProcessIgnoringExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}
