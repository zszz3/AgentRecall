import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveDshDesktopInvocation } from "./dsh-desktop-launcher";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const readCmdShim = require("read-cmd-shim") as {
  sync(filePath: string): string;
};
const which = require("which") as {
  sync(command: string, options?: {
    path?: string;
    pathExt?: string;
  }): string;
};

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
const WINDOWS_POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;
const SIMPLE_NODE_WRAPPER_PATTERN = /^\s*(?:@echo\s+off\s*\r?\n)?\s*"([^"\r\n]+\.(?:exe|com))"\s+"([^"\r\n]+\.(?:c?m?js))"\s+%\*\s*$/iu;
const SIMPLE_NATIVE_WRAPPER_PATTERN = /^\s*(?:@echo\s+off\s*\r?\n)?\s*"([^"\r\n]+\.(?:exe|com))"\s+%\*\s*$/iu;
const NODE_SHEBANG_PATTERN = /^#!.*\bnode\b/i;

export interface CliPlatformOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  execPath?: string;
  isElectronRuntime?: boolean;
  fileExists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
  readShim?: (filePath: string) => string;
  resolveCommand?: (command: string, environment: NodeJS.ProcessEnv) => string | null;
}

export interface ResolvedCliInvocation {
  file: string;
  args: string[];
  viaWindowsCmd: boolean;
  windowsVerbatimArguments?: true;
  envOverrides?: Record<string, string>;
}

export interface CliSpawnRequest extends SpawnOptions {
  executable: string;
  args?: string[];
}

export interface CliExecRequest extends Omit<ExecFileOptionsWithStringEncoding, "encoding"> {
  executable: string;
  args?: string[];
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const target = key.toUpperCase();
  const entry = Object.entries(environment).find(([name]) => name.toUpperCase() === target);
  return entry?.[1];
}

function defaultResolveCommand(command: string, environment: NodeJS.ProcessEnv): string | null {
  try {
    const resolved = which.sync(command, {
      path: environmentValue(environment, "PATH"),
      pathExt: environmentValue(environment, "PATHEXT"),
    });
    return resolved || null;
  } catch {
    return null;
  }
}

function defaultReadShim(filePath: string): string {
  try {
    return readCmdShim.sync(filePath);
  } catch (error) {
    // read-cmd-shim checks /[.]cmd$/ case-sensitively, whereas which.sync on Windows preserves uppercase .CMD.
    const lowerCmdPath = filePath.replace(/\.cmd$/i, ".cmd");
    if (lowerCmdPath !== filePath) {
      return readCmdShim.sync(lowerCmdPath);
    }
    throw error;
  }
}

function probeWindowsPathWithExtensions(
  basePath: string,
  environment: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
): string | null {
  if (path.win32.extname(basePath)) {
    return fileExists(basePath) ? basePath : null;
  }
  const rawPathExt = environmentValue(environment, "PATHEXT") ?? DEFAULT_WINDOWS_PATHEXT;
  const extensions = rawPathExt
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));

  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fileExists(candidate)) return candidate;
    const lowerCandidate = `${basePath}${ext.toLowerCase()}`;
    if (lowerCandidate !== candidate && fileExists(lowerCandidate)) return lowerCandidate;
  }
  return fileExists(basePath) ? basePath : null;
}

function quoteWindowsCmdExecutable(command: string): string {
  const text = String(command);
  if (/[\r\n\0"]/u.test(text)) {
    throw new Error("Windows batch (.cmd/.bat) executable path cannot contain quotes, newlines, or NUL bytes.");
  }
  return `"${text.replace(/%/g, '"^%"')}"`;
}

function quoteWindowsBatchArg(arg: string): string {
  const text = String(arg);
  if (/[\r\n\0]/u.test(text)) {
    throw new Error(
      "Windows batch (.cmd/.bat) arguments cannot contain newlines or NUL bytes; use a native executable, Node CLI shim, or PowerShell script.",
    );
  }
  let msvcr = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      msvcr += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      msvcr += `${"\\".repeat(backslashes)}${ch}`;
      backslashes = 0;
    }
  }
  msvcr += `${"\\".repeat(backslashes * 2)}"`;

  // Batch (.cmd/.bat) %* expansion parses the command line twice on cmd.exe.
  const escapeCmdMeta = (value: string) => value.replace(/[()%!^"<>&|]/g, "^$&");
  return escapeCmdMeta(escapeCmdMeta(msvcr));
}

function buildWindowsCmdInvocation(
  executable: string,
  args: string[],
  comspec: string,
): { file: string; args: string[]; viaWindowsCmd: true; windowsVerbatimArguments: true } {
  const command = `"${[quoteWindowsCmdExecutable(executable), ...args.map(quoteWindowsBatchArg)].join(" ")}"`;
  return {
    file: comspec,
    args: ["/d", "/v:off", "/s", "/c", command],
    viaWindowsCmd: true,
    windowsVerbatimArguments: true,
  };
}

function resolveNodeRuntime(
  referenceFile: string | undefined,
  environment: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
  resolveCommand: (command: string, environment: NodeJS.ProcessEnv) => string | null,
  options: CliPlatformOptions,
): { file: string; envOverrides?: Record<string, string> } {
  if (referenceFile) {
    const adjacentNode = path.win32.join(path.win32.dirname(referenceFile), "node.exe");
    if (fileExists(adjacentNode)) return { file: adjacentNode };
  }
  const configuredNode = environmentValue(environment, "AGENT_RECALL_NODE_PATH")?.trim();
  if (configuredNode && fileExists(configuredNode)) {
    return { file: configuredNode };
  }
  const resolvedExe = resolveCommand("node.exe", environment);
  if (resolvedExe) return { file: resolvedExe };
  const resolvedBare = resolveCommand("node", environment);
  if (resolvedBare && path.win32.extname(resolvedBare).toLowerCase() === ".exe") {
    return { file: resolvedBare };
  }
  const execPath = options.execPath ?? process.execPath;
  const isElectronRuntime = options.isElectronRuntime ?? Boolean(process.versions.electron);
  return isElectronRuntime
    ? { file: execPath, envOverrides: { ELECTRON_RUN_AS_NODE: "1" } }
    : { file: execPath };
}

function isNodeShebangScript(
  filePath: string,
  readTextFile: (filePath: string) => string,
): boolean {
  try {
    const firstLine = readTextFile(filePath).split(/\r?\n/, 1)[0] ?? "";
    return NODE_SHEBANG_PATTERN.test(firstLine);
  } catch {
    // Unreadable scripts fall back to direct OS execution and surface standard errors.
    return false;
  }
}

function unwrapWindowsCmd(
  cmdPath: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
  readTextFile: (filePath: string) => string,
  readShim: (filePath: string) => string,
  resolveCommand: (command: string, environment: NodeJS.ProcessEnv) => string | null,
  options: CliPlatformOptions,
): Omit<ResolvedCliInvocation, "viaWindowsCmd"> | null {
  const lowerCmdPath = cmdPath.replace(/\.(cmd|bat)$/i, (_, extension: string) => `.${extension.toLowerCase()}`);
  const readableCmdPath = fileExists(cmdPath)
    ? cmdPath
    : fileExists(lowerCmdPath)
      ? lowerCmdPath
      : null;
  if (!readableCmdPath) return null;
  const shimDirectory = path.win32.dirname(readableCmdPath);

  let shimTarget: string | null = null;
  try {
    shimTarget = readShim(readableCmdPath);
  } catch {
    // Non-standard .cmd scripts fall through to narrow wrapper inspection below.
  }

  if (shimTarget) {
    const resolvedTarget = path.win32.resolve(shimDirectory, shimTarget);
    if (fileExists(resolvedTarget)) {
      const targetExt = path.win32.extname(resolvedTarget).toLowerCase();
      if (targetExt === ".js" || targetExt === ".mjs" || targetExt === ".cjs") {
        const node = resolveNodeRuntime(cmdPath, environment, fileExists, resolveCommand, options);
        return {
          file: node.file,
          args: [resolvedTarget, ...args],
          ...(node.envOverrides ? { envOverrides: node.envOverrides } : {}),
        };
      }
      if (targetExt === ".exe" || targetExt === ".com") {
        return { file: resolvedTarget, args: [...args] };
      }
      if (targetExt === ".ps1") {
        const psExe = resolveCommand("powershell.exe", environment) ?? "powershell.exe";
        return {
          file: psExe,
          args: [...WINDOWS_POWERSHELL_ARGS, resolvedTarget, ...args],
        };
      }
      if (!targetExt && isNodeShebangScript(resolvedTarget, readTextFile)) {
        const node = resolveNodeRuntime(cmdPath, environment, fileExists, resolveCommand, options);
        return {
          file: node.file,
          args: [resolvedTarget, ...args],
          ...(node.envOverrides ? { envOverrides: node.envOverrides } : {}),
        };
      }
    }
  }

  let contents = "";
  try {
    contents = readTextFile(readableCmdPath);
  } catch {
    // Unreadable batch files fall back to cmd.exe so Windows reports the file error.
    return null;
  }

  const nodeWrapperMatch = contents.match(SIMPLE_NODE_WRAPPER_PATTERN);
  if (nodeWrapperMatch) {
    const exePath = path.win32.resolve(shimDirectory, nodeWrapperMatch[1]);
    const scriptPath = path.win32.resolve(shimDirectory, nodeWrapperMatch[2]);
    if (fileExists(exePath) && fileExists(scriptPath)) {
      return { file: exePath, args: [scriptPath, ...args] };
    }
  }

  const nativeWrapperMatch = contents.match(SIMPLE_NATIVE_WRAPPER_PATTERN);
  if (nativeWrapperMatch) {
    const exePath = path.win32.resolve(shimDirectory, nativeWrapperMatch[1]);
    if (fileExists(exePath)) {
      return { file: exePath, args: [...args] };
    }
  }

  return null;
}

export function resolveCliInvocation(executable: string, args?: string[]): ResolvedCliInvocation;
export function resolveCliInvocation(
  executable: string,
  args: string[] | undefined,
  options: CliPlatformOptions,
): ResolvedCliInvocation;
export function resolveCliInvocation(
  executable: string,
  args: string[] = [],
  options: CliPlatformOptions = {},
): ResolvedCliInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      file: executable,
      args: [...args],
      viaWindowsCmd: false,
    };
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const comspec = options.comspec ?? environmentValue(env, "ComSpec") ?? "cmd.exe";
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const readShim = options.readShim ?? defaultReadShim;
  const resolveCommand = options.resolveCommand ?? defaultResolveCommand;

  const trimmed = executable.trim();
  if (!trimmed) {
    return {
      file: executable,
      args: [...args],
      viaWindowsCmd: false,
    };
  }

  const hasPathSeparator = /[\\/]/u.test(trimmed) || path.win32.isAbsolute(trimmed);
  const resolvedPath = hasPathSeparator
    ? probeWindowsPathWithExtensions(
      path.win32.isAbsolute(trimmed) ? path.win32.normalize(trimmed) : path.win32.resolve(cwd, trimmed),
      env,
      fileExists,
    )
    : resolveCommand(trimmed, env);

  if (!resolvedPath) {
    const bareExt = path.win32.extname(trimmed).toLowerCase();
    if (bareExt === ".cmd" || bareExt === ".bat") {
      return buildWindowsCmdInvocation(trimmed, args, comspec);
    }
    return {
      file: executable,
      args: [...args],
      viaWindowsCmd: false,
    };
  }

  const ext = path.win32.extname(resolvedPath).toLowerCase();
  if (ext === ".exe" || ext === ".com") {
    return {
      file: resolvedPath,
      args: [...args],
      viaWindowsCmd: false,
    };
  }

  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const node = resolveNodeRuntime(resolvedPath, env, fileExists, resolveCommand, options);
    return {
      file: node.file,
      args: [resolvedPath, ...args],
      viaWindowsCmd: false,
      ...(node.envOverrides ? { envOverrides: node.envOverrides } : {}),
    };
  }

  if (ext === ".ps1") {
    const psExe = resolveCommand("powershell.exe", env) ?? "powershell.exe";
    return {
      file: psExe,
      args: [...WINDOWS_POWERSHELL_ARGS, resolvedPath, ...args],
      viaWindowsCmd: false,
    };
  }

  if (ext === ".cmd" || ext === ".bat") {
    const unwrapped = unwrapWindowsCmd(
      resolvedPath,
      args,
      env,
      fileExists,
      readTextFile,
      readShim,
      resolveCommand,
      options,
    );
    if (unwrapped) {
      return {
        ...unwrapped,
        viaWindowsCmd: false,
      };
    }
    return buildWindowsCmdInvocation(resolvedPath, args, comspec);
  }

  if (!ext && fileExists(resolvedPath) && isNodeShebangScript(resolvedPath, readTextFile)) {
    const node = resolveNodeRuntime(resolvedPath, env, fileExists, resolveCommand, options);
    return {
      file: node.file,
      args: [resolvedPath, ...args],
      viaWindowsCmd: false,
      ...(node.envOverrides ? { envOverrides: node.envOverrides } : {}),
    };
  }

  return {
    file: resolvedPath,
    args: [...args],
    viaWindowsCmd: false,
  };
}

function resolveCwdString(cwd: string | URL | undefined): string | undefined {
  if (typeof cwd === "string") return cwd;
  if (cwd instanceof URL) return fileURLToPath(cwd);
  return undefined;
}

export function spawnCli(request: CliSpawnRequest): ChildProcess {
  const { executable, args = [], ...options } = request;
  const desktop = resolveDshDesktopInvocation(executable, args, options.env);
  const effectiveEnv = desktop?.env ?? options.env ?? process.env;
  const invocation = resolveCliInvocation(desktop?.executable ?? executable, desktop?.args ?? args, {
    env: effectiveEnv,
    cwd: resolveCwdString(options.cwd),
  });
  const finalEnv = invocation.envOverrides
    ? { ...effectiveEnv, ...invocation.envOverrides }
    : (desktop ? desktop.env : options.env);
  return spawn(invocation.file, invocation.args, {
    ...options,
    ...(finalEnv ? { env: finalEnv } : {}),
    windowsHide: options.windowsHide ?? true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export async function execCli(request: CliExecRequest): Promise<{ stdout: string; stderr: string }> {
  const { executable, args = [], ...options } = request;
  const desktop = resolveDshDesktopInvocation(executable, args, options.env);
  const effectiveEnv = desktop?.env ?? options.env ?? process.env;
  const invocation = resolveCliInvocation(desktop?.executable ?? executable, desktop?.args ?? args, {
    env: effectiveEnv,
    cwd: resolveCwdString(options.cwd),
  });
  const finalEnv = invocation.envOverrides
    ? { ...effectiveEnv, ...invocation.envOverrides }
    : (desktop ? desktop.env : options.env);
  return execFileAsync(invocation.file, invocation.args, {
    ...options,
    ...(finalEnv ? { env: finalEnv } : {}),
    windowsHide: options.windowsHide ?? true,
    encoding: "utf8",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export function terminateCliProcess(
  proc: Pick<ChildProcess, "pid" | "killed" | "exitCode" | "kill"> | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {},
): void {
  if (!proc) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && typeof proc.pid === "number" && proc.pid > 0 && proc.exitCode === null) {
    const spawnFn = options.spawnImpl ?? spawn;
    try {
      const killer = spawnFn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("error", () => {
        if (proc.exitCode === null && !proc.killed) proc.kill(signal);
      });
      killer.once("exit", (code) => {
        if (code !== 0 && proc.exitCode === null && !proc.killed) proc.kill(signal);
      });
      killer.unref?.();
      return;
    } catch {
      // Fall back to direct process termination if taskkill cannot be spawned.
    }
  }
  if (!proc.killed) {
    proc.kill(signal);
  }
}
