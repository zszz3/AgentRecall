import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { FolderOpen, RefreshCw, UsersRound } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload, TeamRequest, TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";

type Inspection = {
  scope: { projectId: string; root: string; repository: string };
  target: "codex" | "claude";
  data: Extract<TeamPayload, { kind: "skill-preview" | "work-preview" | "work-status" | "work-diff" }>;
};

export function TeamWorkspacePage({ language, api = window.sessionSearch.teamWorkspace }: { language: LanguageMode; api?: TeamWorkspaceApi }): ReactElement {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [target, setTarget] = useState<"codex" | "claude">("codex");
  const [transport, setTransport] = useState<"https" | "ssh">("https");
  const [storedInspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState<TeamRequest["action"] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<{ message: string; details?: Readonly<Record<string, unknown>> } | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; backups: string[] } | null>(null);
  const [teamForm, setTeamForm] = useState({ id: "", name: "", repository: "" });
  const [projectForm, setProjectForm] = useState({ id: "", name: "", directory: "", remote: "" });
  const alive = useRef(false);
  const running = useRef(false);
  const inspectionElement = useRef<HTMLElement>(null);
  const config = snapshot?.config;
  const enabled = Boolean(config?.teamEnabled);
  const projects = config?.projects ?? [];
  const teams = config?.teams ?? [];
  const project = projects.find((item) => item.id === selectedProject) ?? projects[0];
  const teamId = project?.teamId === undefined ? config?.defaultTeamId : project.teamId;
  const team = teams.find((item) => item.id === teamId);
  const locked = Boolean(busy || snapshot?.busy);
  const scope = project ? { projectId: project.id, root: project.root } : null;
  const inspection = storedInspection && storedInspection.scope.projectId === project?.id
    && storedInspection.scope.root === project.root && storedInspection.target === target ? storedInspection : null;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error);
      else if (reply.data.kind === "snapshot") setSnapshot(reply.data.value);
    }).catch(() => { if (active) setError({ message: "团队配置读取失败，请刷新后重试。" }); });
    return () => { active = false; };
  }, [api, refreshKey]);

  useEffect(() => {
    let active = true;
    setInspection(null);
    setCatalog(null);
    if (!project) return;
    setCatalogLoading(true);
    void api.request({ action: "catalog", scope: { projectId: project.id, root: project.root } }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError({ message: "项目资产读取失败，请刷新后重试。" }); }).finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [api, project?.id, project?.root, project?.teamId, config?.defaultTeamId, enabled, refreshKey]);

  useEffect(() => { setInspection(null); }, [target]);
  useEffect(() => { if (inspection) inspectionElement.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [inspection]);

  async function run(request: TeamRequest): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(request.action);
    setError(null);
    setFeedback(null);
    try {
      const reply = await api.request(request);
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error); return; }
      const data = reply.data;
      switch (data.kind) {
        case "snapshot":
          setSnapshot(data.value);
          if (request.action === "add-team") setTeamForm({ id: "", name: "", repository: "" });
          if (request.action === "add-project") { setProjectForm({ id: "", name: "", directory: "", remote: "" }); setSelectedProject(request.id); }
          setInspection(null);
          setRefreshKey((value) => value + 1);
          setFeedback({ message: l("Configuration saved.", "配置已保存。"), backups: [] });
          break;
        case "folder": if (data.value) setProjectForm((value) => ({ ...value, directory: data.value! })); break;
        case "complete":
          setFeedback({ message: data.message, backups: data.backups });
          setInspection(null);
          setRefreshKey((value) => value + 1);
          break;
        case "skill-preview": case "work-preview": case "work-status": case "work-diff":
          if ("scope" in request && "target" in request) setInspection({ scope: { ...request.scope, repository: data.value.repository }, target: request.target, data });
          break;
        case "catalog": setCatalog(data.value); break;
        case "cancelled": break;
      }
    } catch {
      if (alive.current) setError({ message: l("The request failed. Refresh and try again.", "请求未完成，请刷新后重试。") });
    } finally {
      running.current = false;
      if (alive.current) setBusy(null);
    }
  }

  const bindingValue = (value: string | null | undefined) => value === undefined ? "__inherit__" : value === null ? "__personal__" : value;
  const binding = (value: string): string | null | undefined => value === "__inherit__" ? undefined : value === "__personal__" ? null : value;
  const localConfigurations = catalog?.installed.filter((item) => item.target === target) ?? [];

  return (
    <section className="team-workspace">
      <header className="team-workspace-head">
        <div><h2><UsersRound size={22} /> {l("Team workspace", "团队工作区")}</h2><p>{l("Share project skills and work configurations. Sessions are never uploaded here.", "按项目共享 Skill 和工作配置，这里不会上传 Session。")}</p></div>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setError(null); setRefreshKey((value) => value + 1); }}><RefreshCw size={15} />{l("Refresh", "刷新")}</button>
      </header>
      <label className="team-workspace-toggle">
        <div><strong>{l("Enable team features", "启用团队功能")}</strong><p>{l("Off by default. Enabling does not sync or install anything automatically.", "默认关闭。启用不会自动同步或安装任何内容。")}</p></div>
        <input aria-label={l("Enable team features", "启用团队功能")} type="checkbox" className="switch" checked={enabled} disabled={!snapshot || locked} onChange={(event) => void run({ action: "enable", enabled: event.currentTarget.checked })} />
      </label>
      {!enabled && <p className="team-workspace-notice">{l("Personal features remain available. Existing local configurations can still be inspected and removed below.", "个人功能照常可用。已安装的本地工作配置仍可在下方查看和卸载。")}</p>}
      {locked && <div role="status" className="team-workspace-notice">{l("A team operation is in progress.", "团队操作正在进行。")}{busy === "sync" && <button type="button" onClick={() => void api.request({ action: "cancel-sync" })}>{l("Cancel sync", "取消同步")}</button>}</div>}
      {error && <div role="alert" className="team-workspace-error"><p>{error.message}</p>{error.details && <details><summary>{l("Recovery details", "恢复详情")}</summary><pre>{JSON.stringify(error.details, null, 2)}</pre></details>}</div>}
      {feedback && <div role="status" className="team-workspace-notice"><p>{feedback.message}</p>{feedback.backups.map((backup) => <code key={backup}>{backup}</code>)}</div>}

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

      {projects.length > 0 && <div className="team-workspace-toolbar">
        <label>{l("Project", "项目")}<select disabled={locked} value={project?.id ?? ""} onChange={(event) => setSelectedProject(event.currentTarget.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{l("Client", "客户端")}<select disabled={locked} value={target} onChange={(event) => setTarget(event.currentTarget.value as "codex" | "claude")}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
        <label>{l("Connection", "连接方式")}<select disabled={locked || !enabled} value={transport} onChange={(event) => setTransport(event.currentTarget.value as "https" | "ssh")}><option value="https">HTTPS</option><option value="ssh">SSH</option></select></label>
        <button type="button" className="is-primary" disabled={locked || !enabled || !team || !scope} onClick={() => scope && team && void run({ action: "sync", scope: { ...scope, repository: team.repository }, transport })}>{l("Sync assets", "同步资产")}</button>
        {team && <small>{team.name} · {team.repository}</small>}
      </div>}
      {catalogLoading && <p role="status">{l("Loading project assets…", "正在读取项目资产…")}</p>}
      {catalog?.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
      {enabled && catalog?.assets && scope && <div className="team-workspace-assets">
        <section><h3>Skills <span>{catalog.assets.skills.length}</span></h3>{catalog.assets.skills.map((skill) => <article key={skill.id}><div><strong>{skill.id}</strong><p>{skill.description}</p></div><button type="button" disabled={locked} onClick={() => void run({ action: "skill-preview", scope, id: skill.id, target })}>{l("Preview", "预览")}</button></article>)}</section>
        <section><h3>{l("Work configurations", "工作配置")} <span>{catalog.assets.workConfigs.length}</span></h3>{catalog.assets.workConfigs.map((item) => <article key={item.id}><div><strong>{item.name}</strong><p>{item.description}</p><small>{item.skills.join(" · ")}</small></div><button type="button" disabled={locked} onClick={() => void run({ action: "work-preview", scope, id: item.id, target })}>{l("Preview", "预览")}</button></article>)}</section>
      </div>}
      {project && <section className="team-workspace-installed"><h3>{l("Installed work configurations", "已安装的工作配置")}</h3>
        {!localConfigurations.length && <p>{l("No recorded configurations for this client.", "此客户端暂无工作配置记录。")}</p>}
        {localConfigurations.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.repository}</small></div><button type="button" disabled={locked || !scope} onClick={() => scope && void run({ action: "work-status", scope, id: item.id, target })}>{l("Status", "查看状态")}</button><button type="button" disabled={locked || !enabled || !scope} onClick={() => scope && void run({ action: "work-diff", scope, id: item.id, target })}>{l("Compare update", "查看更新")}</button></article>)}
      </section>}
      {inspection && <section ref={inspectionElement} className="team-workspace-inspection" aria-label={l("Asset preview", "资产预览")}>
        <header><h3>{inspection.data.kind === "skill-preview" ? inspection.data.value.id : inspection.data.value.name}</h3><button type="button" onClick={() => setInspection(null)}>{l("Close", "关闭")}</button></header>
        <small>{inspection.scope.repository} · {inspection.target}</small>
        {"commit" in inspection.data.value && <p>{l("Version: ", "版本：")}<code>{inspection.data.value.commit}</code></p>}
        {inspection.data.kind === "skill-preview" && <>
          <label>{l("File", "文件")}<select disabled={locked} value={inspection.data.value.file} onChange={(event) => void run({ action: "skill-preview", scope: inspection.scope, id: inspection.data.value.id, target: inspection.target, file: event.currentTarget.value })}>{inspection.data.value.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
          {inspection.data.value.encoding === "base64" && <p>{l("Binary file shown as Base64.", "二进制文件，以 Base64 显示。")}</p>}
          <pre>{inspection.data.value.content}</pre>
          <button type="button" className="is-primary" disabled={locked || !enabled} onClick={() => void run({ action: "skill-install", scope: inspection.scope, id: inspection.data.value.id, target: inspection.target, revision: inspection.data.kind === "skill-preview" ? inspection.data.value.commit : "" })}>{l("Install this version", "安装此版本")}</button>
        </>}
        {inspection.data.kind === "work-preview" && <>
          <p>{inspection.data.value.description}</p>
          {inspection.data.value.configurationConflict && <p className="team-workspace-error">{inspection.data.value.configurationConflict}</p>}
          <ul>{inspection.data.value.skills.map((skill) => <li key={skill.id}><strong>{skill.id}</strong> · {skill.status === "existing" ? l("Reuse existing", "复用现有内容") : skill.status === "conflict" ? l("Conflict", "有冲突") : l("Install", "待安装")}{skill.reason && <p>{skill.reason}</p>}{skill.destination && <small>{skill.destination}</small>}</li>)}</ul>
          <button type="button" className="is-primary" disabled={locked || !enabled || Boolean(inspection.data.value.configurationConflict) || inspection.data.value.skills.some((skill) => skill.status === "conflict")} onClick={() => void run({ action: "work-install", scope: inspection.scope, id: inspection.data.value.id, target: inspection.target, revision: inspection.data.kind === "work-preview" ? inspection.data.value.commit : "" })}>{l("Install configuration", "安装工作配置")}</button>
        </>}
        {inspection.data.kind === "work-status" && <>
          <p>{l("Installed version: ", "已安装版本：")}<code>{inspection.data.value.revision}</code></p>
          <ul>{inspection.data.value.skills.map((skill) => <li key={skill.id}><strong>{skill.id}</strong> · {skill.state === "ready" ? l("Content verified", "内容完整") : skill.state === "missing" ? l("Missing", "文件缺失") : l("Changed or conflicting", "内容有变化或冲突")}<p>{skill.action === "keep_shared" ? l("Keep: shared by ", "保留：其他配置仍引用 ") + skill.otherConfigs.join("、") : skill.action === "keep_independent" ? l("Keep existing independent installation", "保留原有独立安装") : skill.action === "missing" ? l("Remove the missing reference", "仅移除缺失引用") : l("Move to backup on uninstall", "卸载时移入备份")}</p></li>)}</ul>
          <button type="button" disabled={locked || inspection.data.value.skills.some((skill) => skill.action === "backup" && skill.state !== "ready")} onClick={() => void run({ action: "work-uninstall", scope: inspection.scope, id: inspection.data.value.id, target: inspection.target, revision: inspection.data.kind === "work-status" ? inspection.data.value.revision : "" })}>{l("Uninstall configuration…", "卸载工作配置…")}</button>
        </>}
        {inspection.data.kind === "work-diff" && <>
          <p><code>{inspection.data.value.fromRevision}</code> → <code>{inspection.data.value.revision}</code></p>
          <ul>{inspection.data.value.changes.map((change) => <li key={change.id}><strong>{change.id}</strong> · {{
            install: l("Install", "安装"), reuse: l("Reuse", "复用"), update: l("Back up and update", "备份并更新"), backup: l("Move to backup", "移入备份"),
            keep_shared: l("Keep shared content", "保留共享内容"), keep_independent: l("Keep independent content", "保留独立安装"),
            missing: l("Remove missing reference", "移除缺失引用"), conflict: l("Conflict", "有冲突"),
          }[change.action]}{change.reason && <p>{change.reason}</p>}{change.otherConfigs.length > 0 && <small>{l("Other references: ", "其他引用：")}{change.otherConfigs.join("、")}</small>}</li>)}</ul>
          <button type="button" className="is-primary" disabled={locked || !enabled || !inspection.data.value.canUpdate} onClick={() => inspection.data.kind === "work-diff" && void run({ action: "work-update", scope: inspection.scope, id: inspection.data.value.id, target: inspection.target, fromRevision: inspection.data.value.fromRevision, revision: inspection.data.value.revision })}>{l("Apply this update", "按以上差异更新")}</button>
        </>}
      </section>}
    </section>
  );
}
