import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { TeamPushDraft } from "../../../../shared/team-push";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { TeamPushDialog } from "./team-push-dialog";

/** Opens the shared Push flow without navigating away from the local session. */
export function TeamUploadDialog({ language, drafts, onClose, onPushed, onOpenSettings, api = window.sessionSearch.teamWorkspace }: {
  language: LanguageMode; drafts: TeamPushDraft[]; onClose(): void; onPushed(keys: string[]): void; onOpenSettings(): void; api?: TeamWorkspaceApi;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null), [teamId, setTeamId] = useState<string>();
  const [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true;
    setError("");
    void api.request({ action: "snapshot" }).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") {
        setSnapshot(reply.data.value);
        const teams = reply.data.value.config?.teams ?? [];
        if (teams.length === 1 && reply.data.value.config?.teamEnabled) setTeamId(teams[0]!.id);
      }
    }).catch(() => { if (active) setError(l("Could not load teams. Retry to continue.", "无法读取团队，请重试。")); });
    return () => { active = false; };
  }, [api, retry]);
  const team = snapshot?.config?.teams.find(entry => entry.id === teamId);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    if (!team) element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [team]);
  if (team && snapshot) return <TeamPushDialog selection={{ team, enabled: Boolean(snapshot.config?.teamEnabled), busy: snapshot.busy }} directories={[]} drafts={drafts} language={language} api={api} onClose={onClose} onBusy={setBusy} onPublished={onPushed} />;
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Upload to team", "上传到团队")} onCancel={event => { event.preventDefault(); onClose(); }}><section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Upload to team", "上传到团队")}</h2><p>{l("Choose a destination. Nothing has been uploaded.", "选择上传目标，当前内容尚未上传。")}</p></div><button className="team-icon-button" aria-label={l("Close upload", "关闭上传")} onClick={onClose}><X size={18} /></button></header>
    {error ? <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></p> : !snapshot ? <p role="status">{l("Loading teams…", "正在读取团队…")}</p> : !snapshot.config?.teamEnabled || !snapshot.config.teams.length ? <p>{l("Enable and connect a team in Settings to upload.", "请先在设置中开启并连接团队。 ")}<button onClick={onOpenSettings}>{l("Team settings", "团队设置")}</button></p> : <div className="team-project-list">{snapshot.config.teams.map(entry => <button className="team-project-row" key={entry.id} onClick={() => setTeamId(entry.id)}><span><strong>{entry.name}</strong><small>{entry.repository.replace("https://github.com/", "")}</small></span></button>)}</div>}
  </section></dialog>;
}
