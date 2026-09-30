import { useEffect, useRef, useState } from "react";
import { Download, MessagesSquare, RefreshCw } from "lucide-react";
import type { TeamSessionSnapshot, TeamSessionPage, TeamSharedSession } from "../../../../shared/team-sessions";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamSessionReader } from "./team-session-reader";

export function TeamSessionsPanel({ selection, language, api = window.sessionSearch.teamWorkspace }: { selection: TeamSelection; language: LanguageMode; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository };
  const [list, setList] = useState<TeamSessionPage | null>(null);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [selectionDetail, setSelectionDetail] = useState<{ item: TeamSharedSession; content: TeamSessionSnapshot } | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const alive = useRef(false), running = useRef(false), generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; void api.request({ action: "cancel-sync" }).catch(() => undefined); }; }, [api]);
  useEffect(() => {
    let active = true;
    generation.current++;
    setList(null); setSelectionDetail(null); setError("");
    if (enabled && team) {
      setLoading(true);
      void api.request({ action: "session-list", scope, page }).then((reply) => {
        if (!active) return;
        if (!reply.ok) setError(reply.error.message);
        else if (reply.data.kind === "session-list") setList(reply.data.value);
      }).catch(() => { if (active) setError(l("Could not load shared sessions.", "共享会话读取失败，请刷新重试。")); }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, page, refresh]);
  async function run(request: TeamRequest, item: TeamSharedSession) {
    if (running.current) return;
    const current = generation.current;
    running.current = true; setBusy(true); setError(""); setFeedback("");
    if (request.action === "session-open") setSelectionDetail(null);
    try {
      const reply = await api.request(request);
      if (!alive.current || current !== generation.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "session-open") {
        const content = reply.data.value;
        setSelectionDetail({ item, content });
      }
      else if (reply.data.kind === "complete") { setFeedback(reply.data.message); if (request.action === "session-withdraw") setRefresh((value) => value + 1); }
    } catch { if (alive.current && current === generation.current) setError(l("Request failed. Try again.", "请求未完成，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const locked = busy || loading || selection.busy || !enabled || !team;
  return <section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Shared sessions", "共享会话")}</h2><p>{l("Share from a local session’s right-click menu. Nothing is uploaded automatically.", "在本地会话的右键菜单中分享，不会自动上传。")}</p></div><button className="team-icon-button" aria-label={l("Refresh sessions", "刷新会话")} title={l("Refresh sessions", "刷新会话")} disabled={locked} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} /></button></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}{feedback && <p role="status" className="team-workspace-notice">{feedback}</p>}
    {!enabled || !team ? <p className="team-workspace-notice">{l("Enable teams in Settings to access shared sessions.", "在设置中启用团队后，可查看共享会话。")}</p> : loading ? <p role="status">{l("Loading…", "正在读取…")}</p> : list && !selectionDetail && <>
      <div className="team-resource-list">{list.items.length ? list.items.map((item) => <button className="team-resource-row" key={item.id} disabled={locked} onClick={() => void run({ action: "session-open", scope, id: item.id, digest: item.digest }, item)}><MessagesSquare size={19} /><span><strong>{item.title}</strong><small>{item.author} · {new Date(item.createdAt).toLocaleDateString()} · {item.storage === "blocks" ? l("Compressed blocks", "分块压缩") : `${(item.bytes / 1024 / 1024).toFixed(2)} MiB`}</small></span><span>{l("Read", "阅读")}</span></button>) : <div className="team-empty"><MessagesSquare size={28} /><strong>{l("No shared sessions yet", "还没有共享会话")}</strong><p>{l("Right-click a local session and choose Upload to team.", "在本地 Session 上右键，选择「上传到团队」。")}</p></div>}</div>
      {(page > 1 || list.hasMore) && <div className="team-space-actions"><button disabled={locked || page === 1} onClick={() => setPage((value) => value - 1)}>{l("Previous", "上一页")}</button><small>{page}</small><button disabled={locked || !list.hasMore || page >= 100} onClick={() => setPage((value) => value + 1)}>{l("Next", "下一页")}</button></div>}
    </>}
    {busy && <p role="status">{l("Loading session… The first open downloads and indexes it locally.", "正在读取会话…首次打开需要下载并建立本地索引。")}</p>}
    {selectionDetail && <section className="team-workspace-inspection"><header><div><button className="team-subtle-action" onClick={() => setSelectionDetail(null)}>{l("Back to sessions", "返回会话列表")}</button><h3>{selectionDetail.item.title}</h3></div><div className="team-space-actions"><button disabled={locked} onClick={() => void run({ action: "session-download", scope, id: selectionDetail.item.id }, selectionDetail.item)}><Download size={14} />{l("Download shared package", "下载分享包")}</button>{selectionDetail.item.canWithdraw && <button disabled={locked} onClick={() => void run({ action: "session-withdraw", scope, id: selectionDetail.item.id }, selectionDetail.item)}>{l("Withdraw share", "撤回分享")}</button>}</div></header><TeamSessionReader key={selectionDetail.item.id} snapshot={selectionDetail.content} item={selectionDetail.item} scope={scope} api={api} language={language} /></section>}
  </section>;
}
