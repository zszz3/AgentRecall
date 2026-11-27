import type { EnvironmentKind, SessionEnvironment, SessionSource } from "./types";

export interface SessionEnvironmentIdentity {
  environmentKind: EnvironmentKind;
  environmentId: string;
  sourceAvailable?: boolean;
  source?: SessionSource;
  filePath?: string | null;
}

export interface SessionStorageIdentity {
  environmentId: string;
  storageEnvironmentId?: string;
}

export function isLocalSessionEnvironment(session: SessionEnvironmentIdentity): boolean {
  return session.environmentKind === "local" && session.environmentId === "local";
}

export function isLocalSessionStorage(session: SessionStorageIdentity): boolean {
  return (session.storageEnvironmentId ?? session.environmentId) === "local";
}

export function canDeleteSessionLocally(session: SessionEnvironmentIdentity): boolean {
  return !isCodexSqliteSession(session)
    && session.source !== "workbuddy-cli"
    && session.source !== "kimi-cli"
    && session.source !== "qwen-code"
    && session.source !== "gemini-cli"
    && session.source !== "antigravity"
    && session.source !== "antigravity-cli"
    && (session.environmentKind !== "ssh" || session.sourceAvailable === false);
}

/** Codex projections share one source database across all paginated threads. */
export function isCodexSqliteSession(session: Pick<SessionEnvironmentIdentity, "source" | "filePath">): boolean {
  return ["codex-cli", "codex-app", "tcodex-cli", "stepcode-codex"].includes(session.source ?? "")
    && /(?:^|[\\/])thread_history_1\.sqlite$/iu.test(session.filePath ?? "");
}

/** Sources whose filePath points at a multi-session SQLite database, not a single-session file. */
export function isSharedSessionSourceDatabase(
  session: Pick<SessionEnvironmentIdentity, "source"> & { filePath?: string | null },
): boolean {
  const source = session.source;
  const filePath = session.filePath ?? "";
  if (isCodexSqliteSession(session) || source === "hermes" || source === "opencode-cli" || source === "codewiz-cli") return true;
  return source === "cursor-agent" && /(^|[\\/])state\.vscdb$/i.test(filePath);
}

export function remoteSessionKey(environment: SessionEnvironment, source: SessionSource | "codewiz", rawId: string): string {
  if (environment.kind !== "ssh" && environment.kind !== "wsl") {
    throw new Error("Remote session key requires an SSH or WSL environment.");
  }
  return `${environment.kind}:${environment.id}:${source}:${rawId}`;
}
