import * as path from "node:path";
import { runRemoteCommand } from "./remote-process";
import { sessionSourceDeletionPaths, type SessionSourceDeleteTarget } from "./session-source-delete";
import type { SessionEnvironment } from "./types";

export type WslCommandRunner = (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;

export async function deleteWslSessionFile(
  environment: SessionEnvironment,
  filePath: string,
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  await deleteWslSessionFiles(environment, [filePath], runCommand);
}

export async function deleteWslSessionFiles(
  environment: SessionEnvironment,
  filePaths: readonly string[],
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  if (environment.kind !== "wsl") throw new Error("WSL session deletion requires a WSL environment.");
  const normalizedPaths = [...new Set(filePaths.map((filePath) => filePath.trim()))];
  if (normalizedPaths.some((filePath) => !filePath.startsWith("/"))) throw new Error("WSL session path must be absolute.");
  if (normalizedPaths.length === 0) return;
  await runCommand(environment, `rm -f -- ${normalizedPaths.map(posixShellQuote).join(" ")}`);
}

export async function deleteWslSessionSources(
  environment: SessionEnvironment,
  targets: readonly SessionSourceDeleteTarget[],
  runCommand: WslCommandRunner = runRemoteCommand,
): Promise<void> {
  if (environment.kind !== "wsl") throw new Error("WSL session deletion requires a WSL environment.");
  const deletionPaths = sessionSourceDeletionPaths(targets, path.posix);
  const allPaths = [
    ...deletionPaths.files,
    ...deletionPaths.directories,
    ...deletionPaths.emptyDirectories,
    ...deletionPaths.requiredAbsentFiles,
  ];
  if (allPaths.some((filePath) => !filePath.startsWith("/"))) throw new Error("WSL session path must be absolute.");
  if (deletionPaths.files.length === 0) return;

  const commands = [
    ...deletionPaths.requiredAbsentFiles.map((filePath) => {
      const quoted = posixShellQuote(filePath);
      return `if [ -e ${quoted} ] || [ -L ${quoted} ]; then exit 1; fi`;
    }),
    ...deletionPaths.files.map((filePath) => {
      const quoted = posixShellQuote(filePath);
      return `if [ -d ${quoted} ] && [ ! -L ${quoted} ]; then exit 1; fi`;
    }),
    ...[...deletionPaths.directories, ...deletionPaths.emptyDirectories].map((directoryPath) => {
      const quoted = posixShellQuote(directoryPath);
      return `if { [ -e ${quoted} ] || [ -L ${quoted} ]; } && { [ ! -d ${quoted} ] || [ -L ${quoted} ]; }; then exit 1; fi`;
    }),
    `rm -f -- ${deletionPaths.files.map(posixShellQuote).join(" ")}`,
  ];
  if (deletionPaths.directories.length > 0) {
    commands.push(`rm -rf -- ${deletionPaths.directories.map(posixShellQuote).join(" ")}`);
  }
  if (deletionPaths.emptyDirectories.length > 0) {
    commands.push(`{ rmdir -- ${deletionPaths.emptyDirectories.map(posixShellQuote).join(" ")} 2>/dev/null || true; }`);
  }
  await runCommand(environment, commands.join(" && "));
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
