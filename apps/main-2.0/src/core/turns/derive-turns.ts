import { createHash } from "node:crypto";

import type {
  CodexIncrementalState,
  SessionMessage,
  SessionTraceEvent,
  SessionTurnStatus,
  TokenUsageEvent,
} from "../types";
import { tracePresentation } from "../trace-presentation";

export const TURN_DERIVATION_VERSION = 11;

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
  sourceTurnId: string | null;
  synthetic: boolean;
  status: SessionTurnStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  abortReason: string | null;
  userText: string;
  assistantText: string;
  toolText: string;
  searchText: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
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
  codexIncrementalState?: CodexIncrementalState;
}

interface TurnDraft {
  sourceMessageIndex: number | null;
  sourceTurnId: string | null;
  synthetic: boolean;
  hasReply?: true;
  superseded?: true;
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

function createSyntheticTurn(sourceTurnId: string | null = null): TurnDraft {
  return {
    sourceMessageIndex: null,
    sourceTurnId,
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

function lifecycleEndedAtMs(traceEvents: readonly SessionTraceEvent[]): Map<string, number> {
  const endedAt = new Map<string, number>();
  for (const event of traceEvents) {
    if (!event.sourceTurnId) continue;
    if (event.eventType !== "codex.turn.completed" && event.eventType !== "codex.turn.aborted") continue;
    const rawEndedAt = event.attributes?.endedAt;
    const explicitEndedAt = typeof rawEndedAt === "string" || typeof rawEndedAt === "number"
      ? timestampMs(rawEndedAt)
      : null;
    const recordedAt = timestampMs(event.timestamp);
    // Codex lifecycle payloads can truncate completed_at to whole seconds while
    // the final message and rollout row retain milliseconds. The terminal row
    // is the later observable boundary for deciding whether a turn id is stale.
    const terminalAt = explicitEndedAt === null
      ? recordedAt
      : recordedAt === null
        ? explicitEndedAt
        : Math.max(explicitEndedAt, recordedAt);
    if (terminalAt === null) continue;
    const previous = endedAt.get(event.sourceTurnId);
    if (previous === undefined || terminalAt > previous) endedAt.set(event.sourceTurnId, terminalAt);
  }
  return endedAt;
}

function isStaleSourceTurnId(
  sourceTurnId: string | null | undefined,
  occurredAt: number | null,
  turnEndedAtMs: ReadonlyMap<string, number>,
): boolean {
  if (!sourceTurnId || occurredAt === null) return false;
  const endedAt = turnEndedAtMs.get(sourceTurnId);
  return endedAt !== undefined && occurredAt > endedAt;
}

function isTurnLifecycleEvent(event: SessionTraceEvent): boolean {
  return event.eventType === "codex.turn.started"
    || event.eventType === "codex.turn.completed"
    || event.eventType === "codex.turn.aborted";
}

function userStartedAt(turn: TurnDraft): number | null {
  return timestampMs(turn.messages.find((message) => message.role === "user")?.timestamp ?? "");
}

function buildTimestampBoundaries(turns: readonly TurnDraft[], startTime: (turn: TurnDraft) => number | null) {
  return turns
    .map((turn, order) => ({ turn, order, startedAt: startTime(turn) }))
    .filter((boundary): boundary is typeof boundary & { startedAt: number } => boundary.startedAt !== null)
    .sort((left, right) => left.startedAt - right.startedAt || left.order - right.order);
}

function timestampBoundaryEnd(boundaries: readonly { startedAt: number }[], occurredAt: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (boundaries[middle].startedAt <= occurredAt) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildTurnDrafts(
  messages: readonly SessionMessage[],
  traceEvents: readonly SessionTraceEvent[],
  tokenEvents: readonly TokenUsageEvent[],
): TurnDraft[] {
  const turns: TurnDraft[] = [];
  const turnsBySourceId = new Map<string, TurnDraft>();
  const splitTurnsBySourceId = new Map<string, TurnDraft[]>();
  const turnEndedAtMs = lifecycleEndedAtMs(traceEvents);
  let current: TurnDraft | null = null;
  let latestUserTurn: TurnDraft | null = null;

  for (const message of [...messages].sort((left, right) => left.index - right.index)) {
    const messageTime = timestampMs(message.timestamp);
    const staleSourceTurn = isStaleSourceTurnId(message.sourceTurnId, messageTime, turnEndedAtMs);

    // Codex may keep tagging assistant replies with a completed turn id after a newer
    // user turn started. Prefer the latest user turn for display grouping.
    if (message.role !== "user" && message.sourceTurnId && staleSourceTurn && latestUserTurn) {
      current = latestUserTurn;
    } else if (message.sourceTurnId) {
      const previous = turnsBySourceId.get(message.sourceTurnId);
      // A resumed rollout can replay multiple exchanges with one passthrough id.
      // Consecutive prompts or steering after commentary alone are not exchanges.
      if (!previous || (message.role === "user" && previous.sourceMessageIndex !== null && previous.hasReply)) {
        current = createSyntheticTurn(message.sourceTurnId);
        turnsBySourceId.set(message.sourceTurnId, current);
        turns.push(current);
        if (previous) {
          previous.superseded = true;
          const splitTurns = splitTurnsBySourceId.get(message.sourceTurnId);
          if (splitTurns) splitTurns.push(current);
          else splitTurnsBySourceId.set(message.sourceTurnId, [previous, current]);
        }
      } else {
        current = previous;
      }
    } else if (message.role === "user") {
      current = createSyntheticTurn();
      turns.push(current);
    } else {
      current ??= ensureSyntheticTurn(turns);
    }
    if (message.role === "user") {
      current.sourceMessageIndex ??= message.index;
      current.synthetic = false;
      latestUserTurn = current;
    } else if (message.role === "assistant" && message.phase !== "commentary") {
      current.hasReply = true;
    }
    current.messages.push(message);
  }

  const lifecycleStartedAt = new Map<TurnDraft, number>();
  const orderedTraceEvents = [...traceEvents].sort(compareTimestamped);
  const splitBoundaries = new Map(
    [...splitTurnsBySourceId].map(([id, drafts]) => [id, buildTimestampBoundaries(drafts, userStartedAt)]),
  );
  const splitRoutingStartedAt = new Map<TurnDraft, number>();
  for (const event of orderedTraceEvents) {
    if (!event.sourceTurnId || !isTurnLifecycleEvent(event)) continue;
    let lifecycleTurn = turnsBySourceId.get(event.sourceTurnId);
    if (!lifecycleTurn) {
      lifecycleTurn = createSyntheticTurn(event.sourceTurnId);
      turnsBySourceId.set(event.sourceTurnId, lifecycleTurn);
      turns.push(lifecycleTurn);
    }
    if (event.eventType !== "codex.turn.started") continue;
    const rawStartedAt = event.attributes?.startedAt;
    const startedAt = timestampMs(
      typeof rawStartedAt === "string" || typeof rawStartedAt === "number"
        ? rawStartedAt
        : event.timestamp,
    );
    if (startedAt === null) continue;
    const boundaries = splitBoundaries.get(event.sourceTurnId);
    if (boundaries?.length) {
      const recordedAt = timestampMs(event.timestamp) ?? startedAt;
      const end = timestampBoundaryEnd(boundaries, recordedAt);
      const previousLastMessageAt = timestampMs(boundaries[end - 1]?.turn.messages.at(-1)?.timestamp ?? "");
      // The task start can precede the new user message, after the last replayed reply.
      const next = boundaries[end];
      if (next && (end === 0 || (previousLastMessageAt !== null && previousLastMessageAt < recordedAt))) {
        lifecycleTurn = next.turn;
        const previousStart = splitRoutingStartedAt.get(lifecycleTurn);
        if (previousStart === undefined || recordedAt < previousStart) splitRoutingStartedAt.set(lifecycleTurn, recordedAt);
      } else {
        lifecycleTurn = boundaries[end - 1]?.turn ?? lifecycleTurn;
      }
    }
    const previous = lifecycleStartedAt.get(lifecycleTurn);
    if (previous === undefined || startedAt < previous) lifecycleStartedAt.set(lifecycleTurn, startedAt);
  }

  const routingStartTime = (turn: TurnDraft): number | null => {
    const userStart = userStartedAt(turn);
    const splitStart = splitRoutingStartedAt.get(turn);
    if (splitStart !== undefined) return userStart === null ? splitStart : Math.min(userStart, splitStart);
    return userStart ?? lifecycleStartedAt.get(turn) ?? null;
  };
  for (const [id, drafts] of splitTurnsBySourceId) {
    if (drafts.some((turn) => splitRoutingStartedAt.has(turn))) {
      splitBoundaries.set(id, buildTimestampBoundaries(drafts, routingStartTime));
    }
  }
  const findSourceTurn = (sourceTurnId: string, occurredAt: number | null): TurnDraft | null => {
    const boundaries = splitBoundaries.get(sourceTurnId);
    if (boundaries?.length && occurredAt !== null) {
      return boundaries[Math.max(0, timestampBoundaryEnd(boundaries, occurredAt) - 1)].turn;
    }
    return turnsBySourceId.get(sourceTurnId) ?? null;
  };

  const timestampBoundaries = buildTimestampBoundaries(turns, routingStartTime);
  let latestOrder = -1;
  let latestTurn: TurnDraft | null = null;
  const timestampCandidates = timestampBoundaries.map((boundary) => {
    if (boundary.order >= latestOrder) {
      latestOrder = boundary.order;
      latestTurn = boundary.turn;
    }
    return latestTurn;
  });
  const findTurnForTimestamp = (occurredAt: number | null): TurnDraft | null => {
    if (turns.length === 0) return null;
    if (occurredAt === null) return turns.at(-1) ?? null;

    const end = timestampBoundaryEnd(timestampBoundaries, occurredAt);
    return end > 0 ? timestampCandidates[end - 1] : turns.find((turn) => turn.synthetic) ?? null;
  };

  for (const event of orderedTraceEvents) {
    const occurredAt = timestampMs(event.timestamp);
    const sourceTurnId = event.sourceTurnId;
    const isLifecycle = isTurnLifecycleEvent(event);
    const splitLifecycle = isLifecycle && sourceTurnId && splitTurnsBySourceId.has(sourceTurnId);
    const staleSourceTurn = !splitLifecycle && isStaleSourceTurnId(sourceTurnId, occurredAt, turnEndedAtMs);
    let target = sourceTurnId && !staleSourceTurn ? findSourceTurn(sourceTurnId, occurredAt) : null;
    if (!target && sourceTurnId && !staleSourceTurn) {
      target = createSyntheticTurn(sourceTurnId);
      turnsBySourceId.set(sourceTurnId, target);
      turns.push(target);
    }
    target ??= findTurnForTimestamp(occurredAt);
    if (!target) target = ensureSyntheticTurn(turns);
    if (isLifecycle) {
      target.synthetic = false;
    }
    target.traceEvents.push(event);
  }

  for (const event of [...tokenEvents].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.dedupeKey.localeCompare(right.dedupeKey);
  })) {
    const occurredAt = timestampMs(event.timestamp);
    const sourceTurnId = event.sourceTurnId?.trim() || null;
    const staleSourceTurn = isStaleSourceTurnId(sourceTurnId, occurredAt, turnEndedAtMs);
    let target = sourceTurnId && !staleSourceTurn ? findSourceTurn(sourceTurnId, occurredAt) : null;
    if (sourceTurnId && !target && !staleSourceTurn) continue;
    target ??= findTurnForTimestamp(occurredAt);
    if (!target) target = ensureSyntheticTurn(turns);
    target.tokenEvents.push(event);
  }

  return turns
    .filter((turn) => turn.messages.length > 0 || turn.traceEvents.length > 0)
    .map((turn, order) => ({
      turn,
      order,
      startedAt: timestampMs(lifecycleProjection(turn).startedAt ?? turnTimeRange(turn).startedAt ?? ""),
    }))
    .sort((left, right) => {
      if (left.startedAt === null && right.startedAt === null) return left.order - right.order;
      if (left.startedAt === null) return 1;
      if (right.startedAt === null) return -1;
      return left.startedAt - right.startedAt || left.order - right.order;
    })
    .map(({ turn }) => turn);
}

function spanName(title: string): string {
  return title.split(" · ", 1)[0]?.trim() || "event";
}

function completedSpanStatus(status: SessionTraceEvent["status"]): DerivedTraceSpan["status"] {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  if (status === "running") return "running";
  return "unknown";
}

/**
 * A call stays running until its result arrives, unless the loader already merged the result
 * into the call (DeepSeek Harness does) or the evidence says the call never ran.
 */
function callSpanStatus(
  status: SessionTraceEvent["status"],
  executionEvidence: string | null,
): DerivedTraceSpan["status"] {
  if (status === "completed" || status === "failed" || status === "aborted") return status;
  if (executionEvidence === "static-only" || executionEvidence === "recorded-request") return completedSpanStatus(status);
  return "running";
}

function spanPayload(value: unknown, fallback: string): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return value ? { text: value } : fallback ? { text: fallback } : null;
  }
  if (value !== null && value !== undefined) return { value };
  return fallback ? { text: fallback } : null;
}

function spanOutput(event: SessionTraceEvent): Record<string, unknown> | null {
  const hasExplicitOutput = event.attributes !== undefined
    && Object.prototype.hasOwnProperty.call(event.attributes, "output");
  return spanPayload(event.attributes?.output, hasExplicitOutput ? "" : event.detail);
}

/** Input and output already have their own span columns; keeping them in attributes would store them twice. */
function withoutPayload(attributes: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!attributes) return {};
  const { input: _input, output: _output, ...rest } = attributes;
  return rest;
}

function attributeTimestamp(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? timestampString(value) : null;
}

function toolAttribute(
  attributes: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const tool = attributes?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const value = (tool as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : null;
}

function isToolSpan(span: DerivedTraceSpan): boolean {
  const traceKind = span.attributes.traceKind;
  const kind = traceKind === "tool_call" || traceKind === "tool_result" ? traceKind : "event";
  const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : null;
  return tracePresentation({ kind, eventType }).category === "tool";
}

function buildSpans(turnId: string, traceEvents: readonly SessionTraceEvent[]): DerivedTraceSpan[] {
  const spans: DerivedTraceSpan[] = [];
  const calls = new Map<string, DerivedTraceSpan>();

  for (const event of [...traceEvents].sort(compareTimestamped)) {
    if (tracePresentation(event).category === "lifecycle") continue;
    const callId = event.callId || null;
    const paired = callId && event.kind !== "tool_call" ? calls.get(callId) : undefined;
    if (paired) {
      paired.endedAt = attributeTimestamp(event.attributes?.endedAt) ?? timestampString(event.timestamp) ?? paired.startedAt;
      paired.output = spanOutput(event);
      paired.status = completedSpanStatus(event.status);
      paired.error = event.status === "failed" ? event.detail || event.title : null;
      paired.attributes = {
        ...paired.attributes,
        resultSource: event.source,
        ...(event.eventType ? { resultEventType: event.eventType } : {}),
      };
      continue;
    }

    const isTool = event.kind !== "event";
    const startedAt = attributeTimestamp(event.attributes?.startedAt) ?? timestampString(event.timestamp);
    const endedAt = attributeTimestamp(event.attributes?.endedAt)
      ?? (event.kind === "tool_call" ? null : timestampString(event.timestamp));
    const executionEvidence = toolAttribute(event.attributes, "executionEvidence");
    const span: DerivedTraceSpan = {
      id: stableId(turnId, "span", event.callId || `${event.kind}:${event.index}`),
      parentSpanId: null,
      spanIndex: spans.length,
      kind: isTool ? "tool" : "event",
      name: spanName(event.title),
      status: event.kind === "tool_call" ? callSpanStatus(event.status, executionEvidence) : completedSpanStatus(event.status),
      startedAt,
      endedAt,
      callId,
      input: spanPayload(event.attributes?.input, event.kind === "tool_call" ? event.detail : ""),
      // A call carries output only when its loader merged the result into it (DeepSeek Harness does).
      output: event.kind === "tool_call" ? spanPayload(event.attributes?.output, "") : spanOutput(event),
      error: event.status === "failed" ? event.detail || event.title : null,
      attributes: {
        source: event.source,
        traceKind: event.kind,
        title: event.title,
        ...(event.eventType ? { eventType: event.eventType } : {}),
        ...withoutPayload(event.attributes),
      },
    };
    spans.push(span);
    if (callId && event.kind === "tool_call") calls.set(callId, span);
  }

  const spansByCallId = new Map(
    spans.flatMap((span) => span.callId ? [[span.callId, span] as const] : []),
  );
  for (const span of spans) {
    const parentCallId = toolAttribute(span.attributes, "parentCallId");
    const parent = parentCallId ? spansByCallId.get(parentCallId) : undefined;
    if (parent && parent !== span) span.parentSpanId = parent.id;
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

  const boundaryTime = userStartedAt(turn);
  return {
    startedAt: new Date(boundaryTime ?? Math.min(...timestamps)).toISOString(),
    endedAt: new Date(Math.max(...timestamps)).toISOString(),
  };
}

function attributeString(attributes: Record<string, unknown> | undefined, key: string): string | null {
  const value = attributes?.[key];
  return typeof value === "string" && value ? value : null;
}

function attributeDuration(attributes: Record<string, unknown> | undefined, key: string): number | null {
  const value = attributes?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function lifecycleProjection(turn: TurnDraft): {
  status: DerivedSessionTurn["status"] | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  abortReason: string | null;
} {
  const lifecycle = [...turn.traceEvents]
    .filter((event) => tracePresentation(event).category === "lifecycle")
    .sort(compareTimestamped);
  const started = lifecycle.find((event) => event.eventType === "codex.turn.started");
  let terminal: SessionTraceEvent | undefined;
  for (const event of lifecycle) {
    if (event.eventType === "codex.turn.completed" || event.eventType === "codex.turn.aborted") {
      terminal = event;
    }
  }
  const endedAt = terminal
    ? attributeString(terminal.attributes, "endedAt") || timestampString(terminal.timestamp)
    : null;
  const durationMs = attributeDuration(terminal?.attributes, "durationMs");
  const explicitStartedAt =
    attributeString(started?.attributes, "startedAt")
    || timestampString(started?.timestamp ?? "");
  const derivedStartedAt = !explicitStartedAt && endedAt && durationMs !== null
    ? new Date(Date.parse(endedAt) - durationMs).toISOString()
    : null;
  return {
    status: terminal?.eventType === "codex.turn.aborted" || terminal?.status === "aborted"
      ? "aborted"
      : terminal?.status === "failed"
        ? "failed"
        : terminal?.eventType === "codex.turn.completed"
          ? "completed"
          : started
            ? "running"
            : null,
    startedAt: explicitStartedAt || derivedStartedAt,
    endedAt,
    durationMs,
    timeToFirstTokenMs: attributeDuration(terminal?.attributes, "timeToFirstTokenMs"),
    abortReason: attributeString(terminal?.attributes, "abortReason"),
  };
}

function buildTurns(
  sessionKey: string,
  drafts: readonly TurnDraft[],
  codexIncrementalState?: CodexIncrementalState,
): DerivedSessionTurn[] {
  const sourceRecordIds = new Map(
    codexIncrementalState?.messageProvenance.map((entry) => [entry.messageIndex, entry.sourceRecordId]) ?? [],
  );
  const activeSourceTurnIds = new Set(codexIncrementalState?.activeTurnIds ?? []);
  return drafts.map((draft, turnIndex) => {
    const turnId = stableId(
      sessionKey,
      "turn",
      draft.sourceMessageIndex !== null
        ? `message:${draft.sourceMessageIndex}`
        : draft.sourceTurnId
          ? `source:${draft.sourceTurnId}`
          : "synthetic",
    );
    const messages = [...draft.messages]
      .sort((left, right) => left.index - right.index)
      .map<DerivedTurnMessage>((message, messageIndex) => ({
        messageIndex,
        sourceMessageIndex: message.index,
        role: message.role,
        content: message.content,
        occurredAt: timestampString(message.timestamp),
        metadata: {
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(message.sourceTurnId ? { sourceTurnId: message.sourceTurnId } : {}),
          ...(message.phase ? { phase: message.phase } : {}),
          ...(sourceRecordIds.get(message.index)
            ? { codex: { sourceItemId: sourceRecordIds.get(message.index) } }
            : {}),
        },
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
    const toolTraceEvents = draft.traceEvents.filter(
      (event) => tracePresentation(event).category !== "lifecycle",
    );
    const toolText = [...toolTraceEvents]
      .sort(compareTimestamped)
      .map((event) => [event.title, event.detail].filter(Boolean).join("\n"))
      .join("\n\n");
    const tokenUsage = draft.tokenEvents.reduce(
      (total, event) => ({
        inputTokens: total.inputTokens + event.inputTokens,
        outputTokens: total.outputTokens + event.outputTokens,
        cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
        cacheCreationInputTokens: total.cacheCreationInputTokens + (event.cacheCreationInputTokens ?? 0),
        reasoningOutputTokens: total.reasoningOutputTokens + event.reasoningOutputTokens,
        totalTokens: total.totalTokens + event.totalTokens,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    );
    const toolSpans = spans.filter(isToolSpan);
    const errorCount = toolSpans.filter((span) => span.status === "failed").length;
    const inferredStatus = errorCount > 0 ? "failed" : "completed";
    const fallbackTimeRange = turnTimeRange(draft);
    const lifecycle = lifecycleProjection(draft);
    // The source id may still be active, but only its latest exchange can be running.
    const lifecycleStatus = draft.superseded && lifecycle.status === "running" ? null : lifecycle.status;

    return {
      id: turnId,
      turnIndex,
      sourceMessageIndex: draft.sourceMessageIndex,
      sourceTurnId: draft.sourceTurnId,
      synthetic: draft.synthetic,
      status: lifecycleStatus
        ?? (!draft.superseded && draft.sourceTurnId && activeSourceTurnIds.has(draft.sourceTurnId) ? "running" : inferredStatus),
      startedAt: lifecycle.startedAt ?? fallbackTimeRange.startedAt,
      endedAt: lifecycle.endedAt ?? fallbackTimeRange.endedAt,
      durationMs: lifecycle.durationMs,
      timeToFirstTokenMs: lifecycle.timeToFirstTokenMs,
      abortReason: lifecycle.abortReason,
      userText,
      assistantText,
      toolText,
      searchText: [userText, assistantText].filter(Boolean).join("\n\n"),
      ...tokenUsage,
      errorCount,
      toolNames: [...new Set(toolSpans.map((span) => span.name))],
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
        sourceTurnId: message.sourceTurnId ?? null,
        phase: message.phase ?? null,
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
        sourceTurnId: event.sourceTurnId ?? null,
        attributes: event.attributes ?? {},
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
        cacheCreationInputTokens: event.cacheCreationInputTokens ?? 0,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: event.totalTokens,
        ...(event.sourceTurnId !== undefined ? { sourceTurnId: event.sourceTurnId } : {}),
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
  codexIncrementalState,
}: DeriveSessionTimelineInput): DerivedSessionTimeline {
  const drafts = buildTurnDrafts(messages, traceEvents, tokenEvents);
  return {
    rawEvents: buildRawEvents(sessionKey, messages, traceEvents, tokenEvents),
    turns: buildTurns(sessionKey, drafts, codexIncrementalState),
  };
}
