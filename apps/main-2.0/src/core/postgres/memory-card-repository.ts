import { randomUUID } from "node:crypto";

import { escapeLike, parseSearchClauses } from "../session-search-query";
import type { PostgresDatabase, PostgresQueryable } from "./database";
import { AGENTRECALL_CREATED_SESSION_SQL, isoValue, nullableIsoValue, numberValue } from "./session-records";

export type MemoryCardKind = "experience" | "decision";
export type MemoryCardStatus = "active" | "superseded";

export interface MemoryCardSource {
  sessionKey: string;
  firstTurnIndex: number;
  lastTurnIndex: number;
  /** When the last Turn of the range started; when that Turn is no longer indexed, when the source was recorded. */
  lastTurnAt: string;
}

export interface MemoryCard {
  id: string;
  projectPath: string;
  kind: MemoryCardKind;
  problem: string;
  solution: string;
  previousSolution: string | null;
  failedAttempts: string[];
  keywords: string[];
  status: MemoryCardStatus;
  supersededBy: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  sources: MemoryCardSource[];
}

/** One validated change proposed by the extraction model. */
export type MemoryCardOperation =
  | { op: "create"; ref: string; kind: MemoryCardKind; problem: string; solution: string; failedAttempts: string[]; keywords: string[] }
  | { op: "update"; id: string; solution?: string; failedAttempts: string[]; keywords: string[] }
  /** The new Turns show the card still holds; only a source is added. */
  | { op: "confirm"; id: string }
  | { op: "supersede"; id: string; replacedBy: string };

export type MemoryExtractionStatus = "pending" | "succeeded" | "succeeded_no_output" | "failed";

export interface MemoryExtractionState {
  sessionKey: string;
  lastExtractedTurnIndex: number | null;
  status: MemoryExtractionStatus;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastRunAt: string | null;
}

export interface MemoryExtractionTurn {
  turnIndex: number;
  startedAt: string;
  userText: string;
  assistantText: string;
  toolText: string;
  toolNames: string[];
}

export interface MemoryExtractionInput {
  sessionKey: string;
  source: string;
  projectPath: string;
  title: string;
  turns: MemoryExtractionTurn[];
}

export interface MemoryExtractionFailure {
  sessionKey: string;
  title: string;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string;
}

export interface MemoryExtractionOverview {
  activeCards: number;
  supersededCards: number;
  processedSessions: number;
  processedToday: number;
  /** Null when no extraction reported usage; Runtimes that do not report usage are not counted as zero. */
  inputTokens: number | null;
  outputTokens: number | null;
  failures: MemoryExtractionFailure[];
}

interface CardRow extends Record<string, unknown> {
  id: string;
  project_path: string;
  kind: MemoryCardKind;
  problem: string;
  solution: string;
  previous_solution: string | null;
  failed_attempts: string[];
  keywords: string[];
  status: MemoryCardStatus;
  superseded_by: string | null;
  model: string;
  created_at: unknown;
  updated_at: unknown;
  sources: Array<{ session_key: string; first_turn_index: number; last_turn_index: number; last_turn_at: unknown }> | null;
}

const CARD_SELECT_SQL = `
  select cards.*,
    (
      select json_agg(json_build_object(
        'session_key', sources.session_key,
        'first_turn_index', sources.first_turn_index,
        'last_turn_index', sources.last_turn_index,
        'last_turn_at', coalesce(turns.started_at, sources.created_at)
      ) order by sources.id)
      from agent_recall.memory_card_sources sources
      left join agent_recall.session_turns turns
        on turns.session_key = sources.session_key and turns.turn_index = sources.last_turn_index
      where sources.card_id = cards.id
    ) as sources
  from agent_recall.memory_cards cards
`;

function hydrateCard(row: CardRow): MemoryCard {
  return {
    id: row.id,
    projectPath: row.project_path,
    kind: row.kind,
    problem: row.problem,
    solution: row.solution,
    previousSolution: row.previous_solution,
    failedAttempts: row.failed_attempts,
    keywords: row.keywords,
    status: row.status,
    supersededBy: row.superseded_by,
    model: row.model,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    sources: (row.sources ?? []).map((source) => ({
      sessionKey: source.session_key,
      firstTurnIndex: source.first_turn_index,
      lastTurnIndex: source.last_turn_index,
      lastTurnAt: isoValue(source.last_turn_at),
    })),
  };
}

function uniqueTexts(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function cardSearchText(card: { problem: string; solution: string; failedAttempts: readonly string[]; keywords: readonly string[] }): string {
  return [card.problem, card.solution, ...card.failedAttempts, ...card.keywords].join("\n");
}

function likePatterns(terms: readonly string[]): string[] {
  return terms.map((term) => `%${escapeLike(term)}%`);
}

/**
 * Experience cards and the per-Session extraction cursor. Cards belong to a
 * project directory; sources are append-only and cascade from Session removal.
 */
export class PostgresMemoryCardRepository {
  constructor(private readonly database: PostgresDatabase) {}

  /**
   * Records what each candidate Session looks like now and returns Sessions
   * whose new Turns were already identical at the previous call. Callers invoke
   * this once per completed index run, so a Session is extracted only after its
   * new Turns survived one index pass unchanged. A failed Session without a
   * retry time exhausted its attempts and waits for `retryFailedExtractions`.
   */
  async pickExtractionSessions(options: { enabledAt: string; now: string; limit: number }): Promise<string[]> {
    const result = await this.database.query<{ session_key: string }>(`
      with fresh as (
        select turns.session_key,
          md5(string_agg(
            turns.turn_index || ':' || turns.status || ':' || length(turns.user_text) || ':'
              || length(turns.assistant_text) || ':' || length(turns.tool_text),
            ',' order by turns.turn_index
          )) as signature,
          bool_or(turns.status = 'running') as running,
          max(turns.started_at) as latest_at
        from agent_recall.session_turns turns
        join agent_recall.local_sessions sessions on sessions.session_key = turns.session_key
        left join agent_recall.memory_extraction_state state on state.session_key = turns.session_key
        where turns.started_at >= $1::timestamptz
          and turns.turn_index > coalesce(state.last_extracted_turn_index, -1)
          and not (${AGENTRECALL_CREATED_SESSION_SQL})
        group by turns.session_key
      ),
      observed as (
        insert into agent_recall.memory_extraction_state (session_key, observed_signature, status, updated_at)
        select session_key, signature, 'pending', $2::timestamptz from fresh
        on conflict (session_key) do update
          set observed_signature = excluded.observed_signature, updated_at = excluded.updated_at
          where agent_recall.memory_extraction_state.observed_signature is distinct from excluded.observed_signature
        returning session_key
      )
      select fresh.session_key
      from fresh
      join agent_recall.memory_extraction_state state on state.session_key = fresh.session_key
      where fresh.session_key not in (select session_key from observed)
        and not fresh.running
        and (state.next_retry_at is null or state.next_retry_at <= $2::timestamptz)
        and not (state.status = 'failed' and state.next_retry_at is null)
      order by fresh.latest_at desc, fresh.session_key
      limit $3
    `, [options.enabledAt, options.now, options.limit]);
    return result.rows.map((row) => row.session_key);
  }

  async loadExtractionInput(sessionKey: string, enabledAt: string): Promise<MemoryExtractionInput | null> {
    const session = await this.database.query<{ source: string; project_path: string; title: string }>(`
      select source, project_path, coalesce(nullif(custom_title, ''), original_title) as title
      from agent_recall.local_sessions where session_key = $1
    `, [sessionKey]);
    const row = session.rows[0];
    if (!row) return null;
    const turns = await this.database.query<{
      turn_index: number; started_at: unknown; user_text: string; assistant_text: string; tool_text: string; tool_names: string[];
    }>(`
      select turns.turn_index, turns.started_at, turns.user_text, turns.assistant_text, turns.tool_text, turns.tool_names
      from agent_recall.session_turns turns
      left join agent_recall.memory_extraction_state state on state.session_key = turns.session_key
      where turns.session_key = $1
        and turns.started_at >= $2::timestamptz
        and turns.turn_index > coalesce(state.last_extracted_turn_index, -1)
        and turns.status <> 'running'
      order by turns.turn_index
    `, [sessionKey, enabledAt]);
    return {
      sessionKey,
      source: row.source,
      projectPath: row.project_path,
      title: row.title,
      turns: turns.rows.map((turn) => ({
        turnIndex: turn.turn_index,
        startedAt: isoValue(turn.started_at),
        userText: turn.user_text,
        assistantText: turn.assistant_text,
        toolText: turn.tool_text,
        toolNames: turn.tool_names,
      })),
    };
  }

  /** Active cards in one project ranked by how many of the given terms they contain. */
  async findSimilarCards(projectPath: string, terms: readonly string[], limit: number): Promise<MemoryCard[]> {
    if (terms.length === 0) return [];
    const result = await this.database.query<CardRow>(`
      ${CARD_SELECT_SQL}
      cross join lateral (
        select count(*) as matched from unnest($2::text[]) pattern where cards.search_text ilike pattern escape '\\'
      ) ranking
      where cards.project_path = $1 and cards.status = 'active' and ranking.matched > 0
      order by ranking.matched desc, cards.updated_at desc
      limit $3
    `, [projectPath, likePatterns(terms), limit]);
    return result.rows.map(hydrateCard);
  }

  /**
   * Applies one validated model batch, appends the Turn range as a source of
   * every touched card and advances the Session cursor. Any missing target card
   * aborts the whole batch.
   */
  async applyExtraction(input: {
    sessionKey: string;
    projectPath: string;
    firstTurnIndex: number;
    lastTurnIndex: number;
    candidateIds: readonly string[];
    operations: readonly MemoryCardOperation[];
    model: string;
    now: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<string[]> {
    return this.database.transaction(async (client) => {
      const created = new Map<string, string>();
      const touched = new Set<string>();
      for (const operation of input.operations) {
        if (operation.op !== "create" && !input.candidateIds.includes(operation.id)) {
          throw new Error(`Experience card ${operation.id} was not offered to the model.`);
        }
        switch (operation.op) {
          case "create": {
            const id = randomUUID();
            const failedAttempts = uniqueTexts(operation.failedAttempts);
            const keywords = uniqueTexts(operation.keywords);
            await client.query(`
              insert into agent_recall.memory_cards (
                id, project_path, kind, problem, solution, failed_attempts, keywords, search_text, model, created_at, updated_at
              ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
            `, [id, input.projectPath, operation.kind, operation.problem, operation.solution, failedAttempts, keywords,
              cardSearchText({ ...operation, failedAttempts, keywords }), input.model, input.now]);
            created.set(operation.ref, id);
            touched.add(id);
            break;
          }
          case "update": {
            const existing = await this.activeCard(client, operation.id, input.projectPath);
            const solution = operation.solution?.trim() ? operation.solution.trim() : existing.solution;
            const previousSolution = solution !== existing.solution ? existing.solution : existing.previousSolution;
            const failedAttempts = uniqueTexts([...existing.failedAttempts, ...operation.failedAttempts]);
            const keywords = uniqueTexts([...existing.keywords, ...operation.keywords]);
            await client.query(`
              update agent_recall.memory_cards
              set solution = $2, previous_solution = $3, failed_attempts = $4, keywords = $5, search_text = $6,
                model = $7, updated_at = $8
              where id = $1
            `, [operation.id, solution, previousSolution, failedAttempts, keywords,
              cardSearchText({ problem: existing.problem, solution, failedAttempts, keywords }), input.model, input.now]);
            touched.add(operation.id);
            break;
          }
          case "confirm":
            await this.activeCard(client, operation.id, input.projectPath);
            touched.add(operation.id);
            break;
          case "supersede": {
            const replacement = created.get(operation.replacedBy);
            if (!replacement) throw new Error(`Experience card ${operation.id} is superseded by an unknown new card.`);
            await this.activeCard(client, operation.id, input.projectPath);
            await client.query(`
              update agent_recall.memory_cards set status = 'superseded', superseded_by = $2, updated_at = $3 where id = $1
            `, [operation.id, replacement, input.now]);
            break;
          }
        }
      }
      for (const cardId of touched) {
        await client.query(`
          insert into agent_recall.memory_card_sources (card_id, session_key, first_turn_index, last_turn_index, created_at)
          values ($1, $2, $3, $4, $5)
        `, [cardId, input.sessionKey, input.firstTurnIndex, input.lastTurnIndex, input.now]);
      }
      await client.query(`
        insert into agent_recall.memory_extraction_state (
          session_key, last_extracted_turn_index, status, attempts, next_retry_at, input_tokens, output_tokens,
          last_error, last_run_at, updated_at
        ) values ($1, $2, $3, 0, null, $4, $5, null, $6, $6)
        on conflict (session_key) do update set
          last_extracted_turn_index = excluded.last_extracted_turn_index,
          status = excluded.status,
          attempts = 0,
          next_retry_at = null,
          input_tokens = case
            when excluded.input_tokens is null then agent_recall.memory_extraction_state.input_tokens
            else coalesce(agent_recall.memory_extraction_state.input_tokens, 0) + excluded.input_tokens end,
          output_tokens = case
            when excluded.output_tokens is null then agent_recall.memory_extraction_state.output_tokens
            else coalesce(agent_recall.memory_extraction_state.output_tokens, 0) + excluded.output_tokens end,
          last_error = null,
          last_run_at = excluded.last_run_at,
          updated_at = excluded.updated_at
      `, [input.sessionKey, input.lastTurnIndex, input.operations.length > 0 ? "succeeded" : "succeeded_no_output",
        input.inputTokens ?? null, input.outputTokens ?? null, input.now]);
      return [...created.values()];
    });
  }

  private async activeCard(client: PostgresQueryable, id: string, projectPath: string): Promise<MemoryCard> {
    const result = await client.query<CardRow>(`${CARD_SELECT_SQL} where cards.id = $1 for update of cards`, [id]);
    const row = result.rows[0];
    if (!row || row.status !== "active" || row.project_path !== projectPath) {
      throw new Error(`Experience card ${id} is missing or no longer active.`);
    }
    return hydrateCard(row);
  }

  /** Exponential backoff from `baseDelayMs`; after `maxAttempts` the Session waits for a manual retry. */
  async recordExtractionFailure(
    sessionKey: string,
    error: string,
    now: string,
    options: { maxAttempts: number; baseDelayMs: number },
  ): Promise<void> {
    await this.database.query(`
      insert into agent_recall.memory_extraction_state (session_key, status, attempts, updated_at)
      values ($1, 'failed', 0, $2)
      on conflict (session_key) do nothing
    `, [sessionKey, now]);
    await this.database.query(`
      update agent_recall.memory_extraction_state
      set status = 'failed',
        attempts = attempts + 1,
        next_retry_at = case when attempts + 1 >= $4 then null
          else $3::timestamptz + make_interval(secs => ($5::bigint * power(2, attempts)) / 1000.0) end,
        last_error = $2,
        last_run_at = $3,
        updated_at = $3
      where session_key = $1
    `, [sessionKey, error.slice(0, 2000), now, options.maxAttempts, options.baseDelayMs]);
  }

  /** Clears failure backoff so failed Sessions are picked again on the next index pass. */
  async retryFailedExtractions(now: string, sessionKey?: string): Promise<number> {
    const result = await this.database.query(`
      update agent_recall.memory_extraction_state
      set status = 'pending', attempts = 0, next_retry_at = null, updated_at = $1
      where status = 'failed' and ($2::text is null or session_key = $2)
    `, [now, sessionKey ?? null]);
    return result.rowCount ?? 0;
  }

  async extractionState(sessionKey: string): Promise<MemoryExtractionState | null> {
    const result = await this.database.query<{
      session_key: string; last_extracted_turn_index: number | null; status: MemoryExtractionStatus; attempts: number;
      next_retry_at: unknown; last_error: string | null; last_run_at: unknown;
    }>("select * from agent_recall.memory_extraction_state where session_key = $1", [sessionKey]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionKey: row.session_key,
      lastExtractedTurnIndex: row.last_extracted_turn_index,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: nullableIsoValue(row.next_retry_at),
      lastError: row.last_error,
      lastRunAt: nullableIsoValue(row.last_run_at),
    };
  }

  async extractionOverview(todayStart: string): Promise<MemoryExtractionOverview> {
    const totals = await this.database.query<Record<string, unknown>>(`
      select
        (select count(*) from agent_recall.memory_cards where status = 'active') as active_cards,
        (select count(*) from agent_recall.memory_cards where status = 'superseded') as superseded_cards,
        count(*) filter (where status in ('succeeded', 'succeeded_no_output')) as processed_sessions,
        count(*) filter (where status in ('succeeded', 'succeeded_no_output') and last_run_at >= $1::timestamptz) as processed_today,
        sum(input_tokens) as input_tokens,
        sum(output_tokens) as output_tokens
      from agent_recall.memory_extraction_state
    `, [todayStart]);
    const failures = await this.database.query<{
      session_key: string; title: string; attempts: number; next_retry_at: unknown; last_error: string | null;
    }>(`
      select state.session_key, coalesce(nullif(sessions.custom_title, ''), sessions.original_title) as title,
        state.attempts, state.next_retry_at, state.last_error
      from agent_recall.memory_extraction_state state
      join agent_recall.sessions sessions on sessions.session_key = state.session_key
      where state.status = 'failed'
      order by state.updated_at desc
      limit 50
    `);
    const row = totals.rows[0] ?? {};
    return {
      activeCards: numberValue(row.active_cards),
      supersededCards: numberValue(row.superseded_cards),
      processedSessions: numberValue(row.processed_sessions),
      processedToday: numberValue(row.processed_today),
      inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : numberValue(row.input_tokens),
      outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : numberValue(row.output_tokens),
      failures: failures.rows.map((failure) => ({
        sessionKey: failure.session_key,
        title: failure.title,
        attempts: failure.attempts,
        nextRetryAt: nullableIsoValue(failure.next_retry_at),
        lastError: failure.last_error ?? "",
      })),
    };
  }

  /** Cards for the Memory page; every query term must occur in the card. */
  async listCards(options: { query?: string; includeSuperseded: boolean; limit?: number }): Promise<MemoryCard[]> {
    const patterns = likePatterns(parseSearchClauses(options.query ?? ""));
    const result = await this.database.query<CardRow>(`
      ${CARD_SELECT_SQL}
      where ($1::boolean or cards.status = 'active')
        and (select bool_and(cards.search_text ilike pattern escape '\\') from unnest($2::text[]) pattern) is not false
      order by cards.project_path, cards.status, cards.updated_at desc
      limit $3
    `, [options.includeSuperseded, patterns, options.limit ?? 500]);
    return result.rows.map(hydrateCard);
  }

  /**
   * Active cards for Agent-facing search. A card must contain at least half of
   * the query terms, so a query that also names details missing from the card
   * still finds it. More matched terms rank first, then the card a Session
   * created, changed or confirmed most recently. Superseded cards are never returned.
   */
  async searchActiveCards(options: { query: string; projectPath?: string; limit?: number }): Promise<MemoryCard[]> {
    const patterns = likePatterns(parseSearchClauses(options.query));
    if (patterns.length === 0) return [];
    const result = await this.database.query<CardRow>(`
      ${CARD_SELECT_SQL}
      cross join lateral (
        select count(*) as matched from unnest($1::text[]) pattern where cards.search_text ilike pattern escape '\\'
      ) ranking
      where cards.status = 'active'
        and ($2::text is null or cards.project_path = $2)
        and ranking.matched * 2 >= cardinality($1::text[])
      order by ranking.matched desc,
        (select max(sources.created_at) from agent_recall.memory_card_sources sources where sources.card_id = cards.id) desc nulls last,
        cards.updated_at desc
      limit $3
    `, [patterns, options.projectPath ?? null, options.limit ?? 5]);
    return result.rows.map(hydrateCard);
  }

  async deleteCard(id: string): Promise<boolean> {
    const result = await this.database.query("delete from agent_recall.memory_cards where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
