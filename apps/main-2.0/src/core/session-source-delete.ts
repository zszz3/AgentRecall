import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionSource } from "./types";

const CLAUDE_SESSION_FILE_SOURCES = new Set<SessionSource>(["claude-cli", "claude-app"]);

export interface SessionSourceDeleteTarget {
  source: SessionSource;
  rawId: string;
  filePath: string;
  isSubagent: boolean;
  orphanedParentSessionId?: string | null;
}

export interface SessionSourceDeletionPaths {
  files: string[];
  directories: string[];
  emptyDirectories: string[];
  requiredAbsentFiles: string[];
}

type PathOperations = Pick<typeof path.posix, "basename" | "dirname" | "extname" | "isAbsolute" | "join">;

export function sessionSourceDeletionPaths(
  targets: readonly SessionSourceDeleteTarget[],
  pathOperations: PathOperations = path,
): SessionSourceDeletionPaths {
  const files = new Set<string>();
  const directories = new Set<string>();
  const emptyDirectories = new Set<string>();
  const requiredAbsentFiles = new Set<string>();

  for (const target of targets) {
    const filePath = target.filePath.trim();
    if (!filePath) throw new Error("Session source file path is missing.");
    if (!pathOperations.isAbsolute(filePath)) throw new Error("Session source file path must be absolute.");
    files.add(filePath);
    if (!CLAUDE_SESSION_FILE_SOURCES.has(target.source)) continue;

    const extension = pathOperations.extname(filePath);
    if (extension.toLowerCase() !== ".jsonl") continue;
    if (target.isSubagent) {
      files.add(`${filePath.slice(0, -extension.length)}.meta.json`);
      const subagentsDirectory = pathOperations.dirname(filePath);
      const sessionDirectory = pathOperations.dirname(subagentsDirectory);
      if (
        target.orphanedParentSessionId
        && pathOperations.basename(subagentsDirectory) === "subagents"
        && pathOperations.basename(sessionDirectory) === target.orphanedParentSessionId
      ) {
        requiredAbsentFiles.add(pathOperations.join(
          pathOperations.dirname(sessionDirectory),
          `${target.orphanedParentSessionId}.jsonl`,
        ));
        directories.add(subagentsDirectory);
        directories.add(pathOperations.join(sessionDirectory, "tool-results"));
        emptyDirectories.add(sessionDirectory);
      }
      continue;
    }
    if (!target.rawId || pathOperations.basename(filePath, extension) !== target.rawId) continue;

    const sessionDirectory = pathOperations.join(pathOperations.dirname(filePath), target.rawId);
    directories.add(pathOperations.join(sessionDirectory, "subagents"));
    directories.add(pathOperations.join(sessionDirectory, "tool-results"));
    emptyDirectories.add(sessionDirectory);
  }

  return {
    files: [...files],
    directories: [...directories],
    emptyDirectories: [...emptyDirectories],
    requiredAbsentFiles: [...requiredAbsentFiles],
  };
}

export function deleteLocalSessionSources(targets: readonly SessionSourceDeleteTarget[]): void {
  const deletionPaths = sessionSourceDeletionPaths(targets);
  validateDeletionPaths(deletionPaths);
  for (const filePath of deletionPaths.files) deleteRegularFile(filePath);
  for (const directoryPath of deletionPaths.directories) deleteOwnedDirectory(directoryPath);
  for (const directoryPath of deletionPaths.emptyDirectories) removeEmptyDirectory(directoryPath);
}

function validateDeletionPaths(deletionPaths: SessionSourceDeletionPaths): void {
  for (const filePath of deletionPaths.requiredAbsentFiles) {
    if (lstatIfPresent(filePath)) {
      throw new Error("Refusing to clean orphaned subagents while the parent session source still exists.");
    }
  }
  for (const filePath of deletionPaths.files) {
    const stat = lstatIfPresent(filePath);
    if (stat?.isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  }
  for (const directoryPath of [...deletionPaths.directories, ...deletionPaths.emptyDirectories]) {
    const stat = lstatIfPresent(directoryPath);
    if (stat && !stat.isDirectory()) throw new Error("Refusing to recursively delete a non-directory session artifact.");
  }
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function deleteRegularFile(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(filePath, { force: true });
}

function deleteOwnedDirectory(directoryPath: string): void {
  try {
    if (!fs.lstatSync(directoryPath).isDirectory()) {
      throw new Error("Refusing to recursively delete a non-directory session artifact.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

function removeEmptyDirectory(directoryPath: string): void {
  try {
    fs.rmdirSync(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}
