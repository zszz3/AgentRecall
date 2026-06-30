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
import type { MigrationAgent, SessionSearchResult, SessionSource } from "./types";

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
  includeOpenClaw: boolean;
  includeHermes: boolean;
  includeOpenCode: boolean;
  includeCursorAgent: boolean;
  includeTrae: boolean;
  hideCodexQuota: boolean;
  hideClaudeQuota: boolean;
  notifyOnSessionComplete: boolean;
  notifyMinDurationSeconds: number;
  summaryAutoBackfill: boolean;
  summaryMaxAgeDays: number;
  summarySource: "codex" | "claude" | "custom";
  sessionSearchMcpEnabled: boolean;
  skillSyncEnabled: boolean;
  skillSyncSupabaseUrl: string;
  skillSyncSupabaseAnonKey: string;
  apiConfig: ApiConfig;
  claudeApiConfig: ClaudeApiConfig;
  summaryApiConfig: ApiConfig;
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, "apiConfig" | "claudeApiConfig" | "summaryApiConfig">> & {
  apiConfig?: Partial<ApiConfig>;
  claudeApiConfig?: Partial<ClaudeApiConfig>;
  summaryApiConfig?: Partial<ApiConfig>;
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
  includeOpenClaw: false,
  includeHermes: false,
  includeOpenCode: false,
  includeCursorAgent: false,
  includeTrae: false,
  hideCodexQuota: false,
  hideClaudeQuota: false,
  notifyOnSessionComplete: false,
  notifyMinDurationSeconds: 30,
  summaryAutoBackfill: false,
  summaryMaxAgeDays: 30,
  summarySource: "codex",
  sessionSearchMcpEnabled: true,
  skillSyncEnabled: false,
  skillSyncSupabaseUrl: "",
  skillSyncSupabaseAnonKey: "",
  apiConfig: defaultApiConfig,
  claudeApiConfig: defaultClaudeApiConfig,
  summaryApiConfig: defaultApiConfig,
};

export function mergeAppSettings(previous: AppSettings, updates: AppSettingsUpdate): AppSettings {
  const merged = { ...previous, ...updates };
  return {
    ...merged,
    defaultTerminal: normalizeTerminal(merged.defaultTerminal),
    globalShortcut: normalizeGlobalShortcut(merged.globalShortcut),
    notifyMinDurationSeconds: normalizeNotifyDuration(merged.notifyMinDurationSeconds),
    summaryMaxAgeDays: normalizeSummaryMaxAgeDays(merged.summaryMaxAgeDays),
    summarySource: merged.summarySource === "claude" || merged.summarySource === "custom" ? merged.summarySource : "codex",
    skillSyncEnabled: Boolean(merged.skillSyncEnabled),
    skillSyncSupabaseUrl: normalizeSupabaseSettingUrl(merged.skillSyncSupabaseUrl),
    skillSyncSupabaseAnonKey: String(merged.skillSyncSupabaseAnonKey ?? "").trim(),
    apiConfig: normalizeApiConfig({ ...previous.apiConfig, ...(updates.apiConfig ?? {}) }),
    claudeApiConfig: normalizeClaudeApiConfig({ ...previous.claudeApiConfig, ...(updates.claudeApiConfig ?? {}) }),
    summaryApiConfig: normalizeApiConfig({ ...previous.summaryApiConfig, ...(updates.summaryApiConfig ?? {}) }),
  };
}

function normalizeSupabaseSettingUrl(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeNotifyDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return defaultSettings.notifyMinDurationSeconds;
  return Math.min(3600, Math.round(value));
}

function normalizeSummaryMaxAgeDays(value: number): number {
  if (!Number.isFinite(value) || value < 1) return defaultSettings.summaryMaxAgeDays;
  return Math.min(3650, Math.round(value));
}

const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];

type SourceFamily = "claude" | "codex" | "codebuddy" | "openclaw" | "hermes" | "opencode" | "cursor" | "trae";

function sourceDisplayName(source: SessionSource): string {
  if (source === "opencode-cli") return "OpenCode";
  if (source === "cursor-agent") return "Cursor Agent";
  if (source === "openclaw") return "OpenClaw";
  if (source === "hermes") return "Hermes";
  if (source === "trae") return "Trae";
  if (source === "codebuddy-cli") return "CodeBuddy";
  if (source.startsWith("claude")) return "Claude";
  return "Codex";
}

export function sourceFamily(source: SessionSource): SourceFamily {
  if (source === "codebuddy-cli") return "codebuddy";
  if (source === "openclaw") return "openclaw";
  if (source === "hermes") return "hermes";
  if (source === "opencode-cli") return "opencode";
  if (source === "cursor-agent") return "cursor";
  if (source === "trae") return "trae";
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}

export function migrationBinary(target: MigrationAgent, settings: AppSettings): string {
  if (target === "claude") return settings.claudeBinary;
  if (target === "codebuddy") return settings.codeBuddyBinary;
  return settings.codexBinary;
}

function migrationTargetDisplayName(target: MigrationAgent): string {
  if (target === "claude") return "Claude";
  if (target === "codebuddy") return "CodeBuddy";
  return "Codex";
}

function migrationResumeArgs(target: MigrationAgent, sessionId: string): string[] {
  return target === "codex" ? ["resume", sessionId] : ["--resume", sessionId];
}

interface ShellCommands {
  posix: string;
  cmd: string;
  powershell: string;
}

interface CommandBuildOptions {
  shell: ShellKind;
  withCwd: boolean;
}

interface MigrationCliVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

const MIN_MIGRATION_CLI_VERSIONS: Record<MigrationAgent, MigrationCliVersion> = {
  claude: { major: 2, minor: 1, patch: 186, text: "2.1.186" },
  codex: { major: 0, minor: 141, patch: 0, text: "0.141.0" },
  codebuddy: { major: 2, minor: 109, patch: 1, text: "2.109.1" },
};

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
  if (family !== "codex") {
    throw new Error(`Resume is not supported for ${sourceDisplayName(session.source)} sessions yet.`);
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

function buildShellCommand(
  command: string,
  args: string[],
  projectPath: string | null | undefined,
  opts: CommandBuildOptions,
): string {
  const quotedCommand = shellTokenQuote(command, opts.shell);
  // PowerShell treats a quoted leading token as a string literal, so the call
  // operator `&` is required to actually run a quoted executable path.
  const invocation = opts.shell === "powershell" && quotedCommand !== command ? `& ${quotedCommand}` : quotedCommand;
  let cmd = [invocation, ...args.map((token) => shellTokenQuote(token, opts.shell))].join(" ");
  if (opts.withCwd && projectPath) {
    cmd = `${buildCdPrefix(projectPath, opts.shell)}${cmd}`;
  }
  return cmd;
}

function buildResumeShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: Required<Pick<ResumeOptions, "withCwd" | "skipPermissions">> & { shell: ShellKind },
): string {
  const { command, args } = buildResumeProcessArgs(session, settings, opts.skipPermissions);
  return buildShellCommand(command, args, session.projectPath, opts);
}

function buildMigrationResumeShellCommand(
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  shell: ShellKind,
  withCwd = true,
): string {
  return buildShellCommand(migrationBinary(target, settings), migrationResumeArgs(target, sessionId), projectPath, {
    shell,
    withCwd,
  });
}

function buildMigrationResumeCommands(
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  withCwd = true,
): ShellCommands {
  return {
    posix: buildMigrationResumeShellCommand(target, sessionId, projectPath, settings, "posix", withCwd),
    cmd: buildMigrationResumeShellCommand(target, sessionId, projectPath, settings, "cmd", withCwd),
    powershell: buildMigrationResumeShellCommand(target, sessionId, projectPath, settings, "powershell", withCwd),
  };
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
export function buildWindowsLaunchPlan(
  terminal: TerminalChoice,
  cmdCommand: string,
  cwd: string,
  powershellCommand?: string,
): WindowsLaunch[] {
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...inner] : inner };
  };
  const pwsh = (): WindowsLaunch => ({
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand ?? cmdCommand],
    cwd: cwd || undefined,
  });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand ?? cmdCommand],
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
  const powershellCommand = sshArgs
    ? getResumePowerShellCommand(session, settings, { ...opts, sshArgs })
    : getResumeCommand(session, { ...settings, defaultTerminal: "PowerShell" }, {
        withCwd: true,
        skipPermissions: opts.skipPermissions,
        platform,
      });
  const terminal = normalizeTerminal(opts.terminal ?? settings.defaultTerminal, "win32");
  const cwd = sshArgs ? "" : existingDirectory(session.projectPath);
  if (!sshArgs) return buildWindowsLaunchPlan(terminal, cmdCommand, cwd, powershellCommand);
  return buildWindowsShellSpecificLaunchPlan(terminal, cmdCommand, powershellCommand, cwd);
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

export function getMigrationResumeProcessSpec(
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
  settings: AppSettings = defaultSettings,
): ResumeProcessSpec {
  const platform = process.platform;
  const shell = localShellKind(platform, settings);
  const commands = buildMigrationResumeCommands(target, sessionId, projectPath, settings, true);
  const displayCommand = shell === "powershell" ? commands.powershell : shell === "cmd" ? commands.cmd : commands.posix;

  return {
    command: migrationBinary(target, settings),
    args: migrationResumeArgs(target, sessionId),
    cwd: projectPath || undefined,
    displayCommand,
  };
}

// Ghostty has no `--initial-command` option, so the previous flag was silently
// ignored and the window opened without resuming. The documented way to run a
// command is the special `-e <command>` argument; run it through the user's
// shell so the `cd … &&` chain plus PATH/aliases resolve, mirroring WezTerm.
function buildGhosttyOpenArgsForCommand(command: string): string[] {
  const shell = process.env.SHELL || "/bin/zsh";
  return ["-na", "Ghostty.app", "--args", "-e", shell, "-ic", command];
}

function buildWezTermOpenArgsForCommand(command: string, cwd?: string): string[] {
  const args = ["-na", "WezTerm.app", "--args", "start"];
  if (cwd) args.push("--cwd", cwd);
  args.push("--", process.env.SHELL || "/bin/zsh", "-ic", command);
  return args;
}

async function runWarpCommand(command: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runAppleScript(`tell application "Warp"
  activate
  delay 0.2
  tell application "System Events" to keystroke "${escapeAppleScript(command)}" & return
end tell`, runner);
}

export function buildGhosttyOpenArgs(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): string[] {
  return buildGhosttyOpenArgsForCommand(getResumeCommand(session, settings, { ...opts, withCwd: true }));
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
      await runWarpCommand(command);
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

async function launchWindowsPlan(plan: WindowsLaunch[], runner: typeof spawnDetached = spawnDetached): Promise<void> {
  let lastError: Error | null = null;
  for (const launch of plan) {
    try {
      await runner(launch.file, launch.args, launch.cwd);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (code === "ENOENT") continue;
      throw lastError;
    }
  }
  throw new Error(`No Windows terminal could be launched. ${lastError?.message ?? ""}`.trim());
}

async function runAppleScript(script: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runner("/usr/bin/osascript", ["-e", script]);
}

async function openCommandInTerminal(
  commands: ShellCommands,
  projectPath: string,
  settings: AppSettings,
  deps: {
    platform?: NodeJS.Platform;
    runProcess?: ProcessRunner;
    spawnDetached?: typeof spawnDetached;
    resolveMacApplicationName?: typeof resolveMacApplicationName;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const run = deps.runProcess ?? runProcess;
  const spawnRunner = deps.spawnDetached ?? spawnDetached;
  const resolveAppName = deps.resolveMacApplicationName ?? resolveMacApplicationName;

  if (platform === "win32") {
    const terminal = normalizeTerminal(settings.defaultTerminal, "win32");
    const cwd = existingDirectory(projectPath);
    await launchWindowsPlan(buildWindowsLaunchPlan(terminal, commands.cmd, cwd, commands.powershell), spawnRunner);
    return;
  }

  if (platform !== "darwin") {
    await run("sh", ["-lc", commands.posix]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveAppName(ITERM_APPLICATION_NAMES, run);
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
    write text "${escapeAppleScript(commands.posix)}"
  end tell
end tell`, run);
    return;
  }

  if (settings.defaultTerminal === "Ghostty") {
    await run("/usr/bin/open", buildGhosttyOpenArgsForCommand(commands.posix));
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    await run("/usr/bin/open", buildWezTermOpenArgsForCommand(commands.posix, existingDirectory(projectPath) || undefined));
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    await run("/usr/bin/open", existingDirectory(projectPath) ? ["-a", "Warp", existingDirectory(projectPath)] : ["-a", "Warp"]);
    return;
  }

  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(commands.posix)}"
end tell`, run);
}

export async function openMigrationResumeInTerminal(
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  deps: {
    platform?: NodeJS.Platform;
    runProcess?: ProcessRunner;
    spawnDetached?: typeof spawnDetached;
    resolveMacApplicationName?: typeof resolveMacApplicationName;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const commands = buildMigrationResumeCommands(target, sessionId, projectPath, settings, platform !== "win32");
  const run = deps.runProcess ?? runProcess;

  if (platform === "darwin" && settings.defaultTerminal === "Warp") {
    await runWarpCommand(commands.posix, run);
    return;
  }

  await openCommandInTerminal(commands, projectPath, settings, deps);
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
  if (family !== "claude" && family !== "codex" && family !== "codebuddy") {
    throw new Error(`Native app opening is not configured for ${sourceDisplayName(source)} sessions yet.`);
  }
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

type CliVersionRunner = (command: string, args: string[]) => Promise<string>;

function runCliVersion(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(Object.assign(failure, { stdout, stderr }));
    });
  });
}

function parseMigrationCliVersion(output: string): MigrationCliVersion | null {
  const match = output.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?(?:[^\d]|$)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? "0"),
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? "0")}`,
  };
}

function compareMigrationCliVersions(left: MigrationCliVersion, right: MigrationCliVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function migrationCliVersionPrefix(target: MigrationAgent): string {
  return `${migrationTargetDisplayName(target)} CLI`;
}

function migrationCliVersionErrorMessage(target: MigrationAgent, binary: string, error: unknown): string {
  const prefix = migrationCliVersionPrefix(target);
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  const detail = [err.stderr?.trim(), err.stdout?.trim(), err.message].find((value) => Boolean(value)) ?? "unknown error";
  if (err.code === "ENOENT") return `${prefix} binary not found: ${binary}`;
  return `${prefix} --version failed for ${binary}: ${detail}`;
}

export async function inspectMigrationCli(
  target: MigrationAgent,
  settings: AppSettings,
  runner: CliVersionRunner = runCliVersion,
): Promise<void> {
  const binary = migrationBinary(target, settings);
  let versionOutput: string;
  try {
    versionOutput = await runner(binary, ["--version"]);
  } catch (error) {
    throw new Error(migrationCliVersionErrorMessage(target, binary, error));
  }

  const trimmed = versionOutput.trim();
  if (!trimmed) {
    throw new Error(`${migrationCliVersionPrefix(target)} returned no version information from ${binary} --version.`);
  }

  const parsed = parseMigrationCliVersion(trimmed);
  if (!parsed) {
    throw new Error(`${migrationCliVersionPrefix(target)} returned an unparseable version from ${binary} --version: ${trimmed}`);
  }

  const minimum = MIN_MIGRATION_CLI_VERSIONS[target];
  if (compareMigrationCliVersions(parsed, minimum) < 0) {
    throw new Error(
      `${migrationCliVersionPrefix(target)} ${parsed.text} is too old for ${binary}; require at least ${minimum.text}.`,
    );
  }
}
