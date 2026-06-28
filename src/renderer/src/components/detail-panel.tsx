import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, Copy, Download, Edit3, FolderOpen, Laptop, Play, Server, Sparkles, Star, Tag, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { formatMessageTime } from "../../../core/format-session";
import type { SessionMessage, SessionSearchResult, SessionTraceEvent } from "../../../core/types";
import { formatTokenCount } from "../format-count";
import { localize, type LanguageMode } from "../language";
import type { LiveSessionState } from "../live-filter";
import type { ActionStatus } from "../app-types";
import {
  environmentBadgeLabel,
  environmentBadgeTitle,
  isBranchTag,
  isRemoteSession,
  localizedLiveStateLabel,
  remoteRevealTitle,
  SOURCE_LABEL,
  sourceUiFamily,
} from "../session-ui";

type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent };

function timestampMs(timestamp: string): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function conversationTimeline(messages: SessionMessage[], traceEvents: SessionTraceEvent[]): ConversationTimelineItem[] {
  const messageTimes = messages.map((message) => timestampMs(message.timestamp)).filter((time): time is number => time !== null);
  const minMessageTime = messageTimes.length > 0 ? Math.min(...messageTimes) : null;
  const maxMessageTime = messageTimes.length > 0 ? Math.max(...messageTimes) : null;
  const visibleTraceEvents =
    messages.length === 0
      ? traceEvents
      : traceEvents.filter((event) => {
          const time = timestampMs(event.timestamp);
          return time === null || minMessageTime === null || maxMessageTime === null || (time >= minMessageTime && time <= maxMessageTime);
        });

  const items: ConversationTimelineItem[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      key: `message:${message.index}`,
      timestampMs: timestampMs(message.timestamp),
      order: message.index * 2,
      message,
    })),
    ...visibleTraceEvents.map((event) => ({
      kind: "trace" as const,
      key: `trace:${event.index}`,
      timestampMs: timestampMs(event.timestamp),
      order: event.index * 2 + 1,
      event,
    })),
  ];

  return items.sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    if (a.timestampMs !== null && b.timestampMs === null) return -1;
    if (a.timestampMs === null && b.timestampMs !== null) return 1;
    return a.order - b.order;
  });
}

export function DetailPanel({
  session,
  messages,
  traceEvents,
  loading,
  actionStatus,
  query,
  liveState,
  language,
  revealLabel,
  showItermAction,
  messagePageSize,
  olderMessageCount,
  onClose,
  onShowMore,
  onRename,
  onAddTag,
  onRemoveTag,
  onFavorite,
  onSummarize,
  summarizing,
  canResume,
  canMigrate,
  migrationTitle,
  onResume,
  onResumeIterm,
  onMigrate,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onCopyPlain,
  onDelete,
  onReveal,
}: {
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  loading: boolean;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  messagePageSize: number;
  olderMessageCount: number;
  onClose: () => void;
  onShowMore: () => void;
  onRename: () => void;
  onAddTag: () => void;
  onRemoveTag: (tagName: string) => void;
  onFavorite: () => void;
  onSummarize: () => void;
  summarizing: boolean;
  canResume: boolean;
  canMigrate: boolean;
  migrationTitle: string;
  onResume: () => void;
  onResumeIterm: () => void;
  onMigrate: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onCopyPlain: () => void;
  onDelete: () => void;
  onReveal: () => void;
}): ReactElement {
  const matchIndex = query
    ? messages.findIndex((message) => message.content.toLowerCase().includes(query.toLowerCase()))
    : -1;
  const context = matchIndex >= 0 ? messages.slice(Math.max(0, matchIndex - 1), Math.min(messages.length, matchIndex + 2)) : [];
  const actionRunning = actionStatus?.kind === "running";
  const l = (en: string, zh: string) => localize(language, en, zh);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingInitialScrollRef = useRef<string | null>(session.sessionKey);
  const timelineItems = useMemo(() => conversationTimeline(messages, traceEvents), [messages, traceEvents]);
  const localOnlyDisabled = isRemoteSession(session);
  const revealTitle = localOnlyDisabled ? remoteRevealTitle(language) : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);

  useEffect(() => {
    pendingInitialScrollRef.current = session.sessionKey;
  }, [session.sessionKey]);

  useEffect(() => {
    if (loading || messages.length === 0 || pendingInitialScrollRef.current !== session.sessionKey) return;
    const frame = window.requestAnimationFrame(() => {
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
      pendingInitialScrollRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, messages.length, session.sessionKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = bodyRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const page = el.clientHeight * 0.9;
      switch (event.key) {
        case "ArrowDown":
          el.scrollBy({ top: 64 });
          break;
        case "ArrowUp":
          el.scrollBy({ top: -64 });
          break;
        case "PageDown":
        case " ":
          el.scrollBy({ top: page });
          break;
        case "PageUp":
          el.scrollBy({ top: -page });
          break;
        case "Home":
          el.scrollTo({ top: 0 });
          break;
        case "End":
          el.scrollTo({ top: el.scrollHeight });
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="detail-backdrop" onClick={onClose}>
      <aside className="detail" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <div>
            <div className="detail-badges">
              <div className={`source-badge ${sourceUiFamily(session.source)}`}>
                {SOURCE_LABEL[session.source]}
              </div>
              <span className={`live-status ${liveState}`}>
                <span className="live-status-dot" />
                {localizedLiveStateLabel(liveState, language)}
              </span>
              <span className={`environment-badge ${session.environmentKind}`} title={environmentBadgeTitle(session, language)}>
                {isRemoteSession(session) ? <Server size={13} /> : <Laptop size={13} />}
                {environmentBadgeLabel(session, language)}
              </span>
            </div>
            <div className="detail-title-row">
              <h2>{session.displayTitle}</h2>
              <button className="title-edit-button detail-title-edit" onClick={onRename} aria-label={l("Rename session", "重命名会话")} title={l("Rename session", "重命名会话")}>
                <Edit3 size={14} />
              </button>
            </div>
            <p>
              {session.projectPath || l("No project", "无项目")} · {new Date(session.timestamp).toLocaleString()} · {l(`${messages.length} messages`, `${messages.length} 条消息`)} ·{" "}
              {l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)}
              {traceEvents.length > 0 ? <> · {l(`${traceEvents.length} trace events`, `${traceEvents.length} 条轨迹`)}</> : null}
            </p>
          </div>
          <div className="detail-header-actions">
            <button
              className={`icon-button favorite-button ${session.favorited ? "active" : ""}`}
              onClick={onFavorite}
              aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
              title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
            >
              <Star size={17} fill={session.favorited ? "currentColor" : "none"} />
            </button>
            <button className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="detail-actions">
          {canResume ? (
            <button onClick={onResume} disabled={actionRunning}>
              <Play size={15} /> Resume
            </button>
          ) : null}
          {canResume && showItermAction ? (
            <button onClick={onResumeIterm} disabled={actionRunning}>
              <TerminalIcon size={15} /> iTerm
            </button>
          ) : null}
          <button onClick={onAddTag} disabled={actionRunning}>
            <Tag size={15} /> {l("Add Tag", "添加标签")}
          </button>
          <button onClick={onSummarize} disabled={actionRunning || summarizing}>
            <Sparkles size={15} />{" "}
            {summarizing
              ? l("Summarizing...", "摘要中...")
              : session.aiSummary
                ? l("Re-summarize", "重新摘要")
                : l("AI Summary", "AI 摘要")}
          </button>
          <button onClick={onMigrate} disabled={actionRunning || !canMigrate} title={migrationTitle}>
            <ArrowRightLeft size={15} /> {l("Migrate to…", "迁移到…")}
          </button>
          {canResume ? (
            <button onClick={onCopyResume} disabled={actionRunning}>
              <Copy size={15} /> {l("Copy Cmd", "复制命令")}
            </button>
          ) : null}
          <button onClick={onCopyMarkdown} disabled={actionRunning}>Markdown</button>
          <button onClick={onExportMarkdown} disabled={actionRunning}>
            <Download size={15} /> {l("Export MD", "导出 MD")}
          </button>
          <button onClick={onCopyPlain} disabled={actionRunning}>{l("Plain Text", "纯文本")}</button>
          <button className="danger" onClick={onDelete} disabled={actionRunning}>
            <Trash2 size={15} /> {l("Delete", "删除")}
          </button>
          <button onClick={onReveal} disabled={actionRunning || localOnlyDisabled} title={revealTitle}>
            <FolderOpen size={15} /> {revealLabel}
          </button>
        </div>
        {session.aiSummary ? (
          <div className="detail-summary">
            <span className="detail-summary-label">
              <Sparkles size={12} /> {l("AI summary", "AI 摘要")}
              {session.aiSummaryStale ? ` · ${l("outdated", "已过期")}` : ""}
            </span>
            <p>{session.aiSummary}</p>
          </div>
        ) : null}
        <div className="detail-tags">
          {session.tags.map((tagName) => (
            <button key={tagName} className={`chip ${isBranchTag(tagName) ? "branch-tag" : ""}`} onClick={() => onRemoveTag(tagName)}>
              #{tagName} ×
            </button>
          ))}
        </div>
        <div className="detail-body" ref={bodyRef}>
          {context.length > 0 ? (
            <section className="matched">
              <h3>{l("Matched Context", "命中上下文")}</h3>
              {context.map((message) => (
                <MessageBlock key={message.index} message={message} query={query} language={language} />
              ))}
            </section>
          ) : null}
          <section className="conversation">
            <h3>{l("Full Conversation", "完整会话")}</h3>
            {loading ? <div className="loading-state">{l("Loading conversation...", "正在加载会话...")}</div> : null}
            {!loading && messages.length === 0 ? <div className="loading-state">{l("No visible messages indexed for this session.", "这个会话没有可见消息被索引。")}</div> : null}
            {!loading && olderMessageCount > 0 ? (
              <button className="show-more" onClick={onShowMore}>
                {l(`Show ${Math.min(messagePageSize, olderMessageCount)} older messages`, `再显示 ${Math.min(messagePageSize, olderMessageCount)} 条更早消息`)}
              </button>
            ) : null}
            {timelineItems.map((item) => (
              item.kind === "message" ? (
                <MessageBlock key={item.key} message={item.message} query={query} language={language} />
              ) : (
                <TraceEventBlock key={item.key} event={item.event} language={language} />
              )
            ))}
          </section>
        </div>
      </aside>
    </div>
  );
}

function MessageBlock({ message, query, language }: { message: SessionMessage; query: string; language: LanguageMode }): ReactElement {
  const content = useMemo(() => {
    const text =
      message.content.length > 3000
        ? `${message.content.slice(0, 3000)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`
        : message.content;
    if (!query) return text;
    return text;
  }, [message.content, query, language]);

  return (
    <div className={`message ${message.role}`}>
      <div className="message-head">
        <strong>{message.role === "user" ? localize(language, "User", "用户") : localize(language, "Assistant", "助手")}</strong>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
      <pre>{content}</pre>
    </div>
  );
}

function traceStatusSymbol(event: SessionTraceEvent): string {
  if (event.kind === "tool_call") return "→";
  if (event.status === "success") return "✓";
  if (event.status === "failure") return "✗";
  return "•";
}

function TraceEventBlock({ event, language }: { event: SessionTraceEvent; language: LanguageMode }): ReactElement {
  const detail = useMemo(() => {
    if (!event.detail) return localize(language, "No detail captured.", "没有记录详情。");
    return event.detail.length > 2400
      ? `${event.detail.slice(0, 2400)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`
      : event.detail;
  }, [event.detail, language]);

  return (
    <details className={`trace-event ${event.kind} ${event.status || "unknown"}`}>
      <summary className="trace-head">
        <strong>
          <span className="trace-symbol">{traceStatusSymbol(event)}</span>
          {event.title}
        </strong>
        <span>{formatMessageTime(event.timestamp)}</span>
      </summary>
      <div className="trace-meta">
        {event.eventType ? <span>{event.eventType}</span> : null}
        {event.callId ? <span>{event.callId}</span> : null}
      </div>
      <pre>{detail}</pre>
    </details>
  );
}
