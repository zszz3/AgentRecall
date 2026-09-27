import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Code2, FileText, FolderOpen, MessagesSquare, MoreHorizontal, PackageSearch, Plus, RefreshCw, Settings, Terminal, UsersRound } from "lucide-react";
import type { DirectoryConnection, TeamSpace } from "@agentrecall/workspace-core";
import type { TeamSnapshot, TeamRequest } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamDocumentsPanel } from "./team-documents-panel";
import { TeamSyncControl } from "./team-sync-control";
import { TeamSessionsPanel } from "./team-sessions-panel";

export type TeamSelection = { team: TeamSpace; connection?: DirectoryConnection; enabled: boolean; busy: boolean };

export function TeamWorkspacePage({ language, settingsOpen, onOpenSettings, api = window.sessionSearch.teamWorkspace }: { language: LanguageMode; settingsOpen: boolean; onOpenSettings(): void; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null), [teamId, setTeamId] = useState<string>();
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const version = useRef(0);
  useEffect(() => {
    if (settingsOpen) return;
    let active = true; const current = ++version.current;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active || current !== version.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") { setSnapshot(reply.data.value); setError(""); }
    }).catch(() => { if (active) setError(l("Could not load teams. Try refreshing.", "团队读取失败，请刷新重试。")); });
    return () => { active = false; };
  }, [api, refresh, settingsOpen]);
  const team = snapshot?.config?.teams.find((entry) => entry.id === teamId);
  return <section className="team-space-page">
    <header className="team-space-heading"><div className="team-space-title">{team ? <button className="team-icon-button" aria-label={l("Back to teams", "返回团队列表")} title={l("Back to teams", "返回团队列表")} onClick={() => setTeamId(undefined)}><ArrowLeft size={18} /></button> : <span className="team-heading-icon"><UsersRound size={21} /></span>}<div><h1>{team?.name ?? l("Team Space", "团队空间")}</h1><p>{team ? team.repository.replace("https://github.com/", "") : l("Shared assets for your everyday work", "团队共用的会话、技能与文档")}</p></div></div><div className="team-space-actions"><button className="team-icon-button" aria-label={l("Refresh teams", "刷新团队")} title={l("Refresh teams", "刷新团队")} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} /></button><button className="team-icon-button" aria-label={l("Team settings", "团队设置")} title={l("Team settings", "团队设置")} onClick={onOpenSettings}><Settings size={17} /></button></div></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    {!snapshot ? <p role="status">{l("Loading teams…", "正在读取团队…")}</p> : !team ? <div className="team-project-list"><header><h2>{l("Your teams", "我的团队")}</h2><button className="team-button is-primary" onClick={onOpenSettings}><Plus size={14} />{l("Connect team", "连接团队")}</button></header>{snapshot.config?.teams.map((item) => <button className="team-project-row" key={item.id} onClick={() => setTeamId(item.id)}><span className="team-avatar"><UsersRound size={20} /></span><span><strong>{item.name}</strong><small>{item.repository.replace("https://github.com/", "")}</small></span><ChevronRight size={16} /></button>)}{!snapshot.config?.teams.length && <p>{l("Connect a team repository in Settings to get started.", "先在设置中连接一个团队资产仓库。")}</p>}</div> : <>

      <TeamContent key={team.id + team.repository} language={language} team={team} snapshot={snapshot} api={api} onSnapshot={(value) => { version.current++; setSnapshot(value); }} />
    </>}
  </section>;
}
function TeamContent({ language, team, snapshot, api, onSnapshot }: { language: LanguageMode; team: TeamSpace; snapshot: TeamSnapshot; api: TeamWorkspaceApi; onSnapshot(value: TeamSnapshot): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [tab, setTab] = useState<"sessions" | "skills" | "documents" | "directories">("sessions");
  const [syncing, setSyncing] = useState(false), [refreshKey, setRefreshKey] = useState(0);
  const directories = (snapshot.directories ?? []).filter((entry) => entry.teamId === team.id);
  const selection = { team, enabled: Boolean(snapshot.config?.teamEnabled), busy: snapshot.busy || syncing };
  return <div className="team-space-project">
    <TeamSyncControl team={team} enabled={selection.enabled} externalBusy={snapshot.busy} language={language} api={api} onBusy={setSyncing} onSynced={() => setRefreshKey((value) => value + 1)} />
    <div className="team-space-tabs" role="group" aria-label={l("Team resources", "团队资源")}>
      <button aria-pressed={tab === "sessions"} onClick={() => setTab("sessions")}><MessagesSquare size={16} />{l("Shared sessions", "共享会话")}</button>
      <button aria-pressed={tab === "skills"} onClick={() => setTab("skills")}><PackageSearch size={16} />Skills</button>
      <button aria-pressed={tab === "documents"} onClick={() => setTab("documents")}><FileText size={16} />{l("Documents", "文档")}</button>
      <button aria-pressed={tab === "directories"} onClick={() => setTab("directories")}><FolderOpen size={16} />{l("Working directories", "工作目录")}</button>
    </div>
    {tab === "sessions" ? <TeamSessionsPanel selection={selection} language={language} api={api} /> : tab === "skills" ? <TeamAssetsPanel selection={selection} refreshKey={refreshKey} language={language} api={api} /> : tab === "documents" ? <TeamDocumentsPanel selection={selection} refreshKey={refreshKey} language={language} api={api} /> : <Directories language={language} team={team} directories={directories} busy={selection.busy} api={api} onSnapshot={onSnapshot} />}

  </div>;
}
function Directories({ language, team, directories, busy: externalBusy, api, onSnapshot }: { language: LanguageMode; team: TeamSpace; directories: DirectoryConnection[]; busy: boolean; api: TeamWorkspaceApi; onSnapshot(value: TeamSnapshot): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [adding, setAdding] = useState(false), [directory, setDirectory] = useState("");
  const [targets, setTargets] = useState<Array<"codex" | "claude">>(["codex"]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false), alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") { onSnapshot(reply.data.value); setAdding(false); setDirectory(""); }
      else if (reply.data.kind === "folder" && reply.data.value) setDirectory(reply.data.value);
    } catch { if (alive.current) setError(l("Request failed. Try again.", "操作未完成，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const locked = busy || externalBusy;
  return <section className="team-workspace"><header className="team-workspace-head"><div><h2>{l("Working directories", "工作目录")}</h2><p>{l("Choose where to use your team assets.", "在这些目录中使用团队资产，各自管理安装与更新。")}</p></div><button className="is-primary" disabled={locked} onClick={() => setAdding(true)}><Plus size={15} />{l("Connect working directory", "接入工作目录")}</button></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    {adding && <form className="team-directory-form" onSubmit={(event) => { event.preventDefault(); void run({ action: "connect-directory", teamId: team.id, directory, targets }); }}><label>{l("Local directory", "本地目录")}<span className="team-settings-folder"><input required value={directory} disabled={locked} onChange={(event) => setDirectory(event.currentTarget.value)} /><button type="button" disabled={locked} onClick={() => void run({ action: "choose-folder" })}>{l("Choose", "选择")}</button></span></label><div className="team-space-actions">{(["codex", "claude"] as const).map((target) => <label className="team-client-chip" key={target}><input type="checkbox" checked={targets.includes(target)} disabled={locked} onChange={(event) => setTargets(event.currentTarget.checked ? [...targets, target] : targets.filter((item) => item !== target))} /><span>{target === "codex" ? <Code2 size={14} /> : <Terminal size={14} />}{target === "codex" ? "Codex" : "Claude Code"}</span></label>)}</div><small>{l("After connecting, Sync team installs and updates resources. Sessions are never uploaded automatically.", "接入后点击「同步团队」，统一安装和更新资源；不会上传会话。")}</small><footer><button type="button" disabled={locked} onClick={() => setAdding(false)}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={locked || !directory || !targets.length}>{l("Connect", "确认接入")}</button></footer></form>}
    {!directories.length && <p className="team-empty">{l("No directories connected. You can already browse assets and share sessions in this team.", "还没有接入工作目录。你已经可以浏览团队资产和分享会话。")}</p>}
    <div className="team-directory-list">{directories.map((entry) => <section key={entry.id} className="team-directory-row"><span className="team-directory-icon"><FolderOpen size={19} /></span><div className="team-directory-name"><strong>{entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path}</strong><small title={entry.path}>{entry.path}</small></div><div className="team-directory-clients">{(["codex", "claude"] as const).map((target) => <label className="team-client-chip" key={target}><input type="checkbox" checked={entry.targets.includes(target)} disabled={locked || entry.targets.length === 1 && entry.targets.includes(target)} onChange={(event) => void run({ action: "update-directory", teamId: team.id, id: entry.id, directory: entry.path, enabled: entry.enabled, targets: event.currentTarget.checked ? [...entry.targets, target] : entry.targets.filter((item) => item !== target) })} /><span>{target === "codex" ? <Code2 size={13} /> : <Terminal size={13} />}{target === "codex" ? "Codex" : "Claude Code"}</span></label>)}</div><label className="team-directory-toggle" title={entry.enabled ? l("Disable directory", "停用目录") : l("Enable directory", "启用目录")}><input className="team-switch" type="checkbox" aria-label={l("Enable directory: ", "启用目录：") + entry.path} checked={entry.enabled} disabled={locked} onChange={(event) => void run({ action: "update-directory", teamId: team.id, id: entry.id, directory: entry.path, enabled: event.currentTarget.checked, targets: entry.targets })} /><span>{entry.enabled ? l("On", "启用") : l("Off", "停用")}</span></label><details className="team-row-menu"><summary aria-label={l("More actions for ", "更多操作：") + entry.path}><MoreHorizontal size={17} /></summary><div><button disabled={locked} onClick={() => void run({ action: "disconnect-directory", teamId: team.id, id: entry.id, directory: entry.path })}>{l("Disconnect directory…", "断开工作目录…")}</button></div></details></section>)}</div>
    {directories.length > 0 && <p className="team-footnote">{l("Disabling or disconnecting preserves installed files and shared sessions.", "停用或断开连接会保留已有文件和已分享会话。")}</p>}

  </section>;
}
