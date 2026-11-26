import type {
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../../../../core/types";
import { tracePresentation } from "../../../../core/trace-presentation";
import { buildTurnTimeline, payloadText, spanDisplayName, type TurnTimelineSpanNode } from "./turn-timeline";

/** What the trajectory ledger shows; each part folds independently. */
export interface TrajectoryOptions {
  turns: boolean;
  calls: boolean;
  subcalls: boolean;
  query: string;
}

export type TrajectoryRow =
  | { kind: "turn"; key: string; turn: SessionTurnSummary }
  | { kind: "message"; key: string; turnId: string; message: SessionTurnMessage; text: string }
  /** A model step that wrote no answer, only reasoning (possibly none) and tool calls. */
  | { kind: "step"; key: string; turnId: string; span: SessionTraceSpan; text: string }
  | {
      kind: "span";
      key: string;
      turnId: string;
      span: SessionTraceSpan;
      depth: 0 | 1;
      tool: boolean;
      input: string;
      output: string;
      /** Subcalls hidden under this call while subcalls are folded. */
      foldedSubcalls: number;
    };

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isToolSpan(span: SessionTraceSpan): boolean {
  const traceKind = span.attributes.traceKind;
  const kind = traceKind === "tool_call" || traceKind === "tool_result" ? traceKind : "event";
  const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : null;
  return tracePresentation({ kind, eventType }).category === "tool";
}

function isModelStep(span: SessionTraceSpan): boolean {
  const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : null;
  return span.kind === "event" && tracePresentation({ kind: "event", eventType }).category === "reasoning";
}

function spanRow(turnId: string, span: SessionTraceSpan, depth: 0 | 1, foldedSubcalls: number): TrajectoryRow {
  return {
    kind: "span",
    key: `span:${span.id}`,
    turnId,
    span,
    depth,
    tool: isToolSpan(span),
    input: span.input ? oneLine(payloadText(span.input)) : "",
    output: oneLine(span.error ?? (span.output ? payloadText(span.output) : "")),
    foldedSubcalls,
  };
}

function rowText(row: TrajectoryRow): string {
  if (row.kind === "turn") return "";
  if (row.kind === "message" || row.kind === "step") return row.text;
  return `${spanDisplayName(row.span)} ${row.input} ${row.output}`;
}

/**
 * Flatten a Session trajectory into ledger rows in conversation order. A search keeps the rows
 * that match, includes subcalls even while they are folded, and keeps the header of each Turn
 * with a match.
 */
export function trajectoryRows(
  trajectory: readonly SessionTurnDetail[],
  options: TrajectoryOptions,
): TrajectoryRow[] {
  const query = options.query.trim().toLocaleLowerCase();
  const matches = (row: TrajectoryRow) => !query || rowText(row).toLocaleLowerCase().includes(query);
  const rows: TrajectoryRow[] = [];

  for (const turn of trajectory) {
    const turnRows: TrajectoryRow[] = [];
    for (const item of buildTurnTimeline(turn)) {
      if (item.kind === "message") {
        const text = oneLine(item.message.content);
        if (!text) continue;
        const row: TrajectoryRow = { kind: "message", key: `message:${turn.id}:${item.message.messageIndex}`, turnId: turn.id, message: item.message, text };
        if (matches(row)) turnRows.push(row);
        continue;
      }
      if (isModelStep(item.span)) {
        // A step exists to make the calls that follow it, so it folds away with them.
        if (!options.calls) continue;
        const output = item.span.output ? payloadText(item.span.output) : "";
        const row: TrajectoryRow = { kind: "step", key: `span:${item.span.id}`, turnId: turn.id, span: item.span, text: oneLine(output) };
        if (matches(row)) turnRows.push(row);
        continue;
      }
      const tool = isToolSpan(item.span);
      if (tool && !options.calls) continue;
      const children = item.childSpans.map((node: TurnTimelineSpanNode) => spanRow(turn.id, node.span, 1, 0));
      const matchingChildren = children.filter(matches);
      const showChildren = options.subcalls || (query !== "" && matchingChildren.length > 0);
      const parent = spanRow(turn.id, item.span, 0, showChildren ? 0 : children.length);
      if (!matches(parent) && matchingChildren.length === 0) continue;
      turnRows.push(parent);
      if (showChildren) turnRows.push(...(query ? matchingChildren : children));
    }
    if (query && turnRows.length === 0) continue;
    if (options.turns) rows.push({ kind: "turn", key: `turn:${turn.id}`, turn });
    rows.push(...turnRows);
  }
  return rows;
}
