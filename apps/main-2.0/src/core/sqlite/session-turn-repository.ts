import type {
  CodexIncrementalState,
  LoadedSession,
  SessionAttachment,
  SessionContextSample,
  SessionMessage,
  SessionTraceEvent,
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../types";
import { normalizeSessionTraceStatus } from "../trace-presentation";
import {
  SESSION_TRAJECTORY_PREVIEW_LENGTH,
  type AssistantTextPosition,
  type TraceEventQueryOptions,
} from "../storage/types";
import type { SqliteDatabase } from "./database";
import {
  SQLITE_SESSION_TURN_SUMMARY_SQL,
  isoValue,
  jsonValue,
  nullableIsoValue,
  nullableJsonValue,
  numberValue,
  optionalTimeMs,
  sessionTurnSummaryFromRow,
  type SqliteSessionTurnSummaryRow,
} from "./session-records";

function attachmentsFromMetadata(
  value: Record<string, unknown> | string | null,
): SessionAttachment[] | undefined {
  if (value === null) return undefined;
  const attachments = jsonValue(value).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments.filter(
    (attachment): attachment is SessionAttachment =>
      Boolean(attachment && typeof attachment === "object" && !Array.isArray(attachment)),
  );
}

function messageFieldsFromMetadata(
  value: Record<string, unknown> | string | null,
): Pick<SessionMessage, "sourceTurnId" | "phase"> {
  const metadata = value === null ? {} : jsonValue(value);
  const sourceTurnId = typeof metadata.sourceTurnId === "string" ? metadata.sourceTurnId : null;
  const phase = metadata.phase === "commentary" || metadata.phase === "final_answer"
    ? metadata.phase
    : null;
  return {
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(phase ? { phase } : {}),
  };
}

type TurnMessageRow = {
  turn_id?: string;
  message_index: number | string;
  source_message_index: number | string | null;
  role: SessionTurnMessage["role"];
  content: string;
  occurred_at: number | string | null;
  metadata: Record<string, unknown> | string;
};

type TraceSpanRow = {
  turn_id?: string;
  id: string;
  parent_span_id: string | null;
  span_index: number | string;
  kind: SessionTraceSpan["kind"];
  name: string;
  status: SessionTraceSpan["status"];
  started_at: number | string | null;
  ended_at: number | string | null;
  call_id: string | null;
  input: Record<string, unknown> | string | null;
  output: Record<string, unknown> | string | null;
  error: string | null;
  attributes: Record<string, unknown> | string;
};

function turnMessageFromRow(row: TurnMessageRow): SessionTurnMessage {
  const attachments = attachmentsFromMetadata(row.metadata);
  return {
    messageIndex: numberValue(row.message_index),
    sourceMessageIndex:
      row.source_message_index === null ? null : numberValue(row.source_message_index),
    role: row.role,
    content: row.content,
    timestamp: isoValue(row.occurred_at),
    ...messageFieldsFromMetadata(row.metadata),
    ...(attachments ? { attachments } : {}),
  };
}

function traceSpanFromRow(row: TraceSpanRow): SessionTraceSpan {
  return {
    id: row.id,
    parentSpanId: row.parent_span_id,
    spanIndex: numberValue(row.span_index),
    kind: row.kind,
    name: row.name,
    status: row.status,
    startedAt: nullableIsoValue(row.started_at),
    endedAt: nullableIsoValue(row.ended_at),
    callId: row.call_id,
    input: nullableJsonValue(row.input),
    output: nullableJsonValue(row.output),
    error: row.error,
    attributes: jsonValue(row.attributes),
  };
}

const INPUT_PREVIEW_KEYS = ["text", "cmd", "command", "query", "path", "file_path", "url"] as const;
const OUTPUT_PREVIEW_KEYS = ["text", "stdout", "aggregatedOutput", "formattedOutput"] as const;

function payloadPreview(raw: Record<string, unknown> | string | null, column: "input" | "output"): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = jsonValue(raw);
  const keys = column === "input" ? INPUT_PREVIEW_KEYS : OUTPUT_PREVIEW_KEYS;
  let picked: string | null = null;
  for (const key of keys) {
    const candidate = parsed[key];
    if (candidate !== null && candidate !== undefined) {
      picked = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      break;
    }
  }
  const text = picked ?? (typeof raw === "string" ? raw : JSON.stringify(parsed));
  return { text: text.slice(0, SESSION_TRAJECTORY_PREVIEW_LENGTH) };
}

function trajectorySpanAttributes(raw: Record<string, unknown> | string): Record<string, unknown> {
  const attributes = jsonValue(raw);
  const result: Record<string, unknown> = {};
  for (const key of ["traceKind", "eventType", "title", "nestedTools"] as const) {
    if (attributes[key] !== undefined && attributes[key] !== null) {
      result[key] = attributes[key];
    }
  }
  const toolRaw = attributes.tool;
  const toolObj: Record<string, unknown> = {};
  if (toolRaw && typeof toolRaw === "object" && !Array.isArray(toolRaw)) {
    const toolRecord = toolRaw as Record<string, unknown>;
    if (toolRecord.executionEvidence !== undefined && toolRecord.executionEvidence !== null) {
      toolObj.executionEvidence = toolRecord.executionEvidence;
    }
    if (toolRecord.parsedFromCodeMode !== undefined && toolRecord.parsedFromCodeMode !== null) {
      toolObj.parsedFromCodeMode = toolRecord.parsedFromCodeMode;
    }
  }
  result.tool = toolObj;
  return result;
}

export class SqliteSessionTurnRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async getMessageCount(sessionKey: string): Promise<number> {
    const row = this.database.get<{ message_count: number | string }>(
      "select message_count from sessions where session_key = ?",
      sessionKey,
    );
    return numberValue(row?.message_count);
  }

  async listSessionTurns(sessionKey: string, page?: { offset: number; limit: number }): Promise<SessionTurnSummary[]> {
    const rows = page
      ? this.database.all<SqliteSessionTurnSummaryRow>(
          `
            ${SQLITE_SESSION_TURN_SUMMARY_SQL}
            where turns.session_key = ?
            order by turns.turn_index
            limit ? offset ?
          `,
          sessionKey,
          page.limit,
          page.offset,
        )
      : this.database.all<SqliteSessionTurnSummaryRow>(
          `
            ${SQLITE_SESSION_TURN_SUMMARY_SQL}
            where turns.session_key = ?
            order by turns.turn_index
          `,
          sessionKey,
        );
    return rows.map(sessionTurnSummaryFromRow);
  }

  async getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null> {
    const summaryRow = this.database.get<SqliteSessionTurnSummaryRow>(
      `
        ${SQLITE_SESSION_TURN_SUMMARY_SQL}
        where turns.session_key = ? and turns.id = ?
      `,
      sessionKey,
      turnId,
    );
    if (!summaryRow) return null;

    const messageRows = this.database.all<TurnMessageRow>(
      `
        select message_index, source_message_index, role, content, occurred_at, metadata
        from turn_messages
        where turn_id = ?
        order by message_index
      `,
      turnId,
    );
    const spanRows = this.database.all<TraceSpanRow>(
      `
        select
          id, parent_span_id, span_index, kind, name, status,
          started_at, ended_at, call_id, input, output, error, attributes
        from trace_spans
        where turn_id = ?
        order by span_index
      `,
      turnId,
    );

    return {
      ...sessionTurnSummaryFromRow(summaryRow),
      messages: messageRows.map(turnMessageFromRow),
      spans: spanRows.map(traceSpanFromRow),
    };
  }

  async listSessionTrajectory(sessionKey: string): Promise<SessionTurnDetail[]> {
    const summaryRows = this.database.all<SqliteSessionTurnSummaryRow>(
      `
        ${SQLITE_SESSION_TURN_SUMMARY_SQL}
        where turns.session_key = ?
        order by turns.turn_index
      `,
      sessionKey,
    );
    const messageRows = this.database.all<TurnMessageRow>(
      `
        select
          messages.turn_id, messages.message_index, messages.source_message_index, messages.role,
          substr(messages.content, 1, ${SESSION_TRAJECTORY_PREVIEW_LENGTH}) as content,
          messages.occurred_at,
          messages.metadata
        from turn_messages messages
        join session_turns turns on turns.id = messages.turn_id
        where turns.session_key = ?
        order by turns.turn_index, messages.message_index
      `,
      sessionKey,
    );
    const spanRows = this.database.all<TraceSpanRow>(
      `
        select
          spans.turn_id, spans.id, spans.parent_span_id, spans.span_index, spans.kind, spans.name,
          spans.status, spans.started_at, spans.ended_at, spans.call_id,
          spans.input,
          spans.output,
          substr(spans.error, 1, ${SESSION_TRAJECTORY_PREVIEW_LENGTH}) as error,
          spans.attributes
        from trace_spans spans
        join session_turns turns on turns.id = spans.turn_id
        where turns.session_key = ?
        order by turns.turn_index, spans.span_index
      `,
      sessionKey,
    );

    const messagesByTurn = new Map<string, SessionTurnMessage[]>();
    for (const row of messageRows) {
      const list = messagesByTurn.get(row.turn_id!) ?? [];
      list.push({
        messageIndex: numberValue(row.message_index),
        sourceMessageIndex:
          row.source_message_index === null ? null : numberValue(row.source_message_index),
        role: row.role,
        content: row.content,
        timestamp: isoValue(row.occurred_at),
        ...messageFieldsFromMetadata(row.metadata),
      });
      messagesByTurn.set(row.turn_id!, list);
    }
    const spansByTurn = new Map<string, SessionTraceSpan[]>();
    for (const row of spanRows) {
      const list = spansByTurn.get(row.turn_id!) ?? [];
      list.push({
        id: row.id,
        parentSpanId: row.parent_span_id,
        spanIndex: numberValue(row.span_index),
        kind: row.kind,
        name: row.name,
        status: row.status,
        startedAt: nullableIsoValue(row.started_at),
        endedAt: nullableIsoValue(row.ended_at),
        callId: row.call_id,
        input: payloadPreview(row.input, "input"),
        output: payloadPreview(row.output, "output"),
        error: row.error,
        attributes: trajectorySpanAttributes(row.attributes),
      });
      spansByTurn.set(row.turn_id!, list);
    }
    return summaryRows.map((row) => {
      const summary = sessionTurnSummaryFromRow(row);
      return {
        ...summary,
        messages: messagesByTurn.get(summary.id) ?? [],
        spans: spansByTurn.get(summary.id) ?? [],
      };
    });
  }

  async listSessionContext(sessionKey: string): Promise<SessionContextSample[]> {
    const callRows = this.database.all<{
      occurred_at: unknown;
      input_tokens: unknown;
      cached_input_tokens: unknown;
      cache_creation_input_tokens: unknown;
      output_tokens: unknown;
    }>(
      `
        select occurred_at, input_tokens, cached_input_tokens, cache_creation_input_tokens, output_tokens
        from token_events
        where session_key = ?
        order by occurred_at, dedupe_key
      `,
      sessionKey,
    );
    const turnRows = this.database.all<{ id: string; turn_index: unknown; started_at: unknown }>(
      `
        select id, turn_index, started_at
        from session_turns
        where session_key = ? and started_at is not null
        order by started_at, turn_index
      `,
      sessionKey,
    );
    const turns = turnRows.map((row) => ({
      id: row.id,
      turnIndex: numberValue(row.turn_index),
      startedAt: Date.parse(isoValue(row.started_at)),
    }));
    let turn = -1;
    return callRows.map((row) => {
      const occurredAt = isoValue(row.occurred_at);
      const time = Date.parse(occurredAt);
      while (turn + 1 < turns.length && turns[turn + 1].startedAt <= time) turn += 1;
      const owner = turn >= 0 ? turns[turn] : null;
      return {
        turnId: owner?.id ?? null,
        turnIndex: owner?.turnIndex ?? null,
        occurredAt,
        inputTokens: numberValue(row.input_tokens),
        cachedInputTokens: numberValue(row.cached_input_tokens),
        cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens),
        outputTokens: numberValue(row.output_tokens),
      };
    });
  }

  async getMessages(sessionKey: string, offset = 0, limit = 120, fromTurnIndex?: number): Promise<SessionMessage[]> {
    const rows = this.database.all<{
      role: SessionMessage["role"];
      content: string;
      occurred_at: number | string | null;
      source_message_index: number | string;
      metadata: Record<string, unknown> | string;
    }>(
      `
        select
          messages.role, messages.content, messages.occurred_at,
          messages.source_message_index, messages.metadata
        from turn_messages messages
        join session_turns turns on turns.id = messages.turn_id
        where turns.session_key = ?
          and (? is null or turns.turn_index >= ?)
        order by messages.source_message_index, turns.turn_index, messages.message_index
        limit ?
        offset ?
      `,
      sessionKey,
      fromTurnIndex ?? null,
      fromTurnIndex ?? null,
      Math.max(0, limit),
      Math.max(0, offset),
    );
    return rows.map((row) => {
      const attachments = attachmentsFromMetadata(row.metadata);
      return {
        role: row.role,
        content: row.content,
        timestamp: isoValue(row.occurred_at),
        index: numberValue(row.source_message_index),
        ...messageFieldsFromMetadata(row.metadata),
        ...(attachments ? { attachments } : {}),
      };
    });
  }

  async getCodexMessageTail(
    sessionKey: string,
    expectedSize: number,
  ): Promise<Pick<LoadedSession, "messages" | "codexIncrementalState" | "messageAppend"> | null> {
    const sessionRow = this.database.get<{
      message_count: number;
      content_indexed_mtime_ms: number | string;
    }>(
      `
        select message_count, content_indexed_mtime_ms
        from sessions
        where session_key = ?
          and content_indexed_size = ?
          and codex_history_mode = 'legacy'
      `,
      sessionKey,
      expectedSize,
    );
    if (!sessionRow) return null;
    const latestTurn = this.database.get<{
      id: string;
      turn_index: number;
      source_message_index: number | null;
    }>(
      `
        select id, turn_index, source_message_index
        from session_turns
        where session_key = ?
        order by turn_index desc
        limit 1
      `,
      sessionKey,
    );
    const latestEvent = this.database.get<{ event_index: number }>(
      `
        select event_index
        from session_raw_events
        where session_key = ?
        order by event_index desc
        limit 1
      `,
      sessionKey,
    );
    if (
      !latestTurn
      || latestTurn.source_message_index === null
      || !latestEvent
      || numberValue(latestEvent.event_index) + 1 !== numberValue(sessionRow.message_count)
    ) {
      return null;
    }

    const rows = this.database.all<{
      role: SessionMessage["role"];
      content: string;
      occurred_at: number | string;
      source_message_index: number;
      metadata: Record<string, unknown> | string;
    }>(
      `
        select role, content, occurred_at, source_message_index, metadata
        from turn_messages
        where turn_id = ?
        order by source_message_index
      `,
      latestTurn.id,
    );
    const messages: SessionMessage[] = [];
    const messageProvenance: CodexIncrementalState["messageProvenance"] = [];
    let timestamp = -Infinity;
    for (const row of rows) {
      const metadata = jsonValue(row.metadata);
      const occurredAt = isoValue(row.occurred_at);
      const nextTimestamp = Date.parse(occurredAt);
      if (
        metadata.sourceTurnId
        || attachmentsFromMetadata(row.metadata)
        || !Number.isFinite(nextTimestamp)
        || nextTimestamp < timestamp
      ) {
        return null;
      }
      timestamp = nextTimestamp;
      const index = numberValue(row.source_message_index);
      if (index !== numberValue(latestTurn.source_message_index) + messages.length) return null;
      messages.push({
        role: row.role,
        content: row.content,
        timestamp: occurredAt,
        index,
        ...messageFieldsFromMetadata(row.metadata),
      });
      const codex = jsonValue(metadata.codex);
      messageProvenance.push({
        messageIndex: index,
        sourceRecordId: typeof codex.sourceItemId === "string" ? codex.sourceItemId : null,
      });
    }
    if (!messages.length || messages.at(-1)!.index + 1 !== numberValue(sessionRow.message_count)) {
      return null;
    }
    const raw = this.database.all<{ payload: Record<string, unknown> | string; kind: string }>(
      `
        select payload, kind
        from session_raw_events
        where session_key = ? and event_index >= ?
        order by event_index
      `,
      sessionKey,
      messages[0].index,
    );
    if (
      raw.length !== messages.length
      || raw.some((row, index) => row.kind !== "message" || jsonValue(row.payload).sourceMessageIndex !== messages[index].index)
    ) {
      return null;
    }
    return {
      messages,
      codexIncrementalState: { historyMode: "legacy", activeTurnIds: [], messageProvenance },
      messageAppend: {
        expectedSize,
        expectedMtimeMs: numberValue(sessionRow.content_indexed_mtime_ms),
        turnIndex: numberValue(latestTurn.turn_index),
        rawEventIndex: messages[0].index,
      },
    };
  }

  async getAllMessages(sessionKey: string): Promise<SessionMessage[]> {
    return this.getMessages(sessionKey, 0, 2_147_483_647);
  }

  async getCodexIncrementalState(sessionKey: string): Promise<CodexIncrementalState> {
    const sessionRow = this.database.get<{
      codex_history_mode: string | null;
      codex_tool_call_state: string | null;
    }>(
      "select codex_history_mode, codex_tool_call_state from sessions where session_key = ?",
      sessionKey,
    );
    const messageRows = this.database.all<{
      source_message_index: number | string;
      metadata: string;
    }>(
      `
        select messages.source_message_index, messages.metadata
        from turn_messages messages
        join session_turns turns on turns.id = messages.turn_id
        where turns.session_key = ?
        order by messages.source_message_index
      `,
      sessionKey,
    );
    const lifecycleRows = this.database.all<{ payload: string }>(
      `
        select payload
        from session_raw_events
        where session_key = ?
          and kind = 'trace'
          and json_extract(payload, '$.eventType') in (
            'codex.turn.started', 'codex.turn.completed', 'codex.turn.aborted'
          )
        order by event_index
      `,
      sessionKey,
    );
    const activeTurnIds = new Set<string>();
    for (const row of lifecycleRows) {
      const payload = jsonValue(row.payload);
      const sourceTurnId = typeof payload.sourceTurnId === "string" ? payload.sourceTurnId : "";
      if (!sourceTurnId) continue;
      if (payload.eventType === "codex.turn.started") activeTurnIds.add(sourceTurnId);
      else activeTurnIds.delete(sourceTurnId);
    }
    const toolCallState = nullableJsonValue(sessionRow?.codex_tool_call_state);
    return {
      historyMode: sessionRow?.codex_history_mode === "paginated" ? "paginated" : "legacy",
      messageProvenance: messageRows.map((row) => {
        const metadata = jsonValue(row.metadata);
        const codex = jsonValue(metadata.codex);
        return {
          messageIndex: numberValue(row.source_message_index),
          sourceRecordId: typeof codex.sourceItemId === "string" ? codex.sourceItemId : null,
        };
      }),
      activeTurnIds: [...activeTurnIds],
      ...(toolCallState && Array.isArray(toolCallState.observations)
        ? { toolCallState: toolCallState as unknown as NonNullable<CodexIncrementalState["toolCallState"]> }
        : {}),
    };
  }

  async getTraceEvents(
    sessionKey: string,
    options: TraceEventQueryOptions = {},
  ): Promise<SessionTraceEvent[]> {
    const params: Array<string | number> = [sessionKey];
    const where = ["session_key = ?", "kind = 'trace'"];
    if (options.startTimestamp) {
      const startMs = optionalTimeMs(options.startTimestamp);
      if (startMs !== null) {
        where.push("occurred_at >= ?");
        params.push(startMs);
      }
    }
    if (options.endTimestamp) {
      const endMs = optionalTimeMs(options.endTimestamp);
      if (endMs !== null) {
        where.push("occurred_at <= ?");
        params.push(endMs);
      }
    }
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : 0;
    if (limit > 0) params.push(limit);
    const rows = this.database.all<{
      payload: string;
      occurred_at: number | string | null;
    }>(
      `
        select payload, occurred_at
        from session_raw_events
        where ${where.join(" and ")}
        order by cast(json_extract(payload, '$.traceIndex') as integer)
        ${limit > 0 ? "limit ?" : ""}
      `,
      ...params,
    );
    return rows.map((row) => {
      const payload = jsonValue(row.payload);
      const status = normalizeSessionTraceStatus(payload.status);
      const attributes = payload.attributes && typeof payload.attributes === "object" && !Array.isArray(payload.attributes)
        ? payload.attributes as Record<string, unknown>
        : null;
      return {
        index: numberValue(payload.traceIndex),
        kind: payload.kind as SessionTraceEvent["kind"],
        source: payload.source as SessionTraceEvent["source"],
        title: String(payload.title || ""),
        detail: String(payload.detail || ""),
        timestamp: isoValue(row.occurred_at),
        ...(payload.callId ? { callId: String(payload.callId) } : {}),
        ...(payload.eventType ? { eventType: String(payload.eventType) } : {}),
        ...(status ? { status } : {}),
        ...(payload.sourceTurnId ? { sourceTurnId: String(payload.sourceTurnId) } : {}),
        ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
      };
    });
  }

  async getAssistantTextPositions(sessionKey: string): Promise<AssistantTextPosition[]> {
    const rows = this.database.all<{
      kind: string;
      trace_index: string | number | null;
      role: string | null;
      content: string | null;
    }>(
      `
        select
          kind,
          json_extract(payload, '$.traceIndex') as trace_index,
          json_extract(payload, '$.role') as role,
          json_extract(payload, '$.content') as content
        from session_raw_events
        where session_key = ? and kind in ('message', 'trace')
        order by event_index
      `,
      sessionKey,
    );
    const positions: AssistantTextPosition[] = [];
    let traceIndex: number | null = null;
    for (const row of rows) {
      if (row.kind === "trace") {
        if (row.trace_index !== null) traceIndex = numberValue(row.trace_index);
        continue;
      }
      const text = row.content ?? "";
      if (row.role !== "assistant" || text.trim() === "") continue;
      positions.push({ traceIndex, text });
    }
    return positions;
  }
}
