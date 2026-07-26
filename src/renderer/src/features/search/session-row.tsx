import { memo } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import {
  Code2,
  Container,
  Edit3,
  EyeOff,
  Laptop,
  Server,
  Star,
  Terminal as TerminalIcon,
} from "lucide-react";
import { formatRelativeTime } from "../../../../core/format-session";
import type {
  SessionMatchHit,
  SessionSearchResult,
  SessionSortBy,
} from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import { HighlightedSearchText } from "../../search-highlight";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import {
  SOURCE_LABEL,
  displayTagName,
  environmentBadgeLabel,
  environmentBadgeTitle,
  hasTokenUsage,
  isBranchTag,
  isRemoteSession,
  localizedLiveStateLabel,
  sessionSortTimestamp,
  sourceUiFamily,
} from "../../session-ui";

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
  return (
    <article
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={() => {
        onSelect(session.sessionKey);
        onOpen(session);
      }}
      onContextMenu={(event) => onContextMenu(event, session)}
    >
      <div className="session-main">
        <div className="session-title">
          <button
            className={`favorite-button ${session.favorited ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite(session);
            }}
            aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
            title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
          >
            <Star size={14} fill={session.favorited ? "currentColor" : "none"} />
          </button>
          {session.hidden ? <EyeOff size={14} /> : null}
          <span className="session-name">{session.displayTitle}</span>
          <button
            className="title-edit-button"
            onClick={(event) => {
              event.stopPropagation();
              onRename(session);
            }}
            aria-label={l("Rename session", "重命名会话")}
            title={l("Rename session", "重命名会话")}
          >
            <Edit3 size={13} />
          </button>
        </div>
        <div className="session-meta">
          <span className={`live-status ${liveState}`}>
            <span className="live-status-dot" />
            {localizedLiveStateLabel(liveState, language)}
          </span>
          <span className={`source-badge ${sourceUiFamily(session.source)}`}>
            {sourceUiFamily(session.source) === "claude" ? <Code2 size={13} /> : <TerminalIcon size={13} />}
            {SOURCE_LABEL[session.source]}
          </span>
          <span className={`environment-badge ${session.environmentKind}`} title={environmentBadgeTitle(session, language)}>
              {session.environmentKind === "wsl" ? <Container size={13} /> : isRemoteSession(session) ? <Server size={13} /> : <Laptop size={13} />}
            {environmentBadgeLabel(session, language)}
          </span>
          <span>{session.projectPath || l("No project path", "无项目路径")}</span>
          <span>{formatRelativeTime(sessionSortTimestamp(session, sortBy))}</span>
          <span>{l(`${session.messageCount} messages`, `${session.messageCount} 条消息`)}</span>
          {hasTokenUsage(session.tokenUsage) ? <span>{l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)}</span> : null}
        </div>
        {matchHits.length > 0 ? (
          <div className="search-match-list">
            <div className="search-match-count">
              {l(`${session.messageMatchCount ?? matchHits.length} message matches`, `${session.messageMatchCount ?? matchHits.length} 条消息命中`)}
            </div>
            {matchHits.map((hit) => {
              const timestamp = Date.parse(hit.timestamp);
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
                    {Number.isFinite(timestamp) ? <time>{formatRelativeTime(timestamp)}</time> : null}
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
      </div>
      <div className="row-tags">
        {session.tags.slice(0, 3).map((tagName) => (
         <span key={tagName} className={isBranchTag(tagName) ? "branch-tag" : undefined}>
            {isBranchTag(tagName) ? "" : "#"}{displayTagName(tagName)}
         </span>
        ))}
      </div>
    </article>
  );
});

