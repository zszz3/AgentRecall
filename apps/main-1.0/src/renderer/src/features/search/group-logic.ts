import { codexTaskWorkspaceDate } from "../../../../core/project-identity";
import { sessionSourceDescriptor } from "../../../../core/session-sources";
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

export function groupSessions<T extends GroupableSession>(sessions: T[], mode: GroupMode, now = Date.now()): Array<SessionGroup<T>> {
  if (mode === "flat") {
    return sessions.length > 0 ? [{ key: "all", sessions }] : [];
  }
  const keyOf =
    mode === "project"
      ? projectGroupKey
      : mode === "source"
        ? (session: T) => session.source
        : (session: T) => timeBucket(session.timestamp, now);

  const map = new Map<string, T[]>();
  for (const session of sessions) {
    const key = keyOf(session);
    const bucket = map.get(key) ?? [];
    bucket.push(session);
    map.set(key, bucket);
  }

  return [...map.entries()]
    .map(([key, grouped]) => ({ key, sessions: grouped }))
    .sort((a, b) => compareGroups(a, b, mode));
}

export function isNoProjectGroupKey(key: string): boolean {
  return key.startsWith(NO_PROJECT_GROUP_PREFIX);
}

function projectGroupKey(session: GroupableSession): string {
  const sourceFamily = sessionSourceDescriptor(session.source).family;
  const isCodexTaskWorkspace = sourceFamily === "codex"
    && codexTaskWorkspaceDate(session.projectPath) !== null;
  return !session.projectPath || isCodexTaskWorkspace
    ? `${NO_PROJECT_GROUP_PREFIX}${sourceFamily}`
    : session.projectPath;
}

function compareGroups<T extends GroupableSession>(a: SessionGroup<T>, b: SessionGroup<T>, mode: GroupMode): number {
  if (mode === "time") {
    return timeBucketOrder(a.key) - timeBucketOrder(b.key);
  }
  // For project and source, order groups by their most recent session (newest first).
  const aLatest = latestTimestamp(a.sessions);
  const bLatest = latestTimestamp(b.sessions);
  return bLatest - aLatest;
}

function latestTimestamp(sessions: GroupableSession[]): number {
  return sessions.reduce((max, session) => Math.max(max, session.timestamp), 0);
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
