import { useEffect, useRef, useState } from "react";
import { PackageSearch, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { TeamSelection } from "./team-workspace-page";
import type { LanguageMode } from "../../language";

type Preview = Extract<TeamPayload, { kind: "skill-preview" }>["value"];
export function TeamAssetsPanel({ language, selection, refreshKey = 0, api = window.sessionSearch.teamWorkspace }: { language: LanguageMode; selection: TeamSelection; refreshKey?: number; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [preview, setPreview] = useState<Preview | null>(null), [selected, setSelected] = useState<string | null>(null), [error, setError] = useState("");
  const requestVersion = useRef(0), panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const { team, enabled } = selection, scope = { teamId: team.id, repository: team.repository };
  useEffect(() => {
    let active = true; requestVersion.current++; setCatalog(null); setPreview(null); setSelected(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope }).then((reply) => { if (!active) return; if (!reply.ok) setError(reply.error.message); else if (reply.data.kind === "catalog") setCatalog(reply.data.value); }).catch(() => { if (active) setError(l("Could not read team Skills.", "团队 Skills 读取失败，请刷新重试。")); });
    return () => { active = false; requestVersion.current++; };
  }, [api, team.id, team.repository, enabled, refreshKey]);
  useEffect(() => { if (selected) panel.current?.focus({ preventScroll: true }); else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }, [selected]);
  async function open(id: string, button?: HTMLButtonElement, file?: string) {
    if (button) trigger.current = button;
    const version = ++requestVersion.current; setSelected(id); setPreview(null); setError("");
    try { const reply = await api.request({ action: "skill-preview", scope, id, ...(file ? { file } : {}) }); if (version !== requestVersion.current) return; if (!reply.ok) setError(reply.error.message); else if (reply.data.kind === "skill-preview") setPreview(reply.data.value); else setError(l("Could not open this Skill.", "无法打开这个 Skill，请重试。")); }
    catch { if (version === requestVersion.current) setError(l("Could not open this Skill.", "无法打开这个 Skill，请重试。")); }
  }
  function close() { requestVersion.current++; setSelected(null); setPreview(null); setError(""); }
  return <div className={`team-documents-layout${selected ? " has-reader" : ""}`} onKeyDown={(event) => { if (event.key === "Escape" && selected) { event.stopPropagation(); close(); } }}>
    <section className="team-workspace team-documents-list"><header className="team-workspace-head"><div><h2>Skills <span className="team-count">{catalog?.assets?.skills.length ?? 0}</span></h2><p>{l("Skills shared by your team. Syncing updates them in enabled working directories.", "团队共用的技能，同步时统一更新到已启用的工作目录。")}</p></div></header>
      {!selected && error && <p className="team-workspace-error" role="alert">{error}</p>}
      {!enabled ? <p>{l("Enable teams in Settings to browse shared Skills.", "在设置中启用团队后，可浏览共享 Skills。")}</p> : !catalog && !error ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog?.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        <div className="team-resource-list">{catalog?.assets?.skills.map((skill) => <button key={skill.id} className="team-resource-row" aria-pressed={selected === skill.id} disabled={selection.busy} onClick={(event) => void open(skill.id, event.currentTarget)}><PackageSearch size={18} /><span><strong>{skill.id}</strong><small>{skill.description}</small></span><span>{l("View", "查看")}</span></button>)}</div>
        {catalog?.assets && !catalog.assets.skills.length && <div className="team-empty"><PackageSearch size={26} /><strong>{l("No team Skills yet", "团队还没有共享技能")}</strong><p>{l("Published team Skills will appear here after syncing.", "团队发布技能后，点击上方「同步团队」即可获取。")}</p></div>}
      </>}
    </section>
    {selected && <aside ref={panel} tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Skill details", "Skill 详情")}><header className="team-document-reader-head"><div><small>{l("Team Skill", "团队 Skill")}</small><h3>{selected}</h3>{preview && <small>{preview.commit.slice(0, 8)}</small>}</div><button className="team-icon-button" aria-label={l("Close Skill", "关闭 Skill")} onClick={close}><X size={17} /></button></header><div className="team-document-reader-body">{error ? <p role="alert" className="team-workspace-error">{error}</p> : !preview ? <p role="status">{l("Opening…", "正在打开…")}</p> : <><label>{l("File", "文件")}<select value={preview.file} onChange={(event) => void open(selected, undefined, event.currentTarget.value)}>{preview.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>{preview.encoding === "base64" && <p>{l("Binary file shown as Base64.", "二进制文件，以 Base64 显示。")}</p>}<pre>{preview.content}</pre></>}</div></aside>}
  </div>;
}
