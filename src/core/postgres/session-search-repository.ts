import type {
  SearchOptions,
  SessionMatchHit,
  SessionMessage,
  SessionSearchPage,
  SessionSearchResult,
} from "../types";
import type { PostgresDatabase } from "./database";
import {
  SESSION_ACTIVITY_SQL,
  SESSION_SELECT_SQL,
  escapeLike,
  hydrateSession,
  isoValue,
  numberValue,
  parseSearchClauses,
  searchSnippet,
  searchTerms,
  type SessionRow,
} from "./session-records";

export class PostgresSessionSearchRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async searchSessions(options: SearchOptions = {}): Promise<SessionSearchResult[]> {
    return (await this.searchSessionPage(options)).sessions;
  }

  async searchSessionPage(options: SearchOptions = {}): Promise<SessionSearchPage> {
    const query = options.query?.trim() || "";
    const clauses = parseSearchClauses(query);
    const terms = searchTerms(clauses);
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const filters: string[] = [];

    if (options.visibility === "hidden") filters.push("sessions.hidden = true");
    else if (options.visibility === "favorites") filters.push("sessions.hidden = false and sessions.favorited = true");
    else if (options.visibility === "pinned") filters.push("sessions.hidden = false and sessions.pinned = true");
    else filters.push("sessions.hidden = false");
    if (options.excludeSubagents) filters.push("sessions.is_subagent = false");
    if (options.projectPath) filters.push(`sessions.project_path = ${bind(options.projectPath)}`);
    if (options.environmentId && options.environmentId !== "all") {
      filters.push(`sessions.environment_id = ${bind(options.environmentId)}`);
    }
    if (options.source && options.source !== "all") {
      if (options.source === "claude") {
        filters.push("sessions.source in ('claude-cli', 'claude-app')");
      } else if (options.source === "codex") {
        filters.push("sessions.source in ('codex-cli', 'codex-app')");
      } else {
        filters.push(`sessions.source = ${bind(options.source)}`);
      }
    }
    if (Number.isFinite(options.dateFrom)) {
      filters.push(`${SESSION_ACTIVITY_SQL} >= ${bind(new Date(options.dateFrom as number).toISOString())}`);
    }
    if (Number.isFinite(options.dateTo)) {
      filters.push(`${SESSION_ACTIVITY_SQL} <= ${bind(new Date(options.dateTo as number).toISOString())}`);
    }
    if (options.tag) {
      filters.push(`
        exists (
          select 1
          from agent_recall.session_tags filter_session_tags
          join agent_recall.tags filter_tags on filter_tags.id = filter_session_tags.tag_id
          where filter_session_tags.session_key = sessions.session_key
            and filter_tags.name = ${bind(options.tag)}
        )
      `);
    }
    if (options.liveStatus) {
      const liveKeys = [...new Set(options.liveSessionKeys ?? [])].filter(Boolean);
      if (liveKeys.length === 0 && options.liveStatus === "open") {
        filters.push("false");
      } else if (liveKeys.length > 0) {
        const liveExpression = `
          case
            when sessions.source in ('claude-cli', 'claude-app', 'claude-internal') then 'claude:' || sessions.raw_id
            when sessions.source in ('codex-cli', 'codex-app', 'codex-internal') then 'codex:' || sessions.raw_id
            when sessions.source = 'tclaude-cli' then 'tclaude:' || sessions.raw_id
            when sessions.source = 'tcodex-cli' then 'tcodex:' || sessions.raw_id
            when sessions.source = 'codebuddy-cli' then 'codebuddy:' || sessions.raw_id
            when sessions.source = 'codewiz-cli' then 'codewiz:' || sessions.raw_id
            when sessions.source = 'trae' then 'trae:' || sessions.raw_id
            when sessions.source = 'qoder' then 'qoder:' || sessions.raw_id
            else null
          end
        `;
        const placeholders = liveKeys.map((key) => bind(key)).join(", ");
        filters.push(
          options.liveStatus === "open"
            ? `${liveExpression} in (${placeholders})`
            : `(${liveExpression} is null or ${liveExpression} not in (${placeholders}))`,
        );
      }
    }

    let bestTurnJoin = "";
    if (clauses.length > 0) {
      const patterns = clauses.map((clause) => bind(`%${escapeLike(clause)}%`));
      const turnPredicates = patterns.map((pattern) => `turns.search_text ilike ${pattern} escape '\\'`);
      const metadataText = `
        concat_ws(
          ' ',
          sessions.custom_title,
          sessions.original_title,
          sessions.first_question,
          sessions.project_path,
          sessions.raw_id,
          sessions.ai_summary
        )
      `;
      const metadataPredicates = patterns.map((pattern) => `${metadataText} ilike ${pattern} escape '\\'`);
      bestTurnJoin = `
        left join lateral (
          select
            turns.id,
            turns.turn_index,
            turns.source_message_index,
            turns.started_at,
            turns.search_text,
            count(*) over () as match_count
          from agent_recall.session_turns turns
          where turns.session_key = sessions.session_key
            and ${turnPredicates.join(" and ")}
          order by
            case when turns.user_text ilike ${patterns[0]} escape '\\' then 0 else 1 end,
            turns.turn_index desc
          limit 1
        ) best_turn on true
      `;
      filters.push(`(best_turn.id is not null or (${metadataPredicates.join(" and ")}))`);
    }

    const limit = Math.max(0, options.limit ?? 200);
    const limitPlaceholder = bind(limit);
    const pinnedOrder = options.prioritizePinned === false ? "" : "sessions.pinned desc,";
    const primarySort =
      options.sortBy === "created"
        ? "sessions.started_at desc"
        : clauses.length > 0
          ? "coalesce(best_turn.match_count, 0) desc, last_activity_at desc"
          : "last_activity_at desc";
    const bestTurnColumns = clauses.length > 0
      ? `
        best_turn.id as best_turn_id,
        best_turn.turn_index as best_turn_index,
        best_turn.source_message_index as best_source_message_index,
        best_turn.started_at as best_turn_started_at,
        best_turn.search_text as best_turn_search_text,
        best_turn.match_count as turn_match_count,
      `
      : `
        null::text as best_turn_id,
        null::integer as best_turn_index,
        null::integer as best_source_message_index,
        null::timestamptz as best_turn_started_at,
        null::text as best_turn_search_text,
        null::bigint as turn_match_count,
      `;
    const result = await this.database.query<SessionRow>(
      `
        select
          ${bestTurnColumns}
          ${SESSION_SELECT_SQL},
          count(*) over () as total_count
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        ${bestTurnJoin}
        where ${filters.join(" and ")}
        order by ${pinnedOrder} ${primarySort}, sessions.session_key
        limit ${limitPlaceholder}
      `,
      values,
    );
    const sessions = result.rows.map((row) => hydrateSession(row, terms));
    if (clauses.length > 0) await this.attachMessageHits(sessions, clauses, terms);
    const totalCount = result.rows.length > 0 ? numberValue(result.rows[0].total_count) : 0;
    return {
      sessions,
      totalCount,
      hasMore: totalCount > sessions.length,
    };
  }

  private async attachMessageHits(
    sessions: SessionSearchResult[],
    clauses: readonly string[],
    terms: readonly string[],
  ): Promise<void> {
    if (sessions.length === 0) return;
    const values: unknown[] = [sessions.map((session) => session.sessionKey)];
    const predicates = clauses.map((clause) => {
      values.push(`%${escapeLike(clause)}%`);
      return `messages.content ilike $${values.length} escape '\\'`;
    });
    const result = await this.database.query<{
      session_key: string;
      turn_id: string;
      turn_index: number | string;
      source_message_index: number | string;
      role: SessionMessage["role"];
      content: string;
      occurred_at: Date | string | null;
    }>(
      `
        select
          turns.session_key,
          turns.id as turn_id,
          turns.turn_index,
          messages.source_message_index,
          messages.role,
          messages.content,
          messages.occurred_at
        from agent_recall.turn_messages messages
        join agent_recall.session_turns turns on turns.id = messages.turn_id
        where turns.session_key = any($1::text[])
          and messages.role in ('user', 'assistant')
          and (${predicates.join(" or ")})
        order by turns.session_key, turns.turn_index, messages.message_index
      `,
      values,
    );
    const sessionsByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
    const hitCounts = new Map<string, number>();
    for (const row of result.rows) {
      hitCounts.set(row.session_key, (hitCounts.get(row.session_key) ?? 0) + 1);
      const session = sessionsByKey.get(row.session_key);
      if (!session || (session.matchHits?.length ?? 0) >= 2) continue;
      const matchedTerms = terms.filter((term) => row.content.toLocaleLowerCase().includes(term));
      const hit: SessionMatchHit = {
        messageIndex: numberValue(row.source_message_index),
        role: row.role,
        timestamp: isoValue(row.occurred_at),
        snippet: searchSnippet(row.content, matchedTerms),
        matchedTerms,
        turnId: row.turn_id,
        turnIndex: numberValue(row.turn_index),
      };
      session.matchHits?.push(hit);
    }
    for (const session of sessions) {
      session.messageMatchCount = hitCounts.get(session.sessionKey) ?? 0;
      session.matchSnippet ??= session.matchHits?.[0]?.snippet ?? null;
    }
  }
}
