import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentRole, AgentRoleChange } from "@agentrecall/workspace-core";
import { agentRoleChangeSchema } from "../../../../../../../packages/workspace-core/src/agent-roles";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import type { LanguageMode } from "../../language";
import { ROLE_RUNTIMES, roleFromAgent } from "./team-agent-roles";

type Option = { id: string; name: string };
const list = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

export function TeamAgentRoleEditor({ initial, roleIds, skills, mcpServers, localAgents, language, onStage, onClose }: {
  initial: AgentRole | null; roleIds: string[]; skills: Option[]; mcpServers: Option[]; localAgents: ConfiguredAgent[]; language: LanguageMode;
  onStage(change: AgentRoleChange): Promise<void>; onClose(): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false);
  const [value, setValue] = useState<AgentRoleChange["value"]>(() => initial
    ? { id: initial.id, name: initial.name, description: initial.description, content: initial.content, model: initial.model, skills: initial.skills, mcpServers: initial.mcpServers, tags: initial.tags }
    : { id: `role-${crypto.randomUUID().slice(0, 8)}`, name: "", description: "", content: "", model: { runtime: "codex" }, skills: [], mcpServers: [], tags: [] });
  const [tools, setTools] = useState(() => Object.fromEntries(value.mcpServers.map(item => [item.id, (item.tools ?? []).join(", ")])));
  const [tags, setTags] = useState(value.tags.join(", "));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; element?.showModal();
    element?.querySelector<HTMLInputElement>('input[name="role-name"]')?.focus();
    return () => { alive.current = false; element?.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);
  const set = (patch: Partial<AgentRoleChange["value"]>) => setValue(current => ({ ...current, ...patch }));
  const toggle = <T,>(items: T[], item: T, on: boolean, key: (entry: T) => string) => on ? [...items.filter(entry => key(entry) !== key(item)), item] : items.filter(entry => key(entry) !== key(item));
  async function save() {
    if (busy) return;
    setError("");
    const model = { runtime: value.model.runtime, ...(value.model.family?.trim() ? { family: value.model.family.trim() } : {}), ...(value.model.reasoningEffort?.trim() ? { reasoningEffort: value.model.reasoningEffort.trim() } : {}) };
    const mcp = value.mcpServers.map(item => { const names = list(tools[item.id] ?? ""); return names.length ? { id: item.id, tools: names } : { id: item.id }; });
    const parsed = agentRoleChangeSchema.safeParse({ kind: "agentRoles", operation: initial ? "update" : "create", value: { ...value, id: value.id.trim(), model, mcpServers: mcp, tags: list(tags) } });
    if (!parsed.success) { setError(l("Check the identifier, name, description, instructions, reasoning effort (lowercase letters), tool names and tags (up to 16, no duplicates).", "请检查标识、名称、说明、角色指令、推理强度（小写字母）、工具名和标签（最多 16 个且不重复）。")); return; }
    setBusy(true);
    try { await onStage(parsed.data); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not save. Try again.", "保存失败，请重试。")); }
    finally { if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog team-configuration-editor" aria-label={initial ? l("Edit Agent role", "编辑 Agent 角色") : l("Add Agent role", "新增 Agent 角色")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><div><h2>{initial ? l("Edit Agent role", "编辑 Agent 角色") : l("Add Agent role", "新增 Agent 角色")}</h2><p>{l("Saved to the local workspace first. Publish it with Push.", "先保存到本地共享空间，再通过 Push 发布。")}</p></div><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Close editor", "关闭编辑")} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="team-workspace-error">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        {!initial && localAgents.length > 0 && <label>{l("Start from a local Agent", "从本机 Agent 填充")}<select disabled={busy} defaultValue="" onChange={event => { const agent = localAgents.find(item => item.id === event.currentTarget.value); if (!agent) return; const next = roleFromAgent(agent, roleIds); setValue(next); setTags(next.tags.join(", ")); setTools({}); }}><option value="">{l("Choose an Agent…", "选择 Agent…")}</option>{localAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>{l("Copies the name, description, instructions, runtime and model name. Channels and keys stay on this machine.", "复制名称、说明、指令、运行时和模型名；渠道与密钥不会上传。")}</small></label>}
        <div className="team-editor-fields">
          <label>{l("Identifier", "标识")}<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={64} value={value.id} disabled={busy || Boolean(initial)} onChange={event => set({ id: event.currentTarget.value })} /></label>
          <label>{l("Name", "名称")}<input name="role-name" required maxLength={200} value={value.name} disabled={busy} onChange={event => set({ name: event.currentTarget.value })} /></label>
        </div>
        <label>{l("Description", "说明")}<input required maxLength={4096} value={value.description} disabled={busy} onChange={event => set({ description: event.currentTarget.value })} placeholder={l("What this role is responsible for", "这个角色负责什么")} /></label>
        <div className="team-editor-fields">
          <label>{l("Runtime", "运行时")}<select value={value.model.runtime} disabled={busy} onChange={event => set({ model: { ...value.model, runtime: event.currentTarget.value } })}>{ROLE_RUNTIMES.map(runtime => <option key={runtime} value={runtime}>{runtime}</option>)}</select></label>
          <label>{l("Model family", "模型系列")}<input maxLength={128} value={value.model.family ?? ""} disabled={busy} placeholder="gpt-5 / sonnet" onChange={event => set({ model: { ...value.model, family: event.currentTarget.value } })} /></label>
          <label>{l("Reasoning effort", "推理强度")}<input maxLength={16} value={value.model.reasoningEffort ?? ""} disabled={busy} placeholder="high" onChange={event => set({ model: { ...value.model, reasoningEffort: event.currentTarget.value } })} /></label>
        </div>
        <small>{l("Only the runtime and model name are shared. Each member picks a local channel when enabling the role.", "只共享运行时和模型名；成员启用角色时各自选择本机渠道。")}</small>
        <label>{l("Role instructions", "角色指令")}<textarea required rows={10} value={value.content} disabled={busy} onChange={event => set({ content: event.currentTarget.value })} placeholder={l("You are the team's code reviewer…", "你是团队的代码审查员…")} /></label>
        <fieldset><legend>Skills</legend>{skills.length ? <div className="team-space-actions">{skills.map(skill => <label className="team-client-chip" key={skill.id}><input type="checkbox" disabled={busy} checked={value.skills.includes(skill.id)} onChange={event => set({ skills: toggle(value.skills, skill.id, event.currentTarget.checked, item => item) })} /><span>{skill.name}</span></label>)}</div> : <small>{l("This team has no Skills yet.", "团队还没有 Skill。")}</small>}</fieldset>
        <fieldset><legend>MCP</legend>{mcpServers.length ? mcpServers.map(server => { const on = value.mcpServers.some(item => item.id === server.id); return <div className="team-editor-variable" key={server.id}><label className="team-client-chip"><input type="checkbox" disabled={busy} checked={on} onChange={event => set({ mcpServers: toggle(value.mcpServers, { id: server.id }, event.currentTarget.checked, item => item.id) })} /><span>{server.name}</span></label>{on && <input aria-label={l("Allowed tools for ", "允许的工具：") + server.name} disabled={busy} value={tools[server.id] ?? ""} placeholder={l("All tools; or comma-separated names", "留空表示全部工具；或用逗号分隔")} onChange={event => { const text = event.currentTarget.value; setTools(current => ({ ...current, [server.id]: text })); }} />}</div>; }) : <small>{l("This team has no MCP servers yet.", "团队还没有 MCP 服务。")}</small>}</fieldset>
        <label>{l("Tags", "标签")}<input value={tags} disabled={busy} placeholder="review, backend" onChange={event => setTags(event.currentTarget.value)} /></label>
        <footer className="team-space-actions"><button type="button" disabled={busy} onClick={onClose}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={busy}>{busy ? l("Saving…", "正在保存…") : l("Save locally", "保存到共享空间")}</button></footer>
      </form>
    </section>
  </dialog>;
}
