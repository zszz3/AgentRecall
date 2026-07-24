import { createHash } from "node:crypto";
import path from "node:path";

export const OPENVIKING_ACCOUNT_ID = "agent-recall";
export const OPENVIKING_LOCAL_EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5";

export type OpenVikingEmbeddingMode = "local" | "remote";
export type OpenVikingIntegration = "claude" | "codex" | "opencode";
export type OpenVikingRuntimeState =
  | "not-installed"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "error";
export type OpenVikingImportState = "idle" | "queued" | "running" | "paused" | "failed" | "completed";
export type OpenVikingRuntimeInstallPhase =
  | "resolving-runtime"
  | "downloading-python"
  | "building-runtime"
  | "packaging-runtime"
  | "downloading-runtime"
  | "verifying-runtime"
  | "installing-runtime";

export interface OpenVikingRuntimeInstallProgress {
  phase: OpenVikingRuntimeInstallPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

export interface OpenVikingWorkspace {
  id: string;
  userId: string;
  rootPath: string;
  identity: string;
  displayName: string;
  managed: boolean;
  importState: OpenVikingImportState;
  importedTurns: number;
  totalTurns: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenVikingMemoryItem {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
  source?: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface OpenVikingRuntimeStatus {
  state: OpenVikingRuntimeState;
  version?: string;
  port?: number;
  progress?: OpenVikingRuntimeInstallProgress;
  error?: string;
}

export interface OpenVikingModelStatus {
  model: typeof OPENVIKING_LOCAL_EMBEDDING_MODEL;
  installed: boolean;
  downloading?: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface OpenVikingMemorySnapshot {
  runtime: OpenVikingRuntimeStatus;
  model: OpenVikingModelStatus;
  workspaces: OpenVikingWorkspace[];
}

export interface ImportTurnFingerprintInput {
  source: string;
  sessionId: string;
  turnIndex: number;
  user: string;
  assistant: string;
}

export function workspaceUserId(identity: string): string {
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity) throw new Error("Workspace identity is required.");
  return `workspace_${sha256(normalizedIdentity).slice(0, 24)}`;
}

export function normalizeWorkspacePath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (rootPath.includes("\0")) throw new Error("Workspace path cannot contain NUL characters.");
  const normalized = (platform === "win32" ? path.win32 : path.posix).resolve(rootPath.trim());
  if (!normalized) throw new Error("Workspace path is required.");
  return normalized;
}

export function importTurnFingerprint(input: ImportTurnFingerprintInput): string {
  return sha256(JSON.stringify([
    input.source,
    input.sessionId,
    input.turnIndex,
    input.user,
    input.assistant,
  ]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
