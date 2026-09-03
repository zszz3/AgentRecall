import type {
  SearchOptions,
  SessionMatchHit,
  SessionMessage,
  SessionSearchPage,
  SessionSearchResult,
} from "../types";
import { LIVE_SESSION_INACTIVITY_TIMEOUT_MS } from "../refresh-policy";
import type { PostgresDatabase } from "./database";
import {
  SESSION_ACTIVITY_SQL,
  SESSION_SELECT_SQL,
  AGENTRECALL_CREATED_SESSION_SQL,
  escapeLike,
  hydrateSession,
  isoValue,
  numberValue,
  parseSearchClauses,
  searchSnippet,
  searchTerms,
  type SessionRow,
} from "./session-records";

const LIVE_SESSION_KEY_SQL = `
  case
    when sessions.source in ('claude-cli', 'claude-app', 'claude-internal', 'stepcode-claude') then 'claude:' || sessions.raw_id
    when sessions.source in ('codex-cli', 'codex-app', 'codex-internal', 'stepcode-codex') then 'codex:' || sessions.raw_id
    when sessions.source = 'tclaude-cli' then 'tclaude:' || sessions.raw_id
    when sessions.source = 'tcodex-cli' then 'tcodex:' || sessions.raw_id
    when sessions.source = 'codebuddy-cli' then 'codebuddy:' || sessions.raw_id
    when sessions.source = 'workbuddy-cli' then 'workbuddy:' || sessions.raw_id
    when sessions.source = 'codewiz-cli' then 'codewiz:' || sessions.raw_id
    when sessions.source = 'trae' then 'trae:' || sessions.raw_id
    when sessions.source = 'qoder' then 'qoder:' || sessions.raw_id
    else null
  end
`;

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
    else filters.push("sessions.hidden = false");
    if (options.excludeSubagents) filters.push("sessions.is_subagent = false");
    if (options.projectPath) filters.push(`sessions.project_path = ${bind(options.projectPath)}`);
    if (options.environmentId && options.environmentId !== "all") {
      filters.push(`sessions.environment_id = ${bind(options.environmentId)}`);
    }
    if (options.source && options.source !== "all") {
      if (options.source === "claude") {
        filters.push("sessions.available_sources && ARRAY['claude-cli', 'claude-app']::text[]");
      } else if (options.source === "codex") {
        filters.push("sessions.available_sources && ARRAY['codex-cli', 'codex-app']::text[]");
      } else if (options.source === "stepcode") {
        filters.push("sessions.available_sources && ARRAY['stepcode-claude', 'stepcode-codex']::text[]");
      } else {
        filters.push(`sessions.available_sources @> ARRAY[${bind(options.source)}]::text[]`);
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
    const liveKeys = [...new Set(options.liveSessionKeys ?? [])].filter(Boolean);
    if (options.liveStatus) {
      if (liveKeys.length === 0 && options.liveStatus === "open") {
        filters.push("false");
      } else if (liveKeys.length > 0) {
        const placeholders = liveKeys.map((key) => bind(key)).join(", ");
        const activeAfter = bind(new Date(Date.now() - LIVE_SESSION_INACTIVITY_TIMEOUT_MS).toISOString());
        filters.push(
          options.liveStatus === "open"
            ? `(${LIVE_SESSION_KEY_SQL} in (${placeholders}) and ${SESSION_ACTIVITY_SQL} > ${activeAfter})`
            : `(${LIVE_SESSION_KEY_SQL} is null or ${LIVE_SESSION_KEY_SQL} not in (${placeholders}) or ${SESSION_ACTIVITY_SQL} <= ${activeAfter})`,
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

    const originCountFilters = [...filters];
    const originCountValues = [...values];
    if (options.origin === "ordinary") filters.push(`not (${AGENTRECALL_CREATED_SESSION_SQL})`);
    else if (options.origin === "agentrecall") filters.push(AGENTRECALL_CREATED_SESSION_SQL);
    const countValues = [...values];
    const sortBy = options.sortBy ?? "smart";
    let rankingColumns = "";
    if (sortBy !== "created" && clauses.length > 0) {
      const smartQuery = clauses.join(" ").toLocaleLowerCase();
      const exactQuery = bind(smartQuery);
      const prefixQuery = bind(`${escapeLike(smartQuery)}%`);
      const containsQuery = bind(`%${escapeLike(smartQuery)}%`);
      const titleText = "lower(coalesce(nullif(sessions.custom_title, ''), nullif(sessions.original_title, ''), nullif(sessions.first_question, ''), ''))";
      const relevanceSql = `
        case
          when ${titleText} = ${exactQuery} then 1000
          when ${titleText} like ${prefixQuery} escape '\\' then 700
          when ${titleText} like ${containsQuery} escape '\\' then 500
          else 0
        end
        + case when lower(sessions.first_question) like ${containsQuery} escape '\\' then 300 else 0 end
        + case when best_turn.id is not null then 120 else 0 end
        + case when (
            lower(sessions.project_path) like ${containsQuery} escape '\\'
            or lower(sessions.raw_id) like ${containsQuery} escape '\\'
          ) then 50 else 0 end
        + case when sessions.favorited then 25 else 0 end
      `;
      rankingColumns = `(${relevanceSql}) as relevance_score,`;
      if (sortBy === "smart") {
        rankingColumns += `
          (
            (${relevanceSql})
            * (
              0.08
              + 0.92 * power(
                0.5,
                greatest(
                  0,
                  extract(epoch from (current_timestamp - (${SESSION_ACTIVITY_SQL}))) / 86400.0
                ) / 30.0
              )
            )
            * case when sessions.favorited then 1.2 else 1.0 end
          ) as smart_score,
        `;
      }
    }
    const favoriteOrder = options.prioritizeFavorites === false
      || sortBy === "created"
      || clauses.length > 0
      ? ""
      : "sessions.favorited desc,";
    const liveOrder = !options.liveStatus && clauses.length === 0 && liveKeys.length > 0
      ? `case when ${LIVE_SESSION_KEY_SQL} in (${liveKeys.map((key) => bind(key)).join(", ")}) then 0 else 1 end,`
      : "";
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit as number)) : 200;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset as number)) : 0;
    const limitPlaceholder = bind(limit);
    const offsetPlaceholder = bind(offset);
    const preferredSourceOrder = options.source === "stepcode"
      || options.source === "stepcode-claude"
      || options.source === "stepcode-codex"
      ? `
              case
                when base_sessions.source in ('stepcode-claude', 'stepcode-codex') then 0
                when base_sessions.source in ('claude-cli', 'claude-app', 'codex-cli', 'codex-app') then 1
                else 0
              end,`
      : `
              case
                when base_sessions.source in ('claude-cli', 'claude-app', 'codex-cli', 'codex-app') then 0
                when base_sessions.source in ('stepcode-claude', 'stepcode-codex') then 1
                else 0
              end,`;
    const primarySort = sortBy === "created"
      ? "sessions.started_at asc"
      : sortBy === "activity"
        ? clauses.length > 0
          ? "relevance_score desc, last_activity_at desc"
          : "last_activity_at desc"
        : clauses.length > 0
          ? "smart_score desc, last_activity_at desc"
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
    const buildFilteredSessionsSql = (activeFilters: readonly string[]): string => `
      from (
        select
          base_sessions.*,
          coalesce(
            (
              select array_agg(distinct related.source order by related.source)
              from agent_recall.sessions related
              where related.environment_id = base_sessions.environment_id
                and related.raw_id = base_sessions.raw_id
                and related.project_path = base_sessions.project_path
                and related.is_subagent = base_sessions.is_subagent
                and related.parent_session_id is not distinct from base_sessions.parent_session_id
                and case
                  when related.source in ('claude-cli', 'claude-app', 'stepcode-claude') then 'claude'
                  when related.source in ('codex-cli', 'codex-app', 'stepcode-codex') then 'codex'
                  else related.source
                end = case
                  when base_sessions.source in ('claude-cli', 'claude-app', 'stepcode-claude') then 'claude'
                  when base_sessions.source in ('codex-cli', 'codex-app', 'stepcode-codex') then 'codex'
                  else base_sessions.source
                end
            ),
            array[base_sessions.source]::text[]
          ) as available_sources,
          row_number() over (
            partition by
              base_sessions.environment_id,
              base_sessions.raw_id,
              base_sessions.project_path,
              base_sessions.is_subagent,
              base_sessions.parent_session_id,
              case
                when base_sessions.source in ('claude-cli', 'claude-app', 'stepcode-claude') then 'claude'
                when base_sessions.source in ('codex-cli', 'codex-app', 'stepcode-codex') then 'codex'
                else base_sessions.source
              end
            order by
              ${preferredSourceOrder}
              base_sessions.session_key
          ) as source_rank
        from agent_recall.sessions base_sessions
      ) sessions
      join agent_recall.environments environments on environments.id = sessions.environment_id
      ${bestTurnJoin}
      where sessions.source_rank = 1
        and ${activeFilters.join(" and ")}
    `;
    const filteredSessionsSql = buildFilteredSessionsSql(filters);
    const originFilteredSessionsSql = buildFilteredSessionsSql(originCountFilters);
    const result = await this.database.query<SessionRow>(
      `
        select
          ${bestTurnColumns}
          ${rankingColumns}
          ${SESSION_SELECT_SQL},
          count(*) over () as total_count
        ${filteredSessionsSql}
        order by ${liveOrder} ${favoriteOrder} ${primarySort}, sessions.session_key
        limit ${limitPlaceholder}
        offset ${offsetPlaceholder}
      `,
      values,
    );
    const sessions = result.rows.map((row) => hydrateSession(row, terms));
    if (clauses.length > 0) await this.attachMessageHits(sessions, clauses, terms, query);
    const totalCount = result.rows.length > 0
      ? numberValue(result.rows[0].total_count)
      : numberValue((await this.database.query<{ total_count: number | string }>(
          `select count(*) as total_count ${filteredSessionsSql}`,
          countValues,
        )).rows[0]?.total_count);
    const originCountRow = (await this.database.query<{
      ordinary_count: number | string;
      agentrecall_count: number | string;
      all_count: number | string;
    }>(
      `
        select
          count(*) filter (where not (${AGENTRECALL_CREATED_SESSION_SQL})) as ordinary_count,
          count(*) filter (where ${AGENTRECALL_CREATED_SESSION_SQL}) as agentrecall_count,
          count(*) as all_count
        ${originFilteredSessionsSql}
      `,
      originCountValues,
    )).rows[0];
    return {
      sessions,
      totalCount,
      hasMore: offset + sessions.length < totalCount,
      originCounts: {
        ordinary: numberValue(originCountRow?.ordinary_count),
        agentRecall: numberValue(originCountRow?.agentrecall_count),
        all: numberValue(originCountRow?.all_count),
      },
    };
  }

  private async attachMessageHits(
    sessions: SessionSearchResult[],
    clauses: readonly string[],
    terms: readonly string[],
    query: string,
  ): Promise<void> {
    if (sessions.length === 0) return;
    const values: unknown[] = [sessions.map((session) => session.sessionKey)];
    const patterns = clauses.map((clause) => {
      values.push(`%${escapeLike(clause)}%`);
      return `$${values.length}`;
    });
    const messagePredicates = patterns.map((pattern) => `messages.content ilike ${pattern} escape '\\'`);
    const turnPredicates = patterns.map((pattern) => `turns.search_text ilike ${pattern} escape '\\'`);
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
          and ${turnPredicates.join(" and ")}
          and (${messagePredicates.join(" or ")})
        order by turns.session_key, turns.turn_index, messages.message_index
      `,
      values,
    );
    const sessionsByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
    const phrase = query
      .replace(/"/gu, "")
      .replace(/\bAND\b/giu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase();
    const rowsBySession = new Map<
      string,
      Array<(typeof result.rows)[number] & {
        matchedTerms: string[];
        rank: number;
        snippet: string;
      }>
    >();
    for (const row of result.rows) {
      const normalized = row.content.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      const matchedTerms = terms.filter((term) => normalized.includes(term));
      if (matchedTerms.length === 0) continue;
      const phraseMatched = phrase.length > 0 && normalized.includes(phrase);
      const ranked = {
        ...row,
        matchedTerms: phraseMatched
          ? [phrase, ...matchedTerms.filter((term) => term !== phrase)]
          : matchedTerms,
        rank: phraseMatched ? 3 : matchedTerms.length === terms.length ? 2 : 1,
        snippet: searchSnippet(row.content, [phrase, ...matchedTerms].filter(Boolean)),
      };
      const group = rowsBySession.get(row.session_key);
      if (group) group.push(ranked);
      else rowsBySession.set(row.session_key, [ranked]);
    }

    for (const [sessionKey, rows] of rowsBySession) {
      const session = sessionsByKey.get(sessionKey);
      if (!session) continue;
      session.messageMatchCount = rows.length;
      rows.sort((left, right) =>
        right.rank - left.rank
        || right.matchedTerms.length - left.matchedTerms.length
        || numberValue(left.source_message_index) - numberValue(right.source_message_index));
      for (const row of rows.slice(0, 2)) {
        const hit: SessionMatchHit = {
          messageIndex: numberValue(row.source_message_index),
          role: row.role,
          timestamp: isoValue(row.occurred_at),
          snippet: row.snippet,
          matchedTerms: row.matchedTerms,
          turnId: row.turn_id,
          turnIndex: numberValue(row.turn_index),
        };
        session.matchHits?.push(hit);
      }
      session.matchSnippet ??= session.matchHits?.[0]?.snippet ?? null;
    }
  }
}
