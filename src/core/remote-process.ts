import { execFile, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { buildWslProcessSpec } from "./wsl";
import type { SessionEnvironment } from "./types";

export interface RemoteProcessSpec {
  command: string;
  args: string[];
}

export const REMOTE_PROCESS_EXEC_OPTIONS = {
  maxBuffer: 128 * 1024 * 1024,
  timeout: 90_000,
} satisfies ExecFileOptions;

export function buildRemoteProcessSpec(environment: SessionEnvironment, remoteCommand: string): RemoteProcessSpec {
  if (environment.kind !== "wsl") throw new Error("WSL process execution requires a WSL environment.");
  return buildWslProcessSpec(environment.wslDistribution ?? "", remoteCommand);
}

export async function runRemoteCommand(
  environment: SessionEnvironment,
  remoteCommand: string,
  options: ExecFileOptions = REMOTE_PROCESS_EXEC_OPTIONS,
): Promise<string> {
  const spec = buildRemoteProcessSpec(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    execFile(spec.command, spec.args, options, (error, stdout, stderr) => {
      const stdoutText = toText(stdout);
      const stderrText = toText(stderr);
      if (error) {
        reject(new Error(formatRemoteProcessError(error, stdoutText, stderrText)));
        return;
      }
      resolve(stdoutText);
    });
  });
}

export async function runRemoteCommandWithInput(
  environment: SessionEnvironment,
  remoteCommand: string,
  input: string,
  options: ExecFileOptions = REMOTE_PROCESS_EXEC_OPTIONS,
): Promise<string> {
  const spec = buildRemoteProcessSpec(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = execFile(spec.command, spec.args, options, (error, stdout, stderr) => {
      const stdoutText = toText(stdout);
      const stderrText = toText(stderr);
      if (error) {
        reject(new Error(formatRemoteProcessError(error, stdoutText, stderrText)));
        return;
      }
      resolve(stdoutText);
    });
    child.stdin?.end(input);
  });
}

export function spawnRemoteCommand(
  environment: SessionEnvironment,
  remoteCommand: string,
): ChildProcess {
  const spec = buildRemoteProcessSpec(environment, remoteCommand);
  return spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
}

export function formatRemoteProcessError(error: Error, stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return detail || error.message;
}

function toText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "";
}
