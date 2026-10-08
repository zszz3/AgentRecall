import type { PostgresDatabase } from "./postgres/database";
import { SESSION_ACTIVITY_SQL } from "./postgres/session-records";
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
  originTurnIndex?: number | null;
}

export interface SubagentSessionNode extends SubagentSessionSummary {
  children: SubagentSessionNode[];
}

export interface SessionFamily {
  parent: SubagentSessionSummary | null;
  parentOriginTurnIndex?: number | null;
  children: SubagentSessionNode[];
  truncated: boolean;
}

interface SessionFamilyRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_label: string | null;
  custom_title: string | null;
  original_title: string;
  first_question: string;
  message_count: number;
  last_activity_at: Date | string;
  ai_summary: string | null;
  parent_session_id: string | null;
  origin_turn_index: number | string | null;
}

const EMPTY_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

export async function findSessionFamily(
  database: PostgresDatabase,
  sessionKey: string,
): Promise<SessionFamily> {
  const targetResult = await database.query<Pick<
    SessionFamilyRow,
    "session_key" | "raw_id" | "source" | "environment_id" | "parent_session_id"
  >>(`
    select session_key, raw_id, source, environment_id, parent_session_id
    from agent_recall.local_sessions sessions
    where session_key = $1
  `, [sessionKey]);
  const target = targetResult.rows[0];
  if (!target) return EMPTY_FAMILY;

  const rowsResult = await database.query<SessionFamilyRow>(`
    with recursive family_descendants as (
      select session_key, raw_id, parent_session_id
      from agent_recall.local_sessions sessions
      where session_key = $3
      union
      select child.session_key, child.raw_id, child.parent_session_id
      from agent_recall.local_sessions child
      inner join family_descendants ancestor
        on child.parent_session_id = ancestor.raw_id
      where child.source = $1
        and child.environment_id = $2
        and child.hidden = false
    ), family_parent as (
      select parent.session_key
      from agent_recall.local_sessions target
      inner join agent_recall.local_sessions parent
        on parent.raw_id = target.parent_session_id
        and parent.source = target.source
        and parent.environment_id = target.environment_id
      where target.session_key = $3
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
      from agent_recall.session_turns turns
      where turns.session_key in (select session_key from family_scope)
        and (
          turns.synthetic = false
          or exists (
            select 1
            from agent_recall.trace_spans trigger_spans
            where trigger_spans.turn_id = turns.id
              and trigger_spans.attributes #>> '{eventType}' = 'codex.collaboration.message'
              and trigger_spans.attributes #>> '{collaboration,triggerTurn}' = 'true'
          )
        )
    ), spawn_events as (
      select distinct on (child_sessions.session_key)
        child_sessions.session_key,
        parent_sessions.session_key as parent_session_key,
        spawn_turns.turn_index as spawn_turn_index,
        spans.turn_id as spawn_turn_id,
        spans.span_index as spawn_span_index,
        spans.started_at as spawned_at
      from agent_recall.local_sessions child_sessions
      join family_descendants child_scope
        on child_scope.session_key = child_sessions.session_key
      join agent_recall.local_sessions parent_sessions
        on parent_sessions.raw_id = child_sessions.parent_session_id
        and parent_sessions.source = child_sessions.source
        and parent_sessions.environment_id = child_sessions.environment_id
      join agent_recall.session_turns spawn_turns
        on spawn_turns.session_key = parent_sessions.session_key
      join agent_recall.trace_spans spans
        on spans.turn_id = spawn_turns.id
      where child_sessions.source = $1
        and child_sessions.environment_id = $2
        and (
          (
            spans.attributes #>> '{eventType}' = 'codex.collaboration.activity'
            and spans.attributes #>> '{collaboration,kind}' = 'started'
            and spans.attributes #>> '{collaboration,agentThreadId}' = child_sessions.raw_id
          )
          or (
            (
              spans.attributes #>> '{collaboration,tool}' = 'spawn_agent'
              or spans.attributes #>> '{codex,rawType}' like 'collab_spawn%'
            )
            and (
              spans.attributes #>> '{collaboration,newThreadId}' = child_sessions.raw_id
              or spans.attributes #>> '{collaboration,receiverThreadId}' = child_sessions.raw_id
              or (spans.attributes #> '{collaboration,receiverThreadIds}')
                @> jsonb_build_array(child_sessions.raw_id)
            )
          )
        )
      order by child_sessions.session_key, spawn_turns.turn_index, spans.span_index
    ), spawn_origins as (
      select
        spawn_events.session_key,
        coalesce(exact_turn.visible_turn_index, fallback_turn.visible_turn_index) as origin_turn_index
      from spawn_events
      left join visible_parent_turns exact_turn
        on exact_turn.id = spawn_events.spawn_turn_id
      left join lateral (
        select candidate_turn.visible_turn_index
        from visible_parent_turns candidate_turn
        where candidate_turn.session_key = spawn_events.parent_session_key
          and candidate_turn.started_at <= spawn_events.spawned_at
        order by candidate_turn.started_at desc, candidate_turn.turn_index desc
        limit 1
      ) fallback_turn on exact_turn.id is null
    )
    select
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
      origin.origin_turn_index,
      ${SESSION_ACTIVITY_SQL} as last_activity_at
    from agent_recall.local_sessions sessions
    left join agent_recall.environments on environments.id = sessions.environment_id
    left join spawn_origins origin on origin.session_key = sessions.session_key
    where sessions.source = $1
      and sessions.environment_id = $2
      and sessions.hidden = false
  `, [target.source, target.environment_id, target.session_key]);
  const rows = rowsResult.rows;

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
    parent: parentRow ? summaryFrom(parentRow, false) : null,
    parentOriginTurnIndex: nullableTurnIndex(
      rows.find((row) => row.session_key === target.session_key)?.origin_turn_index,
    ),
    children: buildChildren(target.raw_id, 0, new Set([target.raw_id])),
    truncated,
  };
}

function summaryFrom(row: SessionFamilyRow, includeOrigin = true): SubagentSessionSummary {
  return {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    title: row.custom_title || row.original_title || row.first_question || "Untitled Session",
    source: row.source,
    environmentId: row.environment_id,
    environmentLabel: row.environment_label || (row.environment_id === "local" ? "Local" : row.environment_id),
    messageCount: row.message_count,
    lastActivityAt: Math.max(0, new Date(row.last_activity_at).getTime() || 0),
    aiSummary: row.ai_summary?.trim() || null,
    originTurnIndex: includeOrigin ? nullableTurnIndex(row.origin_turn_index) : null,
  };
}

function nullableTurnIndex(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function compareRows(left: SessionFamilyRow, right: SessionFamilyRow): number {
  return new Date(left.last_activity_at).getTime() - new Date(right.last_activity_at).getTime()
    || sessionTitle(left).localeCompare(sessionTitle(right))
    || left.session_key.localeCompare(right.session_key);
}

function sessionTitle(row: SessionFamilyRow): string {
  return (row.custom_title || row.original_title || row.first_question || "Untitled Session").toLocaleLowerCase();
}
