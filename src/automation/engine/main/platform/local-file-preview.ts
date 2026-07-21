import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalFilePreview } from "../../shared/types";

export const MAX_LOCAL_FILE_PREVIEW_BYTES = 512 * 1024;

/**
 * Resolve a possibly-relative file path against the work directory (expanding a
 * leading `~/`), reject paths that escape it, and confirm it is a regular file.
 * Shared by the file preview and by artifact registration validation.
 */
export async function resolveWorkDirFile(filePath: string, workDir: string, homeDir: string): Promise<string> {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("File path is required.");
  const absoluteWorkDir = path.resolve(workDir);
  const expandedPath = filePath.startsWith("~/") ? path.join(homeDir, filePath.slice(2)) : filePath;
  const absolutePath = path.resolve(absoluteWorkDir, expandedPath);
  const relativePath = path.relative(absoluteWorkDir, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Only files under the current work directory can be used.");
  }
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error("Only regular files are supported.");
  return absolutePath;
}

/**
 * Resolve a file that must live under at least one of the allowed roots (the
 * global work dir plus each workflow's own dir). Returns the first match.
 */
async function resolveFileUnderRoots(filePath: string, roots: string[], homeDir: string): Promise<string> {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("File path is required.");
  const expandedPath = filePath.startsWith("~/") ? path.join(homeDir, filePath.slice(2)) : filePath;
  for (const rawRoot of roots) {
    if (!rawRoot) continue;
    const root = path.resolve(rawRoot);
    const absolutePath = path.resolve(root, expandedPath);
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
    try {
      const info = await stat(absolutePath);
      if (info.isFile()) return absolutePath;
    } catch {
      // Not under this root / not present; try the next one.
    }
  }
  throw new Error("Only files under the work directory or a workflow directory can be used.");
}

function readPreviewFromBuffer(absolutePath: string, buffer: Buffer): LocalFilePreview {
  const truncated = buffer.byteLength > MAX_LOCAL_FILE_PREVIEW_BYTES;
  const contentBuffer = truncated ? buffer.subarray(0, MAX_LOCAL_FILE_PREVIEW_BYTES) : buffer;
  return {
    path: absolutePath,
    title: path.basename(absolutePath),
    content: contentBuffer.toString("utf8"),
    truncated,
  };
}

export async function createLocalTextFilePreview(filePath: string, workDir: string, homeDir: string): Promise<LocalFilePreview> {
  const absolutePath = await resolveWorkDirFile(filePath, workDir, homeDir);
  return readPreviewFromBuffer(absolutePath, await readFile(absolutePath));
}

export async function createLocalTextFilePreviewUnderRoots(filePath: string, roots: string[], homeDir: string): Promise<LocalFilePreview> {
  const absolutePath = await resolveFileUnderRoots(filePath, roots, homeDir);
  return readPreviewFromBuffer(absolutePath, await readFile(absolutePath));
}
