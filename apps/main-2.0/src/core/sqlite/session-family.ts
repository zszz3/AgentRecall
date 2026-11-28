import type { SessionFamily, SubagentSessionNode, SubagentSessionSummary } from "../session-family";
import type { SessionSource } from "../types";
import type { SqliteDatabase } from "./database";
import { SQLITE_SESSION_ACTIVITY_SQL, timeValue } from "./session-records";

const MAX_FAMILY_DEPTH = 12;
const MAX_FAMILY_NODES = 200;

interface SqliteSessionFamilyRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_label: string | null;
  custom_title: string | null;
  original_title: string;
  first_question: string;
  message_count: number;
  last_activity_at: number | string;
  ai_summary: string | null;
  parent_session_id: string | null;
  origin_turn_index: number | string | null;
}

const EMPTY_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

export async function findSqliteSessionFamily(
  database: SqliteDatabase,
  sessionKey: string,
): Promise<SessionFamily> {
  const target = database.get<Pick<
    SqliteSessionFamilyRow,
    "session_key" | "raw_id" | "source" | "environment_id" | "parent_session_id"
  >>(
    `
      select session_key, raw_id, source, environment_id, parent_session_id
      from local_sessions sessions
      where session_key = ?
    `,
    sessionKey,
  );
  if (!target) return EMPTY_FAMILY;

  const rows = database.all<SqliteSessionFamilyRow>(
    `
      with recursive family_descendants as (
        select session_key, raw_id, parent_session_id
        from local_sessions sessions
        where session_key = ?
        union
        select child.session_key, child.raw_id, child.parent_session_id
        from local_sessions child
        inner join family_descendants ancestor
          on child.parent_session_id = ancestor.raw_id
        where child.source = ?
          and child.environment_id = ?
          and child.hidden = 0
      ), family_parent as (
        select parent.session_key
        from local_sessions target
        inner join local_sessions parent
          on parent.raw_id = target.parent_session_id
          and parent.source = target.source
          and parent.environment_id = target.environment_id
        where target.session_key = ?
      ), family_scope as (
        select session_key from family_descendants
        union
        select session_key from family_parent
      ), visible_parent_turns as (
        select
          turns.*,
          row_number() over (
            partition by turns.session_key
            order by turns.turn_index
          ) - 1 as visible_turn_index
        from session_turns turns
        where turns.session_key in (select session_key from family_scope)
          and (
            turns.synthetic = 0
            or exists (
              select 1
              from trace_spans trigger_spans
              where trigger_spans.turn_id = turns.id
                and json_extract(trigger_spans.attributes, '$.eventType') = 'codex.collaboration.message'
                and json_extract(trigger_spans.attributes, '$.collaboration.triggerTurn') in (1, 'true')
            )
          )
      ), ranked_spawn_events as (
        select
          child_sessions.session_key,
          parent_sessions.session_key as parent_session_key,
          spawn_turns.turn_index as spawn_turn_index,
          spans.turn_id as spawn_turn_id,
          spans.span_index as spawn_span_index,
          spans.started_at as spawned_at,
          row_number() over (
            partition by child_sessions.session_key
            order by spawn_turns.turn_index, spans.span_index
          ) as spawn_rank
        from local_sessions child_sessions
        join family_descendants child_scope
          on child_scope.session_key = child_sessions.session_key
        join local_sessions parent_sessions
          on parent_sessions.raw_id = child_sessions.parent_session_id
          and parent_sessions.source = child_sessions.source
          and parent_sessions.environment_id = child_sessions.environment_id
        join session_turns spawn_turns
          on spawn_turns.session_key = parent_sessions.session_key
        join trace_spans spans
          on spans.turn_id = spawn_turns.id
        where child_sessions.source = ?
          and child_sessions.environment_id = ?
          and (
            (
              json_extract(spans.attributes, '$.eventType') = 'codex.collaboration.activity'
              and json_extract(spans.attributes, '$.collaboration.kind') = 'started'
              and json_extract(spans.attributes, '$.collaboration.agentThreadId') = child_sessions.raw_id
            )
            or (
              (
                json_extract(spans.attributes, '$.collaboration.tool') = 'spawn_agent'
                or json_extract(spans.attributes, '$.codex.rawType') like 'collab_spawn%'
              )
              and (
                json_extract(spans.attributes, '$.collaboration.newThreadId') = child_sessions.raw_id
                or json_extract(spans.attributes, '$.collaboration.receiverThreadId') = child_sessions.raw_id
                or (
                  json_type(spans.attributes, '$.collaboration.receiverThreadIds') = 'array'
                  and exists (
                    select 1
                    from json_each(spans.attributes, '$.collaboration.receiverThreadIds') receiver
                    where receiver.value = child_sessions.raw_id
                  )
                )
              )
            )
          )
      ), spawn_events as (
        select
          session_key,
          parent_session_key,
          spawn_turn_index,
          spawn_turn_id,
          spawn_span_index,
          spawned_at
        from ranked_spawn_events
        where spawn_rank = 1
      ), spawn_origins as (
        select
          spawn_events.session_key,
          coalesce(
            exact_turn.visible_turn_index,
            (
              select candidate_turn.visible_turn_index
              from visible_parent_turns candidate_turn
              where candidate_turn.session_key = spawn_events.parent_session_key
                and candidate_turn.started_at <= spawn_events.spawned_at
              order by candidate_turn.started_at desc, candidate_turn.turn_index desc
              limit 1
            )
          ) as origin_turn_index
        from spawn_events
        left join visible_parent_turns exact_turn
          on exact_turn.id = spawn_events.spawn_turn_id
      )
      select
        sessions.session_key,
        sessions.raw_id,
        sessions.source,
        sessions.environment_id,
        environments.label as environment_label,
        sessions.custom_title,
        sessions.original_title,
        sessions.first_question,
        sessions.message_count,
        sessions.ai_summary,
        sessions.parent_session_id,
        origin.origin_turn_index,
        ${SQLITE_SESSION_ACTIVITY_SQL} as last_activity_at
      from local_sessions sessions
      left join environments on environments.id = sessions.environment_id
      left join spawn_origins origin on origin.session_key = sessions.session_key
      where sessions.source = ?
        and sessions.environment_id = ?
        and sessions.hidden = 0
    `,
    target.session_key,
    target.source,
    target.environment_id,
    target.session_key,
    target.source,
    target.environment_id,
    target.source,
    target.environment_id,
  );

  rows.sort(compareRows);
  const rowsByRawId = new Map<string, SqliteSessionFamilyRow>();
  const childrenByParentId = new Map<string, SqliteSessionFamilyRow[]>();
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
    parent: parentRow ? summaryFrom(parentRow, false) : null,
    parentOriginTurnIndex: nullableTurnIndex(
      rows.find((row) => row.session_key === target.session_key)?.origin_turn_index,
    ),
    children: buildChildren(target.raw_id, 0, new Set([target.raw_id])),
    truncated,
  };
}

function summaryFrom(row: SqliteSessionFamilyRow, includeOrigin = true): SubagentSessionSummary {
  return {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    title: row.custom_title || row.original_title || row.first_question || "Untitled Session",
    source: row.source,
    environmentId: row.environment_id,
    environmentLabel: row.environment_label || (row.environment_id === "local" ? "Local" : row.environment_id),
    messageCount: Number(row.message_count),
    lastActivityAt: Math.max(0, timeValue(row.last_activity_at)),
    aiSummary: row.ai_summary?.trim() || null,
    originTurnIndex: includeOrigin ? nullableTurnIndex(row.origin_turn_index) : null,
  };
}

function nullableTurnIndex(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function compareRows(left: SqliteSessionFamilyRow, right: SqliteSessionFamilyRow): number {
  return timeValue(left.last_activity_at) - timeValue(right.last_activity_at)
    || sessionTitle(left).localeCompare(sessionTitle(right))
    || left.session_key.localeCompare(right.session_key);
}

function sessionTitle(row: SqliteSessionFamilyRow): string {
  return (row.custom_title || row.original_title || row.first_question || "Untitled Session").toLocaleLowerCase();
}
