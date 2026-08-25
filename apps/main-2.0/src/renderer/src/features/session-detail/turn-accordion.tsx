import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AlertCircle, ArrowRightLeft, BotMessageSquare, ChevronDown, ChevronRight, Clock3, GitFork, LoaderCircle, Paperclip, RotateCw, Wrench, X } from "lucide-react";

import { formatMessageTime } from "../../../../core/format-session";
import { traceCompactionSummary, tracePresentation } from "../../../../core/trace-presentation";
import type {
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
  SessionTurnSummary,
} from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import {
  useClampedContextMenuStyle,
  type ContextMenuPoint,
} from "../../context-menu-position";
import { HighlightedSearchText, searchHighlightTerms } from "../../search-highlight";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import { MessageHead } from "./message-shell";
import { collaborationMessageMetadata } from "./collaboration-message";

export interface TurnAccordionState {
  sessionKey: string;
  expandedTurnIds: Set<string>;
  detailsById: Record<string, SessionTurnDetail | undefined>;
  loadingTurnIds: Set<string>;
  errorsById: Record<string, string | undefined>;
}

export type TurnAccordionAction =
  | { type: "reset"; sessionKey: string }
  | { type: "toggle"; turnId: string }
  | { type: "open"; turnId: string }
  | { type: "load-started"; turnId: string }
  | { type: "load-succeeded"; turnId: string; detail: SessionTurnDetail }
  | { type: "load-failed"; turnId: string; error: string };

export function createTurnAccordionState(sessionKey: string): TurnAccordionState {
  return {
    sessionKey,
    expandedTurnIds: new Set(),
    detailsById: {},
    loadingTurnIds: new Set(),
    errorsById: {},
  };
}

export function turnAccordionReducer(
  state: TurnAccordionState,
  action: TurnAccordionAction,
): TurnAccordionState {
  if (action.type === "reset") return createTurnAccordionState(action.sessionKey);

  if (action.type === "toggle" || action.type === "open") {
    const expandedTurnIds = new Set(state.expandedTurnIds);
    if (action.type === "open") {
      expandedTurnIds.add(action.turnId);
    } else if (expandedTurnIds.has(action.turnId)) {
      expandedTurnIds.delete(action.turnId);
    } else {
      expandedTurnIds.add(action.turnId);
    }
    return { ...state, expandedTurnIds };
  }

  const loadingTurnIds = new Set(state.loadingTurnIds);
  const errorsById = { ...state.errorsById };
  if (action.type === "load-started") {
    loadingTurnIds.add(action.turnId);
    delete errorsById[action.turnId];
    return { ...state, loadingTurnIds, errorsById };
  }

  loadingTurnIds.delete(action.turnId);
  if (action.type === "load-succeeded") {
    return {
      ...state,
      loadingTurnIds,
      errorsById,
      detailsById: { ...state.detailsById, [action.turnId]: action.detail },
    };
  }

  errorsById[action.turnId] = action.error;
  return { ...state, loadingTurnIds, errorsById };
}

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

const EMPTY_TURN_DETAILS: Record<string, SessionTurnDetail | undefined> = {};

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

function spanExecutionEvidence(span: SessionTraceSpan): string | null {
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
        return tracePresentation({ kind, eventType }).category !== "tool";
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

interface TurnFindMatch {
  key: string;
  turnId: string;
}

function turnTimelineSearchText(item: TurnTimelineItem): string {
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

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  const start = timestampMs(startedAt);
  const end = timestampMs(endedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function durationLabel(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function turnStatusLabel(status: SessionTurnSummary["status"], language: LanguageMode): string {
  if (status === "running") return localize(language, "Running", "进行中");
  if (status === "failed") return localize(language, "Failed", "失败");
  if (status === "aborted") return localize(language, "Interrupted", "已中断");
  return localize(language, "Completed", "已完成");
}

function turnTitle(
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

export function TurnMigrationContextMenu({
  point,
  language,
  onMigrate,
}: {
  point: ContextMenuPoint;
  language: LanguageMode;
  onMigrate: () => void;
}): ReactElement {
  const menu = useClampedContextMenuStyle(point);
  return (
    <div
      ref={menu.ref}
      className="context-menu turn-migration-context-menu"
      style={menu.style}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={onMigrate}>
        <ArrowRightLeft size={14} /> {localize(language, "Migrate", "迁移")}
      </button>
    </div>
  );
}

function spanStatusSymbol(span: SessionTraceSpan): string {
  const evidence = spanExecutionEvidence(span);
  if (evidence === "static-only") return "◇";
  const status = span.status;
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "aborted") return "■";
  if (evidence === "recorded-request" || status === "running") return "→";
  return "•";
}

function spanStatusLabel(span: SessionTraceSpan, language: LanguageMode): string {
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

function payloadText(payload: Record<string, unknown>): string {
  if (Object.keys(payload).length === 1 && typeof payload.text === "string") return payload.text;
  return JSON.stringify(payload, null, 2);
}

const MESSAGE_TRUNCATE_LIMIT = 3_000;
const SPAN_PAYLOAD_PREVIEW_LIMIT = 2_400;

function TurnSpanPayload({
  label,
  payload,
  previewLimit,
  language,
}: {
  label: string;
  payload: Record<string, unknown>;
  previewLimit?: number;
  language: LanguageMode;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const text = payloadText(payload);
  const truncated = previewLimit !== undefined && text.length > previewLimit;
  const visibleText = truncated && !expanded
    ? `${text.slice(0, previewLimit)}${localize(language, "...(truncated)", "...（已截断）")}`
    : text;

  return (
    <details className="msg-tool-payload">
      <summary>{label}</summary>
      <pre>{visibleText}</pre>
      {truncated ? (
        <button
          type="button"
          className="expand-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded
            ? localize(language, "Collapse detail", "收起详情")
            : localize(language, "Show full detail", "展开详情")}
        </button>
      ) : null}
    </details>
  );
}

function TurnMessageBlock({
  sessionKey,
  message,
  query,
  language,
  target = false,
}: {
  sessionKey: string;
  message: SessionTurnMessage;
  query: string;
  language: LanguageMode;
  target?: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    name: string;
    kind: "image" | "text";
    data: string;
  } | null>(null);
  const truncated = message.content.length > MESSAGE_TRUNCATE_LIMIT;
  const content = useMemo(() => {
    if (!truncated || expanded) return message.content;
    return markdownPreview(
      message.content,
      MESSAGE_TRUNCATE_LIMIT,
      localize(language, "...(truncated)", "...（已截断）"),
    );
  }, [expanded, language, message.content, truncated]);
  const terms = useMemo(() => searchHighlightTerms(query), [query]);
  const useMarkdown = terms.length === 0;

  return (
    <div className={`msg ${message.role} ${message.phase === "commentary" ? "commentary" : ""} ${target ? "match-target" : ""}`} data-message-index={message.sourceMessageIndex ?? undefined}>
      <MessageHead
        role={message.role}
        phase={message.phase}
        timestamp={message.timestamp}
        language={language}
      />
      {useMarkdown ? (
        <div className="msg-body">
          <Markdown text={content} language={language} />
        </div>
      ) : (
        <pre className="msg-body msg-body-plain"><HighlightedSearchText text={content} terms={terms} /></pre>
      )}
      {(message.attachments?.length ?? 0) > 0 ? (
        <div className="message-attachments">
          {message.attachments?.map((attachment) => (
            <button
              type="button"
              key={attachment.id}
              disabled={attachment.status !== "available"}
              title={attachment.status === "available"
                ? attachment.fileName
                : localize(language, "Attachment unavailable", "附件不可用")}
              onClick={() => {
                const previewRequest = attachment.remoteObjectKey && attachment.sha256
                  ? window.sessionSearch.previewRemoteSessionAttachment(
                    attachment.remoteObjectKey,
                    attachment.sha256,
                    attachment.mimeType,
                    attachment.previewKind,
                  )
                  : window.sessionSearch.previewAttachment(sessionKey, attachment.id);
                void previewRequest
                  .then((preview) => {
                    if ((preview.kind === "image" || preview.kind === "text") && preview.data) {
                      setAttachmentPreview({
                        name: attachment.fileName,
                        kind: preview.kind,
                        data: preview.data,
                      });
                    }
                  })
                  .catch(() => undefined);
              }}
            >
              <Paperclip size={14} />
              <span>{attachment.fileName}</span>
              {attachment.sizeBytes ? <small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {truncated ? (
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full content", "展开全文")}
        </button>
      ) : null}
      {attachmentPreview ? (
        <div className="attachment-preview-backdrop" onClick={() => setAttachmentPreview(null)}>
          <div className="attachment-preview-dialog" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{attachmentPreview.name}</strong>
              <button
                type="button"
                onClick={() => setAttachmentPreview(null)}
                aria-label={localize(language, "Close", "关闭")}
              >
                <X size={16} />
              </button>
            </header>
            {attachmentPreview.kind === "image"
              ? <img src={attachmentPreview.data} alt={attachmentPreview.name} />
              : <pre>{attachmentPreview.data}</pre>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function spanDisplayName(span: SessionTraceSpan): string {
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

function parsedToolSummary(span: SessionTraceSpan): string {
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

function TurnSpanBlock({
  span,
  children = [],
  language,
  target = false,
}: {
  span: SessionTraceSpan;
  children?: TurnTimelineSpanNode[];
  language: LanguageMode;
  target?: boolean;
}): ReactElement {
  const elapsed = durationLabel(durationMs(span.startedAt, span.endedAt));
  const collaboration = collaborationMessageMetadata(span.attributes);
  const compactionSummary = traceCompactionSummary(span.attributes);
  const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : "";
  const agentRelated = eventType.startsWith("codex.collaboration.") || span.name.startsWith("collaboration.");
  const SpanIcon = agentRelated ? BotMessageSquare : Wrench;
  const evidence = spanExecutionEvidence(span);
  const terminal = span.status === "completed" || span.status === "failed" || span.status === "aborted";
  const evidenceClass = evidence === "static-only" || (evidence === "recorded-request" && !terminal)
    ? `evidence-${evidence}`
    : "";
  return (
    <details className={`msg tool ${span.status} ${children.length > 0 ? "msg-tool-group" : ""} ${evidenceClass} ${target ? "match-target" : ""}`}>
      <summary className="msg-tool-summary">
        <span className="msg-avatar" aria-hidden>
          <SpanIcon size={agentRelated ? 13 : 11} />
        </span>
        <span className="msg-head">
          <strong>{spanDisplayName(span)}</strong>
          <span className="msg-tool-status">
            {spanStatusSymbol(span)} {spanStatusLabel(span, language)}
          </span>
          <span className="msg-time">
            {elapsed ? <span>{elapsed}</span> : null}
            {span.startedAt ? <span>{formatMessageTime(span.startedAt, language)}</span> : null}
          </span>
        </span>
      </summary>
      <div className="msg-tool-body">
        {span.callId ? <code className="msg-tool-call-id">{span.callId}</code> : null}
        {collaboration?.author || collaboration?.recipient
          ? <code className="msg-tool-call-id">{collaboration.author || "?"} → {collaboration.recipient || "?"}</code>
          : null}
        {compactionSummary ? (
          <div className="trace-meta">
            <span>{localize(
              language,
              `${compactionSummary.itemCount} ${compactionSummary.itemCount === 1 ? "item" : "items"}`,
              `共 ${compactionSummary.itemCount} 项`,
            )}</span>
            {compactionSummary.itemTypes.map(({ type, count }) => (
              <span key={type}>{type} {count}</span>
            ))}
          </div>
        ) : null}
        {span.input ? (
          <TurnSpanPayload
            label={localize(language, "Input", "输入")}
            payload={span.input}
            previewLimit={eventType === "codex.context.compaction" ? SPAN_PAYLOAD_PREVIEW_LIMIT : undefined}
            language={language}
          />
        ) : null}
        {span.output ? (
          <TurnSpanPayload
            label={localize(language, "Output", "输出")}
            payload={span.output}
            previewLimit={eventType === "codex.context.compaction" ? SPAN_PAYLOAD_PREVIEW_LIMIT : undefined}
            language={language}
          />
        ) : null}
        {span.error ? (
          <div className="msg-tool-error">
            <AlertCircle size={13} />
            <pre>{span.error}</pre>
          </div>
        ) : null}
      </div>
      {children.length > 0 ? (
        <div className="msg-tool-child-results">
          <div className="msg-tool-code-mode-origin" role="note">
            <strong>{localize(
              language,
              `AST static parse · ${children.length} ${children.length === 1 ? "call" : "calls"}`,
              `AST 静态解析 · ${children.length} 个调用`,
            )}</strong>
            <span>{localize(
              language,
              "Call ownership and code arguments come from the exec AST; status and output come from runtime records.",
              "调用归属与代码参数来自 exec AST；状态和输出来自运行时记录",
            )}</span>
          </div>
          {children.map((child) => {
            const summary = parsedToolSummary(child.span);
            const staticOnly = spanExecutionEvidence(child.span) === "static-only";
            return (
              <div className="msg-tool-child-result" key={child.span.id}>
                {!staticOnly ? (
                  <TurnSpanBlock span={child.span} children={child.children} language={language} />
                ) : null}
                <div className="msg-tool-parsed-result">
                  <span className="msg-tool-parsed-result-label">
                    {localize(language, "AST parsed", "AST 解析")}
                  </span>
                  <strong>{spanDisplayName(child.span)}</strong>
                  <code>{summary || localize(language, "Arguments not statically resolved", "参数未能静态解析")}</code>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}

function TurnDetailTimeline({
  sessionKey,
  turnId,
  detail,
  showTools,
  roleFilter,
  query,
  language,
  matchedMessageIndex,
  activeFindMatchKey,
}: {
  sessionKey: string;
  turnId: string;
  detail: SessionTurnDetail;
  showTools: boolean;
  roleFilter: TurnMessageRoleFilter;
  query: string;
  language: LanguageMode;
  matchedMessageIndex: number | null;
  activeFindMatchKey: string | null;
}): ReactElement {
  const timeline = useMemo(
    () => buildTurnTimeline(detail, showTools, roleFilter),
    [detail, roleFilter, showTools],
  );
  return (
    <div className="turn-timeline">
      {timeline.map((item) => {
        const findKey = `${turnId}:${item.key}`;
        const target = activeFindMatchKey === findKey;
        return (
          <div
            key={item.key}
            className={`turn-timeline-item ${item.kind}`}
            data-timeline-key={item.key}
            data-find-key={findKey}
          >
            {item.kind === "message" ? (
              <TurnMessageBlock
                sessionKey={sessionKey}
                message={item.message}
                query={query}
                language={language}
                target={target || (matchedMessageIndex !== null && item.message.sourceMessageIndex === matchedMessageIndex)}
              />
            ) : (
              <TurnSpanBlock span={item.span} children={item.childSpans} language={language} target={target} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TurnAccordion({
  sessionKey,
  turns,
  loading,
  matchedTurnId,
  matchedMessageIndex,
  showTools,
  roleFilter = "all",
  query,
  findQuery = "",
  activeFindMatchIndex = null,
  language,
  live = false,
  isSubagent = false,
  onLoadTurn,
  onMigrateTurn,
  onFindMatchCountChange,
}: {
  sessionKey: string;
  turns: SessionTurnSummary[];
  loading: boolean;
  matchedTurnId: string | null;
  matchedMessageIndex: number | null;
  showTools: boolean;
  roleFilter?: TurnMessageRoleFilter;
  query: string;
  findQuery?: string;
  activeFindMatchIndex?: number | null;
  language: LanguageMode;
  live?: boolean;
  isSubagent?: boolean;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  onMigrateTurn?: (turn: SessionTurnSummary) => void;
  onFindMatchCountChange?: (count: number) => void;
}): ReactElement {
  const [state, dispatch] = useReducer(turnAccordionReducer, sessionKey, createTurnAccordionState);
  const activeSessionRef = useRef(sessionKey);
  const detailsByIdRef = useRef(state.detailsById);
  const inFlightRef = useRef(new Map<string, Promise<void>>());
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightTerms = useMemo(() => searchHighlightTerms(query), [query]);
  const findTerms = useMemo(() => searchHighlightTerms(findQuery), [findQuery]);
  const displayHighlightTerms = findTerms.length > 0 ? findTerms : highlightTerms;
  const messageQuery = findTerms.length > 0 ? findQuery : query;
  const [migrationMenu, setMigrationMenu] = useState<{
    point: ContextMenuPoint;
    turn: SessionTurnSummary;
  } | null>(null);
  const stateMatchesSession = state.sessionKey === sessionKey;
  const currentDetailsById = stateMatchesSession ? state.detailsById : EMPTY_TURN_DETAILS;

  detailsByIdRef.current = currentDetailsById;

  const loadTurn = useCallback(async (turnId: string): Promise<void> => {
    const requestKey = `${sessionKey}:${turnId}`;
    if (detailsByIdRef.current[turnId]) return;
    const inFlight = inFlightRef.current.get(requestKey);
    if (inFlight) return inFlight;
    const request = (async (): Promise<void> => {
      dispatch({ type: "load-started", turnId });
      try {
        const detail = await onLoadTurn(turnId);
        if (activeSessionRef.current !== sessionKey) return;
        if (!detail) throw new Error(localize(language, "Turn detail is unavailable.", "这一轮的详情不可用。"));
        dispatch({ type: "load-succeeded", turnId, detail });
      } catch (error) {
        if (activeSessionRef.current === sessionKey) {
          dispatch({
            type: "load-failed",
            turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        inFlightRef.current.delete(requestKey);
      }
    })();
    inFlightRef.current.set(requestKey, request);
    return request;
  }, [language, onLoadTurn, sessionKey]);

  const findMatches = useMemo(() => {
    if (findTerms.length === 0) return [] as TurnFindMatch[];
    const matches: TurnFindMatch[] = [];
    for (const turn of turns) {
      const detail = currentDetailsById[turn.id];
      if (!detail) continue;
      for (const item of buildTurnTimeline(detail, showTools, roleFilter)) {
        const text = turnTimelineSearchText(item).toLocaleLowerCase();
        if (findTerms.some((term) => text.includes(term))) {
          matches.push({ key: `${turn.id}:${item.key}`, turnId: turn.id });
        }
      }
    }
    return matches;
  }, [currentDetailsById, findTerms, roleFilter, showTools, turns]);
  const activeFindMatch = activeFindMatchIndex === null
    ? null
    : findMatches[activeFindMatchIndex] ?? null;

  useLayoutEffect(() => {
    activeSessionRef.current = sessionKey;
    inFlightRef.current.clear();
    dispatch({ type: "reset", sessionKey });
    setMigrationMenu(null);
  }, [sessionKey]);

  useEffect(() => {
    if (findTerms.length === 0) return;
    let cancelled = false;
    const expectedSessionKey = sessionKey;
    void (async () => {
      for (const turn of turns) {
        if (cancelled || activeSessionRef.current !== expectedSessionKey) return;
        await loadTurn(turn.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [findTerms, loadTurn, sessionKey, turns]);

  useEffect(() => {
    onFindMatchCountChange?.(findMatches.length);
  }, [findMatches.length, onFindMatchCountChange]);

  useEffect(() => {
    if (!activeFindMatch) return;
    dispatch({ type: "open", turnId: activeFindMatch.turnId });
    const frame = window.requestAnimationFrame(() => {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-find-key]") ?? [])]
        .find((element) => element.dataset.findKey === activeFindMatch.key);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFindMatch]);

  useEffect(() => {
    if (!migrationMenu) return;
    const close = (): void => setMigrationMenu(null);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [migrationMenu]);

  useEffect(() => {
    if (!matchedTurnId || !turns.some((turn) => turn.id === matchedTurnId)) return;
    dispatch({ type: "open", turnId: matchedTurnId });
    void loadTurn(matchedTurnId);
    const frame = window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-turn-id="${matchedTurnId}"]`)
        ?.scrollIntoView({ behavior: "auto", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadTurn, matchedTurnId, sessionKey, turns]);

  const matchedTurnDetail = matchedTurnId ? currentDetailsById[matchedTurnId] : undefined;
  useEffect(() => {
    if (!matchedTurnId || matchedMessageIndex === null || !matchedTurnDetail) return;
    const frame = window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-turn-id="${matchedTurnId}"] [data-message-index="${matchedMessageIndex}"]`,
        )
        ?.scrollIntoView({ behavior: "auto", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [matchedMessageIndex, matchedTurnDetail, matchedTurnId]);

  function toggleTurn(turnId: string): void {
    const opening = !stateMatchesSession || !state.expandedTurnIds.has(turnId);
    dispatch({ type: "toggle", turnId });
    if (opening) void loadTurn(turnId);
  }

  if (loading) {
    return (
      <div className="turn-list-loading">
        <LoaderCircle size={16} className="spin" />
        {localize(language, "Loading Turns…", "正在加载各轮对话…")}
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="turn-list-empty">
        {localize(language, "No visible Turns were indexed for this Session.", "这个 Session 没有可展示的 Turn。")}
      </div>
    );
  }

  let visibleTurnNumber = 0;
  let subagentTurnNumber = 0;
  const executionStartIndex = isSubagent
    ? turns.findIndex((turn) => turn.subagentExecutionStart === true)
    : -1;
  const forkedTurnCount = executionStartIndex > 0
    ? turns.slice(0, executionStartIndex).filter((turn) => !turn.synthetic).length
    : 0;
  const turnPresentation = new Map(turns.map((turn, index) => {
    const agentTriggered = turn.agentTriggered === true
      && turn.sourceMessageIndex === null;
    if (!turn.synthetic || agentTriggered) visibleTurnNumber += 1;
    const origin = executionStartIndex >= 0
      ? index < executionStartIndex ? "inherited" as const : "subagent" as const
      : null;
    if (origin === "subagent" && (!turn.synthetic || agentTriggered)) subagentTurnNumber += 1;
    return [turn.id, {
      agentTriggered,
      displayTurnNumber: visibleTurnNumber,
      origin,
      subagentTurnNumber: origin === "subagent" ? subagentTurnNumber : null,
    }] as const;
  }));

  return (
    <div className="turn-list" ref={rootRef}>
      {turns.map((turn, turnListIndex) => {
        const expanded = stateMatchesSession && state.expandedTurnIds.has(turn.id);
        const detail = currentDetailsById[turn.id];
        const loadingDetail = stateMatchesSession && state.loadingTurnIds.has(turn.id);
        const error = stateMatchesSession ? state.errorsById[turn.id] : undefined;
        const elapsed = durationLabel(turn.durationMs ?? durationMs(turn.startedAt, turn.endedAt));
        const firstToken = durationLabel(turn.timeToFirstTokenMs ?? null);
        const presentation = turnPresentation.get(turn.id) ?? {
          agentTriggered: false,
          displayTurnNumber: turn.turnIndex + 1,
          origin: null,
          subagentTurnNumber: null,
        };
        const displayStatus: SessionTurnSummary["status"] =
          turn.status === "running"
            ? live ? "running" : "completed"
            : turn.status;
        const primaryPreview = roleFilter === "assistant"
          ? turn.assistantPreview
          : turn.userPreview || (roleFilter === "all" ? turn.assistantPreview : "");
        const secondaryPreview = roleFilter === "all" && turn.userPreview && turn.assistantPreview
          ? turn.assistantPreview
          : "";
        const previewText = primaryPreview || (presentation.agentTriggered
          ? localize(
              language,
              "Triggered by an agent; task text was not captured",
              "由 Agent 触发，任务文本未记录",
            )
          : localize(language, "No text captured", "没有记录文本"));
        return (
          <Fragment key={turn.id}>
            {turnListIndex === 0 && forkedTurnCount > 0 ? (
              <div className="turn-phase-divider inherited">
                <GitFork size={15} />
                <span>
                  <strong>{localize(language, "Context inherited from the parent Session", "继承自父会话的上下文")}</strong>
                  <small>{localize(
                    language,
                    `The following ${forkedTurnCount} Turns are conversation context inherited when the subagent was created`,
                    `以下 ${forkedTurnCount} 个 Turn 为创建子 Agent 时继承的会话上下文`,
                  )}</small>
                </span>
              </div>
            ) : null}
            {turnListIndex === executionStartIndex ? (
              <div className="turn-phase-divider subagent">
                <BotMessageSquare size={15} />
                <span>
                  <strong>{localize(language, "Subagent task execution", "子 Agent 任务执行")}</strong>
                  <small>{localize(
                    language,
                    "The following Turns record this subagent's task execution",
                    "以下 Turn 为该子 Agent 的任务执行记录",
                  )}</small>
                </span>
              </div>
            ) : null}
            <article
              className={`turn-card ${displayStatus} ${presentation.origin ? `turn-origin-${presentation.origin}` : ""} ${turn.id === matchedTurnId ? "match-target" : ""}`}
              data-turn-id={turn.id}
              data-turn-origin={presentation.origin ?? undefined}
              onContextMenu={onMigrateTurn && !turn.synthetic && turn.sourceMessageIndex !== null
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMigrationMenu({
                      point: { x: event.clientX, y: event.clientY },
                      turn,
                    });
                  }
                : undefined}
            >
            <button
              className="turn-card-summary"
              type="button"
              aria-expanded={expanded}
              aria-controls={`turn-detail-${turn.id}`}
              onClick={() => toggleTurn(turn.id)}
            >
              <span className="turn-card-chevron">
                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </span>
              <span className="turn-card-copy">
                <span className="turn-card-eyebrow">
                  {turnTitle(
                    turn,
                    language,
                    presentation.displayTurnNumber,
                    presentation.agentTriggered,
                    presentation.origin,
                    presentation.subagentTurnNumber,
                  )}
                  {turn.startedAt ? <span>{formatMessageTime(turn.startedAt, language)}</span> : null}
                </span>
                <strong>
                  {displayHighlightTerms.length > 0
                    ? <HighlightedSearchText text={previewText} terms={displayHighlightTerms} />
                    : previewText}
                </strong>
                {secondaryPreview ? <small>{secondaryPreview}</small> : null}
              </span>
              <span className="turn-card-meta">
                <span className={`turn-status ${displayStatus}`}>{turnStatusLabel(displayStatus, language)}</span>
                {turn.spanCount > 0 ? (
                  <span title={localize(language, `${turn.spanCount} tool calls`, `${turn.spanCount} 次工具调用`)}>
                    <Wrench size={11} />
                    {turn.spanCount}
                  </span>
                ) : null}
                {turn.errorCount > 0 ? (
                  <span title={localize(language, `${turn.errorCount} errors`, `${turn.errorCount} 个错误`)}>
                    <AlertCircle size={11} />
                    {turn.errorCount}
                  </span>
                ) : null}
                {elapsed ? (
                  <span>
                    <Clock3 size={11} />
                    {elapsed}
                  </span>
                ) : null}
                {firstToken ? <span>TTFT {firstToken}</span> : null}
                {turn.totalTokens > 0 ? <span>{formatTokenCount(turn.totalTokens)} token</span> : null}
              </span>
            </button>
            {expanded ? (
              <div className="turn-card-detail" id={`turn-detail-${turn.id}`}>
                {loadingDetail ? (
                  <div className="turn-detail-state">
                    <LoaderCircle size={15} className="spin" />
                    {localize(language, "Loading trajectory…", "正在加载轨迹…")}
                  </div>
                ) : error ? (
                  <div className="turn-detail-state error">
                    <span>{error}</span>
                    <button type="button" onClick={() => void loadTurn(turn.id)}>
                      <RotateCw size={13} />
                      {localize(language, "Retry", "重试")}
                    </button>
                  </div>
                ) : detail ? (
                  <TurnDetailTimeline
                    sessionKey={sessionKey}
                    turnId={turn.id}
                    detail={detail}
                    showTools={showTools}
                    roleFilter={roleFilter}
                    query={messageQuery}
                    language={language}
                    matchedMessageIndex={turn.id === matchedTurnId ? matchedMessageIndex : null}
                    activeFindMatchKey={activeFindMatch?.key ?? null}
                  />
                ) : null}
              </div>
            ) : null}
            </article>
          </Fragment>
        );
      })}
      {migrationMenu ? (
        <TurnMigrationContextMenu
          point={migrationMenu.point}
          language={language}
          onMigrate={() => {
            const selectedTurn = migrationMenu.turn;
            setMigrationMenu(null);
            onMigrateTurn?.(selectedTurn);
          }}
        />
      ) : null}
    </div>
  );
}
