import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder, FolderPlus } from "lucide-react";
import { resourceFoldersSchema, type ResourceFolders, type ResourceKind } from "../../../../../../../packages/workspace-core/src/resource-folders";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamSelection } from "./team-workspace-page";
import type { LanguageMode } from "../../language";

export function TeamResourceFolders({ kind, organization, items, selection, api, language, children, onChanged }: {
  kind: ResourceKind; organization: ResourceFolders[]; items: Array<{ id: string; name: string }>;
  selection: TeamSelection; api: TeamWorkspaceApi; language: LanguageMode; children(id: string): ReactNode; onChanged?(): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const initial = () => organization.find(item => item.id === kind) ?? { id: kind, name: l(`${kind} folders`, `${kind} 文件夹`), folders: [], assignments: [] };
  const [value, setValue] = useState<ResourceFolders>(initial), [folder, setFolder] = useState("*"), [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<"create" | "rename" | "delete" | "move" | null>(null), [name, setName] = useState(""), [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setValue(initial()); setSelected([]); setFolder("*"); setEditing(null); setError(""); }, [organization, kind, selection.team.id]);
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  const assigned = new Map(value.assignments.map(item => [item.resourceId, item.folder]));
  const visible = items.filter(item => folder === "*" || (assigned.get(item.id) ?? "") === folder);
  async function save(next: ResourceFolders) {
    if (running.current) return;
    const parsed = resourceFoldersSchema.safeParse(next);
    if (!parsed.success) { setError(l("Use unique folder names, with / for subfolders. Parent folders must exist.", "文件夹名称不能重复；用 / 表示子目录，父目录必须已存在。")); return; }
    running.current = true; setBusy(true); setError("");
    try {
      const reply = await api.request({ action: "workspace-stage", scope, items: [{ kind: "configuration", key: `organization:${kind}`, change: { kind: "organization", operation: "update", value: parsed.data } }] });
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); return; }
      if (reply.data.kind !== "workspace-changes") throw new Error("Unexpected response");
      onChanged?.(); setValue(parsed.data); setSelected([]); setEditing(null);
      if (folder !== "*" && folder && !next.folders.includes(folder)) setFolder("");
    } catch { if (alive.current) setError(l("Could not save folders. Retry.", "分类保存失败，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  function submit() {
    if (editing === "move") { void save({ ...value, assignments: [...value.assignments.filter(item => !selected.includes(item.resourceId)), ...selected.flatMap(resourceId => destination ? [{ resourceId, folder: destination }] : [])] }); return; }
    if (editing === "delete") { void save({ ...value, folders: value.folders.filter(path => path !== folder && !path.startsWith(folder + "/")), assignments: value.assignments.filter(item => item.folder !== folder && !item.folder.startsWith(folder + "/")) }); return; }
    const next = name.trim();
    if (editing === "create") { void save({ ...value, folders: [...value.folders, next] }); return; }
    if (next === folder) { setEditing(null); return; }
    const rename = (path: string) => path === folder || path.startsWith(folder + "/") ? next + path.slice(folder.length) : path;
    void save({ ...value, folders: value.folders.map(rename), assignments: value.assignments.map(item => ({ ...item, folder: rename(item.folder) })) });
  }
  return <div className="team-folder-browser">
    <div className="team-folder-toolbar"><Folder size={16}/><select aria-label={l("Resource folder", "资源文件夹")} value={folder} disabled={busy} onChange={event => { setFolder(event.currentTarget.value); setSelected([]); setEditing(null); }}><option value="*">{l("All", "全部")}</option><option value="">{l("Uncategorized", "未分类")}</option>{[...value.folders].sort().map(path => <option key={path} value={path}>{path}</option>)}</select>
      <button disabled={busy || selection.busy} onClick={() => { setEditing("create"); setName(folder && folder !== "*" ? folder + "/" : ""); setError(""); }}><FolderPlus size={14}/>{l("New folder", "新建文件夹")}</button>
      {folder && folder !== "*" && <><button disabled={busy || selection.busy} onClick={() => { setEditing("rename"); setName(folder); }}>{l("Rename / move", "重命名 / 移动")}</button><button disabled={busy || selection.busy} onClick={() => setEditing("delete")}>{l("Delete folder", "删除文件夹")}</button></>}
      {selected.length > 0 && <button disabled={busy || selection.busy} onClick={() => { setEditing("move"); setDestination(""); }}>{l("Move selected", "移动所选")} ({selected.length})</button>}
    </div>
    {editing && <form className="team-folder-editor" onSubmit={event => { event.preventDefault(); submit(); }}>
      {editing === "delete" ? <p>{l("Delete this folder and its subfolders? Resources move to Uncategorized.", "删除此文件夹及子文件夹？其中的资源会移到未分类，不会被删除。")}</p> : editing === "move" ? <label>{l("Destination", "目标文件夹")}<select value={destination} disabled={busy} onChange={event => setDestination(event.currentTarget.value)}><option value="">{l("Uncategorized", "未分类")}</option>{value.folders.map(path => <option key={path}>{path}</option>)}</select></label> : <label>{l("Folder path", "文件夹路径")}<input autoFocus value={name} disabled={busy} placeholder={l("Frontend / Review", "前端/代码审查")} onChange={event => setName(event.currentTarget.value)}/></label>}
      <button type="button" disabled={busy} onClick={() => setEditing(null)}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={busy || selection.busy || ((editing === "create" || editing === "rename") && !name.trim())}>{busy ? l("Saving…", "保存中…") : l("Confirm", "确认")}</button>
    </form>}
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    <div className="team-resource-list">{visible.map(item => <div className="team-folder-resource" key={item.id} onContextMenu={event => { event.preventDefault(); if (!busy && !selection.busy) { setSelected([item.id]); setDestination(assigned.get(item.id) ?? ""); setEditing("move"); } }}><input type="checkbox" aria-label={l(`Select ${item.name}`, `选择 ${item.name}`)} checked={selected.includes(item.id)} disabled={busy || selection.busy} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); }}/>{children(item.id)}</div>)}</div>
    {!visible.length && <p className="team-import-empty">{l("No resources in this folder.", "此文件夹还没有资源。")}</p>}
  </div>;
}
