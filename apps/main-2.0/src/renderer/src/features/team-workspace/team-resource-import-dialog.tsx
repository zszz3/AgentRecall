import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DirectoryConnection } from "@agentrecall/workspace-core";
import type { TeamPushDraft } from "../../../../shared/team-push";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

/** Copy selected source files into the team's local working view. Never publishes. */
export function TeamResourceImportDialog({ selection, directories, language, api, onClose, onSaved }: {
  selection: TeamSelection; directories: DirectoryConnection[]; language: LanguageMode; api: TeamWorkspaceApi; onClose(): void; onSaved(): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const choices = directories.filter(item => item.enabled);
  const [directoryId, setDirectoryId] = useState(choices[0]?.id ?? "");
  const [resources, setResources] = useState<TeamPushDraft[]>([]), [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false);
  const directory = choices.find(item => item.id === directoryId);
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  useEffect(() => {
    alive.current = true;
    const element = dialog.current, previous = document.activeElement; element?.showModal();
    return () => { alive.current = false; element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let active = true;
    setResources([]); setSelected(new Set()); setError(""); setNotice("");
    if (!directory) return;
    setLoading(true);
    void (async () => {
      const catalog = await api.request({ action: "catalog", scope });
      if (!catalog.ok) throw new Error(catalog.error.message);
      if (catalog.data.kind !== "catalog" || !catalog.data.value.assets) throw new Error(l("Pull once to initialize team resources.", "请先 Pull 一次以初始化团队资源。"));
      const baseline = catalog.data.value.assets;
      const found: TeamPushDraft[] = [];
      for (const kind of ["skills", "documents"] as const) {
        const reply = await api.request({ action: "local-assets", scope: { ...scope, connectionId: directory.id, directory: directory.path }, kind });
        if (!reply.ok) throw new Error(reply.error.message);
        if (reply.data.kind !== "local-assets") throw new Error(l("Invalid resource list.", "资源列表无效。"));
        if (active && (reply.data.value.limited || reply.data.value.skipped)) setNotice(l("Some paths were skipped or reached the scan limit.", "部分路径已跳过或达到扫描上限。"));
        for (const entry of reply.data.value.entries) {
          const existing = kind === "documents" ? baseline.documents.find(item => item.target.normalize("NFC").toLowerCase() === entry.path.normalize("NFC").toLowerCase()) : undefined;
          let hash = 2166136261; for (const char of entry.path) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
          const id = kind === "skills" ? entry.name : existing?.id ?? `doc-${entry.path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "")}-${hash.toString(16)}`;
          found.push({ item: { kind: "resource", resource: kind, key: `${directory.id}:${kind}:${entry.path}`, connectionId: directory.id, directory: directory.path, file: entry.path, id, name: existing?.name ?? entry.name,
            ...(kind === "documents" ? { destination: existing?.target ?? (entry.path.startsWith("docs/") ? entry.path.replace(/\.md$/i, ".md") : `docs/team/${id}.md`) } : {}) }, title: existing?.name ?? entry.name, subtitle: `${kind === "skills" ? "Skill" : l("Document", "文档")} · ${entry.path}` });
        }
      }
      if (active) setResources(found);
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : l("Could not read resources.", "资源读取失败。")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, directory?.id, directory?.path]);
  async function save() {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      const reply = await api.request({ action: "workspace-stage", scope, items: resources.filter(entry => selected.has(entry.item.key)).map(entry => entry.item) });
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message); else onSaved();
    } catch { if (alive.current) setError(l("Could not save resources. Retry.", "保存失败，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Add local resources", "添加本地资源")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Add resources", "添加资源")}</h2><p>{l("Save a copy in this local team workspace, then review changes with Push.", "复制到本地共享空间，之后可从 Push 查看差异并上传。")}</p></div><button className="team-icon-button" disabled={busy} aria-label={l("Close", "关闭")} onClick={onClose}><X size={18} /></button></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!choices.length ? <p>{l("Connect a working directory in team settings first.", "请先在工作目录页接入一个本地目录。")}</p> : <label>{l("Source directory", "来源目录")}<select disabled={busy} value={directoryId} onChange={event => setDirectoryId(event.currentTarget.value)}>{choices.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></label>}
    {loading && <p role="status">{l("Reading resources…", "正在读取资源…")}</p>}
    <div className="team-resource-list">{resources.map(entry => <label className="team-resource-row" key={entry.item.key}><input type="checkbox" checked={selected.has(entry.item.key)} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(entry.item.key); else next.delete(entry.item.key); return next; }); }} /><span><strong>{entry.title}</strong><small>{entry.subtitle}</small></span></label>)}</div>
    {selected.size > 64 && <p role="alert">{l("Select up to 64 resources at a time.", "一次最多添加 64 项资源。")}</p>}
    <footer className="team-push-footer"><span>{l(`${selected.size} selected`, `已选 ${selected.size} 项`)}</span><button className="is-primary" disabled={busy || loading || !selected.size || selected.size > 64} onClick={() => void save()}>{busy ? l("Saving…", "正在保存…") : l("Add to workspace", "加入共享空间")}</button></footer>
  </section></dialog>;
}
