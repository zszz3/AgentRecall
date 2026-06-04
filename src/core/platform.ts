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
import { normalizeProjectGrouping } from "./project-grouping";
import type { ProjectGroupingMode, SessionSearchResult, SessionSource } from "./types";

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

export interface AppSettings {
  defaultTerminal: TerminalChoice;
  globalShortcut: GlobalShortcut;
  claudeBinary: string;
  codexBinary: string;
  codeBuddyBinary: string;
  projectGrouping: ProjectGroupingMode;
  promotedProjectRoots: string[];
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
  projectGrouping: "cwd",
  promotedProjectRoots: [],
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
    projectGrouping: normalizeProjectGrouping(merged.projectGrouping),
    promotedProjectRoots: normalizePromotedProjectRoots(merged.promotedProjectRoots),
    apiConfig: normalizeApiConfig({ ...previous.apiConfig, ...(updates.apiConfig ?? {}) }),
    claudeApiConfig: normalizeClaudeApiConfig({ ...previous.claudeApiConfig, ...(updates.claudeApiConfig ?? {}) }),
  };
}

export function normalizePromotedProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];

export function sourceFamily(source: SessionSource): "claude" | "codex" | "codebuddy" {
  if (source === "codebuddy-cli") return "codebuddy";
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}

export function getResumeCommand(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: { withCwd?: boolean; skipPermissions?: boolean; platform?: NodeJS.Platform } = {},
): string {
  const { withCwd = true, skipPermissions = false, platform = process.platform } = opts;
  let cmd: string;
  const family = sourceFamily(session.source);
  if (family === "claude") {
    cmd = `${settings.claudeBinary} --resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-skip-permissions";
  } else if (family === "codebuddy") {
    cmd = `${settings.codeBuddyBinary} --resume ${session.rawId}`;
  } else {
    cmd = `${settings.codexBinary} resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-bypass-approvals-and-sandbox";
  }
  if (withCwd && session.projectPath) {
    cmd =
      platform === "win32"
        ? `cd /d ${winQuote(session.projectPath)} && ${cmd}`
        : `cd ${shellQuote(session.projectPath)} && ${cmd}`;
  }
  return cmd;
}

interface WindowsLaunch {
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

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  // WindowsTerminal (default): wt first, then fall back through shells.
  return [wt(), pwsh(), powershell(), cmd()];
}

async function openResumeInWindowsTerminal(session: SessionSearchResult, settings: AppSettings): Promise<void> {
  const command = getResumeCommand(session, settings, { withCwd: false, platform: "win32" });
  const terminal = normalizeTerminal(settings.defaultTerminal, "win32");
  const cwd = existingDirectory(session.projectPath);
  const plan = buildWindowsLaunchPlan(terminal, command, cwd);

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
  opts: { skipPermissions?: boolean; platform?: NodeJS.Platform } = {},
): ResumeProcessSpec {
  const { skipPermissions = false, platform = process.platform } = opts;
  const family = sourceFamily(session.source);
  let command: string;
  let args: string[];

  if (family === "claude") {
    command = settings.claudeBinary;
    args = ["--resume", session.rawId];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
  } else if (family === "codebuddy") {
    command = settings.codeBuddyBinary;
    args = ["--resume", session.rawId];
  } else {
    command = settings.codexBinary;
    args = ["resume", session.rawId];
    if (skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
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
export function buildGhosttyOpenArgs(session: SessionSearchResult, settings: AppSettings): string[] {
  const shell = process.env.SHELL || "/bin/zsh";
  return ["-na", "Ghostty.app", "--args", "-e", shell, "-ic", getResumeCommand(session, settings, { withCwd: true, platform: "darwin" })];
}

export async function openResumeInTerminal(session: SessionSearchResult, settings: AppSettings): Promise<void> {
  const command = getResumeCommand(session, settings, { withCwd: true });
  if (process.platform === "win32") {
    await openResumeInWindowsTerminal(session, settings);
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
    await runProcess("/usr/bin/open", buildGhosttyOpenArgs(session, settings));
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    const args = ["-na", "WezTerm.app", "--args", "start"];
    if (session.projectPath) args.push("--cwd", session.projectPath);
    args.push("--", process.env.SHELL || "/bin/zsh", "-ic", getResumeCommand(session, settings, { withCwd: false }));
    await runProcess("/usr/bin/open", args);
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
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
): Promise<void> {
  await openResumeInTerminal(session, { ...settings, defaultTerminal: terminal });
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

export async function revealInFileManager(targetPath: string): Promise<void> {
  if (!targetPath) return;
  if (process.platform === "darwin") await runProcess("/usr/bin/open", ["-R", targetPath]);
  else if (process.platform === "win32") await runProcess("explorer.exe", [targetPath]);
  else await runProcess("xdg-open", [targetPath]);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function winQuote(s: string): string {
  // cmd.exe quoting: wrap in double quotes, double any embedded quotes.
  return `"${s.replace(/"/g, '""')}"`;
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
