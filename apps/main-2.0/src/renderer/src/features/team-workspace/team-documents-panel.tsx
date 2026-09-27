import { TeamLocalAssetsPanel } from "./team-local-assets-panel";
import { useEffect, useRef, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

type Preview = Extract<TeamPayload, { kind: "document-preview" }>["value"];
export function TeamDocumentsPanel({ selection, language, api = window.sessionSearch.teamWorkspace }: { selection: TeamSelection; language: LanguageMode; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { connection, team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository, ...(connection ? { connectionId: connection.id, directory: connection.path } : {}) };
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [transport, setTransport] = useState<"https" | "ssh">("https");
  const alive = useRef(false), running = useRef(false), syncing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (syncing.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); }; }, [api]);
  useEffect(() => {
    let active = true;
    setCatalog(null); setPreview(null);
    if (enabled && team) void api.request({ action: "catalog", scope }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load documents.", "文档读取失败，请刷新重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, connection?.id, connection?.path, enabled, refresh]);
  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true; syncing.current = request.action === "sync"; setBusy(true); setError(""); setFeedback("");
    if (request.action !== "document-install") setPreview(null);
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "document-preview") setPreview(reply.data.value);
      else if (reply.data.kind === "complete") { setFeedback(reply.data.message); setRefresh((value) => value + 1); }
    } catch { if (alive.current) setError(l("Request failed. Try again.", "请求未完成，请重试。")); }
    finally { running.current = false; syncing.current = false; if (alive.current) setBusy(false); }
  }
  const locked = busy || selection.busy || !enabled || !team;
  return <section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Documents", "文档")}</h2><p>{l("Team instructions and project guides. Preview before applying.", "团队规范和项目说明，预览后应用到本地。")}</p></div><div className="team-space-actions"><details className="team-sync-options"><summary>{l("Connection", "连接方式")}</summary><label><select aria-label={l("Sync connection", "同步连接方式")} disabled={locked} value={transport} onChange={(event) => setTransport(event.currentTarget.value as "https" | "ssh")}><option value="https">HTTPS</option><option value="ssh">SSH</option></select></label></details><button disabled={locked} onClick={() => void run({ action: "sync", scope, transport })}><RefreshCw size={14} />{busy ? l("Working…", "处理中…") : l("Sync", "同步")}</button></div></header>
    {error && <p className="team-workspace-error" role="alert">{error}</p>}
    {feedback && <p className="team-workspace-notice" role="status">{feedback}</p>}
    <TeamLocalAssetsPanel selection={selection} kind="documents" language={language} api={api} />
    <h3>{l("Team documents", "团队文档")}</h3>
    {!enabled || !team ? <p className="team-workspace-notice">{l("Enable teams and select a team project in Settings.", "请在设置中启用团队，并选择团队下的项目。")}</p> : !catalog ? <p role="status">{l("Loading documents…", "正在读取文档…")}</p> : <>
      {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
      <div className="team-resource-list">{catalog.assets?.documents.length ? catalog.assets.documents.map((document) => <button className="team-resource-row" key={document.id} disabled={locked} onClick={() => void run({ action: "document-preview", scope, id: document.id })}><FileText size={19} /><span><strong>{document.name}</strong><small>{document.target}</small></span><span>{l("Preview", "预览")}</span></button>) : <p className="team-empty">{l("No team documents yet. Sync again after documents are published to the team repository.", "团队仓库还没有共享文档。发布后点击同步，即可在这里查看。")}</p>}</div>
      {preview && <section className="team-workspace-inspection"><header><div><h3>{preview.name}</h3><small>{preview.target} · {preview.commit.slice(0, 8)}</small></div><button disabled={locked || (preview.status === "conflict" || preview.status === "unselected")} onClick={() => void run({ action: "document-install", scope, id: preview.id, revision: preview.commit })}>{preview.status === "existing" ? l("Already applied", "已是相同内容") : l("Apply locally", "应用到本地")}</button></header>
        {preview.status === "conflict" && <p role="status">{l("The local file has different content. Merge it in your editor; the existing file will be kept.", "本地文件内容不同，请在编辑器中手动合并，已有文件会保留。")}</p>}
        <div className="team-document-comparison"><section><h3>{l("Team version", "团队版本")}</h3><pre>{preview.content}</pre></section><section><h3>{l("Local version", "本地版本")}</h3><pre>{preview.local ?? (preview.status === "unselected" ? l("Choose a local folder to compare", "选择本地目录后对照") : l("File does not exist yet", "尚未创建此文件"))}</pre></section></div>
      </section>}
    </>}
  </section>;
}
