import { runRemoteCommand } from "./remote-process";
import type { SessionEnvironment } from "./types";

export type WslCommandRunner = (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;

export async function deleteWslSessionFile(
  environment: SessionEnvironment,
  filePath: string,
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  if (environment.kind !== "wsl") throw new Error("WSL session deletion requires a WSL environment.");
  const normalizedPath = filePath.trim();
  if (!normalizedPath.startsWith("/")) throw new Error("WSL session path must be absolute.");
  await runCommand(environment, `rm -f -- ${posixShellQuote(normalizedPath)}`);
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
