import { useEffect, useRef, useState } from "react";
import { FileText, PackageSearch, RefreshCw } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamLocalAsset, TeamLocalCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamSelection } from "./team-workspace-page";
import type { LanguageMode } from "../../language";

export function TeamLocalAssetsPanel({ selection, kind, language, api, onOpen, selectedPath, disabled = false }: { selection: TeamSelection; kind: "skills" | "documents"; language: LanguageMode; api: TeamWorkspaceApi; onOpen?(file: TeamLocalAsset, trigger: HTMLButtonElement): void; selectedPath?: string; disabled?: boolean }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<TeamLocalCatalog | null>(null), [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const alive = useRef(false), running = useRef(false);
  const { team, connection } = selection;
  const scope = { teamId: team.id, repository: team.repository, ...(connection ? { connectionId: connection.id, directory: connection.path } : {}) };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true; setCatalog(null); setPreview(null); setError("");
    if (connection) void api.request({ action: "local-assets", scope, kind }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "local-assets") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not read local files. Try refreshing.", "本地文件读取失败，请刷新重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, connection?.id, connection?.path, kind, refresh]);
  async function inspect(file: string) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); setPreview(null);
    try {
      const reply = await api.request({ action: "local-assets", scope, kind, file });
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "local-preview") setPreview(reply.data.value);
    } catch { if (alive.current) setError(l("Could not read this file.", "无法读取此文件，请刷新后重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="team-workspace-installed team-local-assets"><header className="team-workspace-head"><div><h3>{kind === "skills" ? l("Local Skills", "本地 Skills") : l("Local documents", "本地文档")}</h3><small>{l("Only on this device. Reading here does not publish files to the team.", "仅在本机查看，文件不会自动分享到团队。")}</small></div>{connection && <button className="team-icon-button" aria-label={l("Refresh local files", "刷新本地文件")} title={l("Refresh local files", "刷新本地文件")} disabled={busy || disabled} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /></button>}</header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    {!connection ? <p>{l("Choose a connected working directory above to view local assets.", "在上方选择已接入的工作目录，查看其中已有的内容。")}</p> : !catalog && !error ? <p role="status">{l("Reading local files…", "正在读取本地文件…")}</p> : catalog && <>
      {!catalog.entries.length && <p>{kind === "skills" ? l("No SKILL.md found in .agents/skills, .claude/skills, .codex/skills or skills.", "未在 .agents/skills、.claude/skills、.codex/skills 或 skills 中找到 SKILL.md。") : l("No Markdown files found at the directory root or under docs.", "未在目录根部或 docs 中找到 Markdown 文档。")}</p>}
      {catalog.entries.map((item) => <button key={item.path} className="team-resource-row" aria-pressed={onOpen ? selectedPath === item.path : undefined} disabled={busy || disabled} onClick={(event) => onOpen ? onOpen(item, event.currentTarget) : void inspect(item.path)}>{kind === "skills" ? <PackageSearch size={17} /> : <FileText size={17} />}<span><strong>{item.name}</strong><small>{item.path} · {(item.bytes / 1024).toFixed(1)} KiB</small></span><span className="team-local-badge">{l("Local", "本地")}</span></button>)}
      {(catalog.limited || catalog.skipped > 0) && <small>{l("The scan is bounded and skips links. Some entries may not be listed.", "扫描有数量和深度限制，并跳过链接；部分条目可能未列出。")}</small>}
    </>}
    {preview && <div className="team-local-preview"><header className="team-workspace-head"><strong>{preview.path}</strong><button onClick={() => setPreview(null)}>{l("Close", "关闭")}</button></header><pre>{preview.content}</pre></div>}
  </section>;
}
