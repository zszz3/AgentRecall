import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamSessionSnapshot, TeamSessionTurnsPage, TeamSharedSession } from "../../../../shared/team-sessions";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamScope } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import { teamSessionReadCache } from "./team-session-read-cache";
import { SOURCE_LABEL } from "../../session-ui";
import { isSessionSource } from "../../../../core/session-sources";
import { TurnAccordion } from "../session-detail/turn-accordion";

export function TeamSessionReader({ snapshot, initialPage, item, scope, api, language, query = "" }: {
  query?: string; initialPage?: TeamSessionTurnsPage | null; snapshot: TeamSessionSnapshot; item: TeamSharedSession; scope: TeamScope & { repository: string };
  api: TeamWorkspaceApi; language: LanguageMode;
}) {
  const top = useRef<HTMLDivElement>(null);
  const [record, setRecord] = useState(item.match?.record ?? 0), [offset, setOffset] = useState(item.match?.offset ?? 0);
  useEffect(() => { top.current?.scrollIntoView({ block: "start" }); }, [record, offset]);
  const [page, setPage] = useState<TeamSessionTurnsPage | null>(initialPage ?? null);
  const [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    let active = true;
    const cache = teamSessionReadCache(api);
    const request = { action: "session-turns" as const, scope, id: item.id, digest: item.digest, record, offset };
    const cached = cache.peek(request);
    setError("");
    if (cached?.ok && cached.data.kind === "session-turns") { setPage(cached.data.value); return; }
    setPage(null);
    void cache.read(request).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "session-turns") setPage(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load turns.", "轮次读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, scopeKey, item.id, item.digest, record, offset, retry]);
  const loadTurn = useCallback(async (turnId: string) => {
    const reply = await api.request({ action: "session-turn", scope, id: item.id, digest: item.digest, record, turnId });
    if (!reply.ok) throw new Error(reply.error.message);
    if (reply.data.kind !== "session-turn") throw new Error("Unexpected session reply");
    return reply.data.value;
  }, [api, scopeKey, item.id, item.digest, record]);
  const key = `${scope.repository}:${item.id}:${item.digest}:${record}:${offset}`;
  return <div ref={top} className="team-session-content">
    <p className="team-session-status">{snapshot.partial ? l("Shared excerpt · read-only local copy", "分享片段 · 本地只读副本") : l("Shared session · read-only local copy", "共享会话 · 本地只读副本")}</p>
    {snapshot.records.length > 1 && <label>{l("Session", "会话")} <select value={record} onChange={event => { setRecord(Number(event.target.value)); setOffset(0); }}>
      {snapshot.records.map((entry, index) => <option key={index} value={index}>{entry.source ? (isSessionSource(entry.source) ? SOURCE_LABEL[entry.source] : entry.source) + " · " : ""}{entry.title} · {entry.turnCount}</option>)}
    </select></label>}
    {error ? <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></p> : <TurnAccordion key={key} sessionKey={key} turns={page?.turns ?? []}
      loading={!page} matchedTurnId={item.match?.record === record ? item.match.turnId : null} matchedMessageIndex={null} showTools query={query} language={language}
      onLoadTurn={loadTurn} turnNumbering="source" attachmentAccess="download" />}
    <div className="team-space-actions"><button disabled={!page || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>{l("Previous turns", "上一页轮次")}</button>
      <small>{Math.floor(offset / 50) + 1} / {Math.max(1, Math.ceil((snapshot.records[record]?.turnCount ?? 0) / 50))}</small>
      <button disabled={!page?.hasMore} onClick={() => setOffset(value => value + 50)}>{l("Next turns", "下一页轮次")}</button></div>
    {snapshot.missingAttachments.length > 0 && <p>{l("Unavailable attachments", "无法读取的附件")} · {snapshot.missingAttachments.length}</p>}
    <details><summary>{l("Included files", "包含的文件")} · {snapshot.files.length}</summary><ul>{snapshot.files.map((file, index) => <li key={index}>{file.name} · {(file.bytes / 1024).toFixed(1)} KiB</li>)}</ul></details>
  </div>;
}
