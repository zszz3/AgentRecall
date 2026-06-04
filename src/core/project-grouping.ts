import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectGroupingMode } from "./types";

const REPO_ROOT_CACHE = new Map<string, string>();

export function normalizeProjectGrouping(value: unknown): ProjectGroupingMode {
  return value === "repo" ? "repo" : "cwd";
}

export function groupProjectPath(projectPath: string, grouping: ProjectGroupingMode = "cwd", promotedRoots: string[] = []): string {
  const normalized = projectPath.trim();
  if (!normalized) return "";
  if (grouping === "cwd") return normalized;
  const promotedRoot = findPromotedProjectRoot(normalized, promotedRoots);
  if (promotedRoot) return promotedRoot;
  const cached = REPO_ROOT_CACHE.get(normalized);
  if (cached) return cached;
  const grouped = detectRepositoryRoot(normalized);
  REPO_ROOT_CACHE.set(normalized, grouped);
  return grouped;
}

function normalizeComparablePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function findPromotedProjectRoot(projectPath: string, promotedRoots: string[]): string | null {
  const comparableProjectPath = normalizeComparablePath(projectPath);
  let bestMatch: string | null = null;
  let bestLength = -1;

  for (const root of promotedRoots) {
    const normalizedRoot = root.trim();
    if (!normalizedRoot) continue;
    const comparableRoot = normalizeComparablePath(normalizedRoot);
    if (comparableProjectPath !== comparableRoot && !comparableProjectPath.startsWith(`${comparableRoot}/`)) continue;
    if (comparableRoot.length <= bestLength) continue;
    bestMatch = normalizedRoot;
    bestLength = comparableRoot.length;
  }

  return bestMatch;
}

function detectRepositoryRoot(projectPath: string): string {
  let current = projectPath;
  try {
    const resolved = fs.realpathSync.native(projectPath);
    const stat = fs.statSync(resolved);
    current = stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return projectPath;
  }

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return projectPath;
    current = parent;
  }
}
