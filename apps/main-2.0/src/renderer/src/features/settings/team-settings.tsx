import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
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
  const [teamForm, setTeamForm] = useState({ id: "", name: "", repository: "" });
  const [projectForm, setProjectForm] = useState({ id: "", name: "", directory: "", remote: "" });
  const running = useRef(false);
  const alive = useRef(false);
  const config = snapshot?.config;
  const enabled = Boolean(config?.teamEnabled);
  const teams = config?.teams ?? [];
  const projects = config?.projects ?? [];
  const locked = busy || Boolean(snapshot?.busy);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
        if (request.action === "add-team") setTeamForm({ id: "", name: "", repository: "" });
        if (request.action === "add-project") setProjectForm({ id: "", name: "", directory: "", remote: "" });
        setFeedback(l("Team settings saved.", "团队设置已保存。"));
      } else if (reply.data.kind === "folder" && reply.data.value) {
        const directory = reply.data.value;
        setProjectForm((value) => ({ ...value, directory }));
      }
    } catch { if (alive.current) setError(l("Could not save. Refresh and try again.", "操作未完成，请刷新后重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const bindingValue = (value: string | null | undefined) => value === undefined ? "__inherit__" : value === null ? "__personal__" : value;
  const binding = (value: string): string | null | undefined => value === "__inherit__" ? undefined : value === "__personal__" ? null : value;
  return <section className="team-workspace team-settings">
    <header className="team-workspace-head"><div><h3>{l("Team", "团队")}</h3><p>{l("Manage repositories here. Browse team content inside each feature page.", "在这里管理仓库与项目；团队内容在各功能页中查看。")}</p></div><button type="button" disabled={busy} onClick={() => { setError(null); setRefreshKey((value) => value + 1); }}><RefreshCw size={15} />{l("Refresh", "刷新")}</button></header>
      <label className="team-workspace-toggle">
        <div><strong>{l("Enable team features", "启用团队功能")}</strong><p>{l("Off by default. Enabling does not sync or install anything automatically.", "默认关闭。启用不会自动同步或安装任何内容。")}</p></div>
        <input aria-label={l("Enable team features", "启用团队功能")} type="checkbox" className="switch" checked={enabled} disabled={!snapshot || locked} onChange={(event) => void run({ action: "enable", enabled: event.currentTarget.checked })} />
      </label>
      {!enabled && <p className="team-workspace-notice">{l("Personal features remain available. Existing configurations can still be inspected and removed in Skills → Team.", "个人功能照常可用。已安装的工作配置仍可在 Skills 页的团队范围中查看和卸载。")}</p>}

    {locked && <p role="status">{l("A team operation is in progress.", "团队操作正在进行。")}</p>}
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    {feedback && <p role="status" className="team-workspace-notice">{feedback}</p>}
      {enabled && <details className="team-workspace-configuration" open={!teams.length || !projects.length}>
        <summary>{l("Repositories and project bindings", "仓库与项目绑定")}</summary>
        <p>{l("Add an existing GitHub asset repository. Access uses your existing Git credentials; no remote repository is created.", "添加现有的 GitHub 资产仓库，访问权限沿用本机 Git；不会创建远端仓库。")}</p>
        <div className="team-workspace-forms">
          <form onSubmit={(event) => { event.preventDefault(); void run({ action: "add-team", ...teamForm }); }}>
            <h3>{l("Add asset repository", "添加资产仓库")}</h3>
            <label>{l("Team ID", "团队 ID")}<input required pattern="[a-z][a-z0-9-]*" maxLength={64} value={teamForm.id} onChange={(event) => setTeamForm({ ...teamForm, id: event.currentTarget.value })} placeholder="engineering" /></label>
            <label>{l("Name", "名称")}<input required maxLength={200} value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.currentTarget.value })} /></label>
            <label>GitHub<input required maxLength={2048} value={teamForm.repository} onChange={(event) => setTeamForm({ ...teamForm, repository: event.currentTarget.value })} placeholder="https://github.com/your-team/skills" /></label>
            <button type="submit" disabled={locked}>{l("Add repository", "添加仓库")}</button>
            <label>{l("Default team", "默认团队")}<select disabled={locked} value={config?.defaultTeamId ?? "__personal__"} onChange={(event) => void run({ action: "default-team", id: event.currentTarget.value === "__personal__" ? null : event.currentTarget.value })}><option value="__personal__">{l("Personal", "个人")}</option>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void run({ action: "add-project", ...projectForm, remote: projectForm.remote || undefined }); }}>
            <h3>{l("Add business project", "添加业务项目")}</h3>
            <label>{l("Project ID", "项目 ID")}<input required pattern="[a-z][a-z0-9-]*" maxLength={64} value={projectForm.id} onChange={(event) => setProjectForm({ ...projectForm, id: event.currentTarget.value })} placeholder="backend" /></label>
            <label>{l("Name", "名称")}<input required maxLength={200} value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.currentTarget.value })} /></label>
            <label>{l("Git checkout", "Git 项目目录")}<div className="team-workspace-inline"><input required value={projectForm.directory} onChange={(event) => setProjectForm({ ...projectForm, directory: event.currentTarget.value })} /><button type="button" disabled={locked} onClick={() => void run({ action: "choose-folder" })}><FolderOpen size={15} />{l("Choose", "选择")}</button></div></label>
            <label>{l("Remote name (optional)", "远端名称（可选）")}<input value={projectForm.remote} onChange={(event) => setProjectForm({ ...projectForm, remote: event.currentTarget.value })} placeholder="origin" /></label>
            <button type="submit" disabled={locked}>{l("Add project", "添加项目")}</button>
          </form>
        </div>
        {projects.map((item) => <div className="team-workspace-project" key={item.id}>
          <div><strong>{item.name}</strong><small>{item.root}</small></div>
          <select aria-label={l("Team for ", "所属团队：") + item.name} disabled={locked} value={bindingValue(item.teamId)} onChange={(event) => void run({ action: "bind-project", id: item.id, root: item.root, teamId: binding(event.currentTarget.value) })}>
            <option value="__inherit__">{l("Use default", "跟随默认")}</option><option value="__personal__">{l("Personal", "个人")}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
          <button type="button" disabled={locked} onClick={() => void run({ action: "remove-project", id: item.id, root: item.root })}>{l("Remove binding", "移除绑定")}</button>
        </div>)}
      </details>}

  </section>;
}
