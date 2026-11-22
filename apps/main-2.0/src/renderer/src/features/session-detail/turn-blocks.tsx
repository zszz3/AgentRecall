import { createContext, useContext, useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { AlertCircle, ArrowRightLeft, BotMessageSquare, ChevronDown, ChevronRight, Paperclip, Wrench, X } from "lucide-react";

import { formatMessageTime } from "../../../../core/format-session";
import { traceCompactionSummary } from "../../../../core/trace-presentation";
import type {
  SessionTraceSpan,
  SessionTurnDetail,
  SessionTurnMessage,
} from "../../../../core/types";
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
import {
  buildTurnTimeline,
  durationLabel,
  durationMs,
  parsedToolSummary,
  payloadText,
  spanDisplayName,
  spanExecutionEvidence,
  spanStatusLabel,
  spanStatusSymbol,
  type TurnMessageRoleFilter,
  type TurnTimelineSpanNode,
} from "./turn-timeline";

export function TurnContextMenu({
  onSelect,
  point,
  language,
  onMigrate,
}: {
  point: ContextMenuPoint;
  language: LanguageMode;
  onMigrate?: () => void;
  onSelect?: () => void;
}): ReactElement {
  const menu = useClampedContextMenuStyle(point);
  return (
    <div
      ref={menu.ref}
      className="context-menu turn-context-menu"
      style={menu.style}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {onSelect && <button type="button" onClick={onSelect}>{localize(language, "Select turns…", "多选轮次…")}</button>}
      {onMigrate && <button type="button" onClick={onMigrate}>
        <ArrowRightLeft size={14} /> {localize(language, "Migrate", "迁移")}
      </button>}
    </div>
  );
}

const MESSAGE_TRUNCATE_LIMIT = 3_000;
const SPAN_PAYLOAD_PREVIEW_LIMIT = 2_400;

export const TurnDisplayState = createContext<Map<string, boolean> | null>(null);
function useTurnExpansion(key: string): [boolean, (value: boolean) => void] {
  const remembered = useContext(TurnDisplayState);
  const [expanded, setExpanded] = useState(() => remembered?.get(key) ?? false);
  const update = useCallback((value: boolean) => {
    remembered?.set(key, value);
    setExpanded(value);
  }, [key, remembered]);
  return [expanded, update];
}

function TurnSpanPayload({
  stateKey,
  label,
  payload,
  previewLimit,
  language,
}: {
  stateKey: string;
  label: string;
  payload: Record<string, unknown>;
  previewLimit?: number;
  language: LanguageMode;
}): ReactElement {
  const [expanded, setExpanded] = useTurnExpansion(`${stateKey}:full`);
  const [open, setOpen] = useTurnExpansion(`${stateKey}:open`);
  const text = payloadText(payload);
  const truncated = previewLimit !== undefined && text.length > previewLimit;
  const visibleText = truncated && !expanded
    ? `${text.slice(0, previewLimit)}${localize(language, "...(truncated)", "...（已截断）")}`
    : text;

  return (
    <details className="msg-tool-payload" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      <pre>{visibleText}</pre>
      {truncated ? (
        <button
          type="button"
          className="expand-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
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
  attachmentAccess,
}: {
  sessionKey: string;
  attachmentAccess: "session" | "download";
  message: SessionTurnMessage;
  query: string;
  language: LanguageMode;
  target?: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useTurnExpansion(`message:${message.messageIndex}`);
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
              disabled={attachmentAccess === "download" || attachment.status !== "available"}
              title={attachmentAccess === "download" ? localize(language, "Download the shared package to view this attachment", "下载分享包查看此附件") : attachment.status === "available"
                ? attachment.fileName
                : localize(language, "Attachment unavailable", "附件不可用")}
              onClick={() => {
                if (attachmentAccess === "download") return;
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
        <button className="expand-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
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
  const [open, setOpen] = useTurnExpansion(`${span.id}:open`);
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
    <details className={`msg tool ${span.status} ${children.length > 0 ? "msg-tool-group" : ""} ${evidenceClass} ${target ? "match-target" : ""}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
            stateKey={`${span.id}:input`}
            label={localize(language, "Input", "输入")}
            payload={span.input}
            previewLimit={eventType === "codex.context.compaction" ? SPAN_PAYLOAD_PREVIEW_LIMIT : undefined}
            language={language}
          />
        ) : null}
        {span.output ? (
          <TurnSpanPayload
            stateKey={`${span.id}:output`}
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

export function TurnDetailTimeline({
  sessionKey,
  turnId,
  detail,
  showTools,
  roleFilter,
  query,
  language,
  matchedMessageIndex,
  activeFindMatchKey,
  attachmentAccess,
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
  attachmentAccess: "session" | "download";
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
                attachmentAccess={attachmentAccess}
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
