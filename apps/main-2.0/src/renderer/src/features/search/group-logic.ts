import { codexTaskWorkspaceDate } from "../../../../core/project-identity";
import { isSessionSource, sessionSourceDescriptor } from "../../../../core/session-sources";
import type { SessionSource } from "../../../../core/types";

export type GroupMode = "flat" | "project" | "source" | "time";

export interface GroupableSession {
  sessionKey: string;
  source: SessionSource;
  projectPath: string;
  timestamp: number;
}

export interface SessionGroup<T extends GroupableSession = GroupableSession> {
  key: string;
  sessions: T[];
}

export const GROUP_MODES: GroupMode[] = ["flat", "project", "source", "time"];
const NO_PROJECT_GROUP_PREFIX = "agent-recall:no-project:";

/**
 * `timeOf` names the time a Session is filed and ordered by; it must be the time
 * its row shows, or a Session started last week but active today would land
 * under "this week" while reading "10 minutes ago".
 */
export function groupSessions<T extends GroupableSession>(
  sessions: T[],
  mode: GroupMode,
  now = Date.now(),
  timeOf: (session: T) => number = (session) => session.timestamp,
): Array<SessionGroup<T>> {
  if (mode === "flat") {
    return sessions.length > 0 ? [{ key: "all", sessions }] : [];
  }
  const keyOf =
    mode === "project"
      ? projectGroupKey
      : mode === "source"
        ? (session: T) => session.source
        : (session: T) => timeBucket(timeOf(session), now);

  const map = new Map<string, T[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    const bucket = map.get(key) ?? [];
    bucket.push(session);
    map.set(key, bucket);
  }

  return [...map.entries()]
    .map(([key, grouped]) => ({ key, sessions: grouped }))
    .sort((a, b) => compareGroups(a, b, mode, timeOf));
}

export function isNoProjectGroupKey(key: string): boolean {
  return key.startsWith(NO_PROJECT_GROUP_PREFIX);
}

function projectGroupKey(session: GroupableSession): string {
  const sourceFamily = isSessionSource(session.source)
    ? sessionSourceDescriptor(session.source).family
    : String(session.source);
  const isCodexTaskWorkspace = sourceFamily === "codex"
    && codexTaskWorkspaceDate(session.projectPath) !== null;
  return !session.projectPath || isCodexTaskWorkspace
    ? `${NO_PROJECT_GROUP_PREFIX}${sourceFamily}`
    : session.projectPath;
}

function compareGroups<T extends GroupableSession>(
  a: SessionGroup<T>,
  b: SessionGroup<T>,
  mode: GroupMode,
  timeOf: (session: T) => number,
): number {
  if (mode === "time") {
    return timeBucketOrder(a.key) - timeBucketOrder(b.key);
  }
  // For project and source, order groups by their most recent session (newest first).
  const latest = (group: SessionGroup<T>): number =>
    group.sessions.reduce((max, session) => Math.max(max, timeOf(session)), 0);
  return latest(b) - latest(a);
}

export const TIME_BUCKETS = ["today", "yesterday", "thisWeek", "older"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export function timeBucket(timestamp: number, now = Date.now()): TimeBucket {
  const startOfToday = startOfDay(now);
  if (timestamp >= startOfToday) return "today";
  if (timestamp >= startOfToday - DAY_MS) return "yesterday";
  if (timestamp >= startOfToday - 6 * DAY_MS) return "thisWeek";
  return "older";
}

function timeBucketOrder(bucket: string): number {
  const index = TIME_BUCKETS.indexOf(bucket as TimeBucket);
  return index === -1 ? TIME_BUCKETS.length : index;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
