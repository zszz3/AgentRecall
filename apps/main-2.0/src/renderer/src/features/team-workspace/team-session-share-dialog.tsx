import { useEffect, useRef, useState } from "react";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { TeamSessionPreview } from "../../../../shared/team-sessions";
import type { LanguageMode } from "../../language";
import { TeamSessionContentView } from "./team-session-content";

export function TeamSessionShareDialog({ sessionKey, turnIds, language, onClose, api = window.sessionSearch.teamWorkspace }: { sessionKey: string; turnIds?: string[]; language: LanguageMode; onClose(): void; api?: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false);
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [teamId, setTeamId] = useState("");
  const [preview, setPreview] = useState<TeamSessionPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const config = snapshot?.config;
  const choices = config?.teams ?? [];
  const selected = choices.find((team) => team.id === teamId) ?? choices[0];
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
    const scope = { teamId: selected.id, repository: selected.repository };
    try {
      const reply = await api.request(publish && preview ? { action: "session-publish", scope, token: preview.token } : { action: "session-preview", scope, sessionKey, ...(turnIds ? { turnIds } : {}) });
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); if (reply.error.code === "TEAM_PREVIEW_EXPIRED") setPreview(null); }
      else if (reply.data.kind === "session-preview") setPreview(reply.data.value);
      else if (reply.data.kind === "complete") { setDone(reply.data.message); setPreview(null); }
    } catch { if (alive.current) setError(l("Request failed. Keep this preview and retry, or refresh the team list to check the result.", "请求未确认。可保留预览重试，或刷新团队列表核对结果。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Share to team", "分享到团队")} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><h2>{l("Share to team", "分享到团队")}</h2><button disabled={busy} onClick={onClose}>{l("Close", "关闭")}</button></header>
      <p>{turnIds ? l(`Share ${turnIds.length} selected turns, including their messages, tool records and available attachments. Original session files and child sessions are excluded. Public and private team repositories are supported; shares in public repositories are accessible to anyone.`, `分享 ${turnIds.length} 个所选轮次，包含其中的消息、工具记录和可读取附件；不包含原始会话文件和子会话。支持公开和私有团队仓库；公开仓库中的分享可被任何人访问。`) : l("Share a full snapshot, including conversation, tool events, available source files and attachments. Check the contents before confirming. Public and private team repositories are supported; shares in public repositories are accessible to anyone.", "分享完整快照，包括对话、工具事件、可读取的源文件和附件。确认前请检查内容；支持公开和私有团队仓库；公开仓库中的分享可被任何人访问。")}</p>
      {busy && <button onClick={() => { void api.request({ action: "cancel-sync" }).then(() => { if (alive.current) setError(l("Cancelled. If an upload was already sent, refresh the team list to check its result.", "已取消等待。如果上传请求已经发出，请刷新团队会话列表核对结果。")); }).catch(() => { if (alive.current) setError(l("Could not confirm cancellation. Wait for the request to finish.", "取消未确认，请等待当前请求结束。")); }); }}>{l("Cancel operation", "取消操作")}</button>}
      {error && <p className="team-workspace-error" role="alert">{error}</p>}
      {done ? <p className="team-workspace-notice" role="status">{done}</p> : !snapshot ? <p role="status">{l("Loading…", "正在读取…")}</p> : !config?.teamEnabled ? <p className="team-workspace-notice">{l("Enable teams in Settings first. This session has not been uploaded.", "请先在设置中开启团队功能，这条会话尚未上传。")}</p> : !selected ? <p className="team-workspace-notice">{l("Connect a team repository in Settings first.", "请先在设置中连接团队仓库。")}</p> : <>
        <label>{l("Destination team", "分享目标")}<select disabled={busy} value={selected.id} onChange={(event) => { setTeamId(event.currentTarget.value); setPreview(null); setError(""); }}>{choices.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        <small>{selected.repository}</small>
        {preview && <TeamSessionContentView key={preview.token} content={preview} language={language} />}
        <footer className="team-space-actions"><button disabled={busy || snapshot.busy} onClick={() => void run(false)}>{busy ? l("Working…", "正在处理…") : preview ? l("Rebuild preview", "重新预览") : turnIds ? l("Preview selected turns", "预览所选轮次") : l("Preview full session", "预览完整会话")}</button>{preview && <button className="is-primary" disabled={busy || snapshot.busy} onClick={() => void run(true)}>{l("Confirm sharing…", "确认分享…")}</button>}</footer>
      </>}
    </section>
  </dialog>;
}
