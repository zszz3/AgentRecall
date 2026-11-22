import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronUp, Paperclip, X } from "lucide-react";
import { formatMessageTime } from "../../../../core/format-session";
import { traceCompactionSummary, traceDetailText, traceDurationLabel } from "../../../../core/trace-presentation";
import type { SessionMessage, SessionTraceEvent } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import { HighlightedSearchText, searchHighlightTerms } from "../../search-highlight";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import { MessageHead } from "./message-shell";
import { collaborationMessageMetadata } from "./collaboration-message";

const MESSAGE_TRUNCATE_LIMIT = 3000;

export function MessageBlock({
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

  const useMarkdown = !highlight;

  return (
    <div className={`msg ${message.role} ${message.phase === "commentary" ? "commentary" : ""} ${highlight ? "match-context" : ""} ${target ? "match-target" : ""}`} data-message-index={message.index} data-timeline-key={timelineKey}>
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
        <pre className="msg-body msg-body-plain"><HighlightedSearchText text={content} terms={highlightTerms} /></pre>
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
                }).catch(() => undefined);
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
  if (event.kind === "tool_call") return "→";
  if (event.status === "completed") return "✓";
  if (event.status === "failed") return "✗";
  if (event.status === "aborted") return "■";
  return "•";
}

function traceStatusLabel(event: SessionTraceEvent, language: LanguageMode): string {
  if (event.status === "running") return localize(language, "Running", "进行中");
  if (event.status === "completed") return localize(language, "Completed", "已完成");
  if (event.status === "failed") return localize(language, "Failed", "失败");
  if (event.status === "aborted") return localize(language, "Interrupted", "已中断");
  return localize(language, "Status unknown", "状态未知");
}

const TRACE_TRUNCATE_LIMIT = 2400;

export function TraceEventBlock({ event, language, timelineKey }: { event: SessionTraceEvent; language: LanguageMode; timelineKey: string }): ReactElement {
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
    <details className={`trace-event ${event.kind} ${event.status || "unknown"}`} data-timeline-key={timelineKey}>
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
    </details>
  );
}
