import type { SessionSource } from "../../core/types";

export type LiveSessionState = "open" | "closed";
export type LiveStatusFilter = "all" | "open" | "closed";

export interface LiveFilterableSession {
  source: SessionSource;
  rawId: string;
}

export function liveSessionKeyForSession(session: LiveFilterableSession): string | null {
  const family = session.source.startsWith("claude")
    ? "claude"
    : session.source.startsWith("codex")
      ? "codex"
      : session.source === "codebuddy-cli"
        ? "codebuddy"
        : session.source === "codewiz-cli"
          ? "codewiz"
        : session.source === "trae"
          ? "trae"
          : null;
  if (!family) return null;
  return `${family}:${session.rawId}`;
}

export function getLiveSessionState(session: LiveFilterableSession, liveSessionKeys: Set<string>, liveDetectionFailed: boolean): LiveSessionState {
  if (liveDetectionFailed) return "closed";
  const liveKey = liveSessionKeyForSession(session);
  if (!liveKey) return "closed";
  return liveSessionKeys.has(liveKey) ? "open" : "closed";
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
  return state === "open" ? "Open" : "Closed";
}
