import { useEffect, useRef, useState } from "react";
import { FileText, RefreshCw, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamLocalAssetsPanel } from "./team-local-assets-panel";

type Preview = Extract<TeamPayload, { kind: "document-preview" }>["value"];
type DocumentItem = { source: "local" | "team"; id: string; name: string; path: string };
type Reader = { item: DocumentItem; loading: boolean; error: string; local?: string; shared?: Preview };
export function TeamDocumentsPanel({ selection, language, api = window.sessionSearch.teamWorkspace }: { selection: TeamSelection; language: LanguageMode; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { connection, team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository, ...(connection ? { connectionId: connection.id, directory: connection.path } : {}) };
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [reader, setReader] = useState<Reader | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [refresh, setRefresh] = useState(0), [transport, setTransport] = useState<"https" | "ssh">("https");
  const alive = useRef(false), running = useRef(false), syncing = useRef(false), readVersion = useRef(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null), readerPanel = useRef<HTMLElement | null>(null);
  const readerKey = reader ? `${reader.item.source}:${reader.item.id}` : null;
  useEffect(() => { alive.current = true; return () => { alive.current = false; readVersion.current++; if (syncing.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); }; }, [api]);
  useEffect(() => { readVersion.current++; setReader(null); }, [team.id, team.repository, connection?.id, connection?.path, enabled]);
  useEffect(() => {
    if (readerKey) readerPanel.current?.focus({ preventScroll: true });
    else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  }, [readerKey]);
  useEffect(() => {
    let active = true; setCatalog(null);
    if (enabled) void api.request({ action: "catalog", scope }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load documents.", "文档读取失败，请刷新重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, connection?.id, connection?.path, enabled, refresh]);

  function closeReader() {
    readVersion.current++; setReader(null);
  }
  async function openDocument(item: DocumentItem, trigger: HTMLButtonElement) {
    if (running.current) return;
    returnFocus.current = trigger; setError(""); setFeedback("");
    const version = ++readVersion.current;
    setReader({ item, loading: true, error: "" });
    try {
      const reply = await api.request(item.source === "local"
        ? { action: "local-assets", scope, kind: "documents", file: item.path }
        : { action: "document-preview", scope, id: item.id });
      if (!alive.current || version !== readVersion.current) return;
      if (!reply.ok) setReader({ item, loading: false, error: reply.error.message });
      else if (reply.data.kind === "local-preview") setReader({ item, loading: false, error: "", local: reply.data.value.content });
      else if (reply.data.kind === "document-preview") setReader({ item, loading: false, error: "", shared: reply.data.value });
      else setReader({ item, loading: false, error: l("Could not read this document. Try again.", "未能读取文档，请重试。") });
    } catch { if (alive.current && version === readVersion.current) setReader({ item, loading: false, error: l("Could not read this document. Try again.", "未能读取文档，请重试。") }); }
  }
  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true; syncing.current = request.action === "sync"; setBusy(true); setError(""); setFeedback("");
    if (request.action === "sync") { readVersion.current++; setReader(null); }
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "complete") {
        setFeedback(reply.data.message); setRefresh((value) => value + 1);
        if (request.action === "document-install") setReader((current) => current?.shared?.id === request.id
          ? { ...current, shared: { ...current.shared, local: current.shared.content, status: "existing" } } : current);
      }
    } catch { if (alive.current) setError(l("Request failed. Try again.", "请求未完成，请重试。")); }
    finally { running.current = false; syncing.current = false; if (alive.current) setBusy(false); }
  }
  const locked = busy || selection.busy || !enabled;
  const preview = reader?.shared;
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && reader) { event.stopPropagation(); closeReader(); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Document list", "文档列表")}>
      <header className="team-workspace-head"><div><h2>{l("Documents", "文档")}</h2><p>{l("Team instructions and project guides. Preview before applying.", "团队规范和项目说明，预览后应用到本地。")}</p></div><div className="team-space-actions"><details className="team-sync-options"><summary>{l("Connection", "连接方式")}</summary><label><select aria-label={l("Sync connection", "同步连接方式")} disabled={locked} value={transport} onChange={(event) => setTransport(event.currentTarget.value as "https" | "ssh")}><option value="https">HTTPS</option><option value="ssh">SSH</option></select></label></details><button disabled={locked} onClick={() => void run({ action: "sync", scope, transport })}><RefreshCw size={14} />{busy ? l("Working…", "处理中…") : l("Sync", "同步")}</button></div></header>
      {!reader && error && <p className="team-workspace-error" role="alert">{error}</p>}
      {!reader && feedback && <p className="team-workspace-notice" role="status">{feedback}</p>}
      <TeamLocalAssetsPanel selection={selection} kind="documents" language={language} api={api} disabled={busy || selection.busy} selectedPath={reader?.item.source === "local" ? reader.item.path : undefined} onOpen={(file, trigger) => void openDocument({ source: "local", id: file.path, name: file.name, path: file.path }, trigger)} />
      <h3>{l("Team documents", "团队文档")}</h3>
      {!enabled ? <p className="team-workspace-notice">{l("Enable team features in Settings to view team documents.", "在设置中启用团队后，可查看团队文档。")}</p> : !catalog ? <p role="status">{l("Loading documents…", "正在读取文档…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        <div className="team-resource-list">{catalog.assets?.documents.length ? catalog.assets.documents.map((document) => <button className="team-resource-row" key={document.id} aria-pressed={reader?.item.source === "team" && reader.item.id === document.id} disabled={locked} onClick={(event) => void openDocument({ source: "team", id: document.id, name: document.name, path: document.target }, event.currentTarget)}><FileText size={19} /><span><strong>{document.name}</strong><small>{document.target}</small></span><span>{l("View", "查看")}</span></button>) : <p className="team-empty">{l("No team documents yet. Sync again after documents are published to the team repository.", "团队仓库还没有共享文档。发布后点击同步，即可在这里查看。")}</p>}</div>
      </>}
    </section>
    {reader && <aside key={readerKey} ref={readerPanel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Document details", "文档详情")}>
      <header className="team-document-reader-head"><div><small>{reader.item.source === "local" ? l("Local document", "本地文档") : l("Team document", "团队文档")}</small><h3>{reader.item.name}</h3><small>{reader.item.path}{preview ? ` · ${preview.commit.slice(0, 8)}` : ""}</small></div><button className="team-icon-button" aria-label={l("Close document", "关闭文档")} title={l("Close · Esc", "关闭 · Esc")} onClick={closeReader}><X size={17} /></button></header>
      <div className="team-document-reader-body">
        {error && <p className="team-workspace-error" role="alert">{error}</p>}
        {feedback && <p className="team-workspace-notice" role="status">{feedback}</p>}
        {reader.loading && <p role="status">{l("Opening document…", "正在打开文档…")}</p>}
        {reader.error && <div className="team-workspace-error" role="alert"><p>{reader.error}</p><button disabled={busy} onClick={() => { if (returnFocus.current) void openDocument(reader.item, returnFocus.current); }}>{l("Retry", "重试")}</button></div>}
        {reader.local !== undefined && <pre>{reader.local}</pre>}
        {preview && <>
          {preview.status === "conflict" && <p role="status" className="team-workspace-notice">{l("The local file has different content. Merge it in your editor; the existing file will be kept.", "本地文件内容不同，请在编辑器中手动合并，已有文件会保留。")}</p>}
          <section><h4>{l("Team version", "团队版本")}</h4><pre>{preview.content}</pre></section>
          {preview.local !== null && <section><h4>{l("Local version", "本地版本")}</h4><pre>{preview.local}</pre></section>}
          {preview.status === "unselected" && <p>{l("Select a working directory above to compare or apply this document.", "在上方选择工作目录后，可对照本地内容并应用。")}</p>}
        </>}
      </div>
      {preview && <footer className="team-document-reader-footer"><button className="is-primary" disabled={locked || preview.status === "conflict" || preview.status === "unselected" || preview.status === "existing"} onClick={() => void run({ action: "document-install", scope, id: preview.id, revision: preview.commit })}>{preview.status === "existing" ? l("Already applied", "已是相同内容") : l("Apply locally", "应用到本地")}</button></footer>}
    </aside>}
  </div>;
}
