import type { EnvironmentKind, SessionEnvironment, SessionSource } from "./types";

export interface SessionEnvironmentIdentity {
  environmentKind: EnvironmentKind;
  environmentId: string;
}

export function isLocalSessionEnvironment(session: SessionEnvironmentIdentity): boolean {
  return session.environmentKind === "local" && session.environmentId === "local";
}

export function remoteSessionKey(environment: SessionEnvironment, source: SessionSource | "codewiz", rawId: string): string {
  if (environment.kind !== "ssh" && environment.kind !== "wsl") {
    throw new Error("Remote session key requires an SSH or WSL environment.");
  }
  return `${environment.kind}:${environment.id}:${source}:${rawId}`;
}
