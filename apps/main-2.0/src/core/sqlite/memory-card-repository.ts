import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import { escapeLike, parseSearchClauses } from "../session-search-query";
import type {
  MemoryCard,
  MemoryCardKind,
  MemoryCardOperation,
  MemoryCardStatus,
  MemoryExtractionInput,
  MemoryExtractionOverview,
  MemoryExtractionState,
  MemoryExtractionStatus,
} from "../storage/types";
import type { SqliteDatabase, SqliteQueryable } from "./database";
import {
  SQLITE_AGENTRECALL_CREATED_SESSION_SQL,
  canUseFts5Trigram,
  fts5TrigramQuery,
  isoValue,
  nullableIsoValue,
  numberValue,
  optionalTimeMs,
  stringArrayValue,
} from "./session-records";

interface SqliteCardRow extends Record<string, unknown> {
  id: string;
  project_path: string;
  kind: MemoryCardKind;
  problem: string;
  solution: string;
  previous_solution: string | null;
  failed_attempts: string | string[];
  keywords: string | string[];
  status: MemoryCardStatus;
  superseded_by: string | null;
  model: string;
  created_at: number | string;
  updated_at: number | string;
  sources: string | Array<{ session_key: string; first_turn_index: number; last_turn_index: number; last_turn_at: unknown }> | null;
}

const CARD_SELECT_SQL = `
  select cards.*,
    (
      select json_group_array(
        json_object(
          'session_key', sources.session_key,
          'first_turn_index', sources.first_turn_index,
          'last_turn_index', sources.last_turn_index,
          'last_turn_at', coalesce(turns.started_at, sources.created_at)
        )
        order by sources.id
      )
      from memory_card_sources sources
      left join session_turns turns
        on turns.session_key = sources.session_key and turns.turn_index = sources.last_turn_index
      where sources.card_id = cards.id
    ) as sources
  from memory_cards cards
`;

function parseSources(
  value: SqliteCardRow["sources"],
): Array<{ session_key: string; first_turn_index: number; last_turn_index: number; last_turn_at: unknown }> {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hydrateCard(row: SqliteCardRow): MemoryCard {
  return {
    id: row.id,
    projectPath: row.project_path,
    kind: row.kind,
    problem: row.problem,
    solution: row.solution,
    previousSolution: row.previous_solution,
    failedAttempts: stringArrayValue(row.failed_attempts),
    keywords: stringArrayValue(row.keywords),
    status: row.status,
    supersededBy: row.superseded_by,
    model: row.model,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
    sources: parseSources(row.sources).map((source) => ({
      sessionKey: source.session_key,
      firstTurnIndex: Number(source.first_turn_index),
      lastTurnIndex: Number(source.last_turn_index),
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

function cardSearchText(card: {
  problem: string;
  solution: string;
  failedAttempts: readonly string[];
  keywords: readonly string[];
}): string {
  return [card.problem, card.solution, ...card.failedAttempts, ...card.keywords].join("\n");
}

function cardTermPredicate(term: string, params: SQLInputValue[]): string {
  if (canUseFts5Trigram(term)) {
    params.push(fts5TrigramQuery(term));
    return "cards.rowid in (select rowid from memory_cards_fts where memory_cards_fts match ?)";
  }
  params.push(`%${escapeLike(term)}%`);
  return "cards.search_text like ? escape '\\'";
}

export class SqliteMemoryCardRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async pickExtractionSessions(options: { enabledAt: string; now: string; limit: number }): Promise<string[]> {
    const enabledAtMs = optionalTimeMs(options.enabledAt) ?? 0;
    const nowMs = optionalTimeMs(options.now) ?? Date.now();
    return this.database.transaction(async (tx) => {
      const turnRows = tx.all<{
        session_key: string;
        turn_index: number;
        status: string;
        started_at: number;
        user_len: number;
        assistant_len: number;
        tool_len: number;
      }>(
        `
          select
            turns.session_key,
            turns.turn_index,
            turns.status,
            turns.started_at,
            length(turns.user_text) as user_len,
            length(turns.assistant_text) as assistant_len,
            length(turns.tool_text) as tool_len
          from session_turns turns
          join local_sessions sessions on sessions.session_key = turns.session_key
          left join memory_extraction_state state on state.session_key = turns.session_key
          where turns.started_at >= ?
            and turns.turn_index > coalesce(state.last_extracted_turn_index, -1)
            and not (${SQLITE_AGENTRECALL_CREATED_SESSION_SQL})
          order by turns.session_key, turns.turn_index
        `,
        enabledAtMs,
      );

      const grouped = new Map<string, { parts: string[]; running: boolean; latestAt: number }>();
      for (const row of turnRows) {
        const entry = grouped.get(row.session_key) ?? { parts: [], running: false, latestAt: -Infinity };
        entry.parts.push(`${row.turn_index}:${row.status}:${row.user_len}:${row.assistant_len}:${row.tool_len}`);
        if (row.status === "running") entry.running = true;
        if (Number(row.started_at) > entry.latestAt) entry.latestAt = Number(row.started_at);
        grouped.set(row.session_key, entry);
      }

      const ready: Array<{ sessionKey: string; latestAt: number }> = [];
      for (const [sessionKey, info] of grouped) {
        const signature = createHash("md5").update(info.parts.join(",")).digest("hex");
        const existing = tx.get<{
          observed_signature: string | null;
          status: MemoryExtractionStatus;
          next_retry_at: number | null;
        }>(
          "select observed_signature, status, next_retry_at from memory_extraction_state where session_key = ?",
          sessionKey,
        );
        if (!existing) {
          tx.run(
            `
              insert into memory_extraction_state (session_key, observed_signature, status, updated_at)
              values (?, ?, 'pending', ?)
            `,
            sessionKey,
            signature,
            nowMs,
          );
          continue;
        }
        if (existing.observed_signature !== signature) {
          tx.run(
            `
              update memory_extraction_state
              set observed_signature = ?, updated_at = ?
              where session_key = ?
            `,
            signature,
            nowMs,
            sessionKey,
          );
          continue;
        }
        if (info.running) continue;
        if (existing.next_retry_at !== null && Number(existing.next_retry_at) > nowMs) continue;
        if (existing.status === "failed" && existing.next_retry_at === null) continue;
        ready.push({ sessionKey, latestAt: info.latestAt });
      }

      ready.sort((left, right) =>
        right.latestAt - left.latestAt
        || (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0));
      return ready.slice(0, Math.max(0, options.limit)).map((item) => item.sessionKey);
    });
  }

  async loadExtractionInput(sessionKey: string, enabledAt: string): Promise<MemoryExtractionInput | null> {
    const enabledAtMs = optionalTimeMs(enabledAt) ?? 0;
    const row = this.database.get<{ source: string; project_path: string; title: string }>(
      `
        select source, project_path, coalesce(nullif(custom_title, ''), original_title) as title
        from local_sessions where session_key = ?
      `,
      sessionKey,
    );
    if (!row) return null;
    const turns = this.database.all<{
      turn_index: number;
      started_at: number | string | null;
      user_text: string;
      assistant_text: string;
      tool_text: string;
      tool_names: string;
    }>(
      `
        select turns.turn_index, turns.started_at, turns.user_text, turns.assistant_text, turns.tool_text, turns.tool_names
        from session_turns turns
        left join memory_extraction_state state on state.session_key = turns.session_key
        where turns.session_key = ?
          and turns.started_at >= ?
          and turns.turn_index > coalesce(state.last_extracted_turn_index, -1)
          and turns.status <> 'running'
        order by turns.turn_index
      `,
      sessionKey,
      enabledAtMs,
    );
    return {
      sessionKey,
      source: row.source,
      projectPath: row.project_path,
      title: row.title,
      turns: turns.map((turn) => ({
        turnIndex: Number(turn.turn_index),
        startedAt: isoValue(turn.started_at),
        userText: turn.user_text,
        assistantText: turn.assistant_text,
        toolText: turn.tool_text,
        toolNames: stringArrayValue(turn.tool_names),
      })),
    };
  }

  async findSimilarCards(projectPath: string, terms: readonly string[], limit: number): Promise<MemoryCard[]> {
    if (terms.length === 0) return [];
    const params: SQLInputValue[] = [];
    const matchExprs = terms.map((term) => `(case when ${cardTermPredicate(term, params)} then 1 else 0 end)`);
    const matchedExpr = matchExprs.join(" + ");
    params.push(projectPath, Math.max(0, limit));
    const rows = this.database.all<SqliteCardRow>(
      `
        select ranked.* from (
          select
            cards.*,
            (${matchedExpr}) as matched,
            (
              select json_group_array(
                json_object(
                  'session_key', sources.session_key,
                  'first_turn_index', sources.first_turn_index,
                  'last_turn_index', sources.last_turn_index,
                  'last_turn_at', coalesce(turns.started_at, sources.created_at)
                )
                order by sources.id
              )
              from memory_card_sources sources
              left join session_turns turns
                on turns.session_key = sources.session_key and turns.turn_index = sources.last_turn_index
              where sources.card_id = cards.id
            ) as sources
          from memory_cards cards
          where cards.project_path = ? and cards.status = 'active'
        ) ranked
        where ranked.matched > 0
        order by ranked.matched desc, ranked.updated_at desc
        limit ?
      `,
      ...params,
    );
    return rows.map(hydrateCard);
  }

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
    const nowMs = optionalTimeMs(input.now) ?? Date.now();
    return this.database.transaction(async (tx) => {
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
            tx.run(
              `
                insert into memory_cards (
                  id, project_path, kind, problem, solution, failed_attempts, keywords, search_text, model, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              id,
              input.projectPath,
              operation.kind,
              operation.problem,
              operation.solution,
              JSON.stringify(failedAttempts),
              JSON.stringify(keywords),
              cardSearchText({ ...operation, failedAttempts, keywords }),
              input.model,
              nowMs,
              nowMs,
            );
            created.set(operation.ref, id);
            touched.add(id);
            break;
          }
          case "update": {
            const existing = this.activeCard(tx, operation.id, input.projectPath);
            const solution = operation.solution?.trim() ? operation.solution.trim() : existing.solution;
            const previousSolution = solution !== existing.solution ? existing.solution : existing.previousSolution;
            const failedAttempts = uniqueTexts([...existing.failedAttempts, ...operation.failedAttempts]);
            const keywords = uniqueTexts([...existing.keywords, ...operation.keywords]);
            tx.run(
              `
                update memory_cards
                set solution = ?, previous_solution = ?, failed_attempts = ?, keywords = ?, search_text = ?,
                  model = ?, updated_at = ?
                where id = ?
              `,
              solution,
              previousSolution,
              JSON.stringify(failedAttempts),
              JSON.stringify(keywords),
              cardSearchText({ problem: existing.problem, solution, failedAttempts, keywords }),
              input.model,
              nowMs,
              operation.id,
            );
            touched.add(operation.id);
            break;
          }
          case "confirm":
            this.activeCard(tx, operation.id, input.projectPath);
            touched.add(operation.id);
            break;
          case "supersede": {
            const replacement = created.get(operation.replacedBy);
            if (!replacement) throw new Error(`Experience card ${operation.id} is superseded by an unknown new card.`);
            this.activeCard(tx, operation.id, input.projectPath);
            tx.run(
              "update memory_cards set status = 'superseded', superseded_by = ?, updated_at = ? where id = ?",
              replacement,
              nowMs,
              operation.id,
            );
            break;
          }
        }
      }
      for (const cardId of touched) {
        tx.run(
          `
            insert into memory_card_sources (card_id, session_key, first_turn_index, last_turn_index, created_at)
            values (?, ?, ?, ?, ?)
          `,
          cardId,
          input.sessionKey,
          input.firstTurnIndex,
          input.lastTurnIndex,
          nowMs,
        );
      }
      tx.run(
        `
          insert into memory_extraction_state (
            session_key, last_extracted_turn_index, status, attempts, next_retry_at, input_tokens, output_tokens,
            last_error, last_run_at, updated_at
          ) values (?, ?, ?, 0, null, ?, ?, null, ?, ?)
          on conflict (session_key) do update set
            last_extracted_turn_index = excluded.last_extracted_turn_index,
            status = excluded.status,
            attempts = 0,
            next_retry_at = null,
            input_tokens = case
              when excluded.input_tokens is null then memory_extraction_state.input_tokens
              else coalesce(memory_extraction_state.input_tokens, 0) + excluded.input_tokens end,
            output_tokens = case
              when excluded.output_tokens is null then memory_extraction_state.output_tokens
              else coalesce(memory_extraction_state.output_tokens, 0) + excluded.output_tokens end,
            last_error = null,
            last_run_at = excluded.last_run_at,
            updated_at = excluded.updated_at
        `,
        input.sessionKey,
        input.lastTurnIndex,
        input.operations.length > 0 ? "succeeded" : "succeeded_no_output",
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        nowMs,
        nowMs,
      );
      return [...created.values()];
    });
  }

  private activeCard(tx: SqliteQueryable, id: string, projectPath: string): MemoryCard {
    const row = tx.get<SqliteCardRow>(`${CARD_SELECT_SQL} where cards.id = ?`, id);
    if (!row || row.status !== "active" || row.project_path !== projectPath) {
      throw new Error(`Experience card ${id} is missing or no longer active.`);
    }
    return hydrateCard(row);
  }

  async recordExtractionFailure(
    sessionKey: string,
    error: string,
    now: string,
    options: { maxAttempts: number; baseDelayMs: number },
  ): Promise<void> {
    const nowMs = optionalTimeMs(now) ?? Date.now();
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert or ignore into memory_extraction_state (session_key, status, attempts, updated_at)
          values (?, 'failed', 0, ?)
        `,
        sessionKey,
        nowMs,
      );
      const existing = tx.get<{ attempts: number }>(
        "select attempts from memory_extraction_state where session_key = ?",
        sessionKey,
      );
      const previousAttempts = Number(existing?.attempts ?? 0);
      const nextAttempts = previousAttempts + 1;
      const nextRetryAt = nextAttempts >= options.maxAttempts
        ? null
        : Math.trunc(nowMs + options.baseDelayMs * Math.pow(2, previousAttempts));
      tx.run(
        `
          update memory_extraction_state
          set status = 'failed',
            attempts = ?,
            next_retry_at = ?,
            last_error = ?,
            last_run_at = ?,
            updated_at = ?
          where session_key = ?
        `,
        nextAttempts,
        nextRetryAt,
        error.slice(0, 2000),
        nowMs,
        nowMs,
        sessionKey,
      );
    });
  }

  async retryFailedExtractions(now: string, sessionKey?: string): Promise<number> {
    const nowMs = optionalTimeMs(now) ?? Date.now();
    const result = this.database.run(
      `
        update memory_extraction_state
        set status = 'pending', attempts = 0, next_retry_at = null, updated_at = ?
        where status = 'failed' and (? is null or session_key = ?)
      `,
      nowMs,
      sessionKey ?? null,
      sessionKey ?? null,
    );
    return result.changes;
  }

  async extractionState(sessionKey: string): Promise<MemoryExtractionState | null> {
    const row = this.database.get<{
      session_key: string;
      last_extracted_turn_index: number | null;
      status: MemoryExtractionStatus;
      attempts: number;
      next_retry_at: number | null;
      last_error: string | null;
      last_run_at: number | null;
    }>("select * from memory_extraction_state where session_key = ?", sessionKey);
    if (!row) return null;
    return {
      sessionKey: row.session_key,
      lastExtractedTurnIndex: row.last_extracted_turn_index,
      status: row.status,
      attempts: Number(row.attempts),
      nextRetryAt: nullableIsoValue(row.next_retry_at),
      lastError: row.last_error,
      lastRunAt: nullableIsoValue(row.last_run_at),
    };
  }

  async extractionOverview(todayStart: string): Promise<MemoryExtractionOverview> {
    const todayStartMs = optionalTimeMs(todayStart) ?? 0;
    const row = this.database.get<Record<string, unknown>>(
      `
        select
          (select count(*) from memory_cards where status = 'active') as active_cards,
          (select count(*) from memory_cards where status = 'superseded') as superseded_cards,
          count(*) filter (where status in ('succeeded', 'succeeded_no_output')) as processed_sessions,
          count(*) filter (where status in ('succeeded', 'succeeded_no_output') and last_run_at >= ?) as processed_today,
          sum(input_tokens) as input_tokens,
          sum(output_tokens) as output_tokens
        from memory_extraction_state
      `,
      todayStartMs,
    ) ?? {};
    const failures = this.database.all<{
      session_key: string;
      title: string;
      attempts: number;
      next_retry_at: number | null;
      last_error: string | null;
    }>(
      `
        select state.session_key, coalesce(nullif(sessions.custom_title, ''), sessions.original_title) as title,
          state.attempts, state.next_retry_at, state.last_error
        from memory_extraction_state state
        join sessions on sessions.session_key = state.session_key
        where state.status = 'failed'
        order by state.updated_at desc
        limit 50
      `,
    );
    return {
      activeCards: numberValue(row.active_cards),
      supersededCards: numberValue(row.superseded_cards),
      processedSessions: numberValue(row.processed_sessions),
      processedToday: numberValue(row.processed_today),
      inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : numberValue(row.input_tokens),
      outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : numberValue(row.output_tokens),
      failures: failures.map((failure) => ({
        sessionKey: failure.session_key,
        title: failure.title,
        attempts: Number(failure.attempts),
        nextRetryAt: nullableIsoValue(failure.next_retry_at),
        lastError: failure.last_error ?? "",
      })),
    };
  }

  async listCards(options: { query?: string; includeSuperseded: boolean; limit?: number }): Promise<MemoryCard[]> {
    const clauses = parseSearchClauses(options.query ?? "");
    const params: SQLInputValue[] = [];
    const conditions: string[] = [];
    if (!options.includeSuperseded) conditions.push("cards.status = 'active'");
    for (const clause of clauses) {
      conditions.push(cardTermPredicate(clause, params));
    }
    params.push(options.limit ?? 500);
    const rows = this.database.all<SqliteCardRow>(
      `
        ${CARD_SELECT_SQL}
        ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        order by cards.project_path, cards.status, cards.updated_at desc
        limit ?
      `,
      ...params,
    );
    return rows.map(hydrateCard);
  }

  async searchActiveCards(options: { query: string; projectPath?: string; limit?: number }): Promise<MemoryCard[]> {
    const clauses = parseSearchClauses(options.query);
    if (clauses.length === 0) return [];
    const params: SQLInputValue[] = [];
    const matchExprs = clauses.map((clause) => `(case when ${cardTermPredicate(clause, params)} then 1 else 0 end)`);
    const matchedExpr = matchExprs.join(" + ");
    params.push(options.projectPath ?? null, options.projectPath ?? null, clauses.length, options.limit ?? 5);
    const rows = this.database.all<SqliteCardRow>(
      `
        select ranked.* from (
          select
            cards.*,
            (${matchedExpr}) as matched,
            (select max(sources.created_at) from memory_card_sources sources where sources.card_id = cards.id) as latest_source_at,
            (
              select json_group_array(
                json_object(
                  'session_key', sources.session_key,
                  'first_turn_index', sources.first_turn_index,
                  'last_turn_index', sources.last_turn_index,
                  'last_turn_at', coalesce(turns.started_at, sources.created_at)
                )
                order by sources.id
              )
              from memory_card_sources sources
              left join session_turns turns
                on turns.session_key = sources.session_key and turns.turn_index = sources.last_turn_index
              where sources.card_id = cards.id
            ) as sources
          from memory_cards cards
          where cards.status = 'active'
            and (? is null or cards.project_path = ?)
        ) ranked
        where ranked.matched * 2 >= ?
        order by ranked.matched desc, ranked.latest_source_at desc nulls last, ranked.updated_at desc
        limit ?
      `,
      ...params,
    );
    return rows.map(hydrateCard);
  }

  async deleteCard(id: string): Promise<boolean> {
    return this.database.run("delete from memory_cards where id = ?", id).changes > 0;
  }
}
