import type { ReactElement, ReactNode, RefObject } from "react";
import { ChevronDown, ChevronUp, Container, Edit3, Laptop, Search, Server, Star, X } from "lucide-react";
import type { SessionSearchResult } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import {
  environmentBadgeLabel,
  environmentBadgeTitle,
  hasTokenUsage,
  isRemoteSession,
  localizedLiveStateLabel,
  SOURCE_LABEL,
  sessionAvailableSources,
  sourceUiFamily,
} from "../../session-ui";

/**
 * Sticky detail header: source/live/environment badges, title with rename,
 * session metadata, favorite and close. `children` renders as the header's last
 * child so in-conversation find stays inside the sticky header.
 */
export function DetailHeader({
  session,
  liveState,
  language,
  readOnly,
  traceCount,
  onRename,
  onFavorite,
  onClose,
  children,
}: {
  session: SessionSearchResult;
  liveState: LiveSessionState;
  language: LanguageMode;
  readOnly: boolean;
  traceCount: number;
  onRename: () => void;
  onFavorite: () => void;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
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
  return (
    <div className="detail-header">
      <div>
        <div className="detail-badges">
          {sessionAvailableSources(session).map((source) => (
            <div className={`source-badge ${sourceUiFamily(source)}`} key={source}>
              {SOURCE_LABEL[source]}
            </div>
          ))}
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
      {children}
    </div>
  );
}

/** In-conversation find bar: Enter/Shift+Enter step through matches, Escape closes. */
export function PanelSearchBar({
  inputRef,
  query,
  matchCount,
  currentMatchIndex,
  language,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matchCount: number;
  currentMatchIndex: number;
  language: LanguageMode;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="panel-search-bar">
      <Search size={14} />
      <input
        ref={inputRef}
        className="panel-search-input"
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
            event.stopPropagation();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          }
        }}
        placeholder={l("Find in conversation…", "在会话中查找…")}
      />
      {query ? (
        <span className="panel-search-count">
          {matchCount > 0
            ? `${currentMatchIndex + 1}/${matchCount}`
            : l("No matches", "无匹配")}
        </span>
      ) : null}
      <button
        className="panel-search-nav"
        onClick={onPrevious}
        disabled={matchCount === 0}
        title={l("Previous match (Shift+Enter)", "上一个匹配 (Shift+Enter)")}
      >
        <ChevronUp size={14} />
      </button>
      <button
        className="panel-search-nav"
        onClick={onNext}
        disabled={matchCount === 0}
        title={l("Next match (Enter)", "下一个匹配 (Enter)")}
      >
        <ChevronDown size={14} />
      </button>
      <button
        className="panel-search-close"
        onClick={onClose}
        title={l("Close (Esc)", "关闭 (Esc)")}
      >
        <X size={14} />
      </button>
    </div>
  );
}
