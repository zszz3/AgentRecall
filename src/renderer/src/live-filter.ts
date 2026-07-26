import type { SessionSource } from "../../core/types";
import { sessionSourceDescriptor } from "../../core/session-sources";

export type LiveSessionState = "open" | "closed";
export type LiveStatusFilter = "all" | "open" | "closed";

export interface LiveFilterableSession {
  source: SessionSource;
  rawId: string;
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
