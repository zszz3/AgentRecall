import type {
  IndexedSession,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  SearchOptions,
  SessionDailyTokenUsage,
  SessionMatchHit,
  SessionMessage,
  SessionMessageEvent,
  SessionSearchPage,
  SessionSearchResult,
  SessionSource,
  SessionStats,
  SessionStatsOptions,
  SessionStatsPeriod,
  SessionStatsSummary,
  SessionTraceEvent,
  SessionTurnMatch,
  TagListOptions,
  TokenUsage,
  TokenUsageEvent,
} from "../types";
import {
  deriveSessionTimeline,
  type DerivedRawEvent,
  type DerivedSessionTurn,
} from "../turns/derive-turns";
import type { PostgresDatabase, PostgresQueryable } from "./database";

export interface TraceEventQueryOptions {
  startTimestamp?: string;
  endTimestamp?: string;
  limit?: number;
}

interface SessionRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_kind: "local" | "ssh";
  environment_label: string;
  project_path: string;
  file_path: string;
  original_title: string;
  first_question: string;
  started_at: Date | string;
  file_mtime_ms: number | string;
  file_size: number | string;
  pr_url: string | null;
  pr_number: number | null;
  custom_title: string | null;
  favorited: boolean;
  pinned: boolean;
  hidden: boolean;
  last_opened_at: Date | string | null;
  last_resumed_at: Date | string | null;
  last_activity_at: Date | string;
  message_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_input_tokens: number | string;
  reasoning_output_tokens: number | string;
  total_tokens: number | string;
  indexed_at: Date | string;
  is_subagent: boolean;
  parent_session_id: string | null;
  ai_summary: string | null;
  ai_summary_at: Date | string | null;
  ai_summary_basis: number | string | null;
  tag_names: string[] | null;
  total_count?: number | string;
  best_turn_id?: string | null;
  best_turn_index?: number | string | null;
  best_source_message_index?: number | string | null;
  best_turn_started_at?: Date | string | null;
  best_turn_search_text?: string | null;
  turn_match_count?: number | string | null;
}

const SESSION_ACTIVITY_SQL = `
  coalesce(
    (
      select max(coalesce(turns.ended_at, turns.started_at))
      from agent_recall.session_turns turns
      where turns.session_key = sessions.session_key
    ),
    case
      when sessions.file_mtime_ms > 0 then to_timestamp(sessions.file_mtime_ms / 1000.0)
      else sessions.started_at
    end,
    sessions.started_at
  )
`;

const SESSION_SELECT_SQL = `
  sessions.*,
  environments.kind as environment_kind,
  environments.label as environment_label,
  ${SESSION_ACTIVITY_SQL} as last_activity_at,
  coalesce(
    (
      select array_agg(tags.name order by lower(tags.name))
      from agent_recall.session_tags
      join agent_recall.tags on tags.id = session_tags.tag_id
      where session_tags.session_key = sessions.session_key
    ),
    array[]::text[]
  ) as tag_names
`;

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function timeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isoValue(value: unknown): string {
  const timestamp = timeValue(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function normalizedTokenUsage(usage?: TokenUsage): TokenUsage {
  const inputTokens = numberValue(usage?.inputTokens);
  const outputTokens = numberValue(usage?.outputTokens);
  const cachedInputTokens = numberValue(usage?.cachedInputTokens);
  const reasoningOutputTokens = numberValue(usage?.reasoningOutputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens,
  };
}

function tokenUsageFromEvents(events: readonly TokenUsageEvent[], fallback?: TokenUsage): TokenUsage {
  if (events.length === 0) return normalizedTokenUsage(fallback);
  return events.reduce<TokenUsage>(
    (total, event) => ({
      inputTokens: total.inputTokens + numberValue(event.inputTokens),
      outputTokens: total.outputTokens + numberValue(event.outputTokens),
      cachedInputTokens: total.cachedInputTokens + numberValue(event.cachedInputTokens),
      reasoningOutputTokens: total.reasoningOutputTokens + numberValue(event.reasoningOutputTokens),
      totalTokens: total.totalTokens + numberValue(event.totalTokens),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  );
}

function branchTagName(branch: string | null | undefined): string | null {
  const normalized = branch?.trim();
  return normalized ? `branch:${normalized}` : null;
}

function projectParts(projectPath: string): string[] {
  return projectPath.split(/[\\/]+/u).filter(Boolean);
}

function projectBasename(projectPath: string): string {
  return projectParts(projectPath).at(-1) || projectPath;
}

function projectParentLabel(projectPath: string): string {
  const parts = projectParts(projectPath);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : projectBasename(projectPath);
}

interface StatsRange {
  period: SessionStatsPeriod;
  since: number | null;
  until: number;
}

function resolveStatsRange(options: SessionStatsOptions, now: number): StatsRange {
  const period = options.period ?? "allTime";
  if (period === "allTime") return { period, since: null, until: now };
  if (period === "today") {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return { period, since: date.getTime(), until: now };
  }
  const days = period === "thirtyDay" ? 30 : 7;
  return { period, since: now - days * 24 * 60 * 60 * 1000, until: now };
}

function dailyRanges(now: number): Array<Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const start = new Date(today);
    start.setDate(today.getDate() - (6 - index));
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { dayStart: start.getTime(), dayEndExclusive: end.getTime() };
  });
}

function emptyStatsSummary(): SessionStatsSummary {
  return {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function jsonValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function parseSearchClauses(query: string): string[] {
  const clauses: string[] = [];
  const expression = /"([^"]+)"|(\S+)/gu;
  for (const match of query.matchAll(expression)) {
    const value = (match[1] || match[2] || "").trim();
    if (!value || value.toLocaleLowerCase() === "and") continue;
    if (!clauses.includes(value)) clauses.push(value);
  }
  return clauses;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function searchTerms(clauses: readonly string[]): string[] {
  return clauses.map((clause) => clause.toLocaleLowerCase());
}

function snippet(value: string, terms: readonly string[]): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const lower = normalized.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const firstMatch = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, firstMatch - 70);
  const end = Math.min(normalized.length, firstMatch + 190);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

function metadataMatch(row: SessionSearchResult, terms: readonly string[]): SessionSearchResult["metadataMatch"] {
  const includesAll = (value: string) => {
    const lower = value.toLocaleLowerCase();
    return terms.every((term) => lower.includes(term));
  };
  if (includesAll(`${row.displayTitle} ${row.originalTitle} ${row.firstQuestion}`)) return "title";
  if (includesAll(row.projectPath)) return "project";
  return row.aiSummary && includesAll(row.aiSummary) ? "summary" : null;
}

function bestTurnFromRow(row: SessionRow, terms: readonly string[]): SessionTurnMatch | null {
  if (!row.best_turn_id || row.best_turn_index === null || row.best_turn_index === undefined) return null;
  const searchText = row.best_turn_search_text || "";
  return {
    turnId: row.best_turn_id,
    turnIndex: numberValue(row.best_turn_index),
    sourceMessageIndex:
      row.best_source_message_index === null || row.best_source_message_index === undefined
        ? null
        : numberValue(row.best_source_message_index),
    startedAt: row.best_turn_started_at ? timeValue(row.best_turn_started_at) : null,
    snippet: snippet(searchText, terms),
    matchedTerms: terms.filter((term) => searchText.toLocaleLowerCase().includes(term)),
  };
}

function hydrateSession(row: SessionRow, queryTerms: readonly string[] = []): SessionSearchResult {
  const displayTitle = row.custom_title || row.original_title || row.first_question || "Untitled Session";
  const bestTurn = bestTurnFromRow(row, queryTerms);
  const result: SessionSearchResult = {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    source: row.source,
    environmentId: row.environment_id,
    environmentKind: row.environment_kind,
    environmentLabel: row.environment_label,
    projectPath: row.project_path,
    filePath: row.file_path,
    originalTitle: row.original_title,
    firstQuestion: row.first_question,
    timestamp: timeValue(row.started_at),
    fileMtimeMs: numberValue(row.file_mtime_ms),
    fileSize: numberValue(row.file_size),
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    tokenUsage: {
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      cachedInputTokens: numberValue(row.cached_input_tokens),
      reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
      totalTokens: numberValue(row.total_tokens),
    },
    customTitle: row.custom_title,
    displayTitle,
    favorited: Boolean(row.favorited),
    pinned: Boolean(row.pinned),
    hidden: Boolean(row.hidden),
    tags: row.tag_names ?? [],
    matchSnippet: bestTurn?.snippet ?? null,
    lastOpenedAt: row.last_opened_at ? timeValue(row.last_opened_at) : null,
    lastResumedAt: row.last_resumed_at ? timeValue(row.last_resumed_at) : null,
    lastActivityAt: timeValue(row.last_activity_at),
    messageCount: numberValue(row.message_count),
    aiSummary: row.ai_summary?.trim() || null,
    aiSummaryStale: Boolean(row.ai_summary) && numberValue(row.file_mtime_ms) > numberValue(row.ai_summary_basis),
    matchHits: [],
    messageMatchCount: 0,
    metadataMatch: null,
    isSubagent: Boolean(row.is_subagent),
    parentSessionId: row.parent_session_id,
    bestTurn,
    turnMatchCount: numberValue(row.turn_match_count),
  };
  if (queryTerms.length > 0 && !bestTurn) result.metadataMatch = metadataMatch(result, queryTerms);
  return result;
}

async function insertRawEvent(
  client: PostgresQueryable,
  sessionKey: string,
  event: DerivedRawEvent,
): Promise<void> {
  await client.query(
    `
      insert into agent_recall.session_raw_events (
        session_key, event_index, event_id, kind, role, occurred_at, payload
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      sessionKey,
      event.eventIndex,
      event.eventId,
      event.kind,
      event.role,
      event.occurredAt,
      JSON.stringify(event.payload),
    ],
  );
}

async function insertTurn(
  client: PostgresQueryable,
  sessionKey: string,
  turn: DerivedSessionTurn,
): Promise<void> {
  await client.query(
    `
      insert into agent_recall.session_turns (
        id, session_key, turn_index, source_message_index, synthetic, status,
        started_at, ended_at, user_text, assistant_text, tool_text, search_text,
        input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
        total_tokens, error_count, tool_names, derivation_version
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20
      )
    `,
    [
      turn.id,
      sessionKey,
      turn.turnIndex,
      turn.sourceMessageIndex,
      turn.synthetic,
      turn.status,
      turn.startedAt,
      turn.endedAt,
      turn.userText,
      turn.assistantText,
      turn.toolText,
      turn.searchText,
      turn.inputTokens,
      turn.outputTokens,
      turn.cachedInputTokens,
      turn.reasoningOutputTokens,
      turn.totalTokens,
      turn.errorCount,
      turn.toolNames,
      turn.derivationVersion,
    ],
  );

  for (const message of turn.messages) {
    await client.query(
      `
        insert into agent_recall.turn_messages (
          turn_id, message_index, source_message_index, role, content, occurred_at, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        turn.id,
        message.messageIndex,
        message.sourceMessageIndex,
        message.role,
        message.content,
        message.occurredAt,
        JSON.stringify(message.metadata),
      ],
    );
  }

  for (const span of turn.spans) {
    await client.query(
      `
        insert into agent_recall.trace_spans (
          id, turn_id, parent_span_id, span_index, kind, name, status,
          started_at, ended_at, call_id, input, output, error, attributes
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb
        )
      `,
      [
        span.id,
        turn.id,
        span.parentSpanId,
        span.spanIndex,
        span.kind,
        span.name,
        span.status,
        span.startedAt,
        span.endedAt,
        span.callId,
        span.input ? JSON.stringify(span.input) : null,
        span.output ? JSON.stringify(span.output) : null,
        span.error,
        JSON.stringify(span.attributes),
      ],
    );
  }
}

export class PostgresSessionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents: readonly TokenUsageEvent[] = [],
    traceEvents: readonly SessionTraceEvent[] = [],
  ): Promise<void> {
    const timeline = deriveSessionTimeline({
      sessionKey: session.sessionKey,
      messages,
      tokenEvents,
      traceEvents,
    });
    const tokenUsage = tokenUsageFromEvents(tokenEvents, session.tokenUsage);
    const environmentId = session.environmentId || "local";
    const startedAt = new Date(Math.max(0, numberValue(session.timestamp))).toISOString();

    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values ($1, $2, $3, 'none', true, 'idle', now(), now())
          on conflict (id) do nothing
        `,
        [
          environmentId,
          session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
          session.environmentLabel || (environmentId === "local" ? "This Mac" : environmentId),
        ],
      );
      await client.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            is_subagent, parent_session_id
          )
          values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17,
            $18, $19, $20, now(), $21, $22
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            started_at = excluded.started_at,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count,
            turn_count = excluded.turn_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
          session.projectPath,
          session.filePath,
          session.originalTitle,
          session.firstQuestion,
          startedAt,
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          messages.length,
          timeline.turns.length,
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          Boolean(session.isSubagent),
          session.parentSessionId ?? null,
        ],
      );

      await client.query("delete from agent_recall.session_raw_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_message_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_turns where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.token_events where session_key = $1", [session.sessionKey]);

      for (const event of timeline.rawEvents) await insertRawEvent(client, session.sessionKey, event);
      for (const message of messages) {
        const occurredAt = Date.parse(message.timestamp);
        await client.query(
          `
            insert into agent_recall.session_message_events (
              session_key, message_index, occurred_at
            )
            values ($1, $2, $3)
          `,
          [
            session.sessionKey,
            message.index,
            new Date(Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : 0).toISOString(),
          ],
        );
      }
      for (const turn of timeline.turns) await insertTurn(client, session.sessionKey, turn);
      for (const event of tokenEvents) {
        await client.query(
          `
            insert into agent_recall.token_events (
              session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
              cached_input_tokens, reasoning_output_tokens, total_tokens
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            session.sessionKey,
            event.dedupeKey,
            new Date(Math.max(0, event.timestamp)).toISOString(),
            event.inputTokens,
            event.outputTokens,
            event.cachedInputTokens,
            event.reasoningOutputTokens,
            event.totalTokens,
          ],
        );
      }

      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) await this.addTagWithClient(client, session.sessionKey, branchTag);
    });
  }

  async upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: readonly TokenUsageEvent[],
    messageEvents?: readonly SessionMessageEvent[],
  ): Promise<void> {
    const tokenUsage = tokenUsageFromEvents(tokenEvents ?? [], session.tokenUsage);
    const environmentId = session.environmentId || "local";
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values ($1, $2, $3, 'none', true, 'idle', now(), now())
          on conflict (id) do nothing
        `,
        [
          environmentId,
          session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
          session.environmentLabel || (environmentId === "local" ? "Local" : environmentId),
        ],
      );
      await client.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            is_subagent, parent_session_id
          )
          values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, 0, $15, $16,
            $17, $18, $19, now(), $20, $21
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            started_at = excluded.started_at,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
          session.projectPath,
          session.filePath,
          session.originalTitle,
          session.firstQuestion,
          new Date(Math.max(0, session.timestamp)).toISOString(),
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          Math.max(0, Math.floor(messageCount)),
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          Boolean(session.isSubagent),
          session.parentSessionId ?? null,
        ],
      );

      if (tokenEvents !== undefined) {
        await client.query("delete from agent_recall.token_events where session_key = $1", [session.sessionKey]);
        for (const event of tokenEvents) {
          await client.query(
            `
              insert into agent_recall.token_events (
                session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
                cached_input_tokens, reasoning_output_tokens, total_tokens
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              session.sessionKey,
              event.dedupeKey,
              new Date(Math.max(0, event.timestamp)).toISOString(),
              event.inputTokens,
              event.outputTokens,
              event.cachedInputTokens,
              event.reasoningOutputTokens,
              event.totalTokens,
            ],
          );
        }
      }
      if (messageEvents !== undefined) {
        await client.query("delete from agent_recall.session_message_events where session_key = $1", [session.sessionKey]);
        for (const event of messageEvents) {
          await client.query(
            `
              insert into agent_recall.session_message_events (
                session_key, message_index, occurred_at
              )
              values ($1, $2, $3)
            `,
            [
              session.sessionKey,
              event.index,
              new Date(Math.max(0, event.timestamp)).toISOString(),
            ],
          );
        }
      }
      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) await this.addTagWithClient(client, session.sessionKey, branchTag);
    });
  }

  async isIndexedSessionFresh(session: IndexedSession): Promise<boolean> {
    if (session.fileMtimeMs <= 0 && session.fileSize <= 0) return false;
    const result = await this.database.query<{
      raw_id: string;
      source: SessionSource;
      environment_id: string;
      project_path: string;
      file_path: string;
      original_title: string;
      first_question: string;
      started_at: Date | string;
      file_mtime_ms: number | string;
      file_size: number | string;
      pr_url: string | null;
      pr_number: number | string | null;
      is_subagent: boolean;
      parent_session_id: string | null;
    }>(
      `
        select raw_id, source, environment_id, project_path, file_path,
          original_title, first_question, started_at, file_mtime_ms, file_size,
          pr_url, pr_number, is_subagent, parent_session_id
        from agent_recall.sessions
        where session_key = $1
      `,
      [session.sessionKey],
    );
    const row = result.rows[0];
    return Boolean(
      row
      && row.raw_id === session.rawId
      && row.source === session.source
      && row.environment_id === (session.environmentId || "local")
      && row.project_path === session.projectPath
      && row.file_path === session.filePath
      && row.original_title === session.originalTitle
      && row.first_question === session.firstQuestion
      && timeValue(row.started_at) === session.timestamp
      && Math.abs(numberValue(row.file_mtime_ms) - session.fileMtimeMs) < 0.001
      && numberValue(row.file_size) === session.fileSize
      && (row.pr_url ?? null) === (session.prUrl ?? null)
      && (row.pr_number === null ? null : numberValue(row.pr_number)) === (session.prNumber ?? null)
      && Boolean(row.is_subagent) === Boolean(session.isSubagent)
      && (row.parent_session_id ?? null) === (session.parentSessionId ?? null),
    );
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    await this.database.query(
      `
        update agent_recall.sessions
        set indexed_at = now()
        where session_key = $1 and indexed_at <= to_timestamp(0)
      `,
      [sessionKey],
    );
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>> {
    const result = await this.database.query<{
      file_path: string;
      file_mtime_ms: number | string;
      file_size: number | string;
      indexed_at: Date | string;
    }>(
      `
        select file_path, file_mtime_ms, file_size, indexed_at
        from agent_recall.sessions
        where environment_id = $1 and file_path <> ''
        order by file_path
      `,
      [environmentId],
    );
    return result.rows.map((row) => ({
      filePath: row.file_path,
      fileMtimeMs: numberValue(row.file_mtime_ms),
      fileSize: numberValue(row.file_size),
      indexedAt: timeValue(row.indexed_at),
    }));
  }

  async setCustomTitle(sessionKey: string, title: string | null): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set custom_title = $2 where session_key = $1",
      [sessionKey, title?.trim() || null],
    );
  }

  async setPinned(sessionKey: string, pinned: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set pinned = $2 where session_key = $1",
      [sessionKey, pinned],
    );
  }

  async setFavorited(sessionKey: string, favorited: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set favorited = $2 where session_key = $1",
      [sessionKey, favorited],
    );
  }

  async setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set hidden = $2 where session_key = $1",
      [sessionKey, hidden],
    );
  }

  async markOpened(sessionKey: string): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set last_opened_at = now() where session_key = $1",
      [sessionKey],
    );
  }

  async markResumed(sessionKey: string): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set last_resumed_at = now() where session_key = $1",
      [sessionKey],
    );
  }

  async addTag(sessionKey: string, tagName: string): Promise<void> {
    const normalized = tagName.trim();
    if (!normalized) return;
    await this.database.transaction((client) => this.addTagWithClient(client, sessionKey, normalized));
  }

  async removeTag(sessionKey: string, tagName: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          delete from agent_recall.session_tags
          where session_key = $1
            and tag_id = (select id from agent_recall.tags where name = $2)
        `,
        [sessionKey, tagName],
      );
      await client.query(
        `
          delete from agent_recall.tags
          where name = $1
            and not exists (
              select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
            )
        `,
        [tagName],
      );
    });
  }

  async deleteTag(tagName: string): Promise<void> {
    await this.database.query(
      "delete from agent_recall.tags where name = $1",
      [tagName.trim()],
    );
  }

  async listTags(options: TagListOptions = {}): Promise<string[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (options.environmentId && options.environmentId !== "all") {
      conditions.push(`sessions.environment_id = ${bind(options.environmentId)}`);
    }
    if (options.projectPath) conditions.push(`sessions.project_path = ${bind(options.projectPath)}`);
    if (options.projectEnvironmentId) {
      conditions.push(`sessions.environment_id = ${bind(options.projectEnvironmentId)}`);
    }
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = false");
    const result = await this.database.query<{ name: string }>(
      `
        select distinct tags.name
        from agent_recall.tags
        join agent_recall.session_tags on session_tags.tag_id = tags.id
        join agent_recall.sessions sessions on sessions.session_key = session_tags.session_key
        ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        order by lower(tags.name)
      `,
      values,
    );
    return result.rows.map((row) => row.name);
  }

  async listTagsByProject(
    options: { excludeSubagents?: boolean } = {},
  ): Promise<ProjectTagEntry[]> {
    const result = await this.database.query<{
      environment_id: string;
      project_path: string;
      tag_name: string;
    }>(
      `
        select
          sessions.environment_id,
          sessions.project_path,
          tags.name as tag_name
        from agent_recall.tags
        join agent_recall.session_tags on session_tags.tag_id = tags.id
        join agent_recall.sessions sessions on sessions.session_key = session_tags.session_key
        where trim(sessions.project_path) <> ''
          ${options.excludeSubagents ? "and sessions.is_subagent = false" : ""}
        order by sessions.environment_id, sessions.project_path, lower(tags.name)
      `,
    );
    const entries = new Map<string, ProjectTagEntry>();
    for (const row of result.rows) {
      const key = `${row.environment_id}\0${row.project_path}`;
      const entry = entries.get(key) ?? {
        environmentId: row.environment_id,
        projectPath: row.project_path,
        tags: [],
      };
      if (!entry.tags.includes(row.tag_name)) entry.tags.push(row.tag_name);
      entries.set(key, entry);
    }
    return [...entries.values()];
  }

  async listProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
    const values: unknown[] = [];
    const conditions = ["trim(sessions.project_path) <> ''"];
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = false");
    if (options.environmentId && options.environmentId !== "all") {
      values.push(options.environmentId);
      conditions.push(`sessions.environment_id = $${values.length}`);
    }
    const result = await this.database.query<{
      project_path: string;
      environment_id: string;
      environment_label: string;
      session_count: number | string;
      created_at: Date | string;
      last_activity_at: Date | string;
    }>(
      `
        select
          sessions.project_path,
          sessions.environment_id,
          environments.label as environment_label,
          count(*) as session_count,
          max(sessions.started_at) as created_at,
          max(${SESSION_ACTIVITY_SQL}) as last_activity_at
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where ${conditions.join(" and ")}
        group by sessions.project_path, sessions.environment_id, environments.label
      `,
      values,
    );
    const summaries = result.rows.map<ProjectSummary>((row) => ({
      path: row.project_path,
      label: projectBasename(row.project_path),
      sessionCount: numberValue(row.session_count),
      environmentId: row.environment_id,
      environmentLabel: row.environment_label,
      createdAt: timeValue(row.created_at),
      lastActivityAt: timeValue(row.last_activity_at),
    }));
    const basenameCounts = new Map<string, number>();
    const environmentsByPath = new Map<string, Set<string>>();
    for (const summary of summaries) {
      const basename = projectBasename(summary.path);
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
      const environments = environmentsByPath.get(summary.path) ?? new Set<string>();
      environments.add(summary.environmentId);
      environmentsByPath.set(summary.path, environments);
    }
    return summaries
      .map((summary) => ({
        ...summary,
        label:
          (environmentsByPath.get(summary.path)?.size ?? 0) > 1
            ? `${summary.label} · ${summary.environmentLabel}`
            : (basenameCounts.get(projectBasename(summary.path)) ?? 0) > 1
              ? projectParentLabel(summary.path)
              : summary.label,
      }))
      .sort(
        (left, right) =>
          (left.environmentId === "local" ? 0 : 1) - (right.environmentId === "local" ? 0 : 1)
          || right.lastActivityAt - left.lastActivityAt
          || left.label.localeCompare(right.label),
      );
  }

  async deleteSessionRecord(sessionKey: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<{ session_key: string }>(
        "select session_key from agent_recall.sessions where session_key = $1",
        [sessionKey],
      );
      if (existing.rows.length === 0) return false;
      await client.query("delete from agent_recall.sessions where session_key = $1", [sessionKey]);
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
      return true;
    });
  }

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    if (!legacyKey || !targetKey || legacyKey === targetKey) return false;
    return this.database.transaction(async (client) => {
      const legacyResult = await client.query<{
        custom_title: string | null;
        favorited: boolean;
        pinned: boolean;
        hidden: boolean;
        last_opened_at: Date | string | null;
        last_resumed_at: Date | string | null;
        ai_summary: string | null;
        ai_summary_model: string | null;
        ai_summary_at: Date | string | null;
        ai_summary_basis: number | string | null;
      }>(
        `
          select custom_title, favorited, pinned, hidden, last_opened_at, last_resumed_at,
            ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
          from agent_recall.sessions
          where session_key = $1
        `,
        [legacyKey],
      );
      const legacy = legacyResult.rows[0];
      if (!legacy) return false;
      const targetResult = await client.query<{ session_key: string }>(
        "select session_key from agent_recall.sessions where session_key = $1",
        [targetKey],
      );

      if (targetResult.rows.length === 0) {
        await client.query(
          `
            insert into agent_recall.sessions (
              session_key, raw_id, source, environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, pinned, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
            )
            select
              $2, raw_id, source, environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, pinned, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
            from agent_recall.sessions
            where session_key = $1
          `,
          [legacyKey, targetKey],
        );
        for (const table of [
          "session_raw_events",
          "session_message_events",
          "session_turns",
          "token_events",
          "session_tags",
        ]) {
          await client.query(
            `update agent_recall.${table} set session_key = $2 where session_key = $1`,
            [legacyKey, targetKey],
          );
        }
      } else {
        await client.query(
          `
            update agent_recall.sessions
            set
              custom_title = coalesce(custom_title, $2),
              favorited = favorited or $3,
              pinned = pinned or $4,
              hidden = hidden or $5,
              last_opened_at = greatest(last_opened_at, $6),
              last_resumed_at = greatest(last_resumed_at, $7),
              ai_summary = coalesce(ai_summary, $8),
              ai_summary_model = case when ai_summary is null then $9 else ai_summary_model end,
              ai_summary_at = case when ai_summary is null then $10 else ai_summary_at end,
              ai_summary_basis = case when ai_summary is null then $11 else ai_summary_basis end
            where session_key = $1
          `,
          [
            targetKey,
            legacy.custom_title,
            legacy.favorited,
            legacy.pinned,
            legacy.hidden,
            legacy.last_opened_at,
            legacy.last_resumed_at,
            legacy.ai_summary,
            legacy.ai_summary_model,
            legacy.ai_summary_at,
            legacy.ai_summary_basis,
          ],
        );
        await client.query(
          `
            insert into agent_recall.session_tags (session_key, tag_id)
            select $2, tag_id
            from agent_recall.session_tags
            where session_key = $1
            on conflict (session_key, tag_id) do nothing
          `,
          [legacyKey, targetKey],
        );
      }
      await client.query(
        `
          update agent_recall.session_migrations
          set source_session_key = $2
          where source_session_key = $1
        `,
        [legacyKey, targetKey],
      );
      await client.query("delete from agent_recall.sessions where session_key = $1", [legacyKey]);
      return true;
    });
  }

  async listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
  ): Promise<string[]> {
    const result = await this.database.query<{ session_key: string; file_path: string }>(
      `
        select session_key, file_path
        from agent_recall.sessions
        where environment_id = $1 and file_path <> ''
      `,
      [environmentId],
    );
    return result.rows
      .filter((row) => !filePaths.has(row.file_path))
      .map((row) => row.session_key);
  }

  async getSession(sessionKey: string): Promise<SessionSearchResult | null> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.session_key = $1
      `,
      [sessionKey],
    );
    return result.rows[0] ? hydrateSession(result.rows[0]) : null;
  }

  async findByRawId(rawId: string): Promise<SessionSearchResult | null> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.raw_id = $1
        order by sessions.file_mtime_ms desc
        limit 1
      `,
      [rawId],
    );
    return result.rows[0] ? hydrateSession(result.rows[0]) : null;
  }

  async setAiSummary(sessionKey: string, summary: string, model: string): Promise<boolean> {
    const result = await this.database.query<{ file_mtime_ms: number | string }>(
      "select file_mtime_ms from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.database.query(
      `
        update agent_recall.sessions
        set ai_summary = $2,
          ai_summary_model = $3,
          ai_summary_at = now(),
          ai_summary_basis = $4
        where session_key = $1
      `,
      [sessionKey, summary.trim(), model.trim(), numberValue(row.file_mtime_ms)],
    );
    return true;
  }

  async listSessionsNeedingSummary(
    now: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<SessionSearchResult[]> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.file_mtime_ms >= $1
          and (
            sessions.ai_summary is null
            or sessions.file_mtime_ms > coalesce(sessions.ai_summary_basis, 0)
          )
        order by sessions.file_mtime_ms desc
        limit $2
      `,
      [now - maxAgeMs, Math.max(0, limit)],
    );
    return result.rows.map((row) => hydrateSession(row));
  }

  async getMessageCount(sessionKey: string): Promise<number> {
    const result = await this.database.query<{ message_count: number | string }>(
      "select message_count from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    return numberValue(result.rows[0]?.message_count);
  }

  async getMessages(sessionKey: string, offset = 0, limit = 120): Promise<SessionMessage[]> {
    const result = await this.database.query<{
      role: SessionMessage["role"];
      content: string;
      occurred_at: Date | string | null;
      source_message_index: number | string;
    }>(
      `
        select messages.role, messages.content, messages.occurred_at, messages.source_message_index
        from agent_recall.turn_messages messages
        join agent_recall.session_turns turns on turns.id = messages.turn_id
        where turns.session_key = $1
        order by messages.source_message_index, turns.turn_index, messages.message_index
        offset $2
        limit $3
      `,
      [sessionKey, Math.max(0, offset), Math.max(0, limit)],
    );
    return result.rows.map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: isoValue(row.occurred_at),
      index: numberValue(row.source_message_index),
    }));
  }

  async getAllMessages(sessionKey: string): Promise<SessionMessage[]> {
    return this.getMessages(sessionKey, 0, 2_147_483_647);
  }

  async getTraceEvents(
    sessionKey: string,
    options: TraceEventQueryOptions = {},
  ): Promise<SessionTraceEvent[]> {
    const values: unknown[] = [sessionKey];
    const where = ["session_key = $1", "kind = 'trace'"];
    if (options.startTimestamp) {
      values.push(options.startTimestamp);
      where.push(`occurred_at >= $${values.length}`);
    }
    if (options.endTimestamp) {
      values.push(options.endTimestamp);
      where.push(`occurred_at <= $${values.length}`);
    }
    values.push(Math.max(0, options.limit ?? 100_000));
    const result = await this.database.query<{
      payload: Record<string, unknown> | string;
      occurred_at: Date | string | null;
    }>(
      `
        select payload, occurred_at
        from agent_recall.session_raw_events
        where ${where.join(" and ")}
        order by (payload->>'traceIndex')::integer
        limit $${values.length}
      `,
      values,
    );
    return result.rows.map((row) => {
      const payload = jsonValue(row.payload);
      return {
        index: numberValue(payload.traceIndex),
        kind: payload.kind as SessionTraceEvent["kind"],
        source: payload.source as SessionTraceEvent["source"],
        title: String(payload.title || ""),
        detail: String(payload.detail || ""),
        timestamp: isoValue(row.occurred_at),
        ...(payload.callId ? { callId: String(payload.callId) } : {}),
        ...(payload.eventType ? { eventType: String(payload.eventType) } : {}),
        ...(payload.status ? { status: payload.status as SessionTraceEvent["status"] } : {}),
      };
    });
  }

  async getStats(options: SessionStatsOptions = {}, now = Date.now()): Promise<SessionStats> {
    const range = resolveStatsRange(options, now);
    const subagentPredicate = options.excludeSubagents ? "and sessions.is_subagent = false" : "";
    const rangeValues = range.since === null
      ? []
      : [
          new Date(range.since).toISOString(),
          new Date(range.until).toISOString(),
        ];
    const sessionsSql = range.since === null
      ? `
        select source, count(*) as session_count
        from agent_recall.sessions sessions
        ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
        group by source
      `
      : `
        with active as (
          select sessions.source, sessions.session_key
          from agent_recall.sessions sessions
          join agent_recall.session_message_events events on events.session_key = sessions.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
          union
          select sessions.source, sessions.session_key
          from agent_recall.sessions sessions
          join agent_recall.token_events events on events.session_key = sessions.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
        )
        select source, count(distinct session_key) as session_count
        from active
        group by source
      `;
    const messagesSql = range.since === null
      ? `
        select source, coalesce(sum(message_count), 0) as message_count
        from agent_recall.sessions sessions
        ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
        group by source
      `
      : `
        select sessions.source, count(*) as message_count
        from agent_recall.session_message_events events
        join agent_recall.sessions sessions on sessions.session_key = events.session_key
        where events.occurred_at >= $1 and events.occurred_at <= $2 ${subagentPredicate}
        group by sessions.source
      `;
    const tokenWhere = [
      ...(range.since === null ? [] : ["events.occurred_at >= $1 and events.occurred_at <= $2"]),
      ...(options.excludeSubagents ? ["sessions.is_subagent = false"] : []),
    ];
    const tokensSql = `
      with ranked as (
        select
          sessions.source,
          events.dedupe_key,
          events.occurred_at,
          events.input_tokens,
          events.output_tokens,
          events.cached_input_tokens,
          events.reasoning_output_tokens,
          events.total_tokens,
          row_number() over (
            partition by events.dedupe_key
            order by
              events.total_tokens desc,
              case sessions.source
                when 'codex-cli' then 1
                when 'claude-cli' then 1
                when 'codex-app' then 2
                when 'claude-app' then 2
                else 9
              end,
              events.occurred_at
          ) as row_rank
        from agent_recall.token_events events
        join agent_recall.sessions sessions on sessions.session_key = events.session_key
        ${tokenWhere.length > 0 ? `where ${tokenWhere.join(" and ")}` : ""}
      )
      select
        source,
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
        coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
        coalesce(sum(total_tokens), 0) as total_tokens
      from ranked
      where row_rank = 1
      group by source
    `;
    const [sessionRows, messageRows, tokenRows] = await Promise.all([
      this.database.query<{ source: SessionSource; session_count: number | string }>(
        sessionsSql,
        rangeValues,
      ),
      this.database.query<{ source: SessionSource; message_count: number | string }>(
        messagesSql,
        rangeValues,
      ),
      this.database.query<{
        source: SessionSource;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_input_tokens: number | string;
        reasoning_output_tokens: number | string;
        total_tokens: number | string;
      }>(tokensSql, rangeValues),
    ]);
    let effectiveTokenRows = tokenRows.rows;
    if (range.since === null && effectiveTokenRows.length === 0) {
      const fallback = await this.database.query<{
        source: SessionSource;
        input_tokens: number | string;
        output_tokens: number | string;
        cached_input_tokens: number | string;
        reasoning_output_tokens: number | string;
        total_tokens: number | string;
      }>(
        `
          select
            source,
            coalesce(sum(input_tokens), 0) as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
            coalesce(sum(reasoning_output_tokens), 0) as reasoning_output_tokens,
            coalesce(sum(total_tokens), 0) as total_tokens
          from agent_recall.sessions sessions
          ${options.excludeSubagents ? "where sessions.is_subagent = false" : ""}
          group by source
        `,
      );
      effectiveTokenRows = fallback.rows;
    }

    const summaries = new Map<SessionSource, SessionStatsSummary>();
    const getSummary = (source: SessionSource) => {
      const existing = summaries.get(source);
      if (existing) return existing;
      const created = emptyStatsSummary();
      summaries.set(source, created);
      return created;
    };
    for (const row of sessionRows.rows) getSummary(row.source).sessionCount = numberValue(row.session_count);
    for (const row of messageRows.rows) getSummary(row.source).messageCount = numberValue(row.message_count);
    for (const row of effectiveTokenRows) {
      const summary = getSummary(row.source);
      summary.inputTokens = numberValue(row.input_tokens);
      summary.outputTokens = numberValue(row.output_tokens);
      summary.cachedInputTokens = numberValue(row.cached_input_tokens);
      summary.reasoningOutputTokens = numberValue(row.reasoning_output_tokens);
      summary.totalTokens = numberValue(row.total_tokens);
    }
    const bySource = [...summaries.entries()]
      .map(([source, summary]) => ({ source, ...summary }))
      .filter((summary) => summary.sessionCount > 0 || summary.messageCount > 0 || summary.totalTokens > 0)
      .sort((left, right) => left.source.localeCompare(right.source));
    const total = bySource.reduce<SessionStatsSummary>(
      (summary, source) => ({
        sessionCount: summary.sessionCount + source.sessionCount,
        messageCount: summary.messageCount + source.messageCount,
        inputTokens: summary.inputTokens + source.inputTokens,
        outputTokens: summary.outputTokens + source.outputTokens,
        cachedInputTokens: summary.cachedInputTokens + source.cachedInputTokens,
        reasoningOutputTokens: summary.reasoningOutputTokens + source.reasoningOutputTokens,
        totalTokens: summary.totalTokens + source.totalTokens,
      }),
      emptyStatsSummary(),
    );

    const days = dailyRanges(now);
    const dailyRows = await this.database.query<{
      occurred_at: Date | string;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
    }>(
      `
        with ranked as (
          select
            events.*,
            row_number() over (
              partition by events.dedupe_key
              order by events.total_tokens desc, events.occurred_at
            ) as row_rank
          from agent_recall.token_events events
          join agent_recall.sessions sessions on sessions.session_key = events.session_key
          where events.occurred_at >= $1 and events.occurred_at <= $2
            ${options.excludeSubagents ? "and sessions.is_subagent = false" : ""}
        )
        select
          occurred_at, input_tokens, output_tokens, cached_input_tokens,
          reasoning_output_tokens, total_tokens
        from ranked
        where row_rank = 1
      `,
      [
        new Date(days[0].dayStart).toISOString(),
        new Date(now).toISOString(),
      ],
    );
    const dailyTokenUsage = days.map<SessionDailyTokenUsage>((day) => {
      const usage = dailyRows.rows
        .filter((row) => {
          const timestamp = timeValue(row.occurred_at);
          return timestamp >= day.dayStart && timestamp < day.dayEndExclusive;
        })
        .reduce<TokenUsage>(
          (sum, row) => ({
            inputTokens: sum.inputTokens + numberValue(row.input_tokens),
            outputTokens: sum.outputTokens + numberValue(row.output_tokens),
            cachedInputTokens: sum.cachedInputTokens + numberValue(row.cached_input_tokens),
            reasoningOutputTokens: sum.reasoningOutputTokens + numberValue(row.reasoning_output_tokens),
            totalTokens: sum.totalTokens + numberValue(row.total_tokens),
          }),
          normalizedTokenUsage(),
        );
      return { ...day, ...usage };
    });

    return { total, bySource, dailyTokenUsage, range };
  }

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

  async clearSearchIndex(): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query("delete from agent_recall.session_raw_events");
      await client.query("delete from agent_recall.session_message_events");
      await client.query("delete from agent_recall.session_turns");
      await client.query("delete from agent_recall.token_events");
      await client.query(`
        update agent_recall.sessions
        set file_mtime_ms = 0,
          file_size = 0,
          message_count = 0,
          turn_count = 0,
          input_tokens = 0,
          output_tokens = 0,
          cached_input_tokens = 0,
          reasoning_output_tokens = 0,
          total_tokens = 0,
          original_title = '',
          first_question = ''
      `);
    });
  }

  async deleteSessionsBySource(sources: readonly SessionSource[]): Promise<void> {
    if (sources.length === 0) return;
    await this.database.transaction(async (client) => {
      await client.query(
        "delete from agent_recall.sessions where source = any($1::text[])",
        [[...sources]],
      );
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
    });
  }

  async getSessionDeletionTarget(
    sessionKey: string,
  ): Promise<{ source: SessionSource; filePath: string } | null> {
    const result = await this.database.query<{ source: SessionSource; file_path: string }>(
      "select source, file_path from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    return result.rows[0]
      ? { source: result.rows[0].source, filePath: result.rows[0].file_path }
      : null;
  }

  private async addTagWithClient(
    client: PostgresQueryable,
    sessionKey: string,
    tagName: string,
  ): Promise<void> {
    await client.query(
      "insert into agent_recall.tags (name) values ($1) on conflict (name) do nothing",
      [tagName],
    );
    await client.query(
      `
        insert into agent_recall.session_tags (session_key, tag_id)
        select $1, id from agent_recall.tags where name = $2
        on conflict (session_key, tag_id) do nothing
      `,
      [sessionKey, tagName],
    );
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
        snippet: snippet(row.content, matchedTerms),
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
