import { cleanTitle } from "../format-adapters";
import type {
  EnvironmentKind,
  RuntimeInvocationSummary,
  SessionOriginFilter,
  SessionSearchResult,
  SessionSource,
  SessionTurnMatch,
  SessionTurnStatus,
  SessionTurnSummary,
  TokenUsage,
  TokenUsageEvent,
} from "../types";

export function normalizeProjectPath(projectPath: string): string {
  return /^[a-z]:(?=[\\/])/u.test(projectPath)
    ? `${projectPath[0].toUpperCase()}${projectPath.slice(1)}`
    : projectPath;
}

export function projectPathMatchVariants(projectPath: string): string[] {
  const normalized = normalizeProjectPath(projectPath);
  if (/^[A-Z]:(?=[\\/])/u.test(normalized)) {
    const lowerDrive = `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
    return lowerDrive === normalized ? [normalized] : [normalized, lowerDrive];
  }
  return [normalized];
}

export function normalizedProjectPathSql(column: string): string {
  return `
    case
      when unicode(${column}) between 97 and 122
        and substr(${column}, 2, 1) = ':'
        and substr(${column}, 3, 1) in ('/', char(92))
      then upper(substr(${column}, 1, 1)) || substr(${column}, 2)
      else ${column}
    end
  `;
}

export interface SqliteSessionRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  available_sources: string | SessionSource[] | null;
  environment_id: string;
  storage_environment_id: string | null;
  environment_kind: EnvironmentKind;
  environment_label: string;
  project_path: string;
  file_path: string;
  original_title: string;
  first_question: string;
  started_at: number | string;
  file_mtime_ms: number | string;
  file_size: number | string;
  pr_url: string | null;
  pr_number: number | null;
  custom_title: string | null;
  favorited: number | boolean;
  pinned: number | boolean;
  hidden: number | boolean;
  source_available: number | boolean;
  last_opened_at: number | string | null;
  last_resumed_at: number | string | null;
  last_activity_at: number | string;
  message_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_input_tokens: number | string;
  cache_creation_input_tokens: number | string;
  reasoning_output_tokens: number | string;
  total_tokens: number | string;
  indexed_at: number | string;
  is_subagent: number | boolean;
  parent_session_id: string | null;
  ai_summary: string | null;
  ai_summary_at: number | string | null;
  ai_summary_basis: number | string | null;
  tag_names: string | string[] | null;
  total_count?: number | string;
  best_turn_id?: string | null;
  best_turn_index?: number | string | null;
  best_source_message_index?: number | string | null;
  best_turn_started_at?: number | string | null;
  best_turn_search_text?: string | null;
  turn_match_count?: number | string | null;
  created_by_agent_recall: number | boolean;
  runtime_invocations: unknown;
}

export interface SqliteSessionTurnSummaryRow extends Record<string, unknown> {
  id: string;
  turn_index: number | string;
  source_message_index: number | string | null;
  source_turn_id: string | null;
  agent_triggered: number | boolean;
  subagent_execution_start: number | boolean;
  synthetic: number | boolean;
  status: SessionTurnStatus;
  started_at: number | string | null;
  ended_at: number | string | null;
  duration_ms: number | string | null;
  time_to_first_token_ms: number | string | null;
  abort_reason: string | null;
  user_preview: string;
  assistant_preview: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_input_tokens: number | string;
  cache_creation_input_tokens: number | string;
  reasoning_output_tokens: number | string;
  total_tokens: number | string;
  error_count: number | string;
  tool_names: string | string[] | null;
  message_count: number | string;
  span_count: number | string;
}

export const SQLITE_SESSION_TURN_SUMMARY_SQL = `
  select
    turns.id,
    turns.turn_index,
    turns.source_message_index,
    turns.source_turn_id,
    exists (
      select 1
      from trace_spans trigger_spans
      where trigger_spans.turn_id = turns.id
        and json_extract(trigger_spans.attributes, '$.eventType') = 'codex.collaboration.message'
        and json_extract(trigger_spans.attributes, '$.collaboration.triggerTurn') in (1, 'true')
    ) as agent_triggered,
    exists (
      select 1
      from trace_spans new_task_spans
      where new_task_spans.turn_id = turns.id
        and json_extract(new_task_spans.attributes, '$.eventType') = 'codex.collaboration.message'
        and json_extract(new_task_spans.attributes, '$.collaboration.direction') = 'incoming'
        and json_extract(new_task_spans.attributes, '$.collaboration.triggerTurn') in (1, 'true')
        and json_extract(new_task_spans.attributes, '$.collaboration.messageType') = 'new_task'
    ) as subagent_execution_start,
    turns.synthetic,
    turns.status,
    turns.started_at,
    turns.ended_at,
    turns.duration_ms,
    turns.time_to_first_token_ms,
    turns.abort_reason,
    substr(turns.user_text, 1, 320) as user_preview,
    substr(turns.assistant_text, 1, 180) as assistant_preview,
    turns.input_tokens,
    turns.output_tokens,
    turns.cached_input_tokens,
    turns.cache_creation_input_tokens,
    turns.reasoning_output_tokens,
    turns.total_tokens,
    turns.error_count,
    turns.tool_names,
    (
      select count(*)
      from turn_messages messages
      where messages.turn_id = turns.id
    ) as message_count,
    (
      select count(*)
      from trace_spans spans
      where spans.turn_id = turns.id and spans.kind = 'tool'
    ) as span_count
  from session_turns turns
`;

export const SQLITE_SESSION_ACTIVITY_SQL = `
  coalesce(
    (
      select max(coalesce(turns.ended_at, turns.started_at))
      from session_turns turns
      where turns.session_key = sessions.session_key
    ),
    case
      when sessions.file_mtime_ms > 0 then cast(sessions.file_mtime_ms as integer)
      else sessions.started_at
    end,
    sessions.started_at
  )
`;

/**
 * SQL predicate matching a Runtime binding to its indexed Session family.
 *
 * Indexed Sessions do not carry a trustworthy channel identifier. When the
 * same Runtime/environment/native Session id is observed on more than one
 * channel, refusing to project either binding is safer than attributing one
 * channel's Session to another.
 */
export const SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL = `
  bindings.environment_id = sessions.environment_id
  and bindings.runtime_session_id = sessions.raw_id
  and not exists (
    select 1
    from runtime_session_bindings conflicting_bindings
    where conflicting_bindings.environment_id = bindings.environment_id
      and conflicting_bindings.runtime_id = bindings.runtime_id
      and conflicting_bindings.runtime_session_id = bindings.runtime_session_id
      and nullif(conflicting_bindings.channel_id, '') is not nullif(bindings.channel_id, '')
  )
  and (
    (bindings.runtime_id = 'codex' and sessions.source in (
      'codex-cli', 'codex-app', 'stepcode-codex', 'tcodex-cli'
    ))
    or (bindings.runtime_id = 'claude' and sessions.source in (
      'claude-cli', 'claude-app', 'stepcode-claude', 'tclaude-cli'
    ))
    or (bindings.runtime_id = 'dsh' and sessions.source = 'deepseek-cli')
    or (bindings.runtime_id = 'hermes' and sessions.source = 'hermes')
    or (bindings.runtime_id = 'opencode' and sessions.source = 'opencode-cli')
    or (bindings.runtime_id = 'openclaw' and sessions.source = 'openclaw')
  )
`;

export const SQLITE_AGENTRECALL_CREATED_SESSION_SQL = `
  exists (
    select 1
    from runtime_session_bindings bindings
    join runtime_invocations invocations
      on invocations.id = bindings.invocation_id
    where ${SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL}
      and bindings.relation = 'created'
      and invocations.initiator = 'agentrecall'
  )
`;

export function sqliteSessionOriginPredicate(origin: SessionOriginFilter | undefined): string | undefined {
  if (origin === "agentrecall") return SQLITE_AGENTRECALL_CREATED_SESSION_SQL;
  if (origin === "ordinary") return `not (${SQLITE_AGENTRECALL_CREATED_SESSION_SQL})`;
  return undefined;
}

export function sqliteAvailableSourcesSql(alias: string): string {
  return `
    coalesce(
      nullif(
        (
          select json_group_array(distinct related.source order by related.source)
          from local_sessions related
          where related.environment_id = ${alias}.environment_id
            and related.raw_id = ${alias}.raw_id
            and ${normalizedProjectPathSql("related.project_path")} = ${normalizedProjectPathSql(`${alias}.project_path`)}
            and related.is_subagent = ${alias}.is_subagent
            and related.parent_session_id is ${alias}.parent_session_id
            and case
              when related.source in ('claude-cli', 'claude-app', 'stepcode-claude') then 'claude'
              when related.source in ('codex-cli', 'codex-app', 'stepcode-codex') then 'codex'
              else related.source
            end = case
              when ${alias}.source in ('claude-cli', 'claude-app', 'stepcode-claude') then 'claude'
              when ${alias}.source in ('codex-cli', 'codex-app', 'stepcode-codex') then 'codex'
              else ${alias}.source
            end
        ),
        '[]'
      ),
      json_array(${alias}.source)
    )
  `;
}

function sessionSelectSql(runtimeInvocationLimit?: number): string {
  const runtimeInvocationLimitSql = runtimeInvocationLimit === undefined
    ? ""
    : `limit ${runtimeInvocationLimit}`;
  return `
  sessions.*,
  ${sqliteAvailableSourcesSql("sessions")} as available_sources,
  environments.kind as environment_kind,
  environments.label as environment_label,
  ${SQLITE_SESSION_ACTIVITY_SQL} as last_activity_at,
  coalesce(
    (
      select json_group_array(tags.name order by lower(tags.name))
      from session_tags
      join tags on tags.id = session_tags.tag_id
      where session_tags.session_key = sessions.session_key
    ),
    '[]'
  ) as tag_names,
  ${SQLITE_AGENTRECALL_CREATED_SESSION_SQL} as created_by_agent_recall,
  coalesce(
    (
      select json_group_array(json(history.payload) order by history.started_at desc, history.invocation_id desc)
      from (
        select
          invocations.started_at,
          invocations.id as invocation_id,
          json_object(
            'invocationId', invocations.id,
            'surface', invocations.surface,
            'role', invocations.role,
            'ownerReference', json(invocations.owner_reference),
            'runtimeId', bindings.runtime_id,
            'channelId', nullif(bindings.channel_id, ''),
            'environmentId', bindings.environment_id,
            'status', invocations.status,
            'startedAt', invocations.started_at,
            'finishedAt', invocations.finished_at,
            'relation', bindings.relation,
            'runtimeSessionId', bindings.runtime_session_id,
            'runtimeTurnId', bindings.runtime_turn_id
          ) as payload
        from runtime_session_bindings bindings
        join runtime_invocations invocations
          on invocations.id = bindings.invocation_id
        where ${SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL}
          and invocations.initiator = 'agentrecall'
        order by invocations.started_at desc, invocations.id desc
        ${runtimeInvocationLimitSql}
      ) history
    ),
    '[]'
  ) as runtime_invocations
`;
}

/** List projection keeps navigation payload bounded; detail loading restores full history. */
export const SQLITE_SESSION_SELECT_SQL = sessionSelectSql(20);
export const SQLITE_SESSION_DETAIL_SELECT_SQL = sessionSelectSql();

export function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Replaces NUL bytes with U+2400 and unpaired UTF-16 surrogates with U+FFFD
 * while preserving valid surrogate pairs (emoji) and all other Unicode text.
 */
export function sanitizeSessionText(value: string): string {
  let normalized = "";
  let chunkStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let replacement: string | null = null;
    if (codeUnit === 0) {
      replacement = "\u2400";
    } else if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
        index += 1;
        continue;
      }
      replacement = "\uFFFD";
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      replacement = "\uFFFD";
    }
    if (replacement === null) continue;
    normalized += value.slice(chunkStart, index) + replacement;
    chunkStart = index + 1;
  }
  return chunkStart === 0 ? value : normalized + value.slice(chunkStart);
}

export function sanitizeSessionJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeSessionText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeSessionJsonValue(item)) as T;
  if (!value || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [sanitizeSessionText(key), sanitizeSessionJsonValue(nested)]),
  ) as T;
}

export function timeValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function optionalTimeMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isoValue(value: unknown): string {
  const timestamp = timeValue(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

export function nullableIsoValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = isoValue(value);
  return timestamp || null;
}

export function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function sessionTurnSummaryFromRow(row: SqliteSessionTurnSummaryRow): SessionTurnSummary {
  return {
    id: row.id,
    turnIndex: numberValue(row.turn_index),
    sourceMessageIndex: row.source_message_index === null ? null : numberValue(row.source_message_index),
    sourceTurnId: row.source_turn_id,
    agentTriggered: Boolean(row.agent_triggered),
    subagentExecutionStart: Boolean(row.subagent_execution_start),
    synthetic: Boolean(row.synthetic),
    status: row.status,
    startedAt: nullableIsoValue(row.started_at),
    endedAt: nullableIsoValue(row.ended_at),
    durationMs: row.duration_ms === null ? null : numberValue(row.duration_ms),
    timeToFirstTokenMs: row.time_to_first_token_ms === null ? null : numberValue(row.time_to_first_token_ms),
    abortReason: row.abort_reason,
    userPreview: row.user_preview || "",
    assistantPreview: row.assistant_preview || "",
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    cachedInputTokens: numberValue(row.cached_input_tokens),
    ...(numberValue(row.cache_creation_input_tokens) > 0
      ? { cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens) }
      : {}),
    reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
    totalTokens: numberValue(row.total_tokens),
    errorCount: numberValue(row.error_count),
    toolNames: stringArrayValue(row.tool_names),
    messageCount: numberValue(row.message_count),
    spanCount: numberValue(row.span_count),
  };
}

export function normalizedTokenUsage(usage?: TokenUsage): TokenUsage {
  const inputTokens = numberValue(usage?.inputTokens);
  const outputTokens = numberValue(usage?.outputTokens);
  const cachedInputTokens = numberValue(usage?.cachedInputTokens);
  const cacheCreationInputTokens = numberValue(usage?.cacheCreationInputTokens);
  const reasoningOutputTokens = numberValue(usage?.reasoningOutputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens + reasoningOutputTokens,
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
      ...((total.cacheCreationInputTokens ?? 0) + numberValue(event.cacheCreationInputTokens) > 0
        ? { cacheCreationInputTokens: (total.cacheCreationInputTokens ?? 0) + numberValue(event.cacheCreationInputTokens) }
        : {}),
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

/**
 * Formats a literal substring for SQLite FTS5 `trigram` MATCH.
 * Only call when `[...clause].length >= 3`; shorter terms return 0 matches in trigram FTS5.
 */
export function fts5TrigramQuery(clause: string): string {
  return `"${clause.replaceAll("\"", "\"\"")}"`;
}

export function canUseFts5Trigram(clause: string): boolean {
  return [...clause].length >= 3;
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

function bestTurnFromRow(row: SqliteSessionRow, terms: readonly string[]): SessionTurnMatch | null {
  if (!row.best_turn_id || row.best_turn_index === null || row.best_turn_index === undefined) return null;
  const searchText = row.best_turn_search_text || "";
  return {
    turnId: row.best_turn_id,
    turnIndex: numberValue(row.best_turn_index),
    sourceMessageIndex:
      row.best_source_message_index === null || row.best_source_message_index === undefined
        ? null
        : numberValue(row.best_source_message_index),
    startedAt: row.best_turn_started_at !== null && row.best_turn_started_at !== undefined
      ? timeValue(row.best_turn_started_at)
      : null,
    snippet: searchSnippet(searchText, terms),
    matchedTerms: terms.filter((term) => searchText.toLocaleLowerCase().includes(term)),
  };
}

export function hydrateSqliteSession(
  row: SqliteSessionRow,
  queryTerms: readonly string[] = [],
): SessionSearchResult {
  const displayTitle = row.custom_title || cleanTitle(row.original_title || row.first_question || "") || "Untitled Session";
  const bestTurn = bestTurnFromRow(row, queryTerms);
  const availableSources = stringArrayValue(row.available_sources) as SessionSource[];
  const result: SessionSearchResult = {
    sessionKey: row.session_key,
    rawId: row.raw_id,
    source: row.source,
    availableSources: availableSources.length > 0 ? availableSources : [row.source],
    environmentId: row.environment_id,
    storageEnvironmentId: row.storage_environment_id || row.environment_id,
    environmentKind: row.environment_kind,
    environmentLabel: row.environment_label,
    projectPath: normalizeProjectPath(row.project_path),
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
      ...(numberValue(row.cache_creation_input_tokens) > 0
        ? { cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens) }
        : {}),
      reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
      totalTokens: numberValue(row.total_tokens),
    },
    customTitle: row.custom_title,
    displayTitle,
    favorited: Boolean(row.favorited),
    hidden: Boolean(row.hidden),
    sourceAvailable: Boolean(row.source_available),
    tags: stringArrayValue(row.tag_names),
    matchSnippet: bestTurn?.snippet ?? null,
    lastOpenedAt: row.last_opened_at !== null && row.last_opened_at !== undefined
      ? timeValue(row.last_opened_at)
      : null,
    lastResumedAt: row.last_resumed_at !== null && row.last_resumed_at !== undefined
      ? timeValue(row.last_resumed_at)
      : null,
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
    createdByAgentRecall: Boolean(row.created_by_agent_recall),
    runtimeInvocations: runtimeInvocationSummaries(row.runtime_invocations),
  };
  if (queryTerms.length > 0 && !bestTurn) result.metadataMatch = metadataMatch(result, queryTerms);
  return result;
}

function runtimeInvocationSummaries(value: unknown): RuntimeInvocationSummary[] {
  let entries: unknown = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): RuntimeInvocationSummary[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.invocationId !== "string"
      || typeof record.surface !== "string"
      || typeof record.runtimeId !== "string"
      || typeof record.environmentId !== "string"
      || typeof record.runtimeSessionId !== "string"
      || (record.relation !== "created" && record.relation !== "continued")
      || !["pending", "completed", "failed", "cancelled", "timed_out"].includes(String(record.status))
    ) return [];
    const ownerReference = jsonValue(record.ownerReference);
    return [{
      invocationId: record.invocationId,
      surface: record.surface,
      role: typeof record.role === "string" ? record.role : null,
      ownerReference: Object.fromEntries(
        Object.entries(ownerReference).flatMap(([key, nested]) =>
          typeof nested === "string" ? [[key, nested]] : []),
      ),
      runtimeId: record.runtimeId,
      channelId: typeof record.channelId === "string" ? record.channelId : null,
      environmentId: record.environmentId,
      status: record.status as RuntimeInvocationSummary["status"],
      startedAt: numberValue(record.startedAt),
      finishedAt: record.finishedAt === null || record.finishedAt === undefined
        ? null
        : numberValue(record.finishedAt),
      relation: record.relation,
      runtimeSessionId: record.runtimeSessionId,
      runtimeTurnId: typeof record.runtimeTurnId === "string" ? record.runtimeTurnId : null,
    }];
  });
}
