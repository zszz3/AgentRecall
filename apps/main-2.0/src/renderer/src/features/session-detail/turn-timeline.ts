import { tracePresentation } from "../../../../core/trace-presentation";
import type {
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";

export type TurnTimelineItem =
  | {
      kind: "message";
      key: string;
      timestampMs: number | null;
      order: number;
      message: SessionTurnMessage;
    }
  | {
      kind: "span";
      key: string;
      timestampMs: number | null;
      order: number;
      span: SessionTraceSpan;
      childSpans: TurnTimelineSpanNode[];
    };

export interface TurnTimelineSpanNode {
  span: SessionTraceSpan;
  children: TurnTimelineSpanNode[];
}

export type TurnMessageRoleFilter = "all" | "user" | "assistant";

function timestampMs(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function spanToolAttributes(span: SessionTraceSpan): Record<string, unknown> | null {
  const tool = span.attributes.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  return tool as Record<string, unknown>;
}

export function spanExecutionEvidence(span: SessionTraceSpan): string | null {
  const evidence = spanToolAttributes(span)?.executionEvidence;
  return typeof evidence === "string" ? evidence : null;
}

function spanWasParsedFromCodeMode(span: SessionTraceSpan): boolean {
  return spanExecutionEvidence(span) === "static-only"
    || spanToolAttributes(span)?.parsedFromCodeMode === true;
}

export function buildTurnTimeline(
  detail: SessionTurnDetail,
  showTools = true,
  roleFilter: TurnMessageRoleFilter = "all",
): TurnTimelineItem[] {
  const visibleMessages = roleFilter === "all"
    ? detail.messages
    : detail.messages.filter((message) => message.role === roleFilter);
  const visibleSpans = showTools
    ? detail.spans
    : detail.spans.filter((span) => {
        const traceKind = span.attributes.traceKind;
        const kind = traceKind === "tool_call" || traceKind === "tool_result" ? traceKind : "event";
        const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : null;
        // A DeepSeek Harness model step only leads to the calls after it, so it hides with them.
        return tracePresentation({ kind, eventType }).category !== "tool" && eventType !== "deepseek.step";
      });
  const spanNodes = new Map<string, TurnTimelineSpanNode>(
    visibleSpans.map((span) => [span.id, { span, children: [] }]),
  );
  const rootSpanNodes: TurnTimelineSpanNode[] = [];
  for (const span of visibleSpans) {
    const node = spanNodes.get(span.id)!;
    const parent = spanWasParsedFromCodeMode(span) && span.parentSpanId
      ? spanNodes.get(span.parentSpanId)
      : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      rootSpanNodes.push(node);
    }
  }
  const items: TurnTimelineItem[] = [
    ...visibleMessages.map((message) => ({
      kind: "message" as const,
      key: `message:${message.messageIndex}`,
      timestampMs: timestampMs(message.timestamp),
      order: message.messageIndex * 2,
      message,
    })),
    ...rootSpanNodes.map(({ span, children }) => ({
          kind: "span" as const,
          key: `span:${span.id}`,
          timestampMs: timestampMs(span.startedAt),
          order: span.spanIndex * 2 + 1,
          span,
          childSpans: children,
        })),
  ];

  return items.sort((left, right) => {
    if (left.timestampMs !== null && right.timestampMs !== null && left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }
    if (left.timestampMs !== null) return -1;
    if (right.timestampMs !== null) return 1;
    return left.order - right.order;
  });
}

export function turnTimelineSearchText(item: TurnTimelineItem): string {
  if (item.kind === "message") return item.message.content;
  const spanText = (node: TurnTimelineSpanNode): string => [
    node.span.name,
    node.span.error,
    node.span.input ? payloadText(node.span.input) : "",
    node.span.output ? payloadText(node.span.output) : "",
    JSON.stringify(node.span.attributes),
    ...node.children.map(spanText),
  ].filter(Boolean).join(" ");
  return [
    item.span.name,
    item.span.error,
    item.span.input ? payloadText(item.span.input) : "",
    item.span.output ? payloadText(item.span.output) : "",
    JSON.stringify(item.span.attributes),
    ...item.childSpans.map(spanText),
  ].filter(Boolean).join(" ");
}

export function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  const start = timestampMs(startedAt);
  const end = timestampMs(endedAt);
  // A Turn whose request got no reply starts and ends at the same instant; "0ms" would read as a measurement.
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

export function durationLabel(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function turnStatusLabel(status: SessionTurnSummary["status"], language: LanguageMode): string {
  if (status === "running") return localize(language, "Running", "进行中");
  if (status === "failed") return localize(language, "Failed", "失败");
  if (status === "aborted") return localize(language, "Interrupted", "已中断");
  return localize(language, "Completed", "已完成");
}

export function turnTitle(
  turn: SessionTurnSummary,
  language: LanguageMode,
  displayTurnNumber: number,
  agentTriggered: boolean,
  origin: "inherited" | "subagent" | null,
  subagentTurnNumber: number | null,
): string {
  if (turn.synthetic && !agentTriggered) return localize(language, "Session setup", "会话准备");
  if (origin === "inherited") {
    return localize(
      language,
      `Parent Turn ${displayTurnNumber} · Forked context`,
      `父会话第 ${displayTurnNumber} 轮 · Fork 继承`,
    );
  }
  if (origin === "subagent" && subagentTurnNumber !== null) {
    return localize(
      language,
      `Subagent Turn ${subagentTurnNumber}${agentTriggered ? " · Triggered by an agent" : ""}`,
      `子 Agent 第 ${subagentTurnNumber} 轮${agentTriggered ? " · Agent 触发" : ""}`,
    );
  }
  if (agentTriggered) {
    return localize(
      language,
      `Turn ${displayTurnNumber} · Triggered by an agent`,
      `第 ${displayTurnNumber} 轮 · Agent 触发`,
    );
  }
  return localize(language, `Turn ${displayTurnNumber}`, `第 ${displayTurnNumber} 轮`);
}

export function spanStatusSymbol(span: SessionTraceSpan): string {
  const evidence = spanExecutionEvidence(span);
  if (evidence === "static-only") return "◇";
  const status = span.status;
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "aborted") return "■";
  if (evidence === "recorded-request" || status === "running") return "→";
  return "•";
}

export function spanStatusLabel(span: SessionTraceSpan, language: LanguageMode): string {
  const evidence = spanExecutionEvidence(span);
  if (evidence === "static-only") return localize(language, "Statically identified", "静态识别");
  const status = span.status;
  if (status === "completed") return localize(language, "Completed", "已完成");
  if (status === "failed") return localize(language, "Failed", "失败");
  if (status === "aborted") return localize(language, "Interrupted", "已中断");
  if (evidence === "recorded-request") return localize(language, "Requested", "已请求");
  if (status === "running") return localize(language, "Running", "进行中");
  return localize(language, "Status unknown", "状态未知");
}

export function payloadText(payload: Record<string, unknown>): string {
  if (Object.keys(payload).length === 1 && typeof payload.text === "string") return payload.text;
  return JSON.stringify(payload, null, 2);
}

export function spanDisplayName(span: SessionTraceSpan): string {
  const nestedTools = span.attributes.nestedTools;
  const title = span.attributes.title;
  return Array.isArray(nestedTools)
    && nestedTools.length > 0
    && typeof title === "string"
    && title.trim()
    ? title.trim()
    : span.name;
}

const PARSED_TOOL_SUMMARY_LIMIT = 240;

export function parsedToolSummary(span: SessionTraceSpan): string {
  const preferredKeys = ["cmd", "command", "query", "path", "file_path", "url"];
  let summary = "";
  for (const key of preferredKeys) {
    const value = span.input?.[key];
    if (typeof value === "string" && value.trim()) {
      summary = value.trim();
      break;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      summary = value.join(" ");
      break;
    }
  }
  if (!summary && span.input) summary = payloadText(span.input).replace(/\s+/g, " ").trim();
  return summary.length > PARSED_TOOL_SUMMARY_LIMIT
    ? `${summary.slice(0, PARSED_TOOL_SUMMARY_LIMIT)}…`
    : summary;
}
