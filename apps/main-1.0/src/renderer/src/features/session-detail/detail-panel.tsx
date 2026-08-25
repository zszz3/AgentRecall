import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, ChevronDown, ChevronUp, CloudUpload, Container, Copy, Download, Edit3, FolderOpen, Laptop, Paperclip, Play, Search, Server, Sparkles, Star, Tag, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { formatMessageTime } from "../../../../core/format-session";
import { traceCompactionSummary, traceDetailText, traceDurationLabel, tracePresentation } from "../../../../core/trace-presentation";
import type { SessionMessage, SessionSearchResult, SessionTraceEvent } from "../../../../core/types";
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
import type { SessionFamily } from "../../../../core/session-family";
import { canDeleteSessionLocally } from "../../../../core/session-environment";
import { isSessionSource, sessionSourceDescriptor } from "../../../../core/session-sources";
import { SubagentSessionTree } from "./subagent-session-tree";
import { SessionContextComponentsPanel } from "./session-context-components-panel";
import { collaborationMessageMetadata } from "./collaboration-message";

export type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent; children: ConversationTraceNode[] };

export interface ConversationTraceNode {
  event: SessionTraceEvent;
  children: ConversationTraceNode[];
}

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

function traceToolAttributes(event: SessionTraceEvent): Record<string, unknown> | null {
  const tool = event.attributes?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  return tool as Record<string, unknown>;
}

function traceToolAttribute(event: SessionTraceEvent, name: string): string | null {
  const value = traceToolAttributes(event)?.[name];
  return typeof value === "string" && value ? value : null;
}

function traceWasParsedFromCodeMode(event: SessionTraceEvent): boolean {
  return traceToolAttribute(event, "executionEvidence") === "static-only"
    || traceToolAttributes(event)?.parsedFromCodeMode === true;
}

export function conversationTimeline(messages: SessionMessage[], traceEvents: SessionTraceEvent[]): ConversationTimelineItem[] {
  const messageTimes = messages.map((message) => timestampMs(message.timestamp)).filter((time): time is number => time !== null);
  const minMessageTime = messageTimes.length > 0 ? Math.min(...messageTimes) : null;
  const maxMessageTime = messageTimes.length > 0 ? Math.max(...messageTimes) : null;
  const presentableTraceEvents = traceEvents.filter(
    (event) => tracePresentation(event).visibility !== "hidden",
  );
  const visibleTraceEvents =
    messages.length === 0
      ? presentableTraceEvents
      : presentableTraceEvents.filter((event) => {
          if (event.sourceTurnId) return true;
          const time = timestampMs(event.timestamp);
          return time === null || minMessageTime === null || maxMessageTime === null || (time >= minMessageTime && time <= maxMessageTime);
        });
  const traceNodes = new Map(
    visibleTraceEvents.map((event) => [event.index, { event, children: [] } satisfies ConversationTraceNode]),
  );
  const traceNodesByCallId = new Map<string, ConversationTraceNode>();
  for (const node of traceNodes.values()) {
    if (node.event.callId && !traceNodesByCallId.has(node.event.callId)) {
      traceNodesByCallId.set(node.event.callId, node);
    }
  }
  const rootTraceNodes: ConversationTraceNode[] = [];
  for (const node of traceNodes.values()) {
    const parentCallId = traceWasParsedFromCodeMode(node.event)
      ? traceToolAttribute(node.event, "parentCallId")
      : null;
    const parent = parentCallId ? traceNodesByCallId.get(parentCallId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      rootTraceNodes.push(node);
    }
  }

  const items: ConversationTimelineItem[] = [
    ...messages.map(messageTimelineItem),
    ...rootTraceNodes.map(({ event, children }) => ({
      kind: "trace" as const,
      key: `trace:${event.index}`,
      timestampMs: timestampMs(event.timestamp),
      order: event.index * 2 + 1,
      event,
      children,
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
    if (item.kind === "trace") {
      const presentation = tracePresentation(item.event);
      if (presentation.visibility === "hidden") return false;
      return presentation.category !== "tool" || showTools;
    }
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
  messages,
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
  newerMessageCount,
  onClose,
  onShowMore,
  onShowNewer,
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
  remoteUploadDisabled = false,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onExportJson,
  onCopyPlain,
  onDelete,
  onReveal,
  readOnly = false,
  backdropClassName = "",
  sessionFamily,
  onOpenFamilySession,
  sessionFamilyLoadFailed = false,
  onRetrySessionFamily,
}: {
  session: SessionSearchResult;
  messages: SessionMessage[];
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
  newerMessageCount: number;
  onClose: () => void;
  onShowMore: () => void;
  onShowNewer: () => void;
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
  remoteUploadDisabled?: boolean;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: (includeToolTrace: boolean) => void;
  onExportJson: () => void;
  onCopyPlain: () => void;
  onDelete: () => void;
  onReveal: () => void;
  readOnly?: boolean;
  backdropClassName?: string;
  sessionFamily: SessionFamily;
  onOpenFamilySession?: (sessionKey: string) => void;
  sessionFamilyLoadFailed?: boolean;
  onRetrySessionFamily?: () => void;
}): ReactElement {
  const actionRunning = actionStatus?.kind === "running";
  const l = (en: string, zh: string) => localize(language, en, zh);
  const traceCount = traceEvents.filter(
    (event) => tracePresentation(event).visibility !== "hidden",
  ).length;
  const detailMeta = [
    session.projectPath || l("No project", "无项目"),
    new Date(session.timestamp).toLocaleString(
      language === "zh" ? "zh-CN" : "en-US",
      language === "zh" ? { hourCycle: "h23" } : undefined,
    ),
    l(`${session.messageCount} messages`, `${session.messageCount} 条消息`),
    ...(hasTokenUsage(session.tokenUsage) ? [l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)] : []),
    ...(traceCount > 0 ? [l(`${traceCount} trace events`, `${traceCount} 条轨迹`)] : []),
  ];
  const bodyRef = useRef<HTMLDivElement>(null);
  const exportMarkdownMenuRef = useRef<HTMLDivElement>(null);
  const pendingInitialScrollRef = useRef<string | null>(session.sessionKey);
  const [roleFilter, setRoleFilter] = useState<ConversationRoleFilter>("all");
  const [showTools, setShowTools] = useState(readInitialToolEventsVisibility);
  const [exportMarkdownMenuOpen, setExportMarkdownMenuOpen] = useState(false);
  const timelineItems = useMemo(() => conversationTimeline(messages, traceEvents), [messages, traceEvents]);
  const visibleTimelineItems = useMemo(
    () => filterConversationTimeline(timelineItems, roleFilter, showTools),
    [roleFilter, showTools, timelineItems],
  );

  useEffect(() => {
    if (!exportMarkdownMenuOpen) return;
    const closeMenu = (event: MouseEvent): void => {
      if (!exportMarkdownMenuRef.current?.contains(event.target as Node)) {
        setExportMarkdownMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setExportMarkdownMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [exportMarkdownMenuOpen]);

  useEffect(() => setExportMarkdownMenuOpen(false), [session.sessionKey]);
  const roleFilterEmpty = !loading
    && messages.length > 0
    && roleFilter !== "all"
    && !messages.some((message) => message.role === roleFilter);
  const localOnlyDisabled = isRemoteSession(session);
  const canDelete = canDeleteSessionLocally(session);
  const canSyncSession = isSessionSource(session.source)
    && sessionSourceDescriptor(session.source).capabilities.sessionSync;
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
        const childText = (node: ConversationTraceNode): string => [
          node.event.title,
          node.event.detail,
          node.event.eventType,
          ...node.children.map(childText),
        ].filter(Boolean).join(" ");
        const hay = [
          item.event.title,
          item.event.detail,
          item.event.eventType,
          ...item.children.map(childText),
        ]
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
  }, [session.sessionKey, matchedMessageIndex]);

  useEffect(() => {
    if (loading || messages.length === 0 || pendingInitialScrollRef.current !== session.sessionKey) return;
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
  }, [loading, messages.length, session.sessionKey, matchedMessageIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = bodyRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;

      // Ctrl+F / Cmd+F: open panel search
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setPanelSearchOpen(true);
        panelSearchInputRef.current?.focus();
        panelSearchInputRef.current?.select();
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
  }, [panelSearchOpen]);

  return (
    <div className={`detail-backdrop ${backdropClassName}`.trim()} onClick={onClose}>
      <aside className="detail" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <div>
            <div className="detail-badges">
              <div className={`source-badge ${sourceUiFamily(session.source)}`}>
                {SOURCE_LABEL[session.source]}
              </div>
              {session.sourceAvailable === false ? (
                <span
                  className="source-cache-badge"
                  title={l("The original Cursor session is unavailable. AgentRecall is showing its cached messages.", "原始 Cursor 会话已不可用，当前展示的是 AgentRecall 缓存消息。")}
                >
                  {l("Cache", "缓存")}
                </span>
              ) : null}
              <span className={`live-status ${liveState}`}>
                <span className="live-status-dot" />
                {localizedLiveStateLabel(liveState, language)}
              </span>
              <span className={`environment-badge ${session.environmentKind}`} title={environmentBadgeTitle(session, language)}>
                {session.environmentKind === "wsl" ? <Container size={13} /> : isRemoteSession(session) ? <Server size={13} /> : <Laptop size={13} />}
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
            {onUploadRemote && canSyncSession ? (
              <button
                onClick={onUploadRemote}
                disabled={actionRunning || remoteUploadDisabled}
                title={remoteUploadDisabled ? l("This session cannot be saved to cloud.", "此会话不能保存到云端。") : undefined}
              >
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
            <div className="export-markdown-menu" ref={exportMarkdownMenuRef}>
              <button
                onClick={() => setExportMarkdownMenuOpen((open) => !open)}
                disabled={actionRunning}
                aria-haspopup="menu"
                aria-expanded={exportMarkdownMenuOpen}
              >
                <Download size={15} /> {l("Export MD", "导出 MD")} <ChevronDown size={13} />
              </button>
              {exportMarkdownMenuOpen ? (
                <div className="export-markdown-options" role="menu">
                  <button role="menuitem" onClick={() => {
                    setExportMarkdownMenuOpen(false);
                    onExportMarkdown(false);
                  }}>
                    {l("Conversation only", "仅导出会话内容")}
                    <small>{l("No Tool Trace", "不含 Tool Trace")}</small>
                  </button>
                  <button role="menuitem" onClick={() => {
                    setExportMarkdownMenuOpen(false);
                    onExportMarkdown(true);
                  }}>
                    {l("Complete record", "导出完整记录")}
                    <small>{l("Include Tool Trace", "包含 Tool Trace")}</small>
                  </button>
                </div>
              ) : null}
            </div>
            <button onClick={onExportJson} disabled={actionRunning}>
              <Download size={15} /> {l("Export JSON", "导出 JSON")}
            </button>
            <button onClick={onCopyPlain} disabled={actionRunning}>{l("Plain Text", "纯文本")}</button>
          </div>
          {canDelete ? (
            <div className="detail-action-group">
              <button className="danger" onClick={onDelete} disabled={actionRunning}>
                <Trash2 size={15} /> {session.sourceAvailable === false ? l("Delete Cache", "删除缓存") : l("Delete", "删除")}
              </button>
            </div>
          ) : null}
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
        <SessionContextComponentsPanel session={session} language={language} />
        <div className="detail-tags">
          {session.tags.map((tagName) => (
            <button key={tagName} className={`chip ${isBranchTag(tagName) ? "branch-tag" : ""}`} onClick={() => onRemoveTag(tagName)} disabled={readOnly}>
              #{tagName} ×
            </button>
          ))}
        </div>
        <div className="detail-body" ref={bodyRef}>
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
                  sessionKey={session.sessionKey}
                  message={item.message}
                  query={panelSearchQuery || query}
                  language={language}
                  highlight={item.message.index === matchedMessageIndex || (panelSearchQuery ? panelSearchMatchKeys.includes(item.key) : false)}
                  target={item.message.index === matchedMessageIndex}
                />
              ) : (
                <TraceEventBlock key={item.key} timelineKey={item.key} event={item.event} children={item.children} language={language} />
              )
            ))}
            {!loading && newerMessageCount > 0 ? (
              <button className="show-more" onClick={onShowNewer}>
                {l(`Show ${Math.min(messagePageSize, newerMessageCount)} newer messages`, `再显示 ${Math.min(messagePageSize, newerMessageCount)} 条更新消息`)}
              </button>
            ) : null}
          </section>
          {onOpenFamilySession ? (
            <SubagentSessionTree
              key={session.sessionKey}
              family={sessionFamily}
              language={language}
              onOpen={onOpenFamilySession}
              loadFailed={sessionFamilyLoadFailed}
              onRetry={onRetrySessionFamily}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

const MESSAGE_TRUNCATE_LIMIT = 3000;

function MessageBlock({
  message,
  sessionKey,
  query,
  language,
  highlight = false,
  target = false,
  timelineKey,
}: {
  message: SessionMessage;
  sessionKey: string;
  query: string;
  language: LanguageMode;
  highlight?: boolean;
  target?: boolean;
  timelineKey: string;
}): ReactElement {
  const truncated = message.content.length > MESSAGE_TRUNCATE_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{ name: string; kind: "image" | "text"; data: string } | null>(null);
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
    <div className={`message ${message.role} ${message.phase === "commentary" ? "commentary" : ""} ${highlight ? "match-context" : ""} ${target ? "match-target" : ""}`} data-message-index={message.index} data-timeline-key={timelineKey}>
      <div className="message-head">
        <strong>{message.role === "user" ? localize(language, "User", "用户") : localize(language, "Assistant", "助手")}</strong>
        {message.phase === "commentary"
          ? <span className="message-phase">{localize(language, "Process note", "过程说明")}</span>
          : null}
        <span>{formatMessageTime(message.timestamp, language)}</span>
      </div>
      {useMarkdown ? (
        <div className="message-md">
          <Markdown text={content} language={language} />
        </div>
      ) : (
        <pre>{highlight ? <HighlightedSearchText text={content} terms={highlightTerms} /> : content}</pre>
      )}
      {(message.attachments?.length ?? 0) > 0 ? (
        <div className="message-attachments">
          {message.attachments?.map((attachment) => (
            <button
              type="button"
              key={attachment.id}
              disabled={attachment.status !== "available"}
              title={attachment.status === "available" ? attachment.fileName : localize(language, "Attachment unavailable", "附件不可用")}
              onClick={() => {
                const previewRequest = attachment.remoteObjectKey && attachment.sha256
                  ? window.sessionSearch.previewRemoteSessionAttachment(
                    attachment.remoteObjectKey,
                    attachment.sha256,
                    attachment.mimeType,
                    attachment.previewKind,
                  )
                  : window.sessionSearch.previewAttachment(sessionKey, attachment.id);
                void previewRequest.then((preview) => {
                  if ((preview.kind === "image" || preview.kind === "text") && preview.data) {
                    setAttachmentPreview({ name: attachment.fileName, kind: preview.kind, data: preview.data });
                  }
                });
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
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full content", "展开全文")}
        </button>
      ) : null}
      {attachmentPreview ? (
        <div className="attachment-preview-backdrop" onClick={() => setAttachmentPreview(null)}>
          <div className="attachment-preview-dialog" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{attachmentPreview.name}</strong>
              <button type="button" onClick={() => setAttachmentPreview(null)} aria-label={localize(language, "Close", "关闭")}>
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

function traceStatusSymbol(event: SessionTraceEvent): string {
  const evidence = traceToolAttribute(event, "executionEvidence");
  if (evidence === "static-only") return "◇";
  if (event.status === "completed") return "✓";
  if (event.status === "failed") return "✗";
  if (event.status === "aborted") return "■";
  if (evidence === "recorded-request" || event.kind === "tool_call") return "→";
  return "•";
}

function traceStatusLabel(event: SessionTraceEvent, language: LanguageMode): string {
  const evidence = traceToolAttribute(event, "executionEvidence");
  if (evidence === "static-only") return localize(language, "Statically identified", "静态识别");
  if (event.status === "completed") return localize(language, "Completed", "已完成");
  if (event.status === "failed") return localize(language, "Failed", "失败");
  if (event.status === "aborted") return localize(language, "Interrupted", "已中断");
  if (evidence === "recorded-request") return localize(language, "Requested", "已请求");
  if (event.status === "running") return localize(language, "Running", "进行中");
  return localize(language, "Status unknown", "状态未知");
}

const TRACE_TRUNCATE_LIMIT = 2400;
const PARSED_TOOL_SUMMARY_LIMIT = 240;

function parsedTraceSummary(event: SessionTraceEvent): string {
  const input = event.attributes?.input;
  let summary = "";
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    for (const key of ["cmd", "command", "query", "path", "file_path", "url"]) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) {
        summary = value.trim();
        break;
      }
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        summary = value.join(" ");
        break;
      }
    }
  }
  if (!summary && event.detail) summary = traceDetailText(event.detail).replace(/\s+/g, " ").trim();
  return summary.length > PARSED_TOOL_SUMMARY_LIMIT
    ? `${summary.slice(0, PARSED_TOOL_SUMMARY_LIMIT)}…`
    : summary;
}

function TraceEventBlock({
  event,
  children = [],
  language,
  timelineKey,
}: {
  event: SessionTraceEvent;
  children?: ConversationTraceNode[];
  language: LanguageMode;
  timelineKey: string;
}): ReactElement {
  const truncated = Boolean(event.detail) && event.detail.length > TRACE_TRUNCATE_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const durationText = traceDurationLabel(event.attributes);
  const compactionSummary = traceCompactionSummary(event.attributes);
  const collaboration = collaborationMessageMetadata(event.attributes);
  const detail = useMemo(() => {
    if (!event.detail) return localize(language, "No detail captured.", "没有记录详情。");
    const readable = traceDetailText(event.detail);
    if (!truncated || expanded) return readable;
    return `${readable.slice(0, TRACE_TRUNCATE_LIMIT)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`;
  }, [event.detail, truncated, expanded, language]);

  return (
    <details className={`trace-event ${children.length > 0 ? "trace-event-group" : ""} ${event.kind} ${event.status || "unknown"}`} data-timeline-key={timelineKey}>
      <summary className="trace-head">
        <strong>
          <span className="trace-symbol">{traceStatusSymbol(event)}</span>
          {event.title}
          <span className="trace-status-label">{traceStatusLabel(event, language)}</span>
        </strong>
        <span>{formatMessageTime(event.timestamp, language)}</span>
      </summary>
      <div className="trace-meta">
        {event.eventType ? <span>{event.eventType}</span> : null}
        {collaboration?.author || collaboration?.recipient
          ? <span>{collaboration.author || "?"} → {collaboration.recipient || "?"}</span>
          : null}
        {durationText ? <span className="trace-duration">{durationText}</span> : null}
        {compactionSummary ? (
          <>
            <span>{localize(
              language,
              `${compactionSummary.itemCount} ${compactionSummary.itemCount === 1 ? "item" : "items"}`,
              `共 ${compactionSummary.itemCount} 项`,
            )}</span>
            {compactionSummary.itemTypes.map(({ type, count }) => (
              <span key={type}>{type} {count}</span>
            ))}
          </>
        ) : null}
        {event.callId ? <span>{event.callId}</span> : null}
      </div>
      <pre>{detail}</pre>
      {truncated ? (
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? localize(language, "Collapse", "收起") : localize(language, "Show full detail", "展开详情")}
        </button>
      ) : null}
      {children.length > 0 ? (
        <div className="trace-child-results">
          <div className="trace-code-mode-origin" role="note">
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
            const staticOnly = traceToolAttribute(child.event, "executionEvidence") === "static-only";
            return (
              <div className="trace-child-result" key={child.event.index}>
                {!staticOnly ? (
                  <TraceEventBlock
                    event={child.event}
                    children={child.children}
                    language={language}
                    timelineKey={`${timelineKey}:child:${child.event.index}`}
                  />
                ) : null}
                <div className="trace-parsed-result">
                  <span className="trace-parsed-result-label">
                    {localize(language, "AST parsed", "AST 解析")}
                  </span>
                  <strong>{child.event.title.split(" · ", 1)[0] || child.event.title}</strong>
                  <code>{parsedTraceSummary(child.event) || localize(language, "Arguments not statically resolved", "参数未能静态解析")}</code>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}
