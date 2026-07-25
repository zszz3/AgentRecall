import { useMemo, useState, type ReactElement } from "react";
import { ChevronLeft, Edit3, Play, Star, X } from "lucide-react";
import { MarkdownV1 } from "./MarkdownV1";
import {
  VirtualTimeline,
  type LoadOlderMessagesRequest,
} from "./VirtualTimeline";
import "./session-detail-v1.css";

export type SessionDetailMessageRoleV1 = "assistant" | "system" | "tool" | "user";

export interface SessionDetailMessageV1 {
  content: string;
  id: string;
  role: SessionDetailMessageRoleV1;
  timestamp?: string | null;
}

export interface SessionDetailModelV1 {
  id: string;
  messageCount?: number;
  projectPath?: string | null;
  sourceLabel?: string | null;
  startedAt?: string | null;
  title: string;
}

export interface SessionDetailV1Labels {
  assistant: string;
  close: string;
  empty: string;
  favorite: string;
  loadOlder: string;
  loading: string;
  loadingOlder: string;
  rename: string;
  resume: string;
  showLess: string;
  showMore: string;
  system: string;
  tool: string;
  unfavorite: string;
  user: string;
}

export type SessionDetailV1Language = "en" | "zh";

export interface SessionDetailV1Props {
  allowExternalImages?: boolean;
  canResume?: boolean;
  className?: string;
  defaultExpandedMessageIds?: readonly string[];
  hasOlderMessages?: boolean;
  isFavorite?: boolean;
  isLoading?: boolean;
  isLoadingOlder?: boolean;
  labels?: Partial<SessionDetailV1Labels>;
  language?: SessionDetailV1Language;
  longMessagePreviewCharacters?: number;
  messages: readonly SessionDetailMessageV1[];
  onClose?: () => void;
  onLoadOlder?: (request: LoadOlderMessagesRequest) => Promise<void> | void;
  onRename?: () => void;
  onResume?: () => void;
  onToggleFavorite?: () => void;
  resumePending?: boolean;
  session: SessionDetailModelV1;
}

const ENGLISH_LABELS: SessionDetailV1Labels = {
  assistant: "Assistant",
  close: "Close details",
  empty: "No messages in this session.",
  favorite: "Add to favorites",
  loadOlder: "Load older messages",
  loading: "Loading conversation…",
  loadingOlder: "Loading older messages…",
  rename: "Rename session",
  resume: "Resume",
  showLess: "Show less",
  showMore: "Show full message",
  system: "System",
  tool: "Tool",
  unfavorite: "Remove from favorites",
  user: "You",
};

const CHINESE_LABELS: SessionDetailV1Labels = {
  assistant: "助手",
  close: "关闭详情",
  empty: "此会话没有消息。",
  favorite: "添加收藏",
  loadOlder: "加载更早消息",
  loading: "正在加载对话…",
  loadingOlder: "正在加载更早消息…",
  rename: "重命名会话",
  resume: "继续会话",
  showLess: "收起",
  showMore: "展开完整消息",
  system: "系统",
  tool: "工具",
  unfavorite: "取消收藏",
  user: "你",
};

function sessionMeta(session: SessionDetailModelV1, language: SessionDetailV1Language): string[] {
  const meta = [session.sourceLabel, session.projectPath].filter(
    (value): value is string => Boolean(value),
  );
  if (session.startedAt) {
    const time = new Date(session.startedAt);
    meta.push(
      Number.isNaN(time.getTime())
        ? session.startedAt
        : time.toLocaleString(language === "zh" ? "zh-CN" : "en"),
    );
  }
  if (session.messageCount !== undefined) {
    meta.push(
      language === "zh"
        ? `${session.messageCount} 条消息`
        : `${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`,
    );
  }
  return meta;
}

function messageTime(timestamp: string | null | undefined, language: SessionDetailV1Language): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleTimeString(language === "zh" ? "zh-CN" : "en", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function roleLabel(
  role: SessionDetailMessageRoleV1,
  labels: Pick<SessionDetailV1Labels, "assistant" | "system" | "tool" | "user">,
): string {
  return labels[role];
}

export interface SessionMessageCardV1Props {
  allowExternalImages?: boolean;
  defaultExpanded?: boolean;
  labels?: Pick<SessionDetailV1Labels, "assistant" | "showLess" | "showMore" | "system" | "tool" | "user">;
  language?: SessionDetailV1Language;
  message: SessionDetailMessageV1;
  previewCharacters?: number;
}

export function SessionMessageCardV1({
  allowExternalImages = false,
  defaultExpanded = false,
  labels = ENGLISH_LABELS,
  language = "en",
  message,
  previewCharacters = 6_000,
}: SessionMessageCardV1Props): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const normalizedPreviewLength = Math.max(200, previewCharacters);
  const isLong =
    message.content.length > normalizedPreviewLength ||
    message.content.split("\n", 82).length > 81;
  const visibleContent =
    isLong && !expanded
      ? `${message.content.slice(0, normalizedPreviewLength).trimEnd()}\n\n…`
      : message.content;

  return (
    <article
      aria-label={`${roleLabel(message.role, labels)} message`}
      className={`ar-v1-message ar-v1-message--${message.role}`}
      data-message-id={message.id}
    >
      <header className="ar-v1-message__header">
        <span>{roleLabel(message.role, labels)}</span>
        {message.timestamp ? (
          <time dateTime={message.timestamp}>{messageTime(message.timestamp, language)}</time>
        ) : null}
      </header>
      <MarkdownV1 allowExternalImages={allowExternalImages}>{visibleContent}</MarkdownV1>
      {isLong ? (
        <button
          aria-expanded={expanded}
          className="ar-v1-message__expand"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? labels.showLess : labels.showMore}
        </button>
      ) : null}
    </article>
  );
}

function messageKey(message: SessionDetailMessageV1): string {
  return message.id;
}

export function SessionDetailV1({
  allowExternalImages = false,
  canResume = true,
  className = "",
  defaultExpandedMessageIds = [],
  hasOlderMessages = false,
  isFavorite = false,
  isLoading = false,
  isLoadingOlder = false,
  labels: labelOverrides,
  language = "en",
  longMessagePreviewCharacters = 6_000,
  messages,
  onClose,
  onLoadOlder,
  onRename,
  onResume,
  onToggleFavorite,
  resumePending = false,
  session,
}: SessionDetailV1Props): ReactElement {
  const labels = useMemo(
    () => ({
      ...(language === "zh" ? CHINESE_LABELS : ENGLISH_LABELS),
      ...labelOverrides,
    }),
    [labelOverrides, language],
  );
  const expandedMessageIds = useMemo(
    () => new Set(defaultExpandedMessageIds),
    [defaultExpandedMessageIds],
  );
  const meta = sessionMeta(session, language);

  return (
    <section
      aria-label={session.title}
      className={`ar-v1-detail ${className}`.trim()}
      data-session-id={session.id}
    >
      <header className="ar-v1-detail__header">
        <div className="ar-v1-detail__heading">
          {onClose ? (
            <button aria-label={labels.close} className="ar-v1-icon-button" onClick={onClose} type="button">
              <ChevronLeft aria-hidden="true" size={18} />
            </button>
          ) : null}
          <div className="ar-v1-detail__title">
            <h2>{session.title}</h2>
            {meta.length > 0 ? <p>{meta.join(" · ")}</p> : null}
          </div>
        </div>
        <div className="ar-v1-detail__actions">
          {onToggleFavorite ? (
            <button
              aria-label={isFavorite ? labels.unfavorite : labels.favorite}
              className={`ar-v1-icon-button ${isFavorite ? "is-active" : ""}`.trim()}
              onClick={onToggleFavorite}
              type="button"
            >
              <Star aria-hidden="true" fill={isFavorite ? "currentColor" : "none"} size={17} />
            </button>
          ) : null}
          {onRename ? (
            <button aria-label={labels.rename} className="ar-v1-icon-button" onClick={onRename} type="button">
              <Edit3 aria-hidden="true" size={17} />
            </button>
          ) : null}
          {onResume ? (
            <button
              className="ar-v1-detail__resume"
              disabled={!canResume || resumePending}
              onClick={onResume}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" size={14} />
              {resumePending ? `${labels.resume}…` : labels.resume}
            </button>
          ) : null}
          {onClose ? (
            <button aria-label={labels.close} className="ar-v1-icon-button ar-v1-detail__close" onClick={onClose} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="ar-v1-detail__body">
        {isLoading && messages.length === 0 ? (
          <div aria-live="polite" className="ar-v1-detail__state">
            {labels.loading}
          </div>
        ) : (
          <VirtualTimeline
            emptyState={labels.empty}
            getItemKey={messageKey}
            hasOlder={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
            items={messages}
            loadOlderLabel={labels.loadOlder}
            loadingOlderLabel={labels.loadingOlder}
            onLoadOlder={onLoadOlder}
            renderItem={(message) => (
              <SessionMessageCardV1
                allowExternalImages={allowExternalImages}
                defaultExpanded={expandedMessageIds.has(message.id)}
                labels={labels}
                language={language}
                message={message}
                previewCharacters={longMessagePreviewCharacters}
              />
            )}
          />
        )}
      </div>
    </section>
  );
}
