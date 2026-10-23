import { useEffect, useRef, useState } from "react";
import { Bot, Pencil, Plus, Power, X } from "lucide-react";
import type { AgentRole, AgentRoleChange } from "@agentrecall/workspace-core";
import type { AppSnapshot } from "../../../../automation/contracts";
import type { AutomationApi } from "../../../../preload/automation";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamAgentRoleEditor } from "./team-agent-role-editor";
import { enableTeamRole, localRoleState, suggestRoleModel, type RoleModelChoice } from "./team-agent-roles";

export type RoleAutomationApi = Pick<AutomationApi, "getSnapshot" | "saveConfiguredAgents">;
type Agents = Pick<AppSnapshot, "configuredAgents" | "channels">;

export function TeamAgentRolesPanel({ selection, language, refreshKey, api, automation = window.sessionSearch.automation, onStage }: {
  selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi; automation?: RoleAutomationApi; onStage(change: AgentRoleChange): Promise<void>;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [local, setLocal] = useState<Agents | null>(null), [localError, setLocalError] = useState("");
  const [readerId, setReaderId] = useState<string | null>(null), [editor, setEditor] = useState<AgentRole | null | undefined>(undefined), [enabling, setEnabling] = useState<AgentRole | null>(null);
  const [notice, setNotice] = useState("");
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
    void automation.getSnapshot().then(snapshot => { if (active) { setLocal({ configuredAgents: snapshot.configuredAgents, channels: snapshot.channels }); setLocalError(""); } })
      .catch(() => { if (active) setLocalError(l("Local Agents could not be read; roles can still be browsed.", "本机 Agent 读取失败，仍可浏览角色。")); });
    return () => { active = false; };
  }, [automation, refreshKey]);
  const assets = catalog?.assets;
  const roles = assets?.agentRoles ?? [];
  const skillName = (id: string) => assets?.skills.find(item => item.id === id)?.id ?? id;
  const mcpName = (id: string) => assets?.configuration.mcpServers.find(item => item.id === id)?.name ?? id;
  const reader = roles.find(role => role.id === readerId) ?? null;
  const state = (role: AgentRole) => local ? localRoleState(local.configuredAgents, team.id, role) : null;
  const badge = (role: AgentRole) => { const status = state(role)?.status; return status === "enabled" ? l("Enabled", "已启用") : status === "changed" ? l("Local copy differs", "本机副本不同") : status === "disabled" ? l("Not enabled", "未启用") : ""; };
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={event => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReaderId(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Agent roles", "Agent 角色")}>
      <header className="team-workspace-head"><div><h2>{l("Agent roles", "Agent 角色")} {assets && <span className="team-count">{roles.length}</span>}</h2><p>{l("Shared Agent definitions: instructions, runtime, Skills and MCP. Each member enables them with a local channel.", "团队共用的 Agent 定义：指令、运行时、Skill 与 MCP；成员用自己的本机渠道启用。")}</p></div><button className="is-primary" disabled={!enabled || selection.busy || !assets} title={!assets ? l("Pull first", "请先Pull 拉取") : undefined} onClick={() => setEditor(null)}><Plus size={15} />{l("Add role", "新增角色")}</button></header>
      {notice && <p role="status" className="team-workspace-notice">{notice}</p>}
      {localError && <p className="team-workspace-notice">{localError}</p>}
      {!enabled ? <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        {roles.map(role => <button className="team-resource-row" key={role.id} aria-pressed={readerId === role.id} onClick={() => setReaderId(role.id)}><Bot size={17} /><span><strong>{role.name}</strong><small>{[role.model.runtime, role.model.family, role.skills.length ? `${role.skills.length} Skills` : "", role.mcpServers.length ? `${role.mcpServers.length} MCP` : ""].filter(Boolean).join(" · ")}</small></span><span>{badge(role)}</span></button>)}
        {assets && !roles.length && <div className="team-empty"><Bot size={26} /><strong>{l("No Agent roles yet", "还没有 Agent 角色")}</strong><p>{l("Add a role, or start from one of your local Agents.", "可以新增角色，或从本机 Agent 填充后发布。")}</p></div>}
        {(catalog.assets?.workConfigs ?? []).length > 0 && <p className="team-footnote">{l("Legacy work configurations are read-only Skill bundles; recreate them as roles to add instructions.", "旧版工作配置仅包含 Skill 列表且为只读；如需指令请改建为角色。")}</p>}
      </>}
    </section>
    {reader && <aside tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Role details", "角色详情")}>
      <header className="team-document-reader-head"><div><small>{[reader.model.runtime, reader.model.family, reader.model.reasoningEffort].filter(Boolean).join(" · ")}</small><h3>{reader.name}</h3></div><div className="team-space-actions">
        <button disabled={selection.busy || !local} onClick={() => setEnabling(reader)}><Power size={14} />{state(reader)?.status === "disabled" ? l("Enable locally", "启用到本机") : l("Update local Agent", "更新本机 Agent")}</button>
        <button disabled={selection.busy} onClick={() => setEditor(reader)}><Pencil size={14} />{l("Edit", "编辑")}</button>
        <button className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReaderId(null)}><X size={17} /></button></div></header>
      <div className="team-document-reader-body">
        <p>{reader.description}</p>
        <dl className="team-role-facts">
          <dt>Skills</dt><dd>{reader.skills.length ? reader.skills.map(skillName).join("、") : l("None", "无")}</dd>
          <dt>MCP</dt><dd>{reader.mcpServers.length ? reader.mcpServers.map(item => `${mcpName(item.id)}${item.tools ? ` (${item.tools.join(", ")})` : ""}`).join("、") : l("None", "无")}</dd>
          {reader.tags.length > 0 && <><dt>{l("Tags", "标签")}</dt><dd>{reader.tags.join("、")}</dd></>}
          <dt>{l("This machine", "本机")}</dt><dd>{badge(reader)}</dd>
        </dl>
        <pre>{reader.content}</pre>
      </div>
    </aside>}
    {editor !== undefined && assets && <TeamAgentRoleEditor initial={editor} roleIds={roles.map(role => role.id)} skills={assets.skills.map(skill => ({ id: skill.id, name: skill.id }))} mcpServers={assets.configuration.mcpServers.map(item => ({ id: item.id, name: item.name }))} localAgents={(local?.configuredAgents ?? []).filter(agent => !agent.managed)} language={language} onClose={() => setEditor(undefined)} onStage={async change => { await onStage(change); setEditor(undefined); }} />}
    {enabling && local && <EnableRoleDialog role={enabling} teamId={team.id} local={local} language={language} onClose={() => setEnabling(null)} onEnable={async choice => {
      const fresh = await automation.getSnapshot();
      const next = await automation.saveConfiguredAgents(enableTeamRole(fresh.configuredAgents, team.id, enabling, choice, Date.now()));
      setLocal({ configuredAgents: next.configuredAgents, channels: next.channels }); setEnabling(null);
      setNotice(l(`“${enabling.name}” is available under Agents. Pull installs its Skills and MCP into working directories.`, `“${enabling.name}”已出现在本机 Agent 列表中。它引用的 Skill 与 MCP 通过「Pull 拉取」安装到工作目录。`));
    }} />}
  </div>;
}

function EnableRoleDialog({ role, teamId, local, language, onClose, onEnable }: { role: AgentRole; teamId: string; local: Agents; language: LanguageMode; onClose(): void; onEnable(choice: RoleModelChoice): Promise<void> }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false);
  const current = localRoleState(local.configuredAgents, teamId, role);
  const [choice, setChoice] = useState<RoleModelChoice | null>(() => suggestRoleModel(role, local.channels, current.agent));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { alive.current = true; const element = dialog.current; element?.showModal(); return () => { alive.current = false; element?.close(); }; }, []);
  const channels = local.channels.filter(channel => channel.agentId === role.model.runtime && channel.models.length);
  const channel = channels.find(item => item.id === choice?.channelId);
  const model = channel?.models.find(item => item.id === choice?.modelId);
  async function submit() {
    if (!choice || busy) return;
    setBusy(true); setError("");
    try { await onEnable(choice); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not save the Agent.", "Agent 保存失败，请重试。")); }
    finally { if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Enable role locally", "启用角色到本机")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><div><h2>{l("Enable “", "启用“")}{role.name}{l("” locally", "”到本机")}</h2><p>{l("Written for ", "角色适用于 ")}{[role.model.runtime, role.model.family].filter(Boolean).join(" · ")}</p></div><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Close", "关闭")} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="team-workspace-error">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {!channels.length ? <p className="team-workspace-error" role="alert">{l(`No local ${role.model.runtime} channel with models. Add one in Runtime first.`, `本机没有可用的 ${role.model.runtime} 渠道。请先在“运行时”中添加渠道并获取模型。`)}</p> : <div className="team-editor-fields">
          <label>{l("Channel", "渠道")}<select disabled={busy} value={choice?.channelId ?? ""} onChange={event => { const next = channels.find(item => item.id === event.currentTarget.value); if (next) setChoice({ channelId: next.id, modelId: next.models[0]!.id }); }}>{channels.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>{l("Model", "模型")}<select disabled={busy} value={choice?.modelId ?? ""} onChange={event => { const modelId = event.currentTarget.value; setChoice(value => value && { channelId: value.channelId, modelId }); }}>{channel?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {model?.reasoningEfforts?.length ? <label>{l("Reasoning effort", "推理强度")}<select disabled={busy} value={choice?.reasoningEffort ?? ""} onChange={event => { const reasoningEffort = event.currentTarget.value || undefined; setChoice(value => value && { ...value, reasoningEffort }); }}><option value="">{l("Default", "默认")}</option>{model.reasoningEfforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label> : null}
        </div>}
        {current.status === "changed" && <p className="team-workspace-notice">{l("The local Agent from this role was edited or the team version changed. Updating replaces its name, description and instructions with the team version.", "本机由该角色创建的 Agent 已被修改，或团队版本已更新。继续将用团队版本覆盖其名称、说明与指令。")}</p>}
        <small>{l("Channels and keys stay on this machine. Skills and MCP referenced by the role are installed into working directories by Pull.", "渠道与密钥只保存在本机；角色引用的 Skill 与 MCP 由「Pull 拉取」安装到工作目录。")}</small>
        <footer className="team-space-actions"><button type="button" disabled={busy} onClick={onClose}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={busy || !choice}>{busy ? l("Saving…", "正在保存…") : current.status === "disabled" ? l("Enable", "启用") : l("Update local Agent", "更新本机 Agent")}</button></footer>
      </form>
    </section>
  </dialog>;
}
