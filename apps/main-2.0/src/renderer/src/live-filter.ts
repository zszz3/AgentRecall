import type { SessionSource } from "../../core/types";
import { sessionSourceDescriptor } from "../../core/session-sources";
import { LIVE_SESSION_INACTIVITY_TIMEOUT_MS } from "../../core/refresh-policy";

export type LiveSessionState = "open" | "closed";
export type LiveStatusFilter = "all" | "open" | "closed";

export interface LiveFilterableSession {
  source: SessionSource;
  rawId: string;
  lastActivityAt: number;
}

export function liveSessionKeyForSession(session: LiveFilterableSession): string | null {
  const family = sessionSourceDescriptor(session.source).liveFamily;
  if (!family) return null;
  return `${family}:${session.rawId}`;
}

export function getLiveSessionState(session: LiveFilterableSession, liveSessionKeys: Set<string>, liveDetectionFailed: boolean): LiveSessionState {
  if (liveDetectionFailed) return "closed";
  const liveKey = liveSessionKeyForSession(session);
  if (!liveKey) return "closed";
  if (!liveSessionKeys.has(liveKey)) return "closed";
  const activeAfter = Date.now() - LIVE_SESSION_INACTIVITY_TIMEOUT_MS;
  return Number.isFinite(session.lastActivityAt) && session.lastActivityAt > activeAfter ? "open" : "closed";
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
