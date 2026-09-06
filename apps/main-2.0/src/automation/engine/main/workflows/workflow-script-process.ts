import { spawn } from "node:child_process";
import type { WorkflowScriptRunner } from "./workflow-executors";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TERMINATE_GRACE_MS = 2_000;
const FORCE_KILL_EXIT_WAIT_MS = 5_000;
const CANCEL_MESSAGE = "Script execution was cancelled.";

function commandFor(runtime: Parameters<WorkflowScriptRunner["run"]>[0]["runtime"], source: string): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  if (runtime === "bash") return { command: process.platform === "win32" ? "bash.exe" : "/bin/bash", args: ["-c", source] };
  if (runtime === "python") return { command: process.platform === "win32" ? "python.exe" : "python3", args: ["-c", source] };
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", "--input-type=module", "--eval", source],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export class WorkflowScriptProcessRunner implements WorkflowScriptRunner {
  private readonly stopRequests = new Map<string, () => void>();

  constructor(private readonly defaultWorkDir: () => string = () => process.cwd()) {}

  run(input: Parameters<WorkflowScriptRunner["run"]>[0]): Promise<{ stdout: string; stderr: string }> {
    const launch = commandFor(input.runtime, input.source);
    const key = `${input.runId}:${input.nodeId}`;
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: input.workDir ?? this.defaultWorkDir(),
        env: launch.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let stopMessage: string | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        input.signal.removeEventListener("abort", abort);
        child.removeListener("exit", onExit);
        this.stopRequests.delete(key);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      // A script that ignores SIGTERM would otherwise outlive this promise with no handle left to
      // stop it, so escalate to SIGKILL and settle only once the process is really gone.
      const stop = (message: string): void => {
        if (stopMessage !== undefined) return;
        // kill() reports false when the script already exited on its own; let close state that outcome.
        if (!child.kill("SIGTERM")) return;
        stopMessage = message;
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
          // A surviving grandchild can hold the stdio pipes open, so close may never arrive.
          giveUpTimer = setTimeout(() => finish(new Error(message)), FORCE_KILL_EXIT_WAIT_MS);
        }, TERMINATE_GRACE_MS);
      };
      const onExit = (): void => {
        const message = stopMessage;
        if (message !== undefined) finish(new Error(message));
      };
      const abort = (): void => stop(CANCEL_MESSAGE);
      const timer = setTimeout(() => stop(`Script execution timed out after ${input.timeoutSeconds} seconds.`), input.timeoutSeconds * 1000);
      this.stopRequests.set(key, abort);
      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop("Script output exceeded 2 MB.");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop("Script output exceeded 2 MB.");
      });
      child.once("error", (error) => finish(error));
      child.once("exit", onExit);
      child.once("close", (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(`Script exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(input.stdin);
      if (input.signal.aborted) abort();
    });
  }

  async cancel(runId: string, nodeId: string): Promise<void> {
    this.stopRequests.get(`${runId}:${nodeId}`)?.();
  }
}
