import { normalizeTerminal } from "../terminal-options";
import { normalizeTerminalTitle, withPosixTerminalTitle } from "../terminal-title";
import type { MigrationTarget, SessionSearchResult } from "../types";
import type { AppSettings } from "./app-settings";
import { resolveMacApplicationName } from "./file-manager";
import {
  buildMigrationResumeCommands,
  buildWindowsLaunchPlan,
  buildWindowsResumeLaunchPlan,
  getMigrationResumeProcessSpec,
  getResumeCommand,
  resolveSshArgs,
  type ResumeOpenOptions,
  type WindowsLaunch,
} from "./resume-commands";
import {
  escapeAppleScript,
  existingDirectory,
  runProcess,
  spawnDetached,
  type ProcessRunner,
  type ShellCommands,
} from "./shell-quoting";

const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];

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

async function runAppleScript(script: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runner("/usr/bin/osascript", ["-e", script]);
}

async function runWarpCommand(command: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runAppleScript(`tell application "Warp"
  activate
  delay 0.2
  tell application "System Events" to keystroke "${escapeAppleScript(command)}" & return
end tell`, runner);
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

export function buildGhosttyOpenArgs(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): string[] {
  const command = getResumeCommand(session, settings, { ...opts, withCwd: true });
  const titledCommand = session.displayTitle ? withPosixTerminalTitle(command, session.displayTitle) : command;
  return buildGhosttyOpenArgsForCommand(titledCommand);
}

export function buildTerminalResumeScript(command: string, title: string): string {
  return `tell application "Terminal"
  activate
  set terminalTab to do script "${escapeAppleScript(command)}"
  set custom title of terminalTab to "${escapeAppleScript(normalizeTerminalTitle(title))}"
  set title displays custom title of terminalTab to true
end tell`;
}

export function buildItermResumeScript(appName: string, command: string, title: string): string {
  return `set wasRunning to application "${escapeAppleScript(appName)}" is running
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
    set name to "${escapeAppleScript(normalizeTerminalTitle(title))}"
  end tell
end tell`;
}

async function openResumeInWindowsTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  await launchWindowsPlan(buildWindowsResumeLaunchPlan(session, settings, opts));
}

export async function openResumeInTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  const sshArgs = resolveSshArgs(opts);
  const command = getResumeCommand(session, settings, { ...opts, withCwd: true });
  const title = session.displayTitle || session.originalTitle || session.rawId;
  const titledCommand = withPosixTerminalTitle(command, title);
  if (process.platform === "win32") {
    await openResumeInWindowsTerminal(session, settings, opts);
    return;
  }
  if (process.platform !== "darwin") {
    // Linux / other: best-effort POSIX shell.
    await runProcess("sh", ["-lc", titledCommand]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveMacApplicationName(ITERM_APPLICATION_NAMES);
    if (!appName) {
      throw new Error("iTerm is not installed or is not registered with macOS. Install iTerm2 or use Resume in Terminal.");
    }

    await runAppleScript(buildItermResumeScript(appName, command, title));
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
      withPosixTerminalTitle(
        getResumeCommand(session, settings, { ...opts, withCwd: Boolean(sshArgs) }),
        title,
      ),
    );
    await runProcess("/usr/bin/open", args);
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    if (sshArgs) {
      await runWarpCommand(titledCommand);
    } else {
      await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
    }
    return;
  }

  await runAppleScript(buildTerminalResumeScript(command, title));
}

export async function openResumeInSpecificTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  terminal: AppSettings["defaultTerminal"],
  opts: ResumeOpenOptions = {},
): Promise<void> {
  await openResumeInTerminal(session, { ...settings, defaultTerminal: terminal }, opts);
}

interface TerminalLaunchDeps {
  platform?: NodeJS.Platform;
  runProcess?: ProcessRunner;
  spawnDetached?: typeof spawnDetached;
  resolveMacApplicationName?: typeof resolveMacApplicationName;
}

async function openCommandInTerminal(
  commands: ShellCommands,
  projectPath: string,
  settings: AppSettings,
  deps: TerminalLaunchDeps = {},
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
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  deps: TerminalLaunchDeps = {},
): Promise<void> {
  // ZCode sessions are resumed from the ZCode app's own session list; there is
  // no terminal command to open, so a successful no-op is the correct launch.
  if (target === "zcode") return;
  const platform = deps.platform ?? process.platform;
  const { displayCommand: _displayCommand, ...spec } = getMigrationResumeProcessSpec(
    target,
    sessionId,
    projectPath,
    settings,
    { platform },
  );
  const commands = buildMigrationResumeCommands(spec, projectPath, platform !== "win32");
  const run = deps.runProcess ?? runProcess;

  if (platform === "darwin" && settings.defaultTerminal === "Warp") {
    await runWarpCommand(commands.posix, run);
    return;
  }

  await openCommandInTerminal(commands, projectPath, settings, deps);
}

export async function openDeepSeekWebInTerminal(
  projectPath: string,
  settings: AppSettings,
  deps: TerminalLaunchDeps = {},
): Promise<void> {
  const spec = { command: settings.deepseekBinary, args: ["--profile", "web"] };
  const commands = buildMigrationResumeCommands(spec, projectPath, (deps.platform ?? process.platform) !== "win32");
  const run = deps.runProcess ?? runProcess;
  if ((deps.platform ?? process.platform) === "darwin" && settings.defaultTerminal === "Warp") {
    await runWarpCommand(commands.posix, run);
    return;
  }
  await openCommandInTerminal(commands, projectPath, settings, deps);
}

export async function probeDeepSeekWeb(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1200,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("http://127.0.0.1:3080/", { signal: controller.signal, redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForDeepSeekWeb(
  probe: () => Promise<boolean> = () => probeDeepSeekWeb(),
  timeoutMs = 8_000,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await probe()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, intervalMs), remaining)));
  }
}
