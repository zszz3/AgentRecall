import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, ChevronDown, ChevronUp, CloudUpload, Copy, Download, Edit3, FolderOpen, Laptop, Play, Search, Server, Sparkles, Star, Tag, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { formatMessageTime } from "../../../../core/format-session";
import type {
  SessionMessage,
  SessionSearchResult,
  SessionTraceEvent,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import { hasTokenUsage } from "../../session-ui";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import type { ActionStatus } from "../../app-types";
import { HighlightedSearchText, searchHighlightTerms } from "../../search-highlight";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import {
  environmentBadgeLabel,
  environmentBadgeTitle,
  isBranchTag,
  isRemoteSession,
  localizedLiveStateLabel,
  remoteRevealTitle,
  SOURCE_LABEL,
  sourceUiFamily,
} from "../../session-ui";
import { readInitialToolEventsVisibility, storeToolEventsVisibility } from "../../tool-events-visibility";
import { TurnAccordion } from "./turn-accordion";

export type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent };

export type ConversationRoleFilter = "all" | SessionMessage["role"];

const CONVERSATION_ROLE_FILTERS: ConversationRoleFilter[] = ["all", "user", "assistant"];

function timestampMs(timestamp: string): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function messageTimelineItem(message: SessionMessage): ConversationTimelineItem {
  return {
    kind: "message",
    key: `message:${message.index}`,
    timestampMs: timestampMs(message.timestamp),
    order: message.index * 2,
    message,
  };
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
    ...messages.map(messageTimelineItem),
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

export function filterConversationTimeline(
  items: ConversationTimelineItem[],
  roleFilter: ConversationRoleFilter,
  showTools: boolean,
): ConversationTimelineItem[] {
  return items.filter((item) => {
    if (item.kind === "trace") return showTools;
    return roleFilter === "all" || item.message.role === roleFilter;
  });
}

function conversationRoleFilterLabel(filter: ConversationRoleFilter, language: LanguageMode): string {
  if (filter === "all") return localize(language, "All", "全部");
  if (filter === "user") return localize(language, "User", "用户");
  return localize(language, "Assistant", "助手");
}

function conversationRoleEmptyLabel(filter: Exclude<ConversationRoleFilter, "all">, language: LanguageMode): string {
  return filter === "user"
    ? localize(language, "No User messages in the loaded conversation.", "当前已加载内容中没有用户消息。")
    : localize(language, "No Assistant messages in the loaded conversation.", "当前已加载内容中没有助手消息。");
}

export function DetailPanel({
  session,
  turns,
  turnsLoading,
  matchedTurnId,
  onLoadTurn,
  messages,
  matchedContextMessages,
  matchedMessageIndex,
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
  onUploadRemote,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onCopyPlain,
  onDelete,
  onReveal,
  readOnly = false,
  backdropClassName = "",
}: {
  session: SessionSearchResult;
  turns: SessionTurnSummary[] | null;
  turnsLoading: boolean;
  matchedTurnId: string | null;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  messages: SessionMessage[];
  matchedContextMessages: SessionMessage[];
  matchedMessageIndex: number | null;
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
  onUploadRemote?: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onCopyPlain: () => void;
  onDelete: () => void;
  onReveal: () => void;
  readOnly?: boolean;
  backdropClassName?: string;
}): ReactElement {
  const context = matchedContextMessages;
  const actionRunning = actionStatus?.kind === "running";
  const l = (en: string, zh: string) => localize(language, en, zh);
  const traceCount = turns === null
    ? traceEvents.length
    : turns.reduce((total, turn) => total + turn.spanCount, 0);
  const detailMeta = [
    session.projectPath || l("No project", "无项目"),
    new Date(session.timestamp).toLocaleString(),
    l(`${session.messageCount} messages`, `${session.messageCount} 条消息`),
    ...(hasTokenUsage(session.tokenUsage) ? [l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)] : []),
    ...(traceCount > 0 ? [l(`${traceCount} trace events`, `${traceCount} 条轨迹`)] : []),
  ];
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingInitialScrollRef = useRef<string | null>(session.sessionKey);
  const [roleFilter, setRoleFilter] = useState<ConversationRoleFilter>("all");
  const [showTools, setShowTools] = useState(readInitialToolEventsVisibility);
  const timelineItems = useMemo(() => conversationTimeline(messages, traceEvents), [messages, traceEvents]);
  const visibleTimelineItems = useMemo(
    () => filterConversationTimeline(timelineItems, roleFilter, showTools),
    [roleFilter, showTools, timelineItems],
  );
  const roleFilterEmpty = !loading
    && messages.length > 0
    && roleFilter !== "all"
    && !messages.some((message) => message.role === roleFilter);
  const localOnlyDisabled = isRemoteSession(session);
  const revealTitle = localOnlyDisabled ? remoteRevealTitle(language) : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);

  const toggleTools = () => {
    setShowTools((current) => {
      const next = !current;
      storeToolEventsVisibility(next);
      return next;
    });
  };

  const [panelSearchOpen, setPanelSearchOpen] = useState(false);
  const [panelSearchQuery, setPanelSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const panelSearchInputRef = useRef<HTMLInputElement>(null);

  const panelSearchTerms = useMemo(
    () => (panelSearchQuery ? searchHighlightTerms(panelSearchQuery) : []),
    [panelSearchQuery],
  );

  const panelSearchMatchKeys = useMemo(() => {
    if (panelSearchTerms.length === 0) return [] as string[];
    const keys: string[] = [];
    for (const item of visibleTimelineItems) {
      if (item.kind === "message") {
        const lower = item.message.content.toLocaleLowerCase();
        if (panelSearchTerms.some((term) => lower.includes(term))) {
          keys.push(item.key);
        }
      } else {
        const hay = [item.event.title, item.event.detail, item.event.eventType]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        if (panelSearchTerms.some((term) => hay.includes(term))) {
          keys.push(item.key);
        }
      }
    }
    return keys;
  }, [visibleTimelineItems, panelSearchTerms]);

  useEffect(() => {
    if (panelSearchOpen && panelSearchInputRef.current) {
      panelSearchInputRef.current.focus();
      panelSearchInputRef.current.select();
    }
  }, [panelSearchOpen]);

  useEffect(() => {
    if (panelSearchMatchKeys.length === 0) {
      setCurrentMatchIndex(0);
      return;
    }
    setCurrentMatchIndex(0);
    requestAnimationFrame(() => scrollToPanelMatch(0));
  }, [panelSearchMatchKeys]);

  const scrollToPanelMatch = (index: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const key = panelSearchMatchKeys[index];
    if (key === undefined) return;
    const target = el.querySelector(`[data-timeline-key="${key}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const nextPanelMatch = () => {
    if (panelSearchMatchKeys.length === 0) return;
    const next = (currentMatchIndex + 1) % panelSearchMatchKeys.length;
    setCurrentMatchIndex(next);
    scrollToPanelMatch(next);
  };

  const prevPanelMatch = () => {
    if (panelSearchMatchKeys.length === 0) return;
    const prev = (currentMatchIndex - 1 + panelSearchMatchKeys.length) % panelSearchMatchKeys.length;
    setCurrentMatchIndex(prev);
    scrollToPanelMatch(prev);
  };

  const closePanelSearch = () => {
    setPanelSearchOpen(false);
    setPanelSearchQuery("");
    setCurrentMatchIndex(0);
  };

  useEffect(() => {
    pendingInitialScrollRef.current = session.sessionKey;
    setRoleFilter("all");
  }, [session.sessionKey]);

  useEffect(() => {
    if (pendingInitialScrollRef.current !== session.sessionKey) return;
    if (turns !== null) {
      if (turnsLoading || turns.length === 0) return;
      const frame = window.requestAnimationFrame(() => {
        if (matchedTurnId === null) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
        pendingInitialScrollRef.current = null;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (loading || messages.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      if (matchedMessageIndex !== null) {
        const target = bodyRef.current?.querySelector(`[data-message-index="${matchedMessageIndex}"]`) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: "auto", block: "center" });
        } else {
          bodyRef.current?.scrollTo({ top: 0 });
        }
      } else {
        bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
      }
      pendingInitialScrollRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    loading,
    matchedMessageIndex,
    matchedTurnId,
    messages.length,
    session.sessionKey,
    turns,
    turnsLoading,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (turns !== null) return;
      const el = bodyRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;

      // Ctrl+F / Cmd+F: open panel search
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setPanelSearchOpen(true);
        return;
      }

      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const page = el.clientHeight * 0.9;
      switch (event.key) {
        case "Escape":
          if (panelSearchOpen) {
            closePanelSearch();
            event.preventDefault();
          }
          return;
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
  }, [panelSearchOpen, turns]);

  return (
    <div className={`detail-backdrop ${backdropClassName}`.trim()} onClick={onClose}>
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
              {!readOnly ? (
                <button className="title-edit-button detail-title-edit" onClick={onRename} aria-label={l("Rename session", "重命名会话")} title={l("Rename session", "重命名会话")}>
                  <Edit3 size={14} />
                </button>
              ) : null}
            </div>
            <p>{detailMeta.join(" · ")}</p>
          </div>
          <div className="detail-header-actions">
            {!readOnly ? (
              <button
                className={`icon-button favorite-button ${session.favorited ? "active" : ""}`}
                onClick={onFavorite}
                aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
                title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
              >
                <Star size={17} fill={session.favorited ? "currentColor" : "none"} />
              </button>
            ) : null}
            <button className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
              <X size={17} />
            </button>
          </div>
        </div>
        {!readOnly ? <div className="detail-actions">
          <div className="detail-action-group">
            {canResume ? (
              <button onClick={onResume} disabled={actionRunning}>
                <Play size={15} /> {session.source === "codex-app" ? l("Open in Codex", "在 Codex 中打开") : "Resume"}
              </button>
            ) : null}
            {canResume && showItermAction ? (
              <button onClick={onResumeIterm} disabled={actionRunning}>
                <TerminalIcon size={15} /> iTerm
              </button>
            ) : null}
            <button onClick={onReveal} disabled={actionRunning || localOnlyDisabled} title={revealTitle}>
              <FolderOpen size={15} /> {revealLabel}
            </button>
          </div>
          <div className="detail-action-group">
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
            {onUploadRemote ? (
              <button onClick={onUploadRemote} disabled={actionRunning}>
                <CloudUpload size={15} /> {l("Save to Remote", "保存到远程")}
              </button>
            ) : null}
          </div>
          <div className="detail-action-group">
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
          </div>
          <div className="detail-action-group">
            <button className="danger" onClick={onDelete} disabled={actionRunning}>
              <Trash2 size={15} /> {l("Delete", "删除")}
            </button>
          </div>
        </div> : null}
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
            <button key={tagName} className={`chip ${isBranchTag(tagName) ? "branch-tag" : ""}`} onClick={() => onRemoveTag(tagName)} disabled={readOnly}>
              #{tagName} ×
            </button>
          ))}
        </div>
        <div className="detail-body" ref={bodyRef}>
          {turns !== null ? (
            <section className="conversation turn-conversation">
              <div className="conversation-header">
                <h3>{l("Turns", "对话轮次")}</h3>
                {!turnsLoading ? (
                  <span className="turn-count">{l(`${turns.length} Turns`, `${turns.length} 轮`)}</span>
                ) : null}
              </div>
              <TurnAccordion
                sessionKey={session.sessionKey}
                turns={turns}
                loading={turnsLoading}
                matchedTurnId={matchedTurnId}
                query={query}
                language={language}
                onLoadTurn={onLoadTurn}
              />
            </section>
          ) : (
            <>
          {context.length > 0 ? (
            <section className="matched">
              <h3>{l("Matched Context", "命中上下文")}</h3>
              {context.map((message) => (
                <MessageBlock
                  key={message.index}
                  timelineKey={`ctx-${message.index}`}
                  message={message}
                  query={query}
                  language={language}
                  highlight
                  target={message.index === matchedMessageIndex}
                />
              ))}
            </section>
          ) : null}
          <section className="conversation">
            <div className="conversation-header">
              <h3>{l("Full Conversation", "完整会话")}</h3>
              <div className="conversation-filters">
                <div className="conversation-role-filter" role="group" aria-label={l("Conversation role filter", "会话角色过滤")}>
                  {CONVERSATION_ROLE_FILTERS.map((filter) => (
                    <button
                      key={filter}
                      className={roleFilter === filter ? "active" : ""}
                      onClick={() => setRoleFilter(filter)}
                      aria-pressed={roleFilter === filter}
                    >
                      {conversationRoleFilterLabel(filter, language)}
                    </button>
                  ))}
                </div>
                <button
                  className={`conversation-tools-toggle ${showTools ? "active" : ""}`}
                  onClick={toggleTools}
                  aria-pressed={showTools}
                >
                  {l("Tools", "工具")}
                </button>
              </div>
            </div>
            {panelSearchOpen ? (
              <div className="panel-search-bar">
                <Search size={14} />
                <input
                  ref={panelSearchInputRef}
                  className="panel-search-input"
                  type="text"
                  value={panelSearchQuery}
                  onChange={(event) => {
                    setPanelSearchQuery(event.target.value);
                    setCurrentMatchIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      closePanelSearch();
                      event.stopPropagation();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (event.shiftKey) prevPanelMatch();
                      else nextPanelMatch();
                    }
                  }}
                  placeholder={l("Find in conversation…", "在会话中查找…")}
                />
                {panelSearchQuery ? (
                  <span className="panel-search-count">
                    {panelSearchMatchKeys.length > 0
                      ? `${currentMatchIndex + 1}/${panelSearchMatchKeys.length}`
                      : l("No matches", "无匹配")}
                  </span>
                ) : null}
                <button
                  className="panel-search-nav"
                  onClick={prevPanelMatch}
                  disabled={panelSearchMatchKeys.length === 0}
                  title={l("Previous match (Shift+Enter)", "上一个匹配 (Shift+Enter)")}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  className="panel-search-nav"
                  onClick={nextPanelMatch}
                  disabled={panelSearchMatchKeys.length === 0}
                  title={l("Next match (Enter)", "下一个匹配 (Enter)")}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  className="panel-search-close"
                  onClick={closePanelSearch}
                  title={l("Close (Esc)", "关闭 (Esc)")}
                >
                  <X size={14} />
                </button>
              </div>
            ) : null}
            {loading ? <div className="loading-state">{l("Loading conversation...", "正在加载会话...")}</div> : null}
            {!loading && messages.length === 0 ? <div className="loading-state">{l("No visible messages indexed for this session.", "这个会话没有可见消息被索引。")}</div> : null}
            {!loading && olderMessageCount > 0 ? (
              <button className="show-more" onClick={onShowMore}>
                {l(`Show ${Math.min(messagePageSize, olderMessageCount)} older messages`, `再显示 ${Math.min(messagePageSize, olderMessageCount)} 条更早消息`)}
              </button>
            ) : null}
            {roleFilter !== "all" && roleFilterEmpty ? (
              <div className="conversation-empty">{conversationRoleEmptyLabel(roleFilter, language)}</div>
            ) : null}
            {visibleTimelineItems.map((item) => (
              item.kind === "message" ? (
                <MessageBlock
                  key={item.key}
                  timelineKey={item.key}
                  message={item.message}
                  query={panelSearchQuery || query}
                  language={language}
                  highlight={panelSearchQuery ? panelSearchMatchKeys.includes(item.key) : false}
                />
              ) : (
                <TraceEventBlock key={item.key} timelineKey={item.key} event={item.event} language={language} />
              )
            ))}
          </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

const MESSAGE_TRUNCATE_LIMIT = 3000;

function MessageBlock({
  message,
  query,
  language,
  highlight = false,
  target = false,
  timelineKey,
}: {
  message: SessionMessage;
  query: string;
  language: LanguageMode;
  highlight?: boolean;
  target?: boolean;
  timelineKey: string;
}): ReactElement {
  const truncated = message.content.length > MESSAGE_TRUNCATE_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const content = useMemo(() => {
    if (!truncated || expanded) return message.content;
    return markdownPreview(
      message.content,
      MESSAGE_TRUNCATE_LIMIT,
      localize(language, "...(truncated)", "...（已截断）"),
    );
  }, [message.content, truncated, expanded, language]);
  const highlightTerms = useMemo(() => (highlight ? searchHighlightTerms(query) : []), [highlight, query]);

  const useMarkdown = message.role === "assistant" && !highlight;

  return (
    <div className={`message ${message.role} ${highlight ? "match-context" : ""} ${target ? "match-target" : ""}`} data-message-index={message.index} data-timeline-key={timelineKey}>
      <div className="message-head">
        <strong>{message.role === "user" ? localize(language, "User", "用户") : localize(language, "Assistant", "助手")}</strong>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
      {useMarkdown ? (
        <div className="message-md">
          <Markdown text={content} language={language} />
        </div>
      ) : (
        <pre>{highlight ? <HighlightedSearchText text={content} terms={highlightTerms} /> : content}</pre>
      )}
      {truncated ? (
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full content", "展开全文")}
        </button>
      ) : null}
    </div>
  );
}

function traceStatusSymbol(event: SessionTraceEvent): string {
  if (event.kind === "tool_call") return "→";
  if (event.status === "success") return "✓";
  if (event.status === "failure") return "✗";
  return "•";
}

const TRACE_TRUNCATE_LIMIT = 2400;

function TraceEventBlock({ event, language, timelineKey }: { event: SessionTraceEvent; language: LanguageMode; timelineKey: string }): ReactElement {
  const truncated = Boolean(event.detail) && event.detail.length > TRACE_TRUNCATE_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const detail = useMemo(() => {
    if (!event.detail) return localize(language, "No detail captured.", "没有记录详情。");
    if (!truncated || expanded) return event.detail;
    return `${event.detail.slice(0, TRACE_TRUNCATE_LIMIT)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`;
  }, [event.detail, truncated, expanded, language]);

  return (
    <details className={`trace-event ${event.kind} ${event.status || "unknown"}`} data-timeline-key={timelineKey}>
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
      {truncated ? (
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full detail", "展开详情")}
        </button>
      ) : null}
    </details>
  );
}
