import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentEvent } from "../../../shared/types";
import { spawnCli } from "../../platform/cli-launcher";
import { resolveWindowsDshInvocation } from "./dsh-windows-launcher";
import {
  DshSessionDiscovery,
  dshSessionsRoot,
  type DshSessionDiscoveryHandle,
} from "./dsh-session-discovery";

const MAX_STDERR_CHARS = 8_000;
const MAX_POSIX_PROMPT_BYTES = 120_000;
const TERMINATION_GRACE_MS = 6_000;
const TERMINATION_CLOSE_MS = 2_000;

export interface DshRunOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
}

interface DshRunnerDependencies {
  platform: NodeJS.Platform;
  spawnProcess: typeof spawn;
  killProcess: typeof process.kill;
  resolveWindowsInvocation: typeof resolveWindowsDshInvocation;
  createSessionDiscovery: (
    sessionsRoot: string,
    onSessionId: (sessionId: string) => void,
  ) => DshSessionDiscoveryHandle;
}

interface ActiveDshRun {
  proc: ChildProcess;
  supportsIpcInterrupt: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (error: unknown) => void;
  finished: boolean;
  stopping: boolean;
  terminalError?: string;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  terminalTimer?: ReturnType<typeof setTimeout>;
  stopPromise?: Promise<void>;
  sessionDiscovery: DshSessionDiscoveryHandle;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("DSH runner start was cancelled.");
  error.name = "AbortError";
  return error;
}

function boundedAppend(current: string, text: string): string {
  return `${current}${text}`.slice(-MAX_STDERR_CHARS);
}

export class DshRunner {
  private active: ActiveDshRun | undefined;
  private pendingStartAbort: AbortController | undefined;
  private readonly dependencies: DshRunnerDependencies;

  constructor(
    private readonly options: DshRunOptions,
    dependencies: Partial<DshRunnerDependencies> = {},
  ) {
    this.dependencies = {
      platform: process.platform,
      spawnProcess: spawn,
      killProcess: process.kill,
      resolveWindowsInvocation: resolveWindowsDshInvocation,
      createSessionDiscovery: (sessionsRoot, onSessionId) =>
        new DshSessionDiscovery(sessionsRoot, onSessionId),
      ...dependencies,
    };
  }

  async start(): Promise<void> {
    if (this.active || this.pendingStartAbort) {
      throw new Error("DSH runner is already running.");
    }

    let exitReported = false;
    const reportExit = (code: number | null): void => {
      if (exitReported) return;
      exitReported = true;
      this.options.onExit(code);
    };

    let proc: ChildProcess;
    let activeCreated = false;
    const startAbort = new AbortController();
    this.pendingStartAbort = startAbort;
    const environment = this.options.env ?? process.env;
    const sessionDiscovery = this.dependencies.createSessionDiscovery(
      dshSessionsRoot(environment),
      (sessionId) => this.options.onEvent({
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "dsh",
          codecVersion: "v1",
          payload: { native: { sessionId } },
        },
      }),
    );
    try {
      if (
        this.dependencies.platform !== "win32"
        && Buffer.byteLength(this.options.prompt, "utf8") > MAX_POSIX_PROMPT_BYTES
      ) {
        throw new Error(
          "The DSH prompt is too large for a single command-line argument. Shorten the request or attached instructions.",
        );
      }
      const preparation = sessionDiscovery.prepare(startAbort.signal);
      if (preparation) await preparation;
      if (startAbort.signal.aborted) throw abortError();
      let executable = this.options.executable;
      let args = ["--profile", "headless", this.options.prompt];
      let stdin: string | undefined;
      let supportsIpcInterrupt = false;
      if (this.dependencies.platform === "win32") {
        const invocation = this.dependencies.resolveWindowsInvocation({
          executable,
          args,
          environment,
          workingDirectory: this.options.cwd,
        });
        executable = invocation.executable;
        args = invocation.args;
        stdin = invocation.stdin;
        supportsIpcInterrupt = invocation.ipc === true;
      }
      proc = spawnCli({
        executable,
        args,
        cwd: this.options.cwd,
        env: environment,
        stdio: supportsIpcInterrupt
          ? [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"]
          : [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: this.dependencies.platform !== "win32",
      });
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const active: ActiveDshRun = {
        proc,
        supportsIpcInterrupt,
        completion,
        resolveCompletion,
        rejectCompletion,
        finished: false,
        stopping: false,
        sessionDiscovery,
      };
      this.active = active;
      this.pendingStartAbort = undefined;
      activeCreated = true;
      sessionDiscovery.observe();

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += stdoutDecoder.write(chunk);
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        stderr = boundedAppend(stderr, text);
        this.options.onStderr?.(text);
      });

      const finish = async (
        code: number | null,
        processError?: unknown,
      ): Promise<void> => {
        if (active.finished) return;
        active.finished = true;
        stdout += stdoutDecoder.end();
        stderr = boundedAppend(stderr, stderrDecoder.end());
        this.clearTimers(active);
        if (this.active === active) this.active = undefined;

        let callbackError: unknown;
        try {
          await active.sessionDiscovery.finish();
        } catch (error) {
          callbackError = error;
        }
        try {
          if (active.terminalError) {
            this.options.onEvent({
              type: "error",
              error: active.terminalError,
            });
          } else if (processError !== undefined && !active.stopping) {
            this.options.onEvent({
              type: "error",
              error: `DSH process error: ${errorMessage(processError)}`,
            });
          } else if (!active.stopping) {
            const content = stdout.trim();
            if (code === 0) {
              if (content) {
                this.options.onEvent({ type: "completed", content });
              } else {
                this.options.onEvent({
                  type: "error",
                  error: "DSH completed without assistant text.",
                });
              }
            } else {
              const detail = (stderr.trim() || content || "no output")
                .slice(-MAX_STDERR_CHARS);
              this.options.onEvent({
                type: "error",
                error: `DSH exited with ${code ?? "unknown"}: ${detail}`,
              });
            }
          }
        } catch (error) {
          callbackError ??= error;
        }
        try {
          reportExit(
            active.stopping || active.terminalError || processError !== undefined
              ? null
              : code,
          );
        } catch (error) {
          callbackError ??= error;
        }

        if (callbackError) {
          active.rejectCompletion(callbackError);
        } else {
          active.resolveCompletion();
        }
      };

      const failProcessInput = (message: string): void => {
        if (active.finished || active.stopping || active.terminalError) return;
        active.terminalError = message;
        this.forceTerminateProcessTree(active);
        active.terminalTimer = setTimeout(() => {
          active.terminalTimer = undefined;
          void finish(null, new Error(message));
        }, TERMINATION_GRACE_MS + TERMINATION_CLOSE_MS);
      };

      proc.once("close", (code) => void finish(code));
      proc.once("error", (error) => void finish(null, error));

      const missingPipes = [
        !proc.stdout ? "stdout" : undefined,
        !proc.stderr ? "stderr" : undefined,
        stdin !== undefined && !proc.stdin ? "stdin" : undefined,
        supportsIpcInterrupt
        && (!proc.connected || typeof proc.send !== "function")
          ? "IPC"
          : undefined,
      ].filter((name): name is string => Boolean(name));
      if (missingPipes.length > 0) {
        failProcessInput(
          `DSH runner failed to create ${missingPipes.join("/")} pipes.`,
        );
      } else if (stdin !== undefined && proc.stdin) {
        const handleStdinError = (error: unknown): void => {
          failProcessInput(`DSH process input error: ${errorMessage(error)}`);
        };
        proc.stdin.once("error", handleStdinError);
        try {
          proc.stdin.end(stdin, "utf8");
        } catch (error) {
          handleStdinError(error);
        }
      }

      await completion;
      return;
    } catch (error) {
      let discoveryCleanupError: unknown;
      try {
        await sessionDiscovery.finish();
      } catch (cleanupError) {
        discoveryCleanupError = cleanupError;
      }
      if (this.pendingStartAbort === startAbort) this.pendingStartAbort = undefined;
      if (startAbort.signal.aborted) {
        reportExit(null);
        return;
      }
      if (activeCreated) throw error;
      const runtimeError = new Error(
        `DSH process error: ${errorMessage(error)}${
          discoveryCleanupError === undefined
            ? ""
            : `; Session discovery cleanup failed: ${errorMessage(discoveryCleanupError)}`
        }`,
      );
      try {
        this.options.onEvent({ type: "error", error: runtimeError.message });
      } finally {
        reportExit(null);
      }
      return;
    }
  }

  async stop(): Promise<void> {
    if (this.pendingStartAbort) {
      this.pendingStartAbort.abort();
      return;
    }
    const active = this.active;
    if (!active) return;
    if (!active.stopPromise) {
      const stopPromise = this.stopActive(active);
      active.stopPromise = stopPromise;
      void stopPromise.catch(() => {
        if (
          this.active === active
          && !active.stopping
          && active.stopPromise === stopPromise
        ) {
          active.stopPromise = undefined;
        }
      });
    }
    await active.stopPromise;
  }

  private async stopActive(active: ActiveDshRun): Promise<void> {
    active.stopping = true;
    if (!this.interruptProcessTree(active)) {
      active.stopping = false;
      throw new Error("DSH process could not be interrupted.");
    }
    this.scheduleForceKill(active);

    await new Promise<void>((resolve, reject) => {
      active.stopTimer = setTimeout(() => {
        active.stopTimer = undefined;
        reject(new Error(
          `DSH process did not exit within ${
            (TERMINATION_GRACE_MS + TERMINATION_CLOSE_MS) / 1_000
          } seconds after interruption.`,
        ));
      }, TERMINATION_GRACE_MS + TERMINATION_CLOSE_MS);
      void active.completion.then(resolve, reject);
    });
  }

  private interruptProcessTree(active: ActiveDshRun): boolean {
    const { proc } = active;
    if (
      active.supportsIpcInterrupt
      && proc.connected
      && typeof proc.send === "function"
    ) {
      try {
        proc.send({ type: "interrupt" }, (error) => {
          if (
            error
            && this.active === active
            && !active.finished
          ) {
            this.forceTerminateProcessTree(active);
          }
        });
        return true;
      } catch {
        return this.forceTerminateProcessTree(active);
      }
    }
    if (this.dependencies.platform === "win32" && proc.pid) {
      try {
        const killer = this.dependencies.spawnProcess(
          "taskkill",
          ["/pid", String(proc.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", () => {
          if (this.active === active && !active.finished) {
            this.killDirectChild(proc, "SIGKILL");
          }
        });
        killer.once("close", (code) => {
          if (
            code !== 0
            && this.active === active
            && !active.finished
          ) {
            this.killDirectChild(proc, "SIGKILL");
          }
        });
        killer.unref();
        return true;
      } catch {
        return this.killDirectChild(proc, "SIGKILL");
      }
    }
    if (proc.pid) {
      try {
        if (this.dependencies.killProcess(-proc.pid, "SIGINT")) {
          return true;
        }
      } catch {
        // Fall back to the direct child when the process group already exited.
      }
    }
    const signaled = this.killDirectChild(proc, "SIGINT");
    return signaled;
  }

  private scheduleForceKill(active: ActiveDshRun): void {
    if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
    active.forceKillTimer = setTimeout(() => {
      active.forceKillTimer = undefined;
      if (this.active !== active || active.finished) return;
      this.forceTerminateProcessTree(active);
    }, TERMINATION_GRACE_MS);
  }

  private forceTerminateProcessTree(active: ActiveDshRun): boolean {
    const { proc } = active;
    if (this.dependencies.platform === "win32" && proc.pid) {
      try {
        const killer = this.dependencies.spawnProcess(
          "taskkill",
          ["/pid", String(proc.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", () => {
          if (this.active === active && !active.finished) {
            this.killDirectChild(proc, "SIGKILL");
          }
        });
        killer.once("close", (code) => {
          if (
            code !== 0
            && this.active === active
            && !active.finished
          ) {
            this.killDirectChild(proc, "SIGKILL");
          }
        });
        killer.unref();
        return true;
      } catch {
        return this.killDirectChild(proc, "SIGKILL");
      }
    }
    let killed = false;
    if (proc.pid) {
      try {
        killed = this.dependencies.killProcess(-proc.pid, "SIGKILL");
      } catch {
        // Fall back to the direct child when the process group is unavailable.
      }
    }
    return killed || this.killDirectChild(proc, "SIGKILL");
  }

  private clearTimers(active: ActiveDshRun): void {
    if (active.forceKillTimer) {
      clearTimeout(active.forceKillTimer);
      active.forceKillTimer = undefined;
    }
    if (active.stopTimer) {
      clearTimeout(active.stopTimer);
      active.stopTimer = undefined;
    }
    if (active.terminalTimer) {
      clearTimeout(active.terminalTimer);
      active.terminalTimer = undefined;
    }
  }

  private killDirectChild(proc: ChildProcess, signal: NodeJS.Signals): boolean {
    try {
      return proc.kill(signal);
    } catch {
      return false;
    }
  }
}
