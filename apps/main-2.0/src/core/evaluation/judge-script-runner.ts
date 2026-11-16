import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type {
  EvaluationJudgeScript,
  EvaluationJudgeScriptInput,
  EvaluationJudgeScriptVerdict,
} from "./nodes/contracts";

const require = createRequire(import.meta.url);
const readCmdShim = require("read-cmd-shim") as {
  sync(filePath: string): string;
};
const which = require("which") as {
  sync(command: string, options?: {
    path?: string;
    pathExt?: string;
    nothrow?: boolean;
  }): string | null;
};

/**
 * Runs judges the user wrote, so a rubric that is easier to express as code than
 * as a prompt does not need a model at all.
 *
 * Two modes, two different trust stories:
 *
 * - **Inline JS** runs in a fresh `node:vm` context with the subject and nothing
 *   else — no `require`, no `process`, no filesystem, no network. A judge is
 *   supposed to look at the artifact, and taking capabilities away is what makes
 *   it safe to paste one in from anywhere.
 * - **A command** is a real process and can do anything the user can, so it stays
 *   behind a setting that is off until it is turned on. When it is off the judge
 *   is *excused* and says so, rather than disappearing from the report.
 *
 * Every failure path here rejects. That is the contract the judge nodes rely on:
 * a script that throws, times out, exits non-zero or prints something that is not
 * a verdict has learned nothing about the agent, and the node turns the rejection
 * into `excused: judge_failure` instead of a zero.
 */

const DEFAULT_INLINE_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Enough of a script's own logging to explain a failure, not enough to flood a row. */
const MAX_CAPTURED_LOG = 2_000;

export interface JudgeScriptRunnerOptions {
  /**
   * Whether spawning a command judge is allowed. Off by default because a
   * command runs unsandboxed with the user's own privileges.
   */
  commandsEnabled?: () => boolean;
  /** Working directory for command judges when the script does not name one. */
  defaultCwd?: string;
  /** Injected so tests do not spawn processes. */
  spawnCommand?: typeof spawn;
  /** Platform override; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Environment override for Windows command resolution; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export type JudgeScriptRunner = (
  input: EvaluationJudgeScriptInput,
) => Promise<{ verdicts: EvaluationJudgeScriptVerdict[]; durationMs: number }>;

export function createJudgeScriptRunner(
  options: JudgeScriptRunnerOptions = {},
): JudgeScriptRunner {
  return async (input) => {
    const startedAt = Date.now();
    const raw = input.script.mode === "command"
      ? await runCommandJudge(input, options)
      : await runInlineJudge(input);
    return { verdicts: normalizeJudgeScriptResult(raw), durationMs: Date.now() - startedAt };
  };
}

function timeoutFor(script: EvaluationJudgeScript, fallback: number): number {
  const requested = script.timeoutMs;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/** The subject, in the shape both modes hand to the script. */
function judgeSubject(input: EvaluationJudgeScriptInput): {
  task: unknown;
  artifact: unknown;
  trajectory: unknown;
} {
  return {
    task: structuredClone(input.task),
    artifact: input.artifact ? structuredClone(input.artifact) : null,
    trajectory: input.trajectory ? structuredClone(input.trajectory) : null,
  };
}

class JudgeScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`script_timed_out_after_${timeoutMs}ms`);
    this.name = "JudgeScriptTimeoutError";
  }
}

async function runInlineJudge(input: EvaluationJudgeScriptInput): Promise<unknown> {
  if (input.script.mode !== "inline_js") throw new Error("Expected an inline script.");
  const source = input.script.source.trim();
  if (!source) throw new Error("script_is_empty");
  throwIfAborted(input.signal);

  const timeoutMs = timeoutFor(input.script, DEFAULT_INLINE_TIMEOUT_MS);
  const subject = judgeSubject(input);
  const logs: string[] = [];
  const capture = (...parts: unknown[]) => {
    if (logs.join("").length < MAX_CAPTURED_LOG) {
      logs.push(parts.map((part) => (typeof part === "string" ? part : safeStringify(part))).join(" "));
    }
  };

  let result: unknown;
  try {
    result = runInNewContext(
      // A bare `return` is what a judge naturally writes, so the source becomes a
      // function body rather than an expression.
      `"use strict"; (function (task, artifact, trajectory) {\n${source}\n})(task, artifact, trajectory)`,
      {
        ...subject,
        console: { log: capture, warn: capture, error: capture, info: capture, debug: capture },
        JSON,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Date,
        RegExp,
        Map,
        Set,
        Error,
        isNaN,
        isFinite,
        parseInt,
        parseFloat,
      },
      {
        timeout: timeoutMs,
        // A judge has no business generating more code, and the timeout above
        // cannot interrupt an eval'd loop the way it interrupts this one.
        contextCodeGeneration: { strings: false, wasm: false },
      },
    );
  } catch (cause) {
    throw withLogs(cause, logs);
  }

  // The vm timeout only covers synchronous execution; an async judge needs its own.
  if (!isPromiseLike(result)) return result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new JudgeScriptTimeoutError(timeoutMs)), timeoutMs);
      }),
      abortPromise(input.signal),
    ]);
  } catch (cause) {
    throw withLogs(cause, logs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCommandJudge(
  input: EvaluationJudgeScriptInput,
  options: JudgeScriptRunnerOptions,
): Promise<unknown> {
  if (input.script.mode !== "command") throw new Error("Expected a command script.");
  const command = input.script.command.trim();
  if (!command) throw new Error("script_command_is_empty");
  if (options.commandsEnabled && !options.commandsEnabled()) {
    throw new Error("script_commands_not_enabled");
  }
  throwIfAborted(input.signal);

  const timeoutMs = timeoutFor(input.script, DEFAULT_COMMAND_TIMEOUT_MS);
  const spawnCommand = options.spawnCommand ?? spawn;
  const platform = options.platform ?? process.platform;
  const cwd = input.script.cwd ?? options.defaultCwd;
  const args = input.script.args ?? [];
  const invocation = resolveCommandInvocation(command, args, cwd, platform, options.env);

  const stdout = await new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(invocation.file, invocation.args, invocation.spawnOptions);
    } catch (cause) {
      reject(new Error(`script_command_failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      return;
    }
    let out = "";
    let err = "";
    let spawnError: Error | undefined;
    let timedOut = false;
    let closed = false;
    let terminationSent = false;

    const terminateChild = () => {
      if (terminationSent || closed) return;
      terminationSent = true;
      terminateProcessTree(child, platform, spawnCommand, () => closed);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    const onAbort = () => terminateChild();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.stdin?.on?.("error", () => {
      // Child may exit before consuming stdin; close handler reports the exit status.
    });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      closed = true;
      cleanup();
      if (timedOut) {
        reject(new JudgeScriptTimeoutError(timeoutMs));
        return;
      }
      if (input.signal?.aborted) {
        reject(new Error("script_aborted"));
        return;
      }
      if (spawnError) {
        reject(new Error(`script_command_failed: ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `script_command_exited_${code}${err.trim() ? `: ${err.trim().slice(0, MAX_CAPTURED_LOG)}` : ""}`,
        ));
        return;
      }
      resolve(out);
    });

    // The subject goes in on stdin, so a judge never has to be told where to
    // find it and the same script works for any case.
    try {
      child.stdin?.end(`${JSON.stringify(judgeSubject(input))}\n`);
    } catch (cause) {
      cleanup();
      terminateChild();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });

  const block = stdout.trim();
  if (!block) throw new Error("script_command_printed_nothing");
  try {
    return JSON.parse(lastJsonBlock(block));
  } catch {
    throw new Error("script_command_output_not_json");
  }
}

interface ResolvedCommandInvocation {
  file: string;
  args: string[];
  spawnOptions: SpawnOptions;
}

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const upper = key.toUpperCase();
  return Object.entries(env).find(([name]) => name.toUpperCase() === upper)?.[1];
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function windowsPathExtensions(pathExt?: string): string[] {
  const raw = pathExt || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .flatMap((ext) => (ext === ext.toLowerCase() ? [ext] : [ext, ext.toLowerCase()]));
}

function findWithWindowsPathExt(basePath: string, pathExt?: string): string | null {
  const extensions = path.extname(basePath) ? ["", ...windowsPathExtensions(pathExt)] : windowsPathExtensions(pathExt);
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (isFile(candidate)) return tryRealpath(candidate);
  }
  return null;
}

function resolveWindowsExecutablePath(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const pathExt = environmentValue(env, "PATHEXT");
  if (/[\\/]/u.test(command) || path.isAbsolute(command)) {
    const candidate = path.isAbsolute(command)
      ? path.resolve(command)
      : path.resolve(cwd ?? process.cwd(), command);
    if (isFile(candidate)) return tryRealpath(candidate);
    if (!path.extname(candidate)) {
      const matched = findWithWindowsPathExt(candidate, pathExt);
      if (matched) return matched;
    }
    return command;
  }

  const envPath = environmentValue(env, "PATH");
  const searchPath = cwd ? `${cwd}${path.delimiter}${envPath ?? ""}` : envPath;
  const resolved = which.sync(command, { path: searchPath, pathExt, nothrow: true });
  if (resolved) return tryRealpath(resolved);

  // `which` checks process.platform at load time, so when simulating win32 on POSIX
  // we also probe PATH directories with PATHEXT extensions.
  if (process.platform !== "win32") {
    const directories = [
      ...(cwd ? [cwd] : []),
      ...(envPath ? envPath.split(envPath.includes(";") ? ";" : path.delimiter) : []),
    ].filter(Boolean);
    for (const dir of directories) {
      const cleaned = dir.replace(/^"(.*)"$/, "$1");
      const matched = findWithWindowsPathExt(path.join(cleaned, command), pathExt);
      if (matched) return matched;
    }
  }
  return command;
}

function hasNodeShebang(filePath: string): boolean {
  try {
    const head = readFileSync(filePath, "utf8").slice(0, 256);
    return /^#![^\r\n]*\bnode(?:\.exe)?\b/i.test(head);
  } catch {
    return false;
  }
}

function resolveCmdShimTarget(shimPath: string): string | null {
  let destination: string | undefined;
  try {
    destination = readCmdShim.sync(shimPath);
  } catch {
    // read-cmd-shim checks `/[.]cmd$/` case-sensitively, whereas Windows which/PATHEXT
    // often returns uppercase `.CMD`.
    if (process.platform === "win32" && /\.cmd$/i.test(shimPath) && !shimPath.endsWith(".cmd")) {
      try {
        destination = readCmdShim.sync(shimPath.replace(/\.cmd$/i, ".cmd"));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!destination) return null;
  const target = path.resolve(path.dirname(shimPath), ...destination.split(/[\\/]/u));
  if (!isFile(target)) return null;
  if (/\.(?:js|mjs|cjs)$/i.test(target) || hasNodeShebang(target)) {
    return tryRealpath(target);
  }
  return null;
}

function resolveNodeExecutable(
  shimPath: string,
  env: NodeJS.ProcessEnv,
): { file: string; extraEnv?: NodeJS.ProcessEnv } {
  const adjacent = path.join(path.dirname(shimPath), "node.exe");
  if (isFile(adjacent)) return { file: tryRealpath(adjacent) };
  const fromPath = resolveWindowsExecutablePath("node.exe", undefined, env);
  if (fromPath !== "node.exe") return { file: fromPath };
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase === "node.exe" || execBase === "node") return { file: process.execPath };
  return { file: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
}

function quoteWindowsCmdArg(value: string): string {
  // Double backslashes before `"`, `%` (broken into `"^%"`), or end-of-string so
  // MSVC CommandLineToArgvW does not treat them as escaping the quote delimiter.
  const escaped = value
    .replace(/(\\*)(?=["%]|$)/g, "$1$1")
    .replace(/"/g, '""')
    .replace(/%/g, '"^%"');
  return `"${escaped}"`;
}

function resolveCommandInvocation(
  command: string,
  args: string[],
  cwd: string | undefined,
  platform: NodeJS.Platform,
  explicitEnv?: NodeJS.ProcessEnv,
): ResolvedCommandInvocation {
  const baseOptions: SpawnOptions = {
    ...(cwd ? { cwd } : {}),
    ...(explicitEnv ? { env: explicitEnv } : {}),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (platform !== "win32") {
    return { file: command, args, spawnOptions: baseOptions };
  }

  const env = explicitEnv ?? process.env;
  const resolved = resolveWindowsExecutablePath(command, cwd, env);
  const extension = path.extname(resolved).toLowerCase();

  if (extension === ".cmd" || extension === ".bat") {
    const shimTarget = resolveCmdShimTarget(resolved);
    if (shimTarget) {
      const nodeExec = resolveNodeExecutable(resolved, env);
      return {
        file: nodeExec.file,
        args: [shimTarget, ...args],
        spawnOptions: nodeExec.extraEnv
          ? { ...baseOptions, env: { ...env, ...nodeExec.extraEnv } }
          : baseOptions,
      };
    }
    const comspec = environmentValue(env, "ComSpec")?.trim() || "cmd.exe";
    const commandLine = `"${[resolved, ...args].map(quoteWindowsCmdArg).join(" ")}"`;
    return {
      file: comspec,
      args: ["/d", "/v:off", "/s", "/c", commandLine],
      spawnOptions: {
        ...baseOptions,
        windowsVerbatimArguments: true,
      },
    };
  }

  if (extension === ".ps1") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
      spawnOptions: baseOptions,
    };
  }

  return { file: resolved, args, spawnOptions: baseOptions };
}

function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnCommand: typeof spawn,
  isClosed: () => boolean,
): void {
  const fallbackKill = () => {
    if (isClosed()) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Child already exited before fallback kill ran.
    }
  };
  if (platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      const killer = spawnCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer?.once?.("error", fallbackKill);
      killer?.once?.("close", (code) => {
        if (code !== 0) fallbackKill();
      });
      killer?.unref?.();
      return;
    } catch {
      fallbackKill();
      return;
    }
  }
  fallbackKill();
}

/**
 * Reads whatever the script returned as verdicts.
 *
 * A number, one object, or a list of objects are all accepted — the strictest
 * form is not worth the friction, and a judge that returns `0.8` means one thing
 * only. Anything else rejects, so a script that returns `undefined` because a
 * branch forgot to return is a judge failure rather than a silent zero.
 */
export function normalizeJudgeScriptResult(value: unknown): EvaluationJudgeScriptVerdict[] {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) throw new Error("script_returned_no_verdict");
  return items.map((item) => {
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("script_score_is_not_a_number");
      return { score: item };
    }
    if (!item || typeof item !== "object") throw new Error("script_returned_no_verdict");
    const record = item as Record<string, unknown>;
    const score = Number(record.score ?? record.value);
    if (!Number.isFinite(score)) throw new Error("script_score_is_not_a_number");
    return {
      score,
      ...(typeof record.dimension === "string" && record.dimension.trim()
        ? { dimension: record.dimension.trim() }
        : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(stringList(record.evidence) ? { evidence: stringList(record.evidence)! } : {}),
      ...(stringList(record.failedCriteria)
        ? { failedCriteria: stringList(record.failedCriteria)! }
        : {}),
    };
  });
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * The last JSON object or array in the output.
 *
 * A command judge often prints progress before its result, and taking the last
 * block means that noise does not have to be suppressed to get a verdict.
 */
function lastJsonBlock(output: string): string {
  const closing = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
  if (closing < 0) return output;
  const opener = output[closing] === "}" ? "{" : "[";
  const opening = output.indexOf(opener);
  return opening >= 0 && opening < closing ? output.slice(opening, closing + 1) : output;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("script_aborted");
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => reject(new Error("script_aborted")), { once: true });
  });
}

/** Puts the script's own logging into the failure, which is where it is read. */
function withLogs(cause: unknown, logs: string[]): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const tail = logs.join("\n").slice(-MAX_CAPTURED_LOG).trim();
  return new Error(tail ? `${message}\n${tail}` : message);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
