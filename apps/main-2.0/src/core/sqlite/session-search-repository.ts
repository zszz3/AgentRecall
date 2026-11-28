import type { SQLInputValue } from "node:sqlite";
import type {
  SearchOptions,
  SessionMatchHit,
  SessionMessage,
  SessionSearchPage,
  SessionSearchResult,
} from "../types";
import { AGENT_RECALL_INVOCATION_SURFACES } from "../../shared/runtime-invocation";
import { LIVE_SESSION_INACTIVITY_TIMEOUT_MS } from "../refresh-policy";
import { escapeLike, parseSearchClauses } from "../session-search-query";
import type { SqliteDatabase } from "./database";
import {
  SQLITE_AGENTRECALL_CREATED_SESSION_SQL,
  SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL,
  SQLITE_SESSION_ACTIVITY_SQL,
  SQLITE_SESSION_SELECT_SQL,
  canUseFts5Trigram,
  fts5TrigramQuery,
  hydrateSqliteSession,
  isoValue,
  normalizedProjectPathSql,
  numberValue,
  projectPathMatchVariants,
  searchSnippet,
  searchTerms,
  sqliteAvailableSourcesSql,
  type SqliteSessionRow,
} from "./session-records";

const MAX_TURN_HITS = 3;

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

function agentRecallCreatedSurfaceSql(): string {
  return `
    exists (
      select 1
      from runtime_session_bindings bindings
      join runtime_invocations invocations
        on invocations.id = bindings.invocation_id
      where ${SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL}
        and bindings.relation = 'created'
        and invocations.initiator = 'agentrecall'
        and invocations.surface = ?
    )
  `;
}

function buildBestTurnsCte(clauses: readonly string[]): { sql: string; params: SQLInputValue[] } {
  if (clauses.length === 0) return { sql: "", params: [] };
  const params: SQLInputValue[] = [];
  const termCtes = clauses.map((clause, index) => {
    if (canUseFts5Trigram(clause)) {
      params.push(fts5TrigramQuery(clause));
      return `term_${index}_turns as materialized (
        select turns.id
        from session_turns_fts
        join session_turns turns on turns.rowid = session_turns_fts.rowid
        where session_turns_fts match ?
      )`;
    }
    params.push(`%${escapeLike(clause)}%`);
    return `term_${index}_turns as materialized (
      select turns.id
      from session_turns turns
      where turns.search_text like ? escape '\\'
    )`;
  });
  params.push(`%${escapeLike(clauses[0])}%`);
  const sql = `
    with ${termCtes.join(",\n    ")},
    matched_turns as (
      select
        turns.session_key,
        turns.id,
        turns.turn_index,
        turns.source_message_index,
        turns.started_at,
        case when turns.user_text like ? escape '\\' then 1 else 0 end as user_matched,
        ${clauses.map((_, index) => `case when turns.id in (select id from term_${index}_turns) then 1 else 0 end as term_${index}`).join(",\n        ")}
      from session_turns turns
      where turns.id in (${clauses.map((_, index) => `select id from term_${index}_turns`).join(" union ")})
    ),
    scored_turns as (
      select
        matched_turns.*,
        (${clauses.map((_, index) => `term_${index}`).join(" + ")}) as matched_terms,
        (${clauses.map((_, index) => `max(term_${index}) over sessions_window = 1`).join(" and ")}) as covers_all,
        count(*) over sessions_window as match_count
      from matched_turns
      window sessions_window as (partition by matched_turns.session_key)
    ),
    ranked_turns as (
      select
        scored_turns.*,
        row_number() over (
          partition by scored_turns.session_key
          order by
            scored_turns.matched_terms desc,
            case when scored_turns.user_matched = 1 then 0 else 1 end,
            scored_turns.turn_index desc
        ) as turn_rank
      from scored_turns
      where scored_turns.covers_all
    ),
    best_turns as materialized (
      select
        ranked_turns.session_key,
        ranked_turns.id,
        ranked_turns.turn_index,
        ranked_turns.source_message_index,
        ranked_turns.started_at,
        ranked_turns.match_count,
        turns.search_text
      from ranked_turns
      join session_turns turns on turns.id = ranked_turns.id
      where ranked_turns.turn_rank = 1
    )
  `;
  return { sql, params };
}

export class SqliteSessionSearchRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async searchSessions(options: SearchOptions = {}): Promise<SessionSearchResult[]> {
    return (await this.searchSessionPage(options)).sessions;
  }

  async searchSessionPage(options: SearchOptions = {}): Promise<SessionSearchPage> {
    const query = options.query?.trim() || "";
    const clauses = parseSearchClauses(query);
    const terms = searchTerms(clauses);
    const nowMs = Date.now();

    const baseFilters: string[] = [];
    const baseFilterParams: SQLInputValue[] = [];

    if (options.visibility === "hidden") baseFilters.push("sessions.hidden = 1");
    else if (options.visibility === "favorites") baseFilters.push("sessions.hidden = 0 and sessions.favorited = 1");
    else baseFilters.push("sessions.hidden = 0");

    if (options.excludeSubagents) baseFilters.push("sessions.is_subagent = 0");

    if (options.projectPath) {
      const variants = projectPathMatchVariants(options.projectPath);
      if (variants.length === 1) {
        baseFilters.push("sessions.project_path = ?");
        baseFilterParams.push(variants[0]);
      } else {
        baseFilters.push("sessions.project_path in (select value from json_each(?))");
        baseFilterParams.push(JSON.stringify(variants));
      }
    }

    if (options.environmentId && options.environmentId !== "all") {
      baseFilters.push("sessions.environment_id = ?");
      baseFilterParams.push(options.environmentId);
    }

    if (options.source && options.source !== "all") {
      if (options.source === "claude") {
        baseFilters.push("exists (select 1 from json_each(sessions.base_available_sources) where value in ('claude-cli', 'claude-app'))");
      } else if (options.source === "codex") {
        baseFilters.push("exists (select 1 from json_each(sessions.base_available_sources) where value in ('codex-cli', 'codex-app'))");
      } else if (options.source === "stepcode") {
        baseFilters.push("exists (select 1 from json_each(sessions.base_available_sources) where value in ('stepcode-claude', 'stepcode-codex'))");
      } else {
        baseFilters.push("exists (select 1 from json_each(sessions.base_available_sources) where value = ?)");
        baseFilterParams.push(options.source);
      }
    }

    if (Number.isFinite(options.dateFrom)) {
      baseFilters.push(`${SQLITE_SESSION_ACTIVITY_SQL} >= ?`);
      baseFilterParams.push(Math.trunc(options.dateFrom as number));
    }
    if (Number.isFinite(options.dateTo)) {
      baseFilters.push(`${SQLITE_SESSION_ACTIVITY_SQL} <= ?`);
      baseFilterParams.push(Math.trunc(options.dateTo as number));
    }

    if (options.tag) {
      baseFilters.push(`
        exists (
          select 1
          from session_tags filter_session_tags
          join tags filter_tags on filter_tags.id = filter_session_tags.tag_id
          where filter_session_tags.session_key = sessions.session_key
            and filter_tags.name = ?
        )
      `);
      baseFilterParams.push(options.tag);
    }

    const liveKeys = [...new Set(options.liveSessionKeys ?? [])].filter(Boolean);
    if (options.liveStatus) {
      if (liveKeys.length === 0 && options.liveStatus === "open") {
        baseFilters.push("0");
      } else if (liveKeys.length > 0) {
        const placeholders = liveKeys.map(() => "?").join(", ");
        const activeAfter = nowMs - LIVE_SESSION_INACTIVITY_TIMEOUT_MS;
        baseFilters.push(
          options.liveStatus === "open"
            ? `(${LIVE_SESSION_KEY_SQL} in (${placeholders}) and ${SQLITE_SESSION_ACTIVITY_SQL} > ?)`
            : `(${LIVE_SESSION_KEY_SQL} is null or ${LIVE_SESSION_KEY_SQL} not in (${placeholders}) or ${SQLITE_SESSION_ACTIVITY_SQL} <= ?)`,
        );
        baseFilterParams.push(...liveKeys, activeAfter);
      }
    }

    const bestTurnsCte = buildBestTurnsCte(clauses);
    const bestTurnJoin = clauses.length > 0
      ? "left join best_turns best_turn on best_turn.session_key = sessions.session_key"
      : "";

    if (clauses.length > 0) {
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
      const metadataPredicates = clauses.map((clause) => {
        baseFilterParams.push(`%${escapeLike(clause)}%`);
        return `${metadataText} like ? escape '\\'`;
      });
      baseFilters.push(`(best_turn.id is not null or (${metadataPredicates.join(" and ")}))`);
    }

    const pageFilters = [...baseFilters];
    const pageFilterParams = [...baseFilterParams];
    if (options.invocationSurface && options.invocationSurface !== "all") {
      if (!AGENT_RECALL_INVOCATION_SURFACES.includes(options.invocationSurface)) {
        throw new Error(`Unsupported Runtime invocation surface: ${options.invocationSurface}`);
      }
      pageFilters.push(agentRecallCreatedSurfaceSql());
      pageFilterParams.push(options.invocationSurface);
    }
    if (options.origin === "ordinary") pageFilters.push(`not (${SQLITE_AGENTRECALL_CREATED_SESSION_SQL})`);
    else if (options.origin === "agentrecall") pageFilters.push(SQLITE_AGENTRECALL_CREATED_SESSION_SQL);

    const sortBy = options.sortBy ?? "smart";
    let rankingColumns = "";
    const rankingParams: SQLInputValue[] = [];
    if (sortBy !== "created" && clauses.length > 0) {
      const smartQuery = clauses.join(" ").toLocaleLowerCase();
      const exactQuery = smartQuery;
      const prefixQuery = `${escapeLike(smartQuery)}%`;
      const containsQuery = `%${escapeLike(smartQuery)}%`;
      const titleText = "lower(coalesce(nullif(sessions.custom_title, ''), nullif(sessions.original_title, ''), nullif(sessions.first_question, ''), ''))";
      const relevanceSql = `
        case
          when ${titleText} = ? then 1000
          when ${titleText} like ? escape '\\' then 700
          when ${titleText} like ? escape '\\' then 500
          else 0
        end
        + case when lower(sessions.first_question) like ? escape '\\' then 300 else 0 end
        + case when best_turn.id is not null then 120 else 0 end
        + case when (
            lower(sessions.project_path) like ? escape '\\'
            or lower(sessions.raw_id) like ? escape '\\'
          ) then 50 else 0 end
        + case when sessions.favorited = 1 then 25 else 0 end
      `;
      const relevanceValues: SQLInputValue[] = [
        exactQuery,
        prefixQuery,
        containsQuery,
        containsQuery,
        containsQuery,
        containsQuery,
      ];
      rankingColumns = `(${relevanceSql}) as relevance_score,`;
      rankingParams.push(...relevanceValues);
      if (sortBy === "smart") {
        rankingColumns += `
          (
            (${relevanceSql})
            * (
              0.08
              + 0.92 * power(
                0.5,
                max(
                  0.0,
                  (? - (${SQLITE_SESSION_ACTIVITY_SQL})) / 86400000.0
                ) / 30.0
              )
            )
            * case when sessions.favorited = 1 then 1.2 else 1.0 end
          ) as smart_score,
        `;
        rankingParams.push(...relevanceValues, nowMs);
      }
    }

    const favoriteOrder = options.prioritizeFavorites === false
      || sortBy === "created"
      || clauses.length > 0
      ? ""
      : "sessions.favorited desc,";
    const liveOrderParams: SQLInputValue[] = [];
    const liveOrder = !options.liveStatus && clauses.length === 0 && liveKeys.length > 0
      ? `case when ${LIVE_SESSION_KEY_SQL} in (${liveKeys.map((key) => {
          liveOrderParams.push(key);
          return "?";
        }).join(", ")}) then 0 else 1 end,`
      : "";

    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit as number)) : 200;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset as number)) : 0;

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
        null as best_turn_id,
        null as best_turn_index,
        null as best_source_message_index,
        null as best_turn_started_at,
        null as best_turn_search_text,
        null as turn_match_count,
      `;

    const buildFilteredSessionsSql = (activeFilters: readonly string[]): string => `
      from (
        select
          base_sessions.*,
          ${sqliteAvailableSourcesSql("base_sessions")} as base_available_sources,
          row_number() over (
            partition by
              base_sessions.environment_id,
              base_sessions.raw_id,
              ${normalizedProjectPathSql("base_sessions.project_path")},
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
        from local_sessions base_sessions
      ) sessions
      join environments on environments.id = sessions.environment_id
      ${bestTurnJoin}
      where sessions.source_rank = 1
        and ${activeFilters.join(" and ")}
    `;

    const filteredSessionsSql = buildFilteredSessionsSql(pageFilters);
    const originFilteredSessionsSql = buildFilteredSessionsSql(baseFilters);
    const invocationSurfaceFilteredSessionsSql = buildFilteredSessionsSql(baseFilters);

    const rows = this.database.all<SqliteSessionRow>(
      `
        ${bestTurnsCte.sql}
        select
          ${bestTurnColumns}
          ${rankingColumns}
          ${SQLITE_SESSION_SELECT_SQL},
          count(*) over () as total_count
        ${filteredSessionsSql}
        order by ${liveOrder} ${favoriteOrder} ${primarySort}, sessions.session_key
        limit ?
        offset ?
      `,
      ...bestTurnsCte.params,
      ...rankingParams,
      ...pageFilterParams,
      ...liveOrderParams,
      limit,
      offset,
    );

    const originCountRow = this.database.get<{
      ordinary_count: number | string;
      agentrecall_count: number | string;
      all_count: number | string;
    }>(
      `
        ${bestTurnsCte.sql}
        select
          count(*) filter (where not (${SQLITE_AGENTRECALL_CREATED_SESSION_SQL})) as ordinary_count,
          count(*) filter (where ${SQLITE_AGENTRECALL_CREATED_SESSION_SQL}) as agentrecall_count,
          count(*) as all_count
        ${originFilteredSessionsSql}
      `,
      ...bestTurnsCte.params,
      ...baseFilterParams,
    );

    const surfaceSelectParams: SQLInputValue[] = [...AGENT_RECALL_INVOCATION_SURFACES];
    const invocationSurfaceCountRow = this.database.get<Record<string, number | string>>(
      `
        ${bestTurnsCte.sql}
        select
          ${AGENT_RECALL_INVOCATION_SURFACES.map((surface) =>
            `count(*) filter (where ${agentRecallCreatedSurfaceSql()}) as ${surface}_count`).join(",\n          ")},
          count(*) filter (where ${SQLITE_AGENTRECALL_CREATED_SESSION_SQL}) as all_count
        ${invocationSurfaceFilteredSessionsSql}
      `,
      ...bestTurnsCte.params,
      ...surfaceSelectParams,
      ...baseFilterParams,
    );

    const sessions = rows.map((row) => hydrateSqliteSession(row, terms));
    if (clauses.length > 0) this.attachMessageHits(sessions, clauses, terms, query);

    const totalCount = rows.length > 0
      ? numberValue(rows[0].total_count)
      : numberValue(this.database.get<{ total_count: number | string }>(
          `${bestTurnsCte.sql} select count(*) as total_count ${filteredSessionsSql}`,
          ...bestTurnsCte.params,
          ...pageFilterParams,
        )?.total_count);

    return {
      sessions,
      totalCount,
      hasMore: offset + sessions.length < totalCount,
      originCounts: {
        ordinary: numberValue(originCountRow?.ordinary_count),
        agentRecall: numberValue(originCountRow?.agentrecall_count),
        all: numberValue(originCountRow?.all_count),
      },
      invocationSurfaceCounts: {
        workflow: numberValue(invocationSurfaceCountRow?.workflow_count),
        evaluation: numberValue(invocationSurfaceCountRow?.evaluation_count),
        team_chat: numberValue(invocationSurfaceCountRow?.team_chat_count),
        agent: numberValue(invocationSurfaceCountRow?.agent_count),
        skill: numberValue(invocationSurfaceCountRow?.skill_count),
        system: numberValue(invocationSurfaceCountRow?.system_count),
        all: numberValue(invocationSurfaceCountRow?.all_count),
      },
    };
  }

  private attachMessageHits(
    sessions: SessionSearchResult[],
    clauses: readonly string[],
    terms: readonly string[],
    query: string,
  ): void {
    const turnMatched = sessions.filter((session) => session.bestTurn);
    if (turnMatched.length === 0) return;

    const params: SQLInputValue[] = [JSON.stringify(turnMatched.map((session) => session.sessionKey))];
    const matchingTurnQueries = clauses.map((clause) => {
      if (canUseFts5Trigram(clause)) {
        params.push(fts5TrigramQuery(clause));
        return `select turns.id from session_turns_fts join session_turns turns on turns.rowid = session_turns_fts.rowid where session_turns_fts match ?`;
      }
      params.push(`%${escapeLike(clause)}%`);
      return "select id from session_turns where search_text like ? escape '\\'";
    });
    const messagePredicates = clauses.map((clause) => {
      params.push(`%${escapeLike(clause)}%`);
      return "messages.content like ? escape '\\'";
    });

    const rows = this.database.all<{
      session_key: string;
      turn_id: string;
      turn_index: number | string;
      source_message_index: number | string;
      role: SessionMessage["role"];
      content: string;
      occurred_at: number | string | null;
    }>(
      `
        with candidate_turns as materialized (
          select turns.id, turns.session_key, turns.turn_index
          from session_turns turns
          where turns.session_key in (select value from json_each(?))
            and turns.id in (${matchingTurnQueries.join(" union ")})
        )
        select
          turns.session_key,
          turns.id as turn_id,
          turns.turn_index,
          messages.source_message_index,
          messages.role,
          messages.content,
          messages.occurred_at
        from candidate_turns turns
        join turn_messages messages on messages.turn_id = turns.id
        where messages.role in ('user', 'assistant')
          and (${messagePredicates.join(" or ")})
        order by turns.session_key, turns.turn_index, messages.message_index
      `,
      ...params,
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
      Array<(typeof rows)[number] & {
        matchedTerms: string[];
        rank: number;
        snippet: string;
      }>
    >();
    for (const row of rows) {
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

    for (const [sessionKey, sessionRows] of rowsBySession) {
      const session = sessionsByKey.get(sessionKey);
      if (!session) continue;
      session.messageMatchCount = sessionRows.length;
      sessionRows.sort((left, right) =>
        right.rank - left.rank
        || right.matchedTerms.length - left.matchedTerms.length
        || numberValue(left.source_message_index) - numberValue(right.source_message_index));
      const bestPerTurn = sessionRows.filter((row, index) =>
        sessionRows.findIndex((other) => other.turn_id === row.turn_id) === index);
      const shown = bestPerTurn
        .slice(0, MAX_TURN_HITS)
        .sort((left, right) => numberValue(left.source_message_index) - numberValue(right.source_message_index));
      for (const row of shown) {
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
