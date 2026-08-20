import type { EnvironmentKind, SessionEnvironment, SessionSource } from "./types";

export interface SessionEnvironmentIdentity {
  environmentKind: EnvironmentKind;
  environmentId: string;
  sourceAvailable?: boolean;
  source?: SessionSource;
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
  return session.source !== "pi-cli"
    && session.source !== "workbuddy-cli"
    && session.source !== "kimi-cli"
    && (session.environmentKind !== "ssh" || session.sourceAvailable === false);
}

/** Sources whose filePath points at a multi-session SQLite database, not a single-session file. */
export function isSharedSessionSourceDatabase(
  session: Pick<SessionEnvironmentIdentity, "source"> & { filePath?: string | null },
): boolean {
  const source = session.source;
  const filePath = session.filePath ?? "";
  if (source === "hermes" || source === "opencode-cli" || source === "codewiz-cli") return true;
  return source === "cursor-agent" && /(^|[\\/])state\.vscdb$/i.test(filePath);
}

export function remoteSessionKey(environment: SessionEnvironment, source: SessionSource | "codewiz", rawId: string): string {
  if (environment.kind !== "ssh" && environment.kind !== "wsl") {
    throw new Error("Remote session key requires an SSH or WSL environment.");
  }
  return `${environment.kind}:${environment.id}:${source}:${rawId}`;
}
