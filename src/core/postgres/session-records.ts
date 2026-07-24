import type {
  EnvironmentKind,
  SessionSearchResult,
  SessionSource,
  SessionTurnMatch,
  SessionTurnStatus,
  SessionTurnSummary,
  TokenUsage,
  TokenUsageEvent,
} from "../types";

export interface SessionRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  environment_kind: EnvironmentKind;
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

export interface SessionTurnSummaryRow extends Record<string, unknown> {
  id: string;
  turn_index: number | string;
  source_message_index: number | string | null;
  synthetic: boolean;
  status: SessionTurnStatus;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  user_preview: string;
  assistant_preview: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_input_tokens: number | string;
  reasoning_output_tokens: number | string;
  total_tokens: number | string;
  error_count: number | string;
  tool_names: string[] | null;
  message_count: number | string;
  span_count: number | string;
}

export const SESSION_TURN_SUMMARY_SQL = `
  select
    turns.id,
    turns.turn_index,
    turns.source_message_index,
    turns.synthetic,
    turns.status,
    turns.started_at,
    turns.ended_at,
    left(turns.user_text, 320) as user_preview,
    left(turns.assistant_text, 180) as assistant_preview,
    turns.input_tokens,
    turns.output_tokens,
    turns.cached_input_tokens,
    turns.reasoning_output_tokens,
    turns.total_tokens,
    turns.error_count,
    turns.tool_names,
    (
      select count(*)::int
      from agent_recall.turn_messages messages
      where messages.turn_id = turns.id
    ) as message_count,
    (
      select count(*)::int
      from agent_recall.trace_spans spans
      where spans.turn_id = turns.id
    ) as span_count
  from agent_recall.session_turns turns
`;

export const SESSION_ACTIVITY_SQL = `
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

export const SESSION_SELECT_SQL = `
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

export function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function postgresText(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\u2400") : value;
}

export function timeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function isoValue(value: unknown): string {
  const timestamp = timeValue(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

export function nullableIsoValue(value: unknown): string | null {
  const timestamp = isoValue(value);
  return timestamp || null;
}

export function sessionTurnSummaryFromRow(row: SessionTurnSummaryRow): SessionTurnSummary {
  return {
    id: row.id,
    turnIndex: numberValue(row.turn_index),
    sourceMessageIndex: row.source_message_index === null ? null : numberValue(row.source_message_index),
    synthetic: row.synthetic,
    status: row.status,
    startedAt: nullableIsoValue(row.started_at),
    endedAt: nullableIsoValue(row.ended_at),
    userPreview: row.user_preview || "",
    assistantPreview: row.assistant_preview || "",
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    cachedInputTokens: numberValue(row.cached_input_tokens),
    reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
    totalTokens: numberValue(row.total_tokens),
    errorCount: numberValue(row.error_count),
    toolNames: row.tool_names ?? [],
    messageCount: numberValue(row.message_count),
    spanCount: numberValue(row.span_count),
  };
}

export function normalizedTokenUsage(usage?: TokenUsage): TokenUsage {
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

export function tokenUsageFromEvents(
  events: readonly TokenUsageEvent[],
  fallback?: TokenUsage,
): TokenUsage {
  if (events.length === 0) return normalizedTokenUsage(fallback);
  return events.reduce<TokenUsage>(
    (total, event) => ({
      inputTokens: total.inputTokens + numberValue(event.inputTokens),
      outputTokens: total.outputTokens + numberValue(event.outputTokens),
      cachedInputTokens: total.cachedInputTokens + numberValue(event.cachedInputTokens),
      reasoningOutputTokens: total.reasoningOutputTokens + numberValue(event.reasoningOutputTokens),
      totalTokens: total.totalTokens + numberValue(event.totalTokens),
    }),
    normalizedTokenUsage(),
  );
}

export function jsonValue(value: unknown): Record<string, unknown> {
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

export function nullableJsonValue(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : jsonValue(value);
}

export function parseSearchClauses(query: string): string[] {
  const clauses: string[] = [];
  const expression = /"([^"]+)"|(\S+)/gu;
  for (const match of query.matchAll(expression)) {
    const value = (match[1] || match[2] || "").trim();
    if (!value || value.toLocaleLowerCase() === "and") continue;
    if (!clauses.includes(value)) clauses.push(value);
  }
  return clauses;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function searchTerms(clauses: readonly string[]): string[] {
  return clauses.map((clause) => clause.toLocaleLowerCase());
}

export function searchSnippet(value: string, terms: readonly string[]): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const lower = normalized.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const firstMatch = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, firstMatch - 70);
  const end = Math.min(normalized.length, firstMatch + 190);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

function metadataMatch(
  row: SessionSearchResult,
  terms: readonly string[],
): SessionSearchResult["metadataMatch"] {
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
    snippet: searchSnippet(searchText, terms),
    matchedTerms: terms.filter((term) => searchText.toLocaleLowerCase().includes(term)),
  };
}

export function hydrateSession(
  row: SessionRow,
  queryTerms: readonly string[] = [],
): SessionSearchResult {
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
    aiSummaryStale: Boolean(row.ai_summary)
      && numberValue(row.file_mtime_ms) > numberValue(row.ai_summary_basis),
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
