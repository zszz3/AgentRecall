import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderGit2, FolderOpen, Plus, RefreshCw, Unlink, UsersRound, X } from "lucide-react";
import type { ProjectBinding, TeamSpace } from "@agentrecall/workspace-core";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamRequest, TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";

export type TeamProjectSelection = { team: TeamSpace | null; project: ProjectBinding; enabled: boolean; busy: boolean };

export function TeamProjectBrowser({ language, settingsOpen, onOpenSettings, children, api = window.sessionSearch.teamWorkspace }: {
  language: LanguageMode;
  settingsOpen: boolean;
  onOpenSettings(): void;
  children(selection: TeamProjectSelection): ReactNode;
  api?: TeamWorkspaceApi;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  // undefined = team list; null = previously registered projects with no team.
  const [teamId, setTeamId] = useState<string | null | undefined>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<"new" | "existing" | null>(null);
  const [form, setForm] = useState({ name: "", directory: "", remote: "" });
  const [existingId, setExistingId] = useState("");
  const alive = useRef(false);
  const running = useRef(false);
  const snapshotVersion = useRef(0);
  const firstInput = useRef<HTMLInputElement>(null);
  const config = snapshot?.config;
  const teams = config?.teams ?? [];
  const allProjects = config?.projects ?? [];
  const owner = (project: ProjectBinding) => project.teamId === undefined ? config?.defaultTeamId ?? null : project.teamId;
  const team = teams.find((item) => item.id === teamId) ?? null;
  const atTeams = teamId === undefined || teamId !== null && !team;
  const projects = atTeams ? [] : allProjects.filter((item) => owner(item) === teamId);
  const project = projects.find((item) => item.id === projectId);
  const unassigned = allProjects.filter((item) => owner(item) === null);
  const existing = unassigned.find((item) => item.id === existingId) ?? unassigned[0];
  const locked = busy || Boolean(snapshot?.busy);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { firstInput.current?.focus(); }, [editor]);
  useEffect(() => {
    let active = true;
    if (settingsOpen) return;
    const version = ++snapshotVersion.current;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active || version !== snapshotVersion.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") setSnapshot(reply.data.value);
    }).catch(() => { if (active && version === snapshotVersion.current) setError(l("Could not load teams. Refresh and try again.", "团队读取失败，请刷新后重试。")); });
    return () => { active = false; };
  }, [api, refresh, settingsOpen]);

  function openTeam(id: string | null | undefined) {
    setTeamId(id); setProjectId(null); setEditor(null); setError(null);
    setForm({ name: "", directory: "", remote: "" }); setExistingId("");
  }
  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); return; }
      if (reply.data.kind === "snapshot") {
        snapshotVersion.current += 1;
        setSnapshot(reply.data.value); setEditor(null); setForm({ name: "", directory: "", remote: "" });
      } else if (reply.data.kind === "folder" && reply.data.value) {
        const directory = reply.data.value;
        setForm((current) => ({ ...current, directory }));
      }
    } catch { if (alive.current) setError(l("The operation failed. Try again.", "操作未完成，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }

  return <div className="team-project-browser">
    <header className="team-project-breadcrumb">
      <nav aria-label={l("Team and project", "团队与项目")}>
        <button type="button" disabled={locked} onClick={() => openTeam(undefined)}>{l("Teams", "团队")}</button>
        {!atTeams && <><ChevronRight size={14} /><button type="button" disabled={locked} onClick={() => { setProjectId(null); setEditor(null); setError(null); }}>{team?.name ?? l("Unassigned local projects", "未归属团队的本地项目")}</button></>}
        {project && <><ChevronRight size={14} /><strong>{project.name}</strong></>}
      </nav>
      <button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Refresh teams and projects", "刷新团队与项目")} onClick={() => { setError(null); setRefresh((value) => value + 1); }}><RefreshCw size={15} /></button>
    </header>
    {error && <p role="alert" className="team-project-error">{error}</p>}
    {!snapshot ? <p role="status" className="team-project-hint">{l("Loading teams…", "正在读取团队…")}</p> : project ? children({ team, project, enabled: Boolean(config?.teamEnabled), busy: Boolean(snapshot.busy) }) : <section className="team-project-list">
      {atTeams ? <>
        <header><div><h2>{l("Your teams", "我的团队")}</h2><p>{l("Choose a team to open its projects.", "先选择团队，再进入它的项目。")}</p></div><button type="button" className="settings-action-button" onClick={onOpenSettings}><Plus size={14} />{l("Connect team", "连接团队")}</button></header>
        {!teams.length && <p className="team-project-hint">{l("No teams connected. Add a team repository in Settings.", "还没有连接团队，请先在设置中添加团队仓库。")}</p>}
        {teams.map((item) => <button type="button" className="team-project-row" key={item.id} disabled={locked} onClick={() => openTeam(item.id)}><UsersRound size={19} /><span><strong>{item.name}</strong><small>{allProjects.filter((entry) => owner(entry) === item.id).length} {l("projects", "个项目")}</small></span><ChevronRight size={16} /></button>)}
        {unassigned.length > 0 && <button type="button" className="team-project-unassigned" disabled={locked} onClick={() => openTeam(null)}>{l("Unassigned local projects", "未归属团队的本地项目")} · {unassigned.length}</button>}
      </> : <>
        <header><div><h2>{team?.name ?? l("Local projects", "本地项目")}</h2><p>{team ? l("Projects in this team. Local folders are used for installation.", "团队下的项目，本地目录用于安装和使用资产。") : l("Existing installations remain available. Associate a project from inside a team.", "已有安装仍可管理。进入一个团队后，可关联这里的项目。")}</p></div>{team && <button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(editor === "new" ? null : "new")}><Plus size={14} />{l("New project", "新建项目")}</button>}</header>
        {team && <small className="team-project-repository">{l("Shared assets: ", "共享资产仓库：")}{team.repository}</small>}
        {team && unassigned.length > 0 && <button type="button" className="team-project-unassigned" disabled={locked} onClick={() => setEditor(editor === "existing" ? null : "existing")}>{l("Associate an existing local project", "关联已有本地项目")}</button>}
        {editor === "existing" && team && existing && <form className="team-settings-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "bind-project", id: existing.id, root: existing.root, teamId: team.id }); }}>
          <label>{l("Local project", "本地项目")}<select value={existing.id} disabled={locked} onChange={(event) => setExistingId(event.currentTarget.value)}>{unassigned.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <p>{existing.root}</p><footer><button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(null)}>{l("Cancel", "取消")}</button><button type="submit" className="settings-action-button is-primary" disabled={locked}>{l("Associate with this team", "关联到此团队")}</button></footer>
        </form>}
        {editor === "new" && team && <form className="team-settings-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "add-project", teamId: team.id, directory: form.directory, name: form.name.trim() || undefined, remote: form.remote.trim() || undefined }); }}>
          <header><strong>{l("New project in ", "新建项目 · ")}{team.name}</strong><button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Cancel project creation", "取消新建项目")} onClick={() => setEditor(null)}><X size={15} /></button></header>
          <label>{l("Project name (optional)", "项目名称（选填）")}<input ref={firstInput} disabled={locked} maxLength={200} value={form.name} placeholder={l("Use folder name", "默认使用目录名称")} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} /></label>
          <label>{l("Local folder", "关联本地目录")}<span className="team-settings-folder"><input required disabled={locked} value={form.directory} placeholder={l("Choose a local Git checkout", "选择本地 Git 仓库目录")} onChange={(event) => setForm({ ...form, directory: event.currentTarget.value })} /><button type="button" className="settings-action-button" disabled={locked} onClick={() => void run({ action: "choose-folder" })}><FolderOpen size={14} />{l("Choose", "选择")}</button></span></label>
          <details><summary>{l("Advanced options", "高级选项")}</summary><label>{l("Git remote (optional)", "Git 远端（选填）")}<input disabled={locked} value={form.remote} maxLength={200} placeholder="origin" onChange={(event) => setForm({ ...form, remote: event.currentTarget.value })} /></label></details>
          <footer><button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(null)}>{l("Cancel", "取消")}</button><button type="submit" className="settings-action-button is-primary" disabled={locked}>{l("Create project", "创建项目")}</button></footer>
        </form>}
        {!projects.length && <p className="team-project-hint">{l("No projects yet. Create the first project for this team.", "此团队还没有项目，可以创建第一个项目。")}</p>}
        {projects.map((item) => <div className="team-project-entry" key={item.id}><button type="button" className="team-project-row" disabled={locked} onClick={() => { setProjectId(item.id); setEditor(null); setError(null); }}><FolderGit2 size={19} /><span><strong>{item.name}</strong><small>{item.root}</small></span><ChevronRight size={16} /></button><button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Remove project binding: ", "移除项目绑定：") + item.name} onClick={() => void run({ action: "remove-project", id: item.id, root: item.root })}><Unlink size={15} /></button></div>)}
      </>}
      {!config?.teamEnabled && <p className="team-project-hint">{l("Team features are off. Configuration and existing local installations are kept.", "团队功能已关闭，仍可整理项目和管理已有本地安装。")}</p>}
    </section>}
  </div>;
}
