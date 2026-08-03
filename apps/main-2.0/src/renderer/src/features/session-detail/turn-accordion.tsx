import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AlertCircle, ArrowRightLeft, ChevronDown, ChevronRight, Clock3, LoaderCircle, RotateCw, Wrench } from "lucide-react";

import { formatMessageTime } from "../../../../core/format-session";
import { tracePresentation } from "../../../../core/trace-presentation";
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
    };

function timestampMs(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildTurnTimeline(
  detail: SessionTurnDetail,
  showTools = true,
): TurnTimelineItem[] {
  const visibleSpans = showTools
    ? detail.spans
    : detail.spans.filter((span) => {
        const traceKind = span.attributes.traceKind;
        const kind = traceKind === "tool_call" || traceKind === "tool_result" ? traceKind : "event";
        const eventType = typeof span.attributes.eventType === "string" ? span.attributes.eventType : null;
        return tracePresentation({ kind, eventType }).category !== "tool";
      });
  const items: TurnTimelineItem[] = [
    ...detail.messages.map((message) => ({
      kind: "message" as const,
      key: `message:${message.messageIndex}`,
      timestampMs: timestampMs(message.timestamp),
      order: message.messageIndex * 2,
      message,
    })),
    ...visibleSpans.map((span) => ({
          kind: "span" as const,
          key: `span:${span.id}`,
          timestampMs: timestampMs(span.startedAt),
          order: span.spanIndex * 2 + 1,
          span,
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

function turnTitle(turn: SessionTurnSummary, language: LanguageMode): string {
  if (turn.synthetic) return localize(language, "Preamble", "前置轨迹");
  return localize(language, `Turn ${turn.turnIndex + 1}`, `第 ${turn.turnIndex + 1} 轮`);
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

function spanStatusSymbol(status: SessionTraceSpan["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "running") return "→";
  if (status === "aborted") return "■";
  return "•";
}

function spanStatusLabel(status: SessionTraceSpan["status"], language: LanguageMode): string {
  if (status === "running") return localize(language, "Running", "进行中");
  if (status === "completed") return localize(language, "Completed", "已完成");
  if (status === "failed") return localize(language, "Failed", "失败");
  if (status === "aborted") return localize(language, "Interrupted", "已中断");
  return localize(language, "Status unknown", "状态未知");
}

function payloadText(payload: Record<string, unknown>): string {
  if (Object.keys(payload).length === 1 && typeof payload.text === "string") return payload.text;
  return JSON.stringify(payload, null, 2);
}

const MESSAGE_TRUNCATE_LIMIT = 3_000;

function TurnMessageBlock({
  message,
  query,
  language,
}: {
  message: SessionTurnMessage;
  query: string;
  language: LanguageMode;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
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
    <div className={`msg ${message.role} ${message.phase === "commentary" ? "commentary" : ""}`} data-message-index={message.sourceMessageIndex ?? undefined}>
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
      {truncated ? (
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full content", "展开全文")}
        </button>
      ) : null}
    </div>
  );
}

function TurnSpanBlock({
  span,
  language,
}: {
  span: SessionTraceSpan;
  language: LanguageMode;
}): ReactElement {
  const elapsed = durationLabel(durationMs(span.startedAt, span.endedAt));
  return (
    <details className={`msg tool ${span.status}`}>
      <summary className="msg-tool-summary">
        <span className="msg-avatar" aria-hidden>
          <Wrench size={11} />
        </span>
        <span className="msg-head">
          <strong>{span.name}</strong>
          <span className="msg-tool-status">
            {spanStatusSymbol(span.status)} {spanStatusLabel(span.status, language)}
          </span>
          <span className="msg-time">
            {elapsed ? <span>{elapsed}</span> : null}
            {span.startedAt ? <span>{formatMessageTime(span.startedAt)}</span> : null}
          </span>
        </span>
      </summary>
      <div className="msg-tool-body">
        {span.callId ? <code className="msg-tool-call-id">{span.callId}</code> : null}
        {span.input ? (
          <details className="msg-tool-payload">
            <summary>{localize(language, "Input", "输入")}</summary>
            <pre>{payloadText(span.input)}</pre>
          </details>
        ) : null}
        {span.output ? (
          <details className="msg-tool-payload">
            <summary>{localize(language, "Output", "输出")}</summary>
            <pre>{payloadText(span.output)}</pre>
          </details>
        ) : null}
        {span.error ? (
          <div className="msg-tool-error">
            <AlertCircle size={13} />
            <pre>{span.error}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function TurnDetailTimeline({
  detail,
  showTools,
  query,
  language,
}: {
  detail: SessionTurnDetail;
  showTools: boolean;
  query: string;
  language: LanguageMode;
}): ReactElement {
  const timeline = useMemo(() => buildTurnTimeline(detail, showTools), [detail, showTools]);
  return (
    <div className="turn-timeline">
      {timeline.map((item) => (
        <div key={item.key} className={`turn-timeline-item ${item.kind}`} data-timeline-key={item.key}>
          {item.kind === "message" ? (
            <TurnMessageBlock message={item.message} query={query} language={language} />
          ) : (
            <TurnSpanBlock span={item.span} language={language} />
          )}
        </div>
      ))}
    </div>
  );
}

export function TurnAccordion({
  sessionKey,
  turns,
  loading,
  matchedTurnId,
  showTools,
  query,
  language,
  live = false,
  onLoadTurn,
  onMigrateTurn,
}: {
  sessionKey: string;
  turns: SessionTurnSummary[];
  loading: boolean;
  matchedTurnId: string | null;
  showTools: boolean;
  query: string;
  language: LanguageMode;
  live?: boolean;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  onMigrateTurn?: (turn: SessionTurnSummary) => void;
}): ReactElement {
  const [state, dispatch] = useReducer(turnAccordionReducer, sessionKey, createTurnAccordionState);
  const activeSessionRef = useRef(sessionKey);
  const inFlightRef = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightTerms = useMemo(() => searchHighlightTerms(query), [query]);
  const [migrationMenu, setMigrationMenu] = useState<{
    point: ContextMenuPoint;
    turn: SessionTurnSummary;
  } | null>(null);

  async function loadTurn(turnId: string): Promise<void> {
    const requestKey = `${sessionKey}:${turnId}`;
    if (state.detailsById[turnId] || inFlightRef.current.has(requestKey)) return;
    inFlightRef.current.add(requestKey);
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
  }

  useEffect(() => {
    activeSessionRef.current = sessionKey;
    inFlightRef.current.clear();
    dispatch({ type: "reset", sessionKey });
    setMigrationMenu(null);
  }, [sessionKey]);

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
  }, [matchedTurnId, sessionKey, turns]);

  function toggleTurn(turnId: string): void {
    const opening = !state.expandedTurnIds.has(turnId);
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

  return (
    <div className="turn-list" ref={rootRef}>
      {turns.map((turn) => {
        const expanded = state.expandedTurnIds.has(turn.id);
        const detail = state.detailsById[turn.id];
        const loadingDetail = state.loadingTurnIds.has(turn.id);
        const error = state.errorsById[turn.id];
        const elapsed = durationLabel(turn.durationMs ?? durationMs(turn.startedAt, turn.endedAt));
        const firstToken = durationLabel(turn.timeToFirstTokenMs ?? null);
        const displayStatus: SessionTurnSummary["status"] =
          turn.status === "running"
            ? live ? "running" : "completed"
            : turn.status;
        return (
          <article
            key={turn.id}
            className={`turn-card ${displayStatus} ${turn.id === matchedTurnId ? "match-target" : ""}`}
            data-turn-id={turn.id}
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
                  {turnTitle(turn, language)}
                  {turn.startedAt ? <span>{formatMessageTime(turn.startedAt)}</span> : null}
                </span>
                <strong>
                  {highlightTerms.length > 0
                    ? <HighlightedSearchText text={turn.userPreview || turn.assistantPreview} terms={highlightTerms} />
                    : turn.userPreview || turn.assistantPreview || localize(language, "No text captured", "没有记录文本")}
                </strong>
                {turn.userPreview && turn.assistantPreview ? <small>{turn.assistantPreview}</small> : null}
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
                    detail={detail}
                    showTools={showTools}
                    query={query}
                    language={language}
                  />
                ) : null}
              </div>
            ) : null}
          </article>
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
