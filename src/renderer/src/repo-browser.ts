import type { ProjectGroupingMode, ProjectSummary, SessionSearchResult } from "../../core/types";
import { localize, type LanguageMode } from "./language";

export interface RepoBrowserDirectory {
  key: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  segments: string[];
  sessionCount: number;
}

export interface RepoBrowserState {
  directories: RepoBrowserDirectory[];
  sessions: SessionSearchResult[];
}

export function normalizeDisplayPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function joinProjectPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const trimmedRoot = rootPath.replace(/[\\/]+$/, "");
  const childPath = relativePath.split("/").filter(Boolean).join(separator);
  return childPath ? `${trimmedRoot}${separator}${childPath}` : trimmedRoot;
}

function comparablePathKey(value: string): string {
  const normalized = normalizeDisplayPath(value);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function toRelativeProjectPath(projectPath: string, rootPath: string): string | null {
  const normalizedProjectPath = normalizeDisplayPath(projectPath);
  const normalizedRootPath = normalizeDisplayPath(rootPath);
  const projectKey = comparablePathKey(projectPath);
  const rootKey = comparablePathKey(rootPath);
  if (!normalizedProjectPath || !normalizedRootPath) return null;
  if (projectKey === rootKey) return "";
  if (!projectKey.startsWith(rootKey)) return null;
  if (normalizedProjectPath.charAt(normalizedRootPath.length) !== "/") return null;
  return normalizedProjectPath.slice(normalizedRootPath.length + 1);
}

export function findContainingProjectRoot(projectPath: string, projects: ProjectSummary[]): string | null {
  let match: string | null = null;
  for (const project of projects) {
    const relativePath = toRelativeProjectPath(projectPath, project.path);
    if (relativePath === null) continue;
    if (!match || normalizeDisplayPath(project.path).length > normalizeDisplayPath(match).length) {
      match = project.path;
    }
  }
  return match;
}

export function formatSessionProjectDisplay(
  projectPath: string,
  projects: ProjectSummary[],
  projectGrouping: ProjectGroupingMode,
  language: LanguageMode,
): string {
  if (!projectPath) return "";
  if (projectGrouping !== "repo") return projectPath;
  const repoRoot = findContainingProjectRoot(projectPath, projects);
  if (!repoRoot) return projectPath;
  const relativePath = toRelativeProjectPath(projectPath, repoRoot);
  if (relativePath === null) return projectPath;
  if (!relativePath) return localize(language, "Repository root", "仓库根目录");
  return relativePath;
}

function splitRelativeSegments(relativePath: string): string[] {
  if (!relativePath) return [];
  return relativePath.split("/").filter(Boolean);
}

function hasSegmentPrefix(segments: string[], prefix: string[]): boolean {
  if (prefix.length > segments.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (segments[index] !== prefix[index]) return false;
  }
  return true;
}

export function buildRepoBrowser(
  sessions: SessionSearchResult[],
  repoRoot: string,
  currentSegments: string[],
): RepoBrowserState {
  const directories = new Map<string, RepoBrowserDirectory>();
  const currentSessions: SessionSearchResult[] = [];

  for (const session of sessions) {
    const relativePath = toRelativeProjectPath(session.projectPath, repoRoot);
    if (relativePath === null) continue;
    const segments = splitRelativeSegments(relativePath);
    if (!hasSegmentPrefix(segments, currentSegments)) continue;

    if (segments.length === currentSegments.length) {
      currentSessions.push(session);
      continue;
    }

    const nextSegments = segments.slice(0, currentSegments.length + 1);
    const key = nextSegments.join("/");
    const existing = directories.get(key);
    if (existing) {
      existing.sessionCount += 1;
      continue;
    }

    directories.set(key, {
      key,
      name: nextSegments[nextSegments.length - 1],
      absolutePath: joinProjectPath(repoRoot, key),
      relativePath: key,
      segments: nextSegments,
      sessionCount: 1,
    });
  }

  return {
    directories: [...directories.values()].sort((a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name)),
    sessions: currentSessions,
  };
}
