import { useEffect, useState } from "react";
import { Bot, Layers, Pencil, Plus, X } from "lucide-react";
import type { AgentRole, AgentRoleChange } from "@agentrecall/workspace-core";
import type { AppSnapshot } from "../../../../automation/contracts";
import type { AutomationApi } from "../../../../preload/automation";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamAgentRoleEditor } from "./team-agent-role-editor";

/** Local Agents only prefill a new role; roles are never turned back into local Agents. */
export type RoleAutomationApi = Pick<AutomationApi, "getSnapshot">;

export function TeamAgentRolesPanel({ selection, language, refreshKey, api, automation = window.sessionSearch.automation, onStage }: {
  selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi; automation?: RoleAutomationApi; onStage(change: AgentRoleChange): Promise<void>;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [localAgents, setLocalAgents] = useState<AppSnapshot["configuredAgents"]>([]);
  const [readerId, setReaderId] = useState<string | null>(null), [editor, setEditor] = useState<AgentRole | null | undefined>(undefined);
  useEffect(() => {
    let active = true; setCatalog(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load roles.", "角色读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry]);
  useEffect(() => {
    let active = true;
    // Local Agents only offer a starting point in the role editor, so a failed read just leaves that list empty.
    void automation.getSnapshot().then(snapshot => { if (active) setLocalAgents(snapshot.configuredAgents.filter(agent => !agent.managed)); }, () => undefined);
    return () => { active = false; };
  }, [automation, refreshKey]);
  const assets = catalog?.assets;
  const roles = assets?.agentRoles ?? [];
  const skillName = (id: string) => assets?.skills.find(item => item.id === id)?.id ?? id;
  const mcpName = (id: string) => assets?.configuration.mcpServers.find(item => item.id === id)?.name ?? id;
  const reader = roles.find(role => role.id === readerId) ?? null;
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={event => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReaderId(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Agent roles", "Agent 角色")}>
      <header className="team-workspace-head"><div><h2>{l("Agent roles", "Agent 角色")} {assets && <span className="team-count">{roles.length}</span>}</h2><p>{l("How the team divides work: each role names its instructions, model, Skills and MCP. Working directories can install only the Skills of selected roles.", "团队的分工：每个角色写明指令、模型、Skill 与 MCP；工作目录可以只安装所选角色用到的 Skill。")}</p></div><button className="is-primary" disabled={!enabled || selection.busy || !assets} title={!assets ? l("Pull first", "请先Pull 拉取") : undefined} onClick={() => setEditor(null)}><Plus size={15} />{l("Add role", "新增角色")}</button></header>
      {!enabled ? <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        {roles.map(role => <button className="team-resource-row" key={role.id} aria-pressed={readerId === role.id} onClick={() => setReaderId(role.id)}><Bot size={17} /><span><strong>{role.name}</strong><small>{[role.model.runtime, role.model.family, role.skills.length ? `${role.skills.length} Skills` : "", role.mcpServers.length ? `${role.mcpServers.length} MCP` : ""].filter(Boolean).join(" · ")}</small></span><span>{l("View", "查看")}</span></button>)}
        {assets && !roles.length && <div className="team-empty"><Bot size={26} /><strong>{l("No Agent roles yet", "还没有 Agent 角色")}</strong><p>{l("Add a role, or start from one of your local Agents.", "可以新增角色，或从本机 Agent 填充后发布。")}</p></div>}
        {roles.length > 0 && assets!.skills.length > 0 && <details className="team-role-matrix"><summary>{l("Skills by role", "Skill 角色矩阵")}</summary>
          <table aria-label={l("Skills by role", "Skill 角色矩阵")}><thead><tr><th scope="col">Skill</th>{roles.map(role => <th scope="col" key={role.id}>{role.name}</th>)}</tr></thead>
            <tbody>{assets!.skills.map(skill => <tr key={skill.id}><th scope="row">{skill.id}</th>{roles.map(role => <td key={role.id} aria-label={`${skill.id} · ${role.name}: ${role.skills.includes(skill.id) ? l("used", "使用") : l("not used", "未使用")}`}>{role.skills.includes(skill.id) ? "●" : ""}</td>)}</tr>)}</tbody></table>
          <p className="team-footnote">{l("Edit a role to change its Skills. Under Working directories, a directory can install only the Skills of selected roles.", "编辑角色可调整其 Skill；在「工作目录」中可让某个目录只安装所选角色用到的 Skill。")}{assets!.skills.some(skill => !roles.some(role => role.skills.includes(skill.id))) ? l(" Skills used by no role are installed only in directories without a role selection.", "未被任何角色使用的 Skill，只会安装到未按角色筛选的目录。") : ""}</p>
        </details>}
        {(assets?.workConfigs ?? []).length > 0 && <section aria-label={l("Legacy work configurations", "旧版工作配置")}>
          <p className="team-footnote">{l("Legacy work configurations are read-only Skill bundles; recreate them as roles to add instructions and a model.", "旧版工作配置只包含 Skill 列表，仅供查看；如需指令和模型，请改建为角色。")}</p>
          {assets!.workConfigs.map(config => <div className="team-resource-row" key={config.id}><Layers size={17} /><span><strong>{config.name}</strong><small>{config.skills.join("、") || config.description}</small></span><span>{l("Read-only", "只读")}</span></div>)}
        </section>}
      </>}
    </section>
    {reader && <aside tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Role details", "角色详情")}>
      <header className="team-document-reader-head"><div><small>{[reader.model.runtime, reader.model.family, reader.model.reasoningEffort].filter(Boolean).join(" · ")}</small><h3>{reader.name}</h3></div><div className="team-space-actions">
        <button disabled={selection.busy} onClick={() => setEditor(reader)}><Pencil size={14} />{l("Edit", "编辑")}</button>
        <button className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReaderId(null)}><X size={17} /></button></div></header>
      <div className="team-document-reader-body">
        <p>{reader.description}</p>
        <dl className="team-role-facts">
          <dt>Skills</dt><dd>{reader.skills.length ? reader.skills.map(skillName).join("、") : l("None", "无")}</dd>
          <dt>MCP</dt><dd>{reader.mcpServers.length ? reader.mcpServers.map(item => `${mcpName(item.id)}${item.tools ? ` (${item.tools.join(", ")})` : ""}`).join("、") : l("None", "无")}</dd>
          {reader.tags.length > 0 && <><dt>{l("Tags", "标签")}</dt><dd>{reader.tags.join("、")}</dd></>}
        </dl>
        <pre>{reader.content}</pre>
      </div>
    </aside>}
    {editor !== undefined && assets && <TeamAgentRoleEditor initial={editor} roleIds={roles.map(role => role.id)} skills={assets.skills.map(skill => ({ id: skill.id, name: skill.id }))} mcpServers={assets.configuration.mcpServers.map(item => ({ id: item.id, name: item.name }))} localAgents={localAgents} language={language} onClose={() => setEditor(undefined)} onStage={async change => { await onStage(change); setEditor(undefined); }} />}
  </div>;
}

