import type {
  SessionMessage,
  SessionTraceEvent,
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../types";
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

export interface TraceEventQueryOptions {
  startTimestamp?: string;
  endTimestamp?: string;
  limit?: number;
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

  async listSessionTurns(sessionKey: string): Promise<SessionTurnSummary[]> {
    const result = await this.database.query<SessionTurnSummaryRow>(
      `
        ${SESSION_TURN_SUMMARY_SQL}
        where turns.session_key = $1
        order by turns.turn_index
      `,
      [sessionKey],
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
      }>(
        `
          select message_index, source_message_index, role, content, occurred_at
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
}
