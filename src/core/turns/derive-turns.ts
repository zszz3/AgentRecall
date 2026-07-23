import { createHash } from "node:crypto";

import type {
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../types";

export const TURN_DERIVATION_VERSION = 1;

export interface DerivedRawEvent {
  eventIndex: number;
  eventId: string;
  kind: "message" | "trace" | "token";
  role: SessionMessage["role"] | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

export interface DerivedTurnMessage {
  messageIndex: number;
  sourceMessageIndex: number | null;
  role: SessionMessage["role"];
  content: string;
  occurredAt: string | null;
  metadata: Record<string, unknown>;
}

export interface DerivedTraceSpan {
  id: string;
  parentSpanId: string | null;
  spanIndex: number;
  kind: "tool" | "event";
  name: string;
  status: "running" | "completed" | "failed" | "aborted" | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  callId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  attributes: Record<string, unknown>;
}

export interface DerivedSessionTurn {
  id: string;
  turnIndex: number;
  sourceMessageIndex: number | null;
  synthetic: boolean;
  status: "completed" | "failed" | "aborted";
  startedAt: string | null;
  endedAt: string | null;
  userText: string;
  assistantText: string;
  toolText: string;
  searchText: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  errorCount: number;
  toolNames: string[];
  derivationVersion: number;
  messages: DerivedTurnMessage[];
  spans: DerivedTraceSpan[];
}

export interface DerivedSessionTimeline {
  rawEvents: DerivedRawEvent[];
  turns: DerivedSessionTurn[];
}

export interface DeriveSessionTimelineInput {
  sessionKey: string;
  messages: readonly SessionMessage[];
  traceEvents?: readonly SessionTraceEvent[];
  tokenEvents?: readonly TokenUsageEvent[];
}

interface TurnDraft {
  sourceMessageIndex: number | null;
  synthetic: boolean;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  tokenEvents: TokenUsageEvent[];
}

interface OrderedRawEvent extends Omit<DerivedRawEvent, "eventIndex"> {
  occurredAtMs: number | null;
  sourceOrder: number;
  kindOrder: number;
}

function stableId(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function timestampMs(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestampString(value: string | number): string | null {
  const parsed = timestampMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function compareTimestamped(
  left: { timestamp: string; index: number },
  right: { timestamp: string; index: number },
): number {
  const leftTime = timestampMs(left.timestamp);
  const rightTime = timestampMs(right.timestamp);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return left.index - right.index;
}

function createSyntheticTurn(): TurnDraft {
  return {
    sourceMessageIndex: null,
    synthetic: true,
    messages: [],
    traceEvents: [],
    tokenEvents: [],
  };
}

function ensureSyntheticTurn(turns: TurnDraft[]): TurnDraft {
  const existing = turns.find((turn) => turn.synthetic);
  if (existing) return existing;
  const synthetic = createSyntheticTurn();
  turns.unshift(synthetic);
  return synthetic;
}

function turnStartMs(turn: TurnDraft): number | null {
  const boundary = turn.messages.find((message) => message.role === "user");
  if (boundary) return timestampMs(boundary.timestamp);
  const timestamps = [
    ...turn.messages.map((message) => timestampMs(message.timestamp)),
    ...turn.traceEvents.map((event) => timestampMs(event.timestamp)),
    ...turn.tokenEvents.map((event) => timestampMs(event.timestamp)),
  ].filter((value): value is number => value !== null);
  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function findTurnForTimestamp(turns: TurnDraft[], occurredAt: number | null): TurnDraft | null {
  if (turns.length === 0) return null;
  if (occurredAt === null) return turns.at(-1) ?? null;

  let candidate: TurnDraft | null = null;
  for (const turn of turns) {
    if (turn.synthetic) continue;
    const startedAt = turnStartMs(turn);
    if (startedAt !== null && startedAt <= occurredAt) candidate = turn;
  }
  if (candidate) return candidate;

  const synthetic = turns.find((turn) => turn.synthetic);
  return synthetic ?? null;
}

function buildTurnDrafts(
  messages: readonly SessionMessage[],
  traceEvents: readonly SessionTraceEvent[],
  tokenEvents: readonly TokenUsageEvent[],
): TurnDraft[] {
  const turns: TurnDraft[] = [];
  let current: TurnDraft | null = null;

  for (const message of [...messages].sort((left, right) => left.index - right.index)) {
    if (message.role === "user") {
      current = {
        sourceMessageIndex: message.index,
        synthetic: false,
        messages: [message],
        traceEvents: [],
        tokenEvents: [],
      };
      turns.push(current);
    } else {
      current ??= ensureSyntheticTurn(turns);
      current.messages.push(message);
    }
  }

  for (const event of [...traceEvents].sort(compareTimestamped)) {
    const occurredAt = timestampMs(event.timestamp);
    let target = findTurnForTimestamp(turns, occurredAt);
    if (!target) target = ensureSyntheticTurn(turns);
    target.traceEvents.push(event);
  }

  for (const event of [...tokenEvents].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.dedupeKey.localeCompare(right.dedupeKey);
  })) {
    const occurredAt = timestampMs(event.timestamp);
    let target = findTurnForTimestamp(turns, occurredAt);
    if (!target) target = ensureSyntheticTurn(turns);
    target.tokenEvents.push(event);
  }

  if (turns.length === 0) turns.push(createSyntheticTurn());
  return turns;
}

function spanName(title: string): string {
  return title.split(" · ", 1)[0]?.trim() || "event";
}

function completedSpanStatus(status: SessionTraceEvent["status"]): DerivedTraceSpan["status"] {
  if (status === "failure") return "failed";
  if (status === "success") return "completed";
  return "unknown";
}

function buildSpans(turnId: string, traceEvents: readonly SessionTraceEvent[]): DerivedTraceSpan[] {
  const spans: DerivedTraceSpan[] = [];
  const calls = new Map<string, DerivedTraceSpan>();

  for (const event of [...traceEvents].sort(compareTimestamped)) {
    const callId = event.callId || null;
    const paired = callId && event.kind !== "tool_call" ? calls.get(callId) : undefined;
    if (paired) {
      paired.endedAt = timestampString(event.timestamp) ?? paired.startedAt;
      paired.output = { text: event.detail };
      paired.status = completedSpanStatus(event.status);
      paired.error = event.status === "failure" ? event.detail || event.title : null;
      paired.attributes = {
        ...paired.attributes,
        resultSource: event.source,
        ...(event.eventType ? { resultEventType: event.eventType } : {}),
      };
      continue;
    }

    const isTool = event.kind !== "event";
    const span: DerivedTraceSpan = {
      id: stableId(turnId, "span", event.callId || `${event.kind}:${event.index}`),
      parentSpanId: null,
      spanIndex: spans.length,
      kind: isTool ? "tool" : "event",
      name: spanName(event.title),
      status: event.kind === "tool_call" ? "running" : completedSpanStatus(event.status),
      startedAt: timestampString(event.timestamp),
      endedAt: event.kind === "tool_call" ? null : timestampString(event.timestamp),
      callId,
      input: event.kind === "tool_call" ? { text: event.detail } : null,
      output: event.kind === "tool_call" ? null : { text: event.detail },
      error: event.status === "failure" ? event.detail || event.title : null,
      attributes: {
        source: event.source,
        traceKind: event.kind,
        title: event.title,
        ...(event.eventType ? { eventType: event.eventType } : {}),
      },
    };
    spans.push(span);
    if (callId && event.kind === "tool_call") calls.set(callId, span);
  }

  return spans;
}

function turnTimeRange(turn: TurnDraft): { startedAt: string | null; endedAt: string | null } {
  const timestamps = [
    ...turn.messages.map((message) => timestampMs(message.timestamp)),
    ...turn.traceEvents.map((event) => timestampMs(event.timestamp)),
    ...turn.tokenEvents.map((event) => timestampMs(event.timestamp)),
  ].filter((value): value is number => value !== null);
  if (timestamps.length === 0) return { startedAt: null, endedAt: null };

  const userBoundary = turn.messages.find((message) => message.role === "user");
  const boundaryTime = userBoundary ? timestampMs(userBoundary.timestamp) : null;
  return {
    startedAt: new Date(boundaryTime ?? Math.min(...timestamps)).toISOString(),
    endedAt: new Date(Math.max(...timestamps)).toISOString(),
  };
}

function buildTurns(sessionKey: string, drafts: readonly TurnDraft[]): DerivedSessionTurn[] {
  return drafts.map((draft, turnIndex) => {
    const turnId = stableId(
      sessionKey,
      "turn",
      draft.synthetic ? "synthetic" : `message:${draft.sourceMessageIndex}`,
    );
    const messages = [...draft.messages]
      .sort((left, right) => left.index - right.index)
      .map<DerivedTurnMessage>((message, messageIndex) => ({
        messageIndex,
        sourceMessageIndex: message.index,
        role: message.role,
        content: message.content,
        occurredAt: timestampString(message.timestamp),
        metadata: {},
      }));
    const spans = buildSpans(turnId, draft.traceEvents);
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n");
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n\n");
    const toolText = [...draft.traceEvents]
      .sort(compareTimestamped)
      .map((event) => [event.title, event.detail].filter(Boolean).join("\n"))
      .join("\n\n");
    const tokenUsage = draft.tokenEvents.reduce(
      (total, event) => ({
        inputTokens: total.inputTokens + event.inputTokens,
        outputTokens: total.outputTokens + event.outputTokens,
        cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
        reasoningOutputTokens: total.reasoningOutputTokens + event.reasoningOutputTokens,
        totalTokens: total.totalTokens + event.totalTokens,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    );
    const errorCount = spans.filter((span) => span.status === "failed").length;
    const aborted = draft.traceEvents.some((event) => event.eventType === "turn_aborted");
    const { startedAt, endedAt } = turnTimeRange(draft);

    return {
      id: turnId,
      turnIndex,
      sourceMessageIndex: draft.sourceMessageIndex,
      synthetic: draft.synthetic,
      status: aborted ? "aborted" : errorCount > 0 ? "failed" : "completed",
      startedAt,
      endedAt,
      userText,
      assistantText,
      toolText,
      searchText: [userText, assistantText, toolText].filter(Boolean).join("\n\n"),
      ...tokenUsage,
      errorCount,
      toolNames: [...new Set(spans.map((span) => span.name))],
      derivationVersion: TURN_DERIVATION_VERSION,
      messages,
      spans,
    };
  });
}

function buildRawEvents(
  sessionKey: string,
  messages: readonly SessionMessage[],
  traceEvents: readonly SessionTraceEvent[],
  tokenEvents: readonly TokenUsageEvent[],
): DerivedRawEvent[] {
  const events: OrderedRawEvent[] = [
    ...messages.map<OrderedRawEvent>((message) => ({
      eventId: stableId(sessionKey, "message", message.index),
      kind: "message",
      role: message.role,
      occurredAt: timestampString(message.timestamp),
      occurredAtMs: timestampMs(message.timestamp),
      sourceOrder: message.index,
      kindOrder: 0,
      payload: {
        sourceMessageIndex: message.index,
        role: message.role,
        content: message.content,
      },
    })),
    ...traceEvents.map<OrderedRawEvent>((event) => ({
      eventId: stableId(sessionKey, "trace", event.index),
      kind: "trace",
      role: null,
      occurredAt: timestampString(event.timestamp),
      occurredAtMs: timestampMs(event.timestamp),
      sourceOrder: event.index,
      kindOrder: 1,
      payload: {
        traceIndex: event.index,
        kind: event.kind,
        source: event.source,
        title: event.title,
        detail: event.detail,
        callId: event.callId ?? null,
        eventType: event.eventType ?? null,
        status: event.status ?? null,
      },
    })),
    ...tokenEvents.map<OrderedRawEvent>((event) => ({
      eventId: stableId(sessionKey, "token", event.dedupeKey),
      kind: "token",
      role: null,
      occurredAt: timestampString(event.timestamp),
      occurredAtMs: timestampMs(event.timestamp),
      sourceOrder: 0,
      kindOrder: 2,
      payload: {
        dedupeKey: event.dedupeKey,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: event.totalTokens,
      },
    })),
  ];

  events.sort((left, right) => {
    if (left.occurredAtMs !== null && right.occurredAtMs !== null && left.occurredAtMs !== right.occurredAtMs) {
      return left.occurredAtMs - right.occurredAtMs;
    }
    if (left.occurredAtMs !== null && right.occurredAtMs === null) return -1;
    if (left.occurredAtMs === null && right.occurredAtMs !== null) return 1;
    if (left.kindOrder !== right.kindOrder) return left.kindOrder - right.kindOrder;
    if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
    return left.eventId.localeCompare(right.eventId);
  });

  return events.map(({ occurredAtMs: _occurredAtMs, sourceOrder: _sourceOrder, kindOrder: _kindOrder, ...event }, eventIndex) => ({
    ...event,
    eventIndex,
  }));
}

export function deriveSessionTimeline({
  sessionKey,
  messages,
  traceEvents = [],
  tokenEvents = [],
}: DeriveSessionTimelineInput): DerivedSessionTimeline {
  const drafts = buildTurnDrafts(messages, traceEvents, tokenEvents);
  return {
    rawEvents: buildRawEvents(sessionKey, messages, traceEvents, tokenEvents),
    turns: buildTurns(sessionKey, drafts),
  };
}
