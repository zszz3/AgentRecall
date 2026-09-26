import { useEffect, useRef, useState } from "react";
import { FolderGit2, FolderOpen, GitBranch, Plus, RefreshCw, Unlink, X } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamRequest, TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";

export function TeamSettings({ language, api = window.sessionSearch.teamWorkspace }: { language: LanguageMode; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editor, setEditor] = useState<"team" | "project" | null>(null);
  const [teamForm, setTeamForm] = useState({ name: "", repository: "", makeDefault: false });
  const [projectForm, setProjectForm] = useState({ name: "", directory: "", remote: "", team: "__inherit__" });
  const running = useRef(false);
  const alive = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const editorElement = useRef<HTMLFormElement>(null);
  const config = snapshot?.config;
  const enabled = Boolean(config?.teamEnabled);
  const teams = config?.teams ?? [];
  const projects = config?.projects ?? [];
  const locked = !snapshot || busy || Boolean(snapshot.busy);
  const defaultTeam = teams.find((team) => team.id === config?.defaultTeamId);
  const inheritedLabel = defaultTeam ? l("Default: ", "跟随默认：") + defaultTeam.name : l("Default: local", "跟随默认：仅本地");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    editorElement.current?.scrollIntoView?.({ block: "nearest" });
    firstInput.current?.focus({ preventScroll: true });
  }, [editor]);
  useEffect(() => {
    let active = true;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") setSnapshot(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load team settings. Retry with Refresh.", "团队设置读取失败，请点击刷新重试。")); });
    return () => { active = false; };
  }, [api, refreshKey]);
  async function run(request: TeamRequest) {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(null); setFeedback(null);
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); return; }
      if (reply.data.kind === "snapshot") {
        setSnapshot(reply.data.value);
        if (request.action === "add-team") { setTeamForm({ name: "", repository: "", makeDefault: false }); setEditor(null); }
        if (request.action === "add-project") { setProjectForm({ name: "", directory: "", remote: "", team: "__inherit__" }); setEditor(null); }
        setFeedback(request.action === "add-team" ? l("Repository saved. Add a project below, then browse Skills → Team.", "团队仓库已保存。添加项目后，可前往「Skills → 团队」查看资产。") : l("Saved.", "已保存。"));
      } else if (reply.data.kind === "folder" && reply.data.value) {
        const directory = reply.data.value;
        setProjectForm((value) => ({ ...value, directory }));
      }
    } catch { if (alive.current) setError(l("Could not save. Refresh and try again.", "操作未完成，请刷新后重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const bindingValue = (value: string | null | undefined) => value === undefined ? "__inherit__" : value === null ? "__personal__" : value;
  const binding = (value: string): string | null | undefined => value === "__inherit__" ? undefined : value === "__personal__" ? null : value;
  return <section className="settings-pane team-settings">
    <header className="settings-pane-head settings-pane-head-row">
      <div><h3>{l("Team", "团队")}</h3><p>{l("Use a shared repository for your team's AI assets.", "通过共享仓库，让项目使用同一套 AI 资产。")}</p></div>
      <button type="button" className="team-settings-icon" aria-label={l("Refresh team settings", "刷新团队设置")} title={l("Refresh", "刷新")} disabled={busy} onClick={() => { setError(null); setRefreshKey((value) => value + 1); }}><RefreshCw size={15} /></button>
    </header>
    <label className="settings-field settings-toggle">
      <span className="settings-field-text"><span className="settings-field-title">{l("Enable team features", "启用团队功能")}</span><span className="settings-field-sub">{l("Browse team assets inside each feature. Sessions stay private.", "在各功能页使用团队资产，Session 不会自动分享。")}</span></span>
      <input aria-label={l("Enable team features", "启用团队功能")} type="checkbox" className="switch" checked={enabled} disabled={locked} onChange={(event) => void run({ action: "enable", enabled: event.currentTarget.checked })} />
    </label>
    {locked && snapshot && <p role="status" className="team-settings-message">{l("Saving or completing a team operation…", "正在处理团队操作…")}</p>}
    {error && <p role="alert" className="team-settings-message is-error">{error}</p>}
    {feedback && <p role="status" className="team-settings-message">{feedback}</p>}
    <section className="team-settings-section" aria-label={l("Team repositories", "团队仓库")}>
      <header><h4>{l("Team repositories", "团队仓库")}<span>{teams.length}</span></h4><button type="button" className="team-settings-add" disabled={locked} onClick={() => { setEditor("team"); setTeamForm((value) => ({ ...value, makeDefault: !config?.defaultTeamId })); setError(null); setFeedback(null); }}><Plus size={14} />{l("Connect team", "连接团队")}</button></header>
      {editor === "team" && <form ref={editorElement} className="team-settings-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "add-team", repository: teamForm.repository, name: teamForm.name.trim() || undefined, makeDefault: teamForm.makeDefault }); }}>
        <header><strong>{l("Connect a team repository", "连接团队仓库")}</strong><button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Cancel connecting a team", "取消连接团队")} onClick={() => setEditor(null)}><X size={15} /></button></header>
        <label>{l("Repository URL", "仓库地址")}<input ref={firstInput} required disabled={locked} maxLength={2048} value={teamForm.repository} onChange={(event) => setTeamForm({ ...teamForm, repository: event.currentTarget.value })} placeholder="https://github.com/your-team/ai-assets" /></label>
        <label>{l("Display name (optional)", "显示名称（选填）")}<input disabled={locked} maxLength={200} value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.currentTarget.value })} placeholder={l("Use repository name", "默认使用仓库名称")} /></label>
        <label className="team-settings-check"><input type="checkbox" disabled={locked} checked={teamForm.makeDefault} onChange={(event) => setTeamForm({ ...teamForm, makeDefault: event.currentTarget.checked })} />{l("Use as the default team", "用作默认团队")}</label>
        <p>{l("GitHub HTTPS or SSH. Uses local Git access; saving does not download assets or grant membership.", "支持 GitHub HTTPS / SSH，沿用本机 Git 权限。保存后在 Skills 中手动同步。")}</p>
        <footer><button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(null)}>{l("Cancel", "取消")}</button><button type="submit" className="settings-action-button is-primary" disabled={locked}>{l("Save repository", "保存仓库")}</button></footer>
      </form>}
      {!teams.length && editor !== "team" && <p className="team-settings-empty">{l("Connect an existing team repository to get started.", "粘贴已有的团队仓库地址，即可开始配置。")}</p>}
      {teams.map((team) => <div className="team-settings-item" key={team.id}><span className="team-settings-item-icon"><GitBranch size={16} /></span><div className="team-settings-item-copy"><strong>{team.name}</strong><small title={team.repository}>{team.repository}</small></div>{team.id === config?.defaultTeamId && <span className="team-settings-badge">{l("Default", "默认")}</span>}</div>)}
      {teams.length > 0 && <label className="team-settings-default"><span>{l("Default team", "默认团队")}<small>{l("Used by projects without an override.", "未单独指定团队的项目使用此设置。")}</small></span><select disabled={locked} value={config?.defaultTeamId ?? "__personal__"} onChange={(event) => void run({ action: "default-team", id: event.currentTarget.value === "__personal__" ? null : event.currentTarget.value })}><option value="__personal__">{l("Local only", "仅本地")}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
    </section>
    <section className="team-settings-section" aria-label={l("Project bindings", "项目绑定")}>
      <header><h4>{l("Project bindings", "项目绑定")}<span>{projects.length}</span></h4><button type="button" className="team-settings-add" disabled={locked} onClick={() => { setEditor("project"); setError(null); setFeedback(null); }}><Plus size={14} />{l("Add project", "添加项目")}</button></header>
      {editor === "project" && <form ref={editorElement} className="team-settings-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "add-project", directory: projectForm.directory, name: projectForm.name.trim() || undefined, remote: projectForm.remote.trim() || undefined, teamId: binding(projectForm.team) }); }}>
        <header><strong>{l("Add a local project", "添加本地项目")}</strong><button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Cancel adding a project", "取消添加项目")} onClick={() => setEditor(null)}><X size={15} /></button></header>
        <label>{l("Project folder", "项目目录")}<span className="team-settings-folder"><input ref={firstInput} required disabled={locked} value={projectForm.directory} onChange={(event) => setProjectForm({ ...projectForm, directory: event.currentTarget.value })} placeholder={l("Select a local Git project", "选择本地 Git 项目")} /><button type="button" className="settings-action-button" disabled={locked} onClick={() => void run({ action: "choose-folder" })}><FolderOpen size={15} />{l("Choose", "选择")}</button></span></label>
        <label>{l("Team", "所属团队")}<select disabled={locked} value={projectForm.team} onChange={(event) => setProjectForm({ ...projectForm, team: event.currentTarget.value })}><option value="__inherit__">{inheritedLabel}</option><option value="__personal__">{l("Local only", "仅本地")}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        <details><summary>{l("Advanced options", "高级选项")}</summary><label>{l("Display name (optional)", "显示名称（选填）")}<input disabled={locked} maxLength={200} value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.currentTarget.value })} placeholder={l("Use folder name", "默认使用目录名称")} /></label><label>{l("Git remote (optional)", "Git 远端（选填）")}<input disabled={locked} maxLength={200} value={projectForm.remote} onChange={(event) => setProjectForm({ ...projectForm, remote: event.currentTarget.value })} placeholder="origin" /></label></details>
        <footer><button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(null)}>{l("Cancel", "取消")}</button><button type="submit" className="settings-action-button is-primary" disabled={locked}>{l("Save project", "保存项目")}</button></footer>
      </form>}
      {!projects.length && editor !== "project" && <p className="team-settings-empty">{l("Choose which team each local project uses.", "选择本地项目，为它指定要使用的团队。")}</p>}
      {projects.map((project) => <div className="team-settings-item team-settings-project" key={project.id}>
        <span className="team-settings-item-icon"><FolderGit2 size={16} /></span><div className="team-settings-item-copy"><strong>{project.name}</strong><small title={project.root}>{project.root}</small></div>
        <select aria-label={l("Team for ", "所属团队：") + project.name} disabled={locked} value={bindingValue(project.teamId)} onChange={(event) => void run({ action: "bind-project", id: project.id, root: project.root, teamId: binding(event.currentTarget.value) })}><option value="__inherit__">{inheritedLabel}</option><option value="__personal__">{l("Local only", "仅本地")}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>
        <button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Remove binding for ", "移除绑定：") + project.name} title={l("Remove binding", "移除绑定")} onClick={() => void run({ action: "remove-project", id: project.id, root: project.root })}><Unlink size={15} /></button>
      </div>)}
    </section>
    <p className="team-settings-footnote">{enabled ? l("Ready to use? Open Skills → Team to sync and preview assets.", "配置完成后，前往「Skills → 团队」同步和预览资产。") : l("Team features are off. Saved repositories and local installations are kept.", "团队功能已关闭，仓库配置和已有本地安装会保留。")}</p>
  </section>;
}
