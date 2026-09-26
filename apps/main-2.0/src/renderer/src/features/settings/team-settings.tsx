import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus, RefreshCw, X } from "lucide-react";
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
  const [editor, setEditor] = useState<"team" | null>(null);
  const [teamForm, setTeamForm] = useState({ name: "", repository: "" });
  const running = useRef(false);
  const alive = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const editorElement = useRef<HTMLFormElement>(null);
  const config = snapshot?.config;
  const enabled = Boolean(config?.teamEnabled);
  const teams = config?.teams ?? [];
  const locked = !snapshot || busy || Boolean(snapshot.busy);
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
        if (request.action === "add-team") { setTeamForm({ name: "", repository: "" }); setEditor(null); }
        setFeedback(request.action === "add-team" ? l("Team saved. Open the Team scope to manage its projects.", "团队已连接。进入功能页的「团队」范围，再管理它的项目。") : l("Saved.", "已保存。"));
      }
    } catch { if (alive.current) setError(l("Could not save. Refresh and try again.", "操作未完成，请刷新后重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="settings-pane team-settings">
    <header className="settings-pane-head settings-pane-head-row">
      <div><h3>{l("Team", "团队")}</h3><p>{l("Connect your teams here; manage projects inside each team.", "在这里连接团队，项目在各自团队内管理。")}</p></div>
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
      <header><h4>{l("Team repositories", "团队仓库")}<span>{teams.length}</span></h4><button type="button" className="team-settings-add" disabled={locked} onClick={() => { setEditor("team"); setError(null); setFeedback(null); }}><Plus size={14} />{l("Connect team", "连接团队")}</button></header>
      {editor === "team" && <form ref={editorElement} className="team-settings-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "add-team", repository: teamForm.repository, name: teamForm.name.trim() || undefined }); }}>
        <header><strong>{l("Connect a team repository", "连接团队仓库")}</strong><button type="button" className="team-settings-icon" disabled={locked} aria-label={l("Cancel connecting a team", "取消连接团队")} onClick={() => setEditor(null)}><X size={15} /></button></header>
        <label>{l("Repository URL", "仓库地址")}<input ref={firstInput} required disabled={locked} maxLength={2048} value={teamForm.repository} onChange={(event) => setTeamForm({ ...teamForm, repository: event.currentTarget.value })} placeholder="https://github.com/your-team/ai-assets" /></label>
        <label>{l("Display name (optional)", "显示名称（选填）")}<input disabled={locked} maxLength={200} value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.currentTarget.value })} placeholder={l("Use repository name", "默认使用仓库名称")} /></label>
        <p>{l("GitHub HTTPS or SSH. Uses local Git access; saving does not download assets or grant membership.", "支持 GitHub HTTPS / SSH，沿用本机 Git 权限。保存后在 Skills 中手动同步。")}</p>
        <footer><button type="button" className="settings-action-button" disabled={locked} onClick={() => setEditor(null)}>{l("Cancel", "取消")}</button><button type="submit" className="settings-action-button is-primary" disabled={locked}>{l("Save repository", "保存仓库")}</button></footer>
      </form>}
      {!teams.length && editor !== "team" && <p className="team-settings-empty">{l("Connect an existing team repository to get started.", "粘贴已有的团队仓库地址，即可开始配置。")}</p>}
      {teams.map((team) => <div className="team-settings-item" key={team.id}><span className="team-settings-item-icon"><GitBranch size={16} /></span><div className="team-settings-item-copy"><strong>{team.name}</strong><small title={team.repository}>{team.repository}</small></div></div>)}
    </section>
    <p className="team-settings-footnote">{enabled ? l("Open the Team scope, choose a team, then create or open a project.", "连接后，进入「团队」范围，选择团队，再创建或打开项目。") : l("Team features are off. Saved repositories and local installations are kept.", "团队功能已关闭，仓库配置和已有本地安装会保留。")}</p>
  </section>;
}
