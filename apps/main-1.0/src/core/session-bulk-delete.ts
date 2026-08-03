import type { EnvironmentKind, LiveSession, SessionSource } from "./types";

export type SessionBulkDeleteSkipReason =
  | "not-found"
  | "live"
  | "favorite"
  | "recent"
  | "read-only"
  | "remote-source"
  | "shared-database";

export interface SessionBulkDeleteRequest {
  sessionKeys: string[];
  liveSessionKeys: string[];
  inactiveBefore?: number;
  protectFavorites?: boolean;
  includeOrphanedSubagents?: boolean;
}

export interface SessionBulkDeleteTarget {
  sessionKey: string;
  cascadeRootSessionKey: string;
  orphanedParentSessionId: string | null;
  rawId: string;
  source: SessionSource;
  filePath: string;
  isSubagent: boolean;
  parentSessionId: string | null;
  ancestorRawIds: string[];
  sourceAvailable: boolean;
  favorited: boolean;
  lastActivityAt: number;
  environmentId: string;
  environmentKind: EnvironmentKind;
}

export interface SessionBulkDeleteIssue {
  sessionKey: string;
  reason: SessionBulkDeleteSkipReason | "delete-failed";
  message: string;
}

export interface SessionBulkDeletePreview {
  requestedCount: number;
  matchedCount: number;
  expandedCount: number;
  deletableCount: number;
  sourceCounts: Array<{ source: SessionSource; count: number }>;
  skipped: SessionBulkDeleteIssue[];
}

export interface SessionBulkDeleteResult extends SessionBulkDeletePreview {
  deletedSessionKeys: string[];
  failed: SessionBulkDeleteIssue[];
}

export function liveSessionDeleteKey(session: Pick<LiveSession, "family" | "rawId" | "environmentId">): string {
  const familyKey = `${session.family}:${session.rawId}`;
  return session.environmentId ? `${session.environmentId}\0${familyKey}` : familyKey;
}
