import { useState } from "react";
import type { TeamSessionContent, TeamSessionDetail } from "../../../../shared/team-sessions";
import type { LanguageMode } from "../../language";

export function TeamSessionContentView({ content, language }: { content: TeamSessionContent; language: LanguageMode }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  return <div className="team-session-content">
    <p>{(content.bytes / 1024 / 1024).toFixed(2)} MiB · {content.children.length} {l("child sessions", "个子会话")} · {content.files.length} {l("files", "个文件")}</p>
    {content.missingAttachments.length > 0 && <details className="team-workspace-notice"><summary>{l("Unavailable attachments", "无法读取的附件")} · {content.missingAttachments.length}</summary><ul>{content.missingAttachments.map((name, index) => <li key={index}>{name}</li>)}</ul></details>}
    {[content.root, ...content.children].map((detail, index) => <SessionRecord key={detail.session.sessionKey} detail={detail} language={language} initiallyOpen={index === 0} />)}
    <details><summary>{l("Included source files and attachments", "包含的源文件与附件")}</summary><ul>{content.files.map((file, index) => <li key={index}>{file.name} · {(file.bytes / 1024).toFixed(1)} KiB · {file.kind}</li>)}</ul></details>
  </div>;
}
function SessionRecord({ detail, language, initiallyOpen }: { detail: TeamSessionDetail; language: LanguageMode; initiallyOpen: boolean }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [open, setOpen] = useState(initiallyOpen), [page, setPage] = useState(0), [toolsOpen, setToolsOpen] = useState(false), [toolPage, setToolPage] = useState(0);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="team-session-record"><summary>{detail.session.displayTitle || detail.session.originalTitle || l("Untitled session", "未命名会话")} · {detail.messages.length} {l("messages", "条消息")}</summary>
    {open && <>
      <div className="team-session-messages">{detail.messages.slice(page * 50, (page + 1) * 50).map((message, index) => <div key={`${page}:${index}`} className="team-session-message"><strong>{message.role}</strong><LongText text={message.content} language={language} />{message.attachments?.map((attachment) => <small key={attachment.id}>{attachment.fileName}</small>)}</div>)}</div>
      {detail.messages.length > 50 && <div className="team-space-actions"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{l("Previous messages", "上一页消息")}</button><small>{page + 1} / {Math.ceil(detail.messages.length / 50)}</small><button disabled={(page + 1) * 50 >= detail.messages.length} onClick={() => setPage((value) => value + 1)}>{l("Next messages", "下一页消息")}</button></div>}
      <details onToggle={(event) => setToolsOpen(event.currentTarget.open)}><summary>{l("Tool events and metadata", "工具事件与元数据")} · {detail.traceEvents.length}</summary>{toolsOpen && <><LongText key={toolPage} text={JSON.stringify({ session: detail.session, traceEvents: detail.traceEvents.slice(toolPage * 20, (toolPage + 1) * 20) }, null, 2)} language={language} />{detail.traceEvents.length > 20 && <div className="team-space-actions"><button disabled={toolPage === 0} onClick={() => setToolPage((value) => value - 1)}>{l("Previous events", "上一页事件")}</button><small>{toolPage + 1} / {Math.ceil(detail.traceEvents.length / 20)}</small><button disabled={(toolPage + 1) * 20 >= detail.traceEvents.length} onClick={() => setToolPage((value) => value + 1)}>{l("Next events", "下一页事件")}</button></div>}</>}</details>
    </>}
  </details>;
}
function LongText({ text, language }: { text: string; language: LanguageMode }) {
  const [visible, setVisible] = useState(20_000);
  return <><pre>{text.slice(0, visible)}</pre>{visible < text.length && <button onClick={() => setVisible((value) => value + 20_000)}>{language === "zh" ? "继续展开内容" : "Show more content"}</button>}</>;
}
