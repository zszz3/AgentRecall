import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { RefreshCw } from "lucide-react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamCatalog, TeamPayload, TeamRequest, TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { LanguageMode } from "../../language";

type Inspection = {
  scope: { projectId: string; root: string; repository: string };
  target: "codex" | "claude";
  data: Extract<TeamPayload, { kind: "skill-preview" | "work-preview" | "work-status" | "work-diff" }>;
};

export function TeamAssetsPanel({ language, settingsOpen = false, onOpenSettings, api = window.sessionSearch.teamWorkspace }: { language: LanguageMode; settingsOpen?: boolean; onOpenSettings(): void; api?: TeamWorkspaceApi }): ReactElement {
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
  const alive = useRef(false);
  const running = useRef(false);
  const activeRequest = useRef<TeamRequest["action"] | null>(null);
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
    return () => {
      alive.current = false;
      if (activeRequest.current === "sync") {
        // The main process also cancels on window destruction if the bridge closes.
        void api.request({ action: "cancel-sync" }).catch(() => undefined);
      }
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    if (settingsOpen) return;
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!active) return;
      if (!reply.ok) setError(reply.error);
      else if (reply.data.kind === "snapshot") setSnapshot(reply.data.value);
    }).catch(() => { if (active) setError({ message: "团队配置读取失败，请刷新后重试。" }); });
    return () => { active = false; };
  }, [api, refreshKey, settingsOpen]);

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
    activeRequest.current = request.action;
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
          setInspection(null);
          setRefreshKey((value) => value + 1);
          setFeedback({ message: l("Configuration saved.", "配置已保存。"), backups: [] });
          break;
        case "folder": break;
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
      activeRequest.current = null;
      if (alive.current) setBusy(null);
    }
  }

  const localConfigurations = catalog?.installed.filter((item) => item.target === target) ?? [];

  return (
    <section className="team-workspace">
      <header className="team-workspace-head">
        <div><h2>{l("Team Skills", "团队 Skills")}</h2><p>{l("Share project skills and work configurations. Sessions are never uploaded here.", "按项目共享 Skill 和工作配置，这里不会上传 Session。")}</p></div>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setError(null); setRefreshKey((value) => value + 1); }}><RefreshCw size={15} />{l("Refresh", "刷新")}</button>
      </header>
      {!enabled && <div className="team-workspace-notice"><p>{l("Team features are off. Existing project installations remain available below.", "团队功能未启用。下方仍可管理已有项目安装。")}</p><button type="button" onClick={onOpenSettings}>{l("Open team settings", "前往团队设置")}</button></div>}
      {enabled && !projects.length && <div className="team-workspace-notice"><p>{l("Add a project and its asset repository in Settings → Team.", "先在「设置 → 团队」中添加项目并绑定资产仓库。")}</p><button type="button" onClick={onOpenSettings}>{l("Set up a team", "配置团队")}</button></div>}
      {locked && <div role="status" className="team-workspace-notice">{l("A team operation is in progress.", "团队操作正在进行。")}{busy === "sync" && <button type="button" onClick={() => void api.request({ action: "cancel-sync" })}>{l("Cancel sync", "取消同步")}</button>}</div>}
      {error && <div role="alert" className="team-workspace-error"><p>{error.message}</p>{error.details && <details><summary>{l("Recovery details", "恢复详情")}</summary><pre>{JSON.stringify(error.details, null, 2)}</pre></details>}</div>}
      {feedback && <div role="status" className="team-workspace-notice"><p>{feedback.message}</p>{feedback.backups.map((backup) => <code key={backup}>{backup}</code>)}</div>}

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
