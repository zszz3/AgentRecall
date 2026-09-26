import { useEffect, useRef, useState } from "react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { TeamSessionPreview } from "../../../../shared/team-sessions";
import type { LanguageMode } from "../../language";
import { TeamSessionContentView } from "./team-session-content";

export function TeamSessionShareDialog({ sessionKey, language, onClose, api = window.sessionSearch.teamWorkspace }: { sessionKey: string; language: LanguageMode; onClose(): void; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false);
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [projectId, setProjectId] = useState("");
  const [preview, setPreview] = useState<TeamSessionPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const config = snapshot?.config;
  const choices = (config?.projects ?? []).flatMap((project) => {
    const team = config?.teams.find((entry) => entry.id === (project.teamId === undefined ? config.defaultTeamId : project.teamId));
    return team && project.repository ? [{ project, team }] : [];
  });
  const selected = choices.find((entry) => entry.project.id === projectId) ?? choices[0];
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void api.request({ action: "snapshot" }).then((reply) => {
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") setSnapshot(reply.data.value);
    }).catch(() => { if (alive.current) setError(l("Could not load team settings.", "无法读取团队设置，请关闭后重试。")); });
    return () => { alive.current = false; void api.request({ action: "cancel-sync" }).catch(() => undefined); };
  }, [api]);
  async function run(publish: boolean) {
    if (running.current || !selected || !config?.teamEnabled || (publish && !preview)) return;
    running.current = true; setBusy(true); setError("");
    const scope = { projectId: selected.project.id, root: selected.project.root, repository: selected.team.repository };
    try {
      const reply = await api.request(publish && preview ? { action: "session-publish", scope, token: preview.token } : { action: "session-preview", scope, sessionKey });
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); if (reply.error.code === "TEAM_PREVIEW_EXPIRED") setPreview(null); }
      else if (reply.data.kind === "session-preview") setPreview(reply.data.value);
      else if (reply.data.kind === "complete") { setDone(reply.data.message); setPreview(null); }
    } catch { if (alive.current) setError(l("Request failed. Keep this preview and retry, or refresh the team list to check the result.", "请求未确认。可保留预览重试，或刷新团队列表核对结果。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Share to team", "分享到团队")} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><h2>{l("Share to team", "分享到团队")}</h2><button disabled={busy} onClick={onClose}>{l("Close", "关闭")}</button></header>
      <p>{l("Share a full snapshot, including conversation, tool events, available source files and attachments. Check the contents before confirming. A private team repository is required.", "分享完整快照，包括对话、工具事件、可读取的源文件和附件。确认前请检查内容；需要使用私有团队仓库。")}</p>
      {busy && <button onClick={() => { void api.request({ action: "cancel-sync" }).then(() => { if (alive.current) setError(l("Cancelled. If an upload was already sent, refresh the team list to check its result.", "已取消等待。如果上传请求已经发出，请刷新团队会话列表核对结果。")); }).catch(() => { if (alive.current) setError(l("Could not confirm cancellation. Wait for the request to finish.", "取消未确认，请等待当前请求结束。")); }); }}>{l("Cancel operation", "取消操作")}</button>}
      {error && <p className="team-workspace-error" role="alert">{error}</p>}
      {done ? <p className="team-workspace-notice" role="status">{done}</p> : !snapshot ? <p role="status">{l("Loading…", "正在读取…")}</p> : !config?.teamEnabled ? <p className="team-workspace-notice">{l("Enable teams in Settings first. This session has not been uploaded.", "请先在设置中开启团队功能，这条会话尚未上传。")}</p> : !selected ? <p className="team-workspace-notice">{l("Create a team project linked to a GitHub code repository first.", "请先在团队空间创建项目并关联 GitHub 代码仓库。")}</p> : <>
        <label>{l("Destination project", "分享目标")}<select disabled={busy} value={selected.project.id} onChange={(event) => { setProjectId(event.currentTarget.value); setPreview(null); setError(""); }}>{choices.map(({ project, team }) => <option key={project.id} value={project.id}>{team.name} / {project.name}</option>)}</select></label>
        <small>{selected.team.repository} · {selected.project.repository}</small>
        {preview && <TeamSessionContentView content={preview} language={language} />}
        <footer className="team-space-actions"><button disabled={busy || snapshot.busy} onClick={() => void run(false)}>{busy ? l("Working…", "正在处理…") : preview ? l("Rebuild preview", "重新预览") : l("Preview full session", "预览完整会话")}</button>{preview && <button className="is-primary" disabled={busy || snapshot.busy} onClick={() => void run(true)}>{l("Confirm sharing…", "确认分享…")}</button>}</footer>
      </>}
    </section>
  </dialog>;
}
