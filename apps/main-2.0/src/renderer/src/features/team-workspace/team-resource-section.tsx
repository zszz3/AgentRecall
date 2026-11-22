import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { TeamSnapshot } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { Button, EmptyState } from "../../ui/primitives";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamConfigurationPanel, type TeamResourceCopy } from "./team-configuration-panel";
import { TeamResourceImportDialog } from "./team-resource-import-dialog";

export type TeamResourceKind = "instructions" | "mcp" | "skills";

/**
 * The team's part of a resource page. Edits are saved to the team's local working copy only;
 * publishing stays in the team space, where Push shows the diff and applies review rules.
 */
export function TeamResourceSection({ kind, language, onOpenTeamSpace, copy, onSkillCopied, api = window.sessionSearch.teamWorkspace }: {
  kind: TeamResourceKind; language: LanguageMode; onOpenTeamSpace?(): void;
  /** How the page copies a team instruction or MCP server into the member's own resources. */
  copy?: TeamResourceCopy;
  onSkillCopied?(): void;
  api?: TeamWorkspaceApi;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null), [error, setError] = useState("");
  const [teamId, setTeamId] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0), [pending, setPending] = useState(0);
  const [editingBusy, setEditingBusy] = useState(false), [importing, setImporting] = useState(false), [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let active = true;
    void api.request({ action: "snapshot" }).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "snapshot") { setSnapshot(reply.data.value); setError(""); }
    }).catch(() => { if (active) setError(l("Could not load teams. Try again.", "团队读取失败，请重试。")); });
    return () => { active = false; };
  }, [api]);
  const teams = snapshot?.config?.teams ?? [];
  const team = teams.find(entry => entry.id === teamId) ?? teams.find(entry => entry.id === snapshot?.config?.defaultTeamId) ?? teams[0];
  useEffect(() => {
    if (!team) return;
    let active = true;
    // The count only points to Push; a failed read leaves the previous count instead of blocking the page.
    void api.request({ action: "workspace-changes", scope: { teamId: team.id, repository: team.repository } }).then(reply => {
      if (active && reply.ok && reply.data.kind === "workspace-changes") setPending(reply.data.value.length);
    }, () => undefined);
    return () => { active = false; };
  }, [api, team?.id, team?.repository, refreshKey]);

  if (error) return <p role="alert" className="ui-notice ui-notice-error">{error}</p>;
  if (!snapshot) return <p role="status" className="team-embedded-status">{l("Loading teams…", "正在读取团队…")}</p>;
  if (!team) return <EmptyState
    title={l("No team connected", "还没有连接团队")}
    description={l("Connect a team repository in the team space to share this with your team.", "在团队空间连接团队仓库后，这里会显示团队共享的内容。")}
    action={onOpenTeamSpace ? <Button size="sm" onClick={onOpenTeamSpace}>{l("Open team space", "打开团队空间")}</Button> : undefined}
  />;

  const directories = (snapshot.directories ?? []).filter(entry => entry.teamId === team.id);
  const selection = { team, enabled: Boolean(snapshot.config?.teamEnabled), busy: snapshot.busy || editingBusy };
  const saved = () => {
    setRefreshKey(value => value + 1);
    setNotice(l("Saved to this team's local copy. Push it from the team space to publish.", "已保存到这个团队的本地副本，在团队空间 Push 后才会发布。"));
  };
  const stage = async (change: ConfigurationChange) => {
    const reply = await api.request({ action: "workspace-stage", scope: { teamId: team.id, repository: team.repository }, items: [{ kind: "configuration", key: `${change.kind}:${change.value.name}`, change }] });
    if (!reply.ok) throw new Error(reply.error.message);
    if (alive.current) saved();
  };
  return <div className="team-space-page team-embedded" data-team-kind={kind}>
    <div className="team-embedded-bar">
      {teams.length > 1
        ? <label className="team-embedded-team"><span>{l("Team", "团队")}</span><select value={team.id} onChange={event => { setTeamId(event.currentTarget.value); setNotice(""); }}>{teams.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        : <span className="team-embedded-team">{team.name}</span>}
      {pending > 0 && <span className="team-embedded-pending">{l(`${pending} local change${pending === 1 ? "" : "s"} not pushed`, `${pending} 项本地修改尚未 Push`)}</span>}
      <span className="team-embedded-actions">
        {kind === "skills" && <Button size="sm" icon={<Plus size={14} />} disabled={selection.busy || !selection.enabled} onClick={() => setImporting(true)}>{l("Add from working directories", "从工作目录添加")}</Button>}
        {onOpenTeamSpace && <Button size="sm" variant="ghost" onClick={onOpenTeamSpace}>{l("Push in team space", "去团队空间 Push")}</Button>}
      </span>
    </div>
    {notice && <p role="status" className="ui-notice ui-notice-success">{notice}</p>}
    {importing && <TeamResourceImportDialog selection={selection} directories={directories} language={language} api={api} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); saved(); }} />}
    {kind === "skills"
      ? <TeamAssetsPanel key={team.id} onCopied={onSkillCopied} onFoldersChanged={() => setRefreshKey(value => value + 1)} selection={selection} refreshKey={refreshKey} language={language} api={api} />
      : <TeamConfigurationPanel key={team.id} kind={kind} copy={copy} onStage={stage} onBusy={setEditingBusy} onFoldersChanged={() => setRefreshKey(value => value + 1)} selection={selection} refreshKey={refreshKey} language={language} api={api} />}
  </div>;
}
