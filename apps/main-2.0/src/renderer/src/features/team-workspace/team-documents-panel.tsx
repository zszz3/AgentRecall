import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

type Preview = Extract<TeamPayload, { kind: "document-preview" }>["value"];
type Reader = { id: string; name: string; path: string; loading: boolean; error: string; preview?: Preview };
export function TeamDocumentsPanel({ selection, language, refreshKey = 0, api = window.sessionSearch.teamWorkspace }: { selection: TeamSelection; language: LanguageMode; refreshKey?: number; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const scope = { teamId: team.id, repository: team.repository };
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [reader, setReader] = useState<Reader | null>(null), [error, setError] = useState("");
  const readVersion = useRef(0), returnFocus = useRef<HTMLButtonElement | null>(null), readerPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true; readVersion.current++; setCatalog(null); setReader(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope }).then((reply) => { if (!active) return; if (!reply.ok) setError(reply.error.message); else if (reply.data.kind === "catalog") setCatalog(reply.data.value); }).catch(() => { if (active) setError(l("Could not load documents.", "文档读取失败，请刷新重试。")); });
    return () => { active = false; readVersion.current++; };
  }, [api, team.id, team.repository, enabled, refreshKey]);
  useEffect(() => { if (reader?.id) readerPanel.current?.focus({ preventScroll: true }); else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }, [reader?.id]);
  function closeReader() { readVersion.current++; setReader(null); }
  async function openDocument(item: { id: string; name: string; path: string }, trigger?: HTMLButtonElement) {
    if (trigger) returnFocus.current = trigger;
    const version = ++readVersion.current; setReader({ ...item, loading: true, error: "" });
    try {
      const reply = await api.request({ action: "document-preview", scope, id: item.id });
      if (version !== readVersion.current) return;
      if (!reply.ok) setReader({ ...item, loading: false, error: reply.error.message });
      else if (reply.data.kind === "document-preview") setReader({ ...item, loading: false, error: "", preview: reply.data.value });
      else setReader({ ...item, loading: false, error: l("Could not open the document.", "无法打开文档，请重试。") });
    } catch { if (version === readVersion.current) setReader({ ...item, loading: false, error: l("Could not open the document.", "无法打开文档，请重试。") }); }
  }
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && reader) { event.stopPropagation(); closeReader(); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Document list", "文档列表")}><header className="team-workspace-head"><div><h2>{l("Documents", "文档")} <span className="team-count">{catalog?.assets?.documents.length ?? 0}</span></h2><p>{l("Shared instructions and guides, updated together when your team syncs.", "团队共用的规范与说明，随团队同步统一更新。")}</p></div></header>
      {error && <p className="team-workspace-error" role="alert">{error}</p>}
      {!enabled ? <p>{l("Enable teams in Settings to view shared documents.", "在设置中启用团队后，可查看共享文档。")}</p> : !catalog && !error ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog?.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        <div className="team-resource-list">{catalog?.assets?.documents.map((document) => <button className="team-resource-row" key={document.id} aria-pressed={reader?.id === document.id} disabled={selection.busy} onClick={(event) => void openDocument({ id: document.id, name: document.name, path: document.target }, event.currentTarget)}><FileText size={18} /><span><strong>{document.name}</strong><small>{document.target}</small></span><span>{l("View", "查看")}</span></button>)}</div>
        {catalog?.assets && !catalog.assets.documents.length && <div className="team-empty"><FileText size={26} /><strong>{l("No shared documents yet", "团队还没有共享文档")}</strong><p>{l("Published documents will appear here after syncing.", "团队发布文档后，点击上方「Pull 拉取」即可获取。")}</p></div>}
      </>}
    </section>
    {reader && <aside key={reader.id} ref={readerPanel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Document details", "文档详情")}><header className="team-document-reader-head"><div><small>{l("Team document", "团队文档")}</small><h3>{reader.name}</h3><small>{reader.path}{reader.preview ? ` · ${reader.preview.commit.slice(0, 8)}` : ""}</small></div><button className="team-icon-button" aria-label={l("Close document", "关闭文档")} title={l("Close · Esc", "关闭 · Esc")} onClick={closeReader}><X size={17} /></button></header><div className="team-document-reader-body">{reader.loading && <p role="status">{l("Opening…", "正在打开文档…")}</p>}{reader.error && <div className="team-workspace-error" role="alert"><p>{reader.error}</p><button onClick={() => void openDocument(reader)}>{l("Retry", "重试")}</button></div>}{reader.preview && <pre>{reader.preview.content}</pre>}</div></aside>}
  </div>;
}
