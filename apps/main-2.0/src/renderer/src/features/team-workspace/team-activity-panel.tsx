import { useEffect, useRef, useState } from "react";
import { GitCommitHorizontal, LoaderCircle, RefreshCw, UserRound } from "lucide-react";
import type { TeamActivity } from "@agentrecall/workspace-core";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

const KINDS: Record<string, [string, string]> = { skills: ["Skill", "Skill"], documents: ["Document", "文档"], instructions: ["Instructions", "共享指令"], mcp: ["MCP", "MCP"], environment: ["Env", "Env"], organization: ["Folders", "资源文件夹"], agentRoles: ["Agent role", "Agent 角色"] };

/** Read-only view of who changed the team repository and what they changed. Reads remote history on open and on refresh. */
export function TeamActivityPanel({ selection, language, api }: { selection: TeamSelection; language: LanguageMode; api: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team } = selection;
  const [activity, setActivity] = useState<TeamActivity | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const version = useRef(0);
  useEffect(() => {
    let active = true; const current = ++version.current;
    setBusy(true); setError("");
    void api.request({ action: "activity", scope: { teamId: team.id, repository: team.repository } }).then(reply => {
      if (!active || current !== version.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "activity") setActivity(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not read team history. Check the network and repository access, then refresh.", "无法读取团队记录，请检查网络和仓库访问权限后刷新。")); })
      .finally(() => { if (active && current === version.current) setBusy(false); });
    return () => { active = false; };
  }, [api, team.id, team.repository, reload]);
  const describe = (change: string) => {
    const match = /^(add|update) ([a-zA-Z]+):(.+)$/.exec(change);
    if (!match) return change;
    const kind = KINDS[match[2]!] ?? [match[2]!, match[2]!];
    return `${match[1] === "add" ? l("Added", "新增") : l("Updated", "更新")} ${l(kind[0], kind[1])} ${match[3]}`;
  };
  return <section className="team-activity" aria-label={l("Members and activity", "成员与动态")}>
    <header className="team-activity-header">
      <p>{l("Access is managed on the Git host. Members here are the people who changed the team repository recently.", "访问权限由 Git 仓库管理；这里显示最近修改过团队仓库的成员。")}</p>
      <button type="button" className="team-text-button" disabled={busy} onClick={() => setReload(value => value + 1)}>{busy ? <LoaderCircle size={14} className="team-transfer-spinner" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{l("Refresh", "刷新")}</button>
    </header>
    {error && <p className="team-workspace-error" role="alert">{error}</p>}
    {activity && <div className="team-activity-body">
      <section aria-label={l("Members", "成员")}>
        <h3>{l("Members", "成员")} · {activity.members.length}</h3>
        {activity.members.map(member => <div className="team-resource-row" key={member.email}><UserRound size={17} /><span><strong>{member.name}</strong><small>{member.email}</small></span><span>{l(`${member.commits} changes · ${new Date(member.lastActive).toLocaleDateString()}`, `${member.commits} 次修改 · ${new Date(member.lastActive).toLocaleDateString()}`)}</span></div>)}
      </section>
      <section aria-label={l("Recent activity", "最近动态")}>
        <h3>{l("Recent activity", "最近动态")}</h3>
        <ol className="team-activity-timeline">
          {activity.entries.map(entry => <li key={entry.commit}>
            <GitCommitHorizontal size={15} aria-hidden="true" />
            <div><strong>{entry.author}</strong><time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleString()}</time>
              <ul>{entry.changes.map(change => <li key={change}>{entry.viaAgentRecall ? describe(change) : change}</li>)}</ul>
              {!entry.viaAgentRecall && <small>{entry.subject} · {l("changed outside AgentRecall", "在 AgentRecall 之外修改")}</small>}
            </div>
          </li>)}
        </ol>
        {activity.limited && <p className="team-footnote">{l("Showing the latest 100 changes. Open the repository on the Git host for older history.", "仅显示最近 100 次修改，更早记录请在 Git 仓库中查看。")}</p>}
      </section>
    </div>}
  </section>;
}
