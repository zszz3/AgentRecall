import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type ProcessRunner = (command: string, args: string[]) => Promise<void>;

// Which shell the displayed/copied command is meant to be pasted into. The
// remote (ssh) command body always runs on a POSIX login shell; the local
// terminal can be cmd.exe or PowerShell on Windows.
export type ShellKind = "posix" | "cmd" | "powershell";

export interface ShellCommands {
  posix: string;
  cmd: string;
  powershell: string;
}

export interface CommandBuildOptions {
  shell: ShellKind;
  withCwd: boolean;
}

export function existingDirectory(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return existsSync(value) ? value : "";
  } catch {
    return "";
  }
}

const WINDOWS_CONSOLE_PROGRAMS = new Set(["cmd.exe", "powershell.exe", "pwsh.exe"]);
const MISSING_PROGRAM_EXIT = 9009;

/** Quotes one argument the way the MSVC runtime parses a command line, matching Node's own spawn quoting. */
function quoteWindowsArgument(arg: string): string {
  if (arg && !/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Node starts `detached` children with DETACHED_PROCESS, which gives a console program no console
 * window at all, so an interactive shell exits immediately. Start-Process creates a new console
 * instead, and the shell it starts stays outside AgentRecall's process tree.
 */
function startWindowsConsole(command: string, args: string[], cwd?: string): Promise<void> {
  const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const startArgs = [
    `-FilePath ${psQuote(command)}`,
    ...(args.length ? [`-ArgumentList ${psQuote(args.map(quoteWindowsArgument).join(" "))}`] : []),
    ...(cwd ? [`-WorkingDirectory ${psQuote(cwd)}`] : []),
  ];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Get-Command -Name ${psQuote(command)} -CommandType Application -ErrorAction SilentlyContinue)) { exit ${MISSING_PROGRAM_EXIT} }`,
    `Start-Process ${startArgs.join(" ")}`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // tsconfig targets a lib without Promise.withResolvers, so the executor form is required here.
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // Launch plans fall through to the next terminal on ENOENT, as with a direct spawn.
      if (error.code === MISSING_PROGRAM_EXIT) return reject(Object.assign(new Error(`${command} was not found.`), { code: "ENOENT" }));
      reject(new Error(stderr?.trim() || error.message));
    });
  });
}

export function spawnDetached(command: string, args: string[], cwd?: string): Promise<void> {
  if (process.platform === "win32" && WINDOWS_CONSOLE_PROGRAMS.has(command.toLowerCase())) {
    return startWindowsConsole(command, args, cwd);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}

// Spawns a process whose non-zero exit code is expected (e.g. explorer.exe),
// only rejecting when the binary itself cannot be launched.
export function runProcessIgnoringExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}

// `ResumeProcessSpec.env` and version-runner env values are override maps, not
// complete process environments. Keep the merge at the child execution edge.
export function mergeProcessEnvOverrides(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(overrides ?? {}) };
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function powershellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function powershellSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s) || /^\d+$/.test(s)) return s;
  return powershellQuote(s);
}

export function winQuote(s: string): string {
  // cmd.exe quoting: wrap in double quotes, double any embedded quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

export function winSshQuote(s: string): string {
  // This display command is fed to cmd.exe by WindowsTerminal/Cmd launch paths;
  // caret escaping keeps cmd from expanding local variables or treating separators as syntax.
  return `"${s.replace(/"/g, '""').replace(/[\^%&|<>]/g, (ch) => `^${ch}`)}"`;
}

export function winSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s)) return s;
  return winSshQuote(s);
}

export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function shellTokenQuote(s: string, shell: ShellKind): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  if (shell === "cmd") return winQuote(s);
  if (shell === "powershell") return powershellQuote(s);
  return shellQuote(s);
}

export function buildCdPrefix(projectPath: string, shell: ShellKind): string {
  // PowerShell has no `cd /d` and chains statements with `;`; cmd uses `&&`.
  if (shell === "cmd") return `cd /d ${winQuote(projectPath)} && `;
  if (shell === "powershell") return `cd ${powershellQuote(projectPath)}; `;
  return `cd ${shellQuote(projectPath)} && `;
}

export function buildShellCommand(
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

export function withWslShellProfile(command: string): string {
  return `if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ${command}`;
}

export function remoteUserShellCommand(command: string): string {
  const preparedCommand = `if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ${command}`;
  const quotedCommand = shellQuote(preparedCommand);
  const script = `if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then exec "$SHELL" -lic ${quotedCommand}; fi; ${preparedCommand}`;
  return `bash -lc ${shellQuote(script)}`;
}

export function remoteInteractiveCommand(sshArgs: string[], command: string): string {
  return sshArgs.includes("-tt") ? remoteUserShellCommand(command) : command;
}

export function formatSshDisplayCommand(sshArgs: string[], innerCommand: string, platform: NodeJS.Platform): string {
  const quoteArg = platform === "win32" ? winSshArgQuote : shellQuote;
  return ["ssh", ...sshArgs.map(quoteArg), quoteArg(innerCommand)].join(" ");
}

export function formatPowershellSshDisplay(sshArgs: string[], innerCommand: string): string {
  return ["ssh", ...sshArgs.map(powershellSshArgQuote), powershellQuote(innerCommand)].join(" ");
}

export function formatWslDisplayCommand(distribution: string, innerCommand: string, platform: NodeJS.Platform): string {
  const quote = platform === "win32" ? winSshQuote : shellQuote;
  return ["wsl.exe", "--distribution", quote(distribution), "--exec", "bash", "-lc", quote(innerCommand)].join(" ");
}

export function formatPowershellWslDisplay(distribution: string, innerCommand: string): string {
  return ["wsl.exe", "--distribution", powershellQuote(distribution), "--exec", "bash", "-lc", powershellQuote(innerCommand)].join(" ");
}
