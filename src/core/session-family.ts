import type { SessionStoreDatabase } from "./store/database";
import type { SessionSource } from "./types";

const MAX_FAMILY_DEPTH = 12;
const MAX_FAMILY_NODES = 200;

export interface SubagentSessionSummary {
  sessionKey: string;
  rawId: string;
  title: string;
  source: SessionSource;
  environmentId: string;
  environmentLabel: string;
  messageCount: number;
  lastActivityAt: number;
  aiSummary: string | null;
}

export interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

export interface SessionFamily {
  parent: SubagentSessionSummary | null;
  children: SubagentSessionNode[];
  truncated: boolean;
}

interface SessionFamilyRow {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_label: string | null;
  custom_title: string | null;
  original_title: string;
  first_question: string;
  message_count: number;
  last_activity_at: number;
  ai_summary: string | null;
  parent_session_id: string | null;
}

const EMPTY_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

export function findSessionFamily(
  db: SessionStoreDatabase,
  sessionKey: string,
): SessionFamily {
  const target = db.prepare(`
    SELECT session_key, raw_id, source, environment_id, parent_session_id
    FROM sessions
    WHERE session_key = ?
  `).get(sessionKey) as Pick<
    SessionFamilyRow,
    "session_key" | "raw_id" | "source" | "environment_id" | "parent_session_id"
  > | undefined;
  if (!target) return EMPTY_FAMILY;

  const rows = db.prepare(`
    SELECT
      sessions.session_key,
      sessions.raw_id,
      sessions.source,
      sessions.environment_id,
      environments.label AS environment_label,
      sessions.custom_title,
      sessions.original_title,
      sessions.first_question,
      sessions.message_count,
      sessions.ai_summary,
      sessions.parent_session_id,
      COALESCE(
        (
          SELECT MAX(message_events.timestamp)
          FROM message_events
          WHERE message_events.session_key = sessions.session_key
        ),
        (
          SELECT MAX(CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000)
          FROM messages
          WHERE messages.session_key = sessions.session_key
        ),
        CASE
          WHEN sessions.file_mtime_ms > 0 THEN sessions.file_mtime_ms
          ELSE sessions.timestamp
        END,
        0
      ) AS last_activity_at
    FROM sessions
    LEFT JOIN environments ON environments.id = sessions.environment_id
    WHERE sessions.source = ?
      AND sessions.environment_id = ?
      AND sessions.hidden = 0
  `).all(target.source, target.environment_id) as unknown as SessionFamilyRow[];

  rows.sort(compareRows);
  const rowsByRawId = new Map<string, SessionFamilyRow>();
  const childrenByParentId = new Map<string, SessionFamilyRow[]>();
  for (const row of rows) {
    if (!rowsByRawId.has(row.raw_id)) rowsByRawId.set(row.raw_id, row);
    if (!row.parent_session_id) continue;
    const children = childrenByParentId.get(row.parent_session_id) ?? [];
    children.push(row);
    childrenByParentId.set(row.parent_session_id, children);
  }

  let truncated = false;
  let nodeCount = 0;
  const buildChildren = (
    parentRawId: string,
    depth: number,
    path: ReadonlySet<string>,
  ): SubagentSessionNode[] => {
    const candidates = childrenByParentId.get(parentRawId) ?? [];
    if (depth >= MAX_FAMILY_DEPTH) {
      if (candidates.length > 0) truncated = true;
      return [];
    }
    const children: SubagentSessionNode[] = [];
    for (const candidate of candidates) {
      if (path.has(candidate.raw_id)) {
        truncated = true;
        continue;
      }
      if (nodeCount >= MAX_FAMILY_NODES) {
        truncated = true;
        break;
      }
      nodeCount += 1;
      const nextPath = new Set(path);
      nextPath.add(candidate.raw_id);
      children.push({
        ...summaryFrom(candidate),
        children: buildChildren(candidate.raw_id, depth + 1, nextPath),
      });
    }
    return children;
  };

  const parentRow = target.parent_session_id
    ? rowsByRawId.get(target.parent_session_id) ?? null
    : null;
  return {
    parent: parentRow ? summaryFrom(parentRow) : null,
    children: buildChildren(target.raw_id, 0, new Set([target.raw_id])),
    truncated,
  };
}

function summaryFrom(row: SessionFamilyRow): SubagentSessionSummary {
  return {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    title: row.custom_title || row.original_title || row.first_question || "Untitled Session",
    source: row.source,
    environmentId: row.environment_id,
    environmentLabel: row.environment_label || (row.environment_id === "local" ? "Local" : row.environment_id),
    messageCount: row.message_count,
    lastActivityAt: row.last_activity_at,
    aiSummary: row.ai_summary?.trim() || null,
  };
}

function compareRows(left: SessionFamilyRow, right: SessionFamilyRow): number {
  return left.last_activity_at - right.last_activity_at
    || sessionTitle(left).localeCompare(sessionTitle(right))
    || left.session_key.localeCompare(right.session_key);
}

function sessionTitle(row: SessionFamilyRow): string {
  return (row.custom_title || row.original_title || row.first_question || "Untitled Session").toLocaleLowerCase();
}
