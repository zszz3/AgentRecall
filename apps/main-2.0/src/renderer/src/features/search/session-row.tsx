import { memo } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import {
  Container,
  Edit3,
  EyeOff,
  Folder,
  GitFork,
  Server,
  Star,
} from "lucide-react";
import { formatRelativeTime } from "../../../../core/format-session";
import type {
  SessionMatchHit,
  SessionSearchResult,
  SessionSortBy,
} from "../../../../core/types";
import { HighlightedSearchText } from "../../search-highlight";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import {
  displayTagName,
  environmentBadgeLabel,
  environmentBadgeTitle,
  hasTokenUsage,
  isBranchTag,
  isRemoteSession,
  localizedLiveStateLabel,
  sessionSortTimestamp,
} from "../../session-ui";
import { formatTokenCount } from "../../format-count";
import { AgentIcon } from "../sessions/agent-icon";

export const SessionRow = memo(function SessionRow({
  session,
  sortBy,
  selected,
  liveState,
  language,
  onSelect,
  onOpen,
  onOpenMatch,
  onRename,
  onFavorite,
  onContextMenu,
  bulkSelectionActive = false,
  bulkSelected = false,
  onToggleBulk,
}: {
  session: SessionSearchResult;
  sortBy?: SessionSortBy;
  selected: boolean;
  liveState: LiveSessionState;
  language: LanguageMode;
  onSelect: (sessionKey: string) => void;
  onOpen: (session: SessionSearchResult) => void;
  onOpenMatch: (session: SessionSearchResult, hit: SessionMatchHit) => void;
  onRename: (session: SessionSearchResult) => void;
  onFavorite: (session: SessionSearchResult) => void;
  onContextMenu: (event: ReactMouseEvent, session: SessionSearchResult) => void;
  bulkSelectionActive?: boolean;
  bulkSelected?: boolean;
  onToggleBulk?: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const matchHits = session.matchHits ?? [];
  const metadataMatchLabel =
    session.metadataMatch === "title"
      ? l("Matched session title", "命中会话标题")
      : session.metadataMatch === "project"
        ? l("Matched project path", "命中项目路径")
        : session.metadataMatch === "summary"
          ? l("Matched session summary", "命中会话摘要")
          : null;
  const project = projectName(session.projectPath);
  const remote = isRemoteSession(session);
  const timestamp = sessionSortTimestamp(session, sortBy);
  return (
    <article
      className={`session-row ${selected ? "selected" : ""} ${bulkSelectionActive ? "bulk-selecting" : ""}`}
      data-favorited={session.favorited || undefined}
      onClick={() => {
        onSelect(session.sessionKey);
        if (matchHits[0]) onOpenMatch(session, matchHits[0]);
        else onOpen(session);
      }}
      onContextMenu={(event) => onContextMenu(event, session)}
    >
      <div className="session-line">
        {bulkSelectionActive && onToggleBulk ? (
          <input
            className="session-bulk-checkbox"
            type="checkbox"
            checked={bulkSelected}
            onChange={() => onToggleBulk(session.sessionKey)}
            onClick={(event) => event.stopPropagation()}
            aria-label={l("Select session", "选择会话")}
          />
        ) : null}
        <span
          className="session-live-dot"
          data-state={liveState}
          role="img"
          aria-label={localizedLiveStateLabel(liveState, language)}
          title={localizedLiveStateLabel(liveState, language)}
        />
        <AgentIcon source={session.source} />
        <span className="session-name" title={session.displayTitle}>{session.displayTitle}</span>
        {session.forkedFromId ? (
          <GitFork size={13} role="img" aria-label={l("Forked session", "分叉会话")} />
        ) : null}
        {session.hidden ? <EyeOff className="session-hidden-icon" size={13} aria-label={l("Hidden", "已隐藏")} /> : null}
        <button
          type="button"
          className={`session-row-action favorite-button ${session.favorited ? "active" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onFavorite(session);
          }}
          aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
          title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
        >
          <Star size={13} fill={session.favorited ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="session-row-action title-edit-button"
          onClick={(event) => {
            event.stopPropagation();
            onRename(session);
          }}
          aria-label={l("Rename session", "重命名会话")}
          title={l("Rename session", "重命名会话")}
        >
          <Edit3 size={13} />
        </button>
        <span className="session-line-spacer" />
        {session.tags.length > 0 ? (
          <span className="row-tags">
            {session.tags.slice(0, 2).map((tagName) => (
              <span key={tagName} title={displayTagName(tagName)} className={isBranchTag(tagName) ? "branch-tag" : undefined}>
                {isBranchTag(tagName) ? "" : "#"}{displayTagName(tagName)}
              </span>
            ))}
          </span>
        ) : null}
        {session.sourceAvailable === false ? (
          <span
            className="source-cache-badge"
            title={l("The original Cursor session is unavailable. AgentRecall is showing its cached messages.", "原始 Cursor 会话已不可用，当前展示的是 AgentRecall 缓存消息。")}
          >
            {l("Cache", "缓存")}
          </span>
        ) : null}
        <span
          className="session-project"
          title={remote ? `${environmentBadgeTitle(session, language)} · ${session.projectPath}` : session.projectPath || l("No project path", "无项目路径")}
        >
          {session.environmentKind === "wsl" ? <Container size={12} /> : remote ? <Server size={12} /> : <Folder size={12} />}
          <span>{remote ? `${environmentBadgeLabel(session, language)} · ${project}` : project || l("No project", "无项目")}</span>
        </span>
        <span className="session-count">{l(`${session.messageCount} msgs`, `${session.messageCount} 条`)}</span>
        <span
          className="session-tokens"
          title={hasTokenUsage(session.tokenUsage) ? `${session.tokenUsage.totalTokens.toLocaleString()} tokens` : undefined}
        >
          {hasTokenUsage(session.tokenUsage) ? formatTokenCount(session.tokenUsage.totalTokens) : ""}
        </span>
        <time className="session-time" dateTime={Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined}>
          {formatRelativeTime(timestamp, language)}
        </time>
      </div>
      {matchHits.length > 0 ? (
        <div className="search-match-list">
          <div className="search-match-count">
            {l(`${session.messageMatchCount ?? matchHits.length} message matches`, `${session.messageMatchCount ?? matchHits.length} 条消息命中`)}
          </div>
          {matchHits.map((hit) => {
            const hitTimestamp = Date.parse(hit.timestamp);
            return (
              <button
                type="button"
                className="search-match-hit"
                key={hit.messageIndex}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenMatch(session, hit);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <span className="search-match-meta">
                  <strong>{hit.role === "user" ? l("User", "用户") : l("Assistant", "助手")}</strong>
                  {Number.isFinite(hitTimestamp) ? <time>{formatRelativeTime(hitTimestamp, language)}</time> : null}
                </span>
                <span className="search-match-snippet">
                  <HighlightedSearchText text={hit.snippet} terms={hit.matchedTerms} />
                </span>
              </button>
            );
          })}
        </div>
      ) : metadataMatchLabel ? (
        <div className="search-metadata-match">
          <span>{metadataMatchLabel}</span>
          {session.matchSnippet ? <span className="snippet">{session.matchSnippet}</span> : null}
        </div>
      ) : session.matchSnippet ? <div className="snippet">{session.matchSnippet}</div> : null}
    </article>
  );
});

function projectName(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}
