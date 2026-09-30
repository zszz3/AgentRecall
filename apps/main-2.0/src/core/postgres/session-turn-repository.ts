import type {
  CodexIncrementalState,
  LoadedSession,
  SessionAttachment,
  SessionMessage,
  SessionTraceEvent,
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../types";
import { normalizeSessionTraceStatus } from "../trace-presentation";
import type { PostgresDatabase } from "./database";
import {
  SESSION_TURN_SUMMARY_SQL,
  isoValue,
  jsonValue,
  nullableIsoValue,
  nullableJsonValue,
  numberValue,
  sessionTurnSummaryFromRow,
  type SessionTurnSummaryRow,
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

export interface TraceEventQueryOptions {
  startTimestamp?: string;
  endTimestamp?: string;
  limit?: number;
}

/**
 * One assistant message, placed at the trace position it follows.
 *
 * A range of trace positions can then claim the text that belongs to it without
 * guessing an alignment from timestamps.
 */
export interface AssistantTextPosition {
  /** Trace index of the last event before the message; null when there was none. */
  traceIndex: number | null;
  text: string;
}

export class PostgresSessionTurnRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async getMessageCount(sessionKey: string): Promise<number> {
    const result = await this.database.query<{ message_count: number | string }>(
      "select message_count from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    return numberValue(result.rows[0]?.message_count);
  }

  async listSessionTurns(sessionKey: string, page?: { offset: number; limit: number }): Promise<SessionTurnSummary[]> {
    const result = await this.database.query<SessionTurnSummaryRow>(
      `
        ${SESSION_TURN_SUMMARY_SQL}
        where turns.session_key = $1
        order by turns.turn_index
        ${page ? "offset $2 limit $3" : ""}
      `,
      page ? [sessionKey, page.offset, page.limit] : [sessionKey],
    );
    return result.rows.map(sessionTurnSummaryFromRow);
  }

  async getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null> {
    const summaryResult = await this.database.query<SessionTurnSummaryRow>(
      `
        ${SESSION_TURN_SUMMARY_SQL}
        where turns.session_key = $1 and turns.id = $2
      `,
      [sessionKey, turnId],
    );
    const summaryRow = summaryResult.rows[0];
    if (!summaryRow) return null;

    const [messageResult, spanResult] = await Promise.all([
      this.database.query<{
        message_index: number | string;
        source_message_index: number | string | null;
        role: SessionTurnMessage["role"];
        content: string;
        occurred_at: Date | string | null;
        metadata: Record<string, unknown> | string;
      }>(
        `
          select message_index, source_message_index, role, content, occurred_at, metadata
          from agent_recall.turn_messages
          where turn_id = $1
          order by message_index
        `,
        [turnId],
      ),
      this.database.query<{
        id: string;
        parent_span_id: string | null;
        span_index: number | string;
        kind: SessionTraceSpan["kind"];
        name: string;
        status: SessionTraceSpan["status"];
        started_at: Date | string | null;
        ended_at: Date | string | null;
        call_id: string | null;
        input: Record<string, unknown> | string | null;
        output: Record<string, unknown> | string | null;
        error: string | null;
        attributes: Record<string, unknown> | string;
      }>(
        `
          select
            id, parent_span_id, span_index, kind, name, status,
            started_at, ended_at, call_id, input, output, error, attributes
          from agent_recall.trace_spans
          where turn_id = $1
          order by span_index
        `,
        [turnId],
      ),
    ]);

    return {
      ...sessionTurnSummaryFromRow(summaryRow),
      messages: messageResult.rows.map((row) => ({
        messageIndex: numberValue(row.message_index),
        sourceMessageIndex:
          row.source_message_index === null ? null : numberValue(row.source_message_index),
        role: row.role,
        content: row.content,
        timestamp: isoValue(row.occurred_at),
        ...messageFieldsFromMetadata(row.metadata),
        ...(attachmentsFromMetadata(row.metadata)
          ? { attachments: attachmentsFromMetadata(row.metadata) }
          : {}),
      })),
      spans: spanResult.rows.map((row) => ({
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
      })),
    };
  }

  async getMessages(sessionKey: string, offset = 0, limit = 120): Promise<SessionMessage[]> {
    const result = await this.database.query<{
      role: SessionMessage["role"];
      content: string;
      occurred_at: Date | string | null;
      source_message_index: number | string;
      metadata: Record<string, unknown> | string;
    }>(
      `
        select
          messages.role, messages.content, messages.occurred_at,
          messages.source_message_index, messages.metadata
        from agent_recall.turn_messages messages
        join agent_recall.session_turns turns on turns.id = messages.turn_id
        where turns.session_key = $1
        order by messages.source_message_index, turns.turn_index, messages.message_index
        offset $2
        limit $3
      `,
      [sessionKey, Math.max(0, offset), Math.max(0, limit)],
    );
    return result.rows.map((row) => {
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

  async getCodexMessageTail(sessionKey: string, expectedSize: number): Promise<Pick<LoadedSession, "messages" | "codexIncrementalState" | "messageAppend"> | null> {
    // Both lookups use session-local ordered indexes. No OFFSET or history scan.
    const result = await this.database.query<{
      id: string; turn_index: number; source_message_index: number;
      message_count: number; event_index: number; content_indexed_mtime_ms: number | string;
    }>(`
      select turns.id, turns.turn_index, turns.source_message_index,
        sessions.message_count, events.event_index, sessions.content_indexed_mtime_ms
      from agent_recall.sessions sessions
      join lateral (
        select id, turn_index, source_message_index from agent_recall.session_turns
        where session_key = sessions.session_key order by turn_index desc limit 1
      ) turns on true
      join lateral (
        select event_index from agent_recall.session_raw_events
        where session_key = sessions.session_key order by event_index desc limit 1
      ) events on true
      where sessions.session_key = $1 and sessions.content_indexed_size = $2
        and sessions.codex_history_mode = 'legacy'
        and events.event_index + 1 = sessions.message_count
    `, [sessionKey, expectedSize]);
    const tail = result.rows[0];
    if (!tail || tail.source_message_index === null) return null;
    const rows = await this.database.query<{
      role: SessionMessage["role"]; content: string; occurred_at: Date | string;
      source_message_index: number; metadata: Record<string, unknown> | string;
    }>(`select role, content, occurred_at, source_message_index, metadata
      from agent_recall.turn_messages where turn_id = $1 order by source_message_index`, [tail.id]);
    const messages: SessionMessage[] = [];
    const messageProvenance: CodexIncrementalState["messageProvenance"] = [];
    let timestamp = -Infinity;
    for (const row of rows.rows) {
      const metadata = jsonValue(row.metadata);
      const occurredAt = isoValue(row.occurred_at);
      const nextTimestamp = Date.parse(occurredAt);
      if (metadata.sourceTurnId || attachmentsFromMetadata(row.metadata)
        || !Number.isFinite(nextTimestamp) || nextTimestamp < timestamp) return null;
      timestamp = nextTimestamp;
      const index = numberValue(row.source_message_index);
      if (index !== numberValue(tail.source_message_index) + messages.length) return null;
      messages.push({ role: row.role, content: row.content, timestamp: occurredAt, index, ...messageFieldsFromMetadata(row.metadata) });
      const codex = jsonValue(metadata.codex);
      messageProvenance.push({ messageIndex: index, sourceRecordId: typeof codex.sourceItemId === "string" ? codex.sourceItemId : null });
    }
    if (!messages.length || messages.at(-1)!.index + 1 !== numberValue(tail.message_count)) return null;
    // Verify that raw chronological ordering matches the message suffix as well.
    const raw = await this.database.query<{ payload: Record<string, unknown> | string; kind: string }>(`
      select payload, kind from agent_recall.session_raw_events
      where session_key = $1 and event_index >= $2 order by event_index
    `, [sessionKey, messages[0].index]);
    if (raw.rows.length !== messages.length || raw.rows.some((row, index) =>
      row.kind !== "message" || jsonValue(row.payload).sourceMessageIndex !== messages[index].index)) return null;
    return {
      messages,
      codexIncrementalState: { historyMode: "legacy", activeTurnIds: [], messageProvenance },
      messageAppend: { expectedSize, expectedMtimeMs: numberValue(tail.content_indexed_mtime_ms), turnIndex: numberValue(tail.turn_index), rawEventIndex: messages[0].index },
    };
  }

  async getAllMessages(sessionKey: string): Promise<SessionMessage[]> {
    return this.getMessages(sessionKey, 0, 2_147_483_647);
  }

  async getCodexIncrementalState(sessionKey: string): Promise<CodexIncrementalState> {
    const [sessionResult, messageResult, lifecycleResult] = await Promise.all([
      this.database.query<{
        codex_history_mode: string | null;
        codex_tool_call_state: Record<string, unknown> | string | null;
      }>(
        "select codex_history_mode, codex_tool_call_state from agent_recall.sessions where session_key = $1",
        [sessionKey],
      ),
      this.database.query<{
        source_message_index: number | string;
        metadata: Record<string, unknown> | string;
      }>(
        `
          select messages.source_message_index, messages.metadata
          from agent_recall.turn_messages messages
          join agent_recall.session_turns turns on turns.id = messages.turn_id
          where turns.session_key = $1
          order by messages.source_message_index
        `,
        [sessionKey],
      ),
      this.database.query<{ payload: Record<string, unknown> | string }>(
        `
          select payload
          from agent_recall.session_raw_events
          where session_key = $1
            and kind = 'trace'
            and payload->>'eventType' in (
              'codex.turn.started', 'codex.turn.completed', 'codex.turn.aborted'
            )
          order by event_index
        `,
        [sessionKey],
      ),
    ]);
    const activeTurnIds = new Set<string>();
    for (const row of lifecycleResult.rows) {
      const payload = jsonValue(row.payload);
      const sourceTurnId = typeof payload.sourceTurnId === "string" ? payload.sourceTurnId : "";
      if (!sourceTurnId) continue;
      if (payload.eventType === "codex.turn.started") activeTurnIds.add(sourceTurnId);
      else activeTurnIds.delete(sourceTurnId);
    }
    const toolCallState = nullableJsonValue(sessionResult.rows[0]?.codex_tool_call_state);
    return {
      historyMode: sessionResult.rows[0]?.codex_history_mode === "paginated" ? "paginated" : "legacy",
      messageProvenance: messageResult.rows.map((row) => {
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
    // An unset limit must return every event: callers feed the result back into
    // upsertIndexedSession, which replaces stored events wholesale, so a capped
    // default would permanently drop the newest events of long sessions.
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : 0;
    if (limit > 0) values.push(limit);
    const result = await this.database.query<{
      payload: Record<string, unknown> | string;
      occurred_at: Date | string | null;
    }>(
      `
        select payload, occurred_at
        from agent_recall.session_raw_events
        where ${where.join(" and ")}
        order by (payload->>'traceIndex')::integer
        ${limit > 0 ? `limit $${values.length}` : ""}
      `,
      values,
    );
    return result.rows.map((row) => {
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

  /**
   * The assistant text of a session, each message placed at the trace position it
   * follows.
   *
   * Messages and trace events are stored in one merged sequence whose order was
   * decided when the session was indexed, so this reads that order instead of
   * re-deriving it. Re-deriving it would mean agreeing with `buildRawEvents` about
   * timestamps that are optional and frequently equal, in a second place.
   */
  async getAssistantTextPositions(sessionKey: string): Promise<AssistantTextPosition[]> {
    const result = await this.database.query<{
      kind: string;
      trace_index: string | number | null;
      role: string | null;
      content: string | null;
    }>(
      `
        select
          kind,
          payload->>'traceIndex' as trace_index,
          payload->>'role' as role,
          payload->>'content' as content
        from agent_recall.session_raw_events
        where session_key = $1 and kind in ('message', 'trace')
        order by event_index
      `,
      [sessionKey],
    );
    const positions: AssistantTextPosition[] = [];
    let traceIndex: number | null = null;
    for (const row of result.rows) {
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
