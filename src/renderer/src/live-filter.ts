import type { SessionSource } from "../../core/types";

export type LiveSessionState = "open" | "closed" | "unknown";
export type LiveStatusFilter = "all" | "open" | "closed";

export interface LiveFilterableSession {
  source: SessionSource;
  rawId: string;
}

export function liveSessionKeyForSession(session: LiveFilterableSession): string {
  const family = session.source.startsWith("claude") ? "claude" : session.source.startsWith("codex") ? "codex" : "codebuddy";
  return `${family}:${session.rawId}`;
}

export function getLiveSessionState(session: LiveFilterableSession, liveSessionKeys: Set<string>, liveDetectionFailed: boolean): LiveSessionState {
  if (liveDetectionFailed) return "unknown";
  return liveSessionKeys.has(liveSessionKeyForSession(session)) ? "open" : "closed";
}

export function filterSessionsByLiveStatus<T extends LiveFilterableSession>(
  sessions: T[],
  liveSessionKeys: Set<string>,
  filter: LiveStatusFilter,
  liveDetectionFailed: boolean,
): T[] {
  if (filter === "all") return sessions;
  return sessions.filter((session) => getLiveSessionState(session, liveSessionKeys, liveDetectionFailed) === filter);
}

export function liveStateLabel(state: LiveSessionState): string {
  if (state === "open") return "Open";
  if (state === "closed") return "Closed";
  return "Unknown";
}
