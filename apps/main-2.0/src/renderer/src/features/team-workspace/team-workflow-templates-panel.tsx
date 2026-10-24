import { useEffect, useRef, useState } from "react";
import { Copy, LayoutTemplate, Plus, Upload, X } from "lucide-react";
import type { WorkflowTemplate, WorkflowTemplateChange } from "@agentrecall/workspace-core";
import { parseWorkflowTemplate, workflowTemplateChangeSchema } from "../../../../../../../packages/workspace-core/src/workflow-templates";
import type { AutomationApi } from "../../../../preload/automation";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import type { WorkflowDefinition } from "../../../../automation/engine/shared/workflow/model";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { templateFromWorkflow, workflowFromTemplate } from "./team-workflow-templates";

export type TemplateAutomationApi = Pick<AutomationApi, "getSnapshot" | "getWorkflowCore" | "saveWorkflowDefinition">;
type Local = { agents: ConfiguredAgent[]; workflows: WorkflowDefinition[] };

export function TeamWorkflowTemplatesPanel({ selection, language, refreshKey, api, automation = window.sessionSearch.automation, onStage }: {
  selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi; automation?: TemplateAutomationApi; onStage(change: WorkflowTemplateChange): Promise<void>;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [local, setLocal] = useState<Local | null>(null), [localError, setLocalError] = useState("");
  const [readerId, setReaderId] = useState<string | null>(null), [publishing, setPublishing] = useState<WorkflowTemplate | null | undefined>(undefined);
  const [notice, setNotice] = useState(""), [actionError, setActionError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; setCatalog(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load templates.", "模板读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry]);
  const loadLocal = async () => {
    const [snapshot, core] = await Promise.all([automation.getSnapshot(), automation.getWorkflowCore()]);
    const next = { agents: snapshot.configuredAgents, workflows: core.definitions.filter(item => !item.isTemplate) };
    setLocal(next); setLocalError("");
    return next;
  };
  useEffect(() => {
    let active = true;
    void Promise.all([automation.getSnapshot(), automation.getWorkflowCore()]).then(([snapshot, core]) => {
      if (active) { setLocal({ agents: snapshot.configuredAgents, workflows: core.definitions.filter(item => !item.isTemplate) }); setLocalError(""); }
    }).catch(() => { if (active) setLocalError(l("Local Agents and Workflows could not be read; templates can still be browsed.", "本机 Agent 与 Workflow 读取失败，仍可浏览模板。")); });
    return () => { active = false; };
  }, [automation, refreshKey]);
  const assets = catalog?.assets;
  const templates = assets?.workflowTemplates ?? [];
  const roleName = (id: string) => assets?.agentRoles.find(role => role.id === id)?.name ?? id;
  const reader = templates.find(item => item.id === readerId) ?? null;
  const graph = reader ? parseWorkflowTemplate(reader.content) : null;
  const summary = (template: WorkflowTemplate) => {
    const content = parseWorkflowTemplate(template.content);
    if (!content) return "";
    const roles = [...new Set(content.nodes.flatMap(node => node.role ? [roleName(node.role)] : []))];
    const scripts = content.nodes.filter(node => node.kind === "script").length;
    return [l(`${content.nodes.length} nodes`, `${content.nodes.length} 个节点`), roles.length ? roles.join("、") : "", scripts ? l(`${scripts} scripts`, `${scripts} 个脚本`) : ""].filter(Boolean).join(" · ");
  };
  async function useTemplate(template: WorkflowTemplate) {
    const content = parseWorkflowTemplate(template.content);
    if (!content || busy) return;
    setBusy(true); setActionError(""); setNotice("");
    try {
      const fresh = await loadLocal();
      const result = workflowFromTemplate(template, content, fresh.agents, team.id, team.repository);
      if (!result.definition) {
        setActionError(l(`Enable these roles under Agent roles first: ${result.missing.map(item => roleName(item.roleId)).join(", ")}.`, `请先在「Agent 角色」中启用这些角色：${result.missing.map(item => roleName(item.roleId)).join("、")}。`));
        return;
      }
      const saved = await automation.saveWorkflowDefinition(result.definition);
      await loadLocal();
      const scripts = content.nodes.some(node => node.kind === "script");
      setNotice(l(`Created the personal Workflow “${saved.name}”.${scripts ? " Review its scripts before the first run." : ""}`, `已创建个人 Workflow“${saved.name}”。${scripts ? "首次运行前需要在 Workflow 页确认其中的脚本。" : ""}`));
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : l("Could not create the Workflow.", "Workflow 创建失败，请重试。")); }
    finally { setBusy(false); }
  }
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={event => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReaderId(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Workflow templates", "Workflow 模板")}>
      <header className="team-workspace-head"><div><h2>{l("Workflow templates", "Workflow 模板")} {assets && <span className="team-count">{templates.length}</span>}</h2><p>{l("Shared Workflows whose Agent steps name team roles. Using one creates a personal copy with the Agents you enabled from those roles.", "团队共用的 Workflow，Agent 节点引用团队角色。使用模板会用你从这些角色启用的本机 Agent 创建一份个人副本。")}</p></div><button className="is-primary" disabled={!enabled || selection.busy || !assets || !local} title={!assets ? l("Pull first", "请先Pull 拉取") : undefined} onClick={() => setPublishing(null)}><Plus size={15} />{l("Publish a Workflow", "发布个人 Workflow")}</button></header>
      {notice && <p role="status" className="team-workspace-notice">{notice}</p>}
      {actionError && <p role="alert" className="team-workspace-error">{actionError}</p>}
      {localError && <p className="team-workspace-notice">{localError}</p>}
      {!enabled ? <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        {templates.map(template => <button className="team-resource-row" key={template.id} aria-pressed={readerId === template.id} onClick={() => setReaderId(template.id)}><LayoutTemplate size={17} /><span><strong>{template.name}</strong><small>{summary(template)}</small></span><span>{local?.workflows.some(item => item.origin?.teamId === team.id && item.origin.templateId === template.id) ? l("In use", "已使用") : ""}</span></button>)}
        {assets && !templates.length && <div className="team-empty"><LayoutTemplate size={26} /><strong>{l("No Workflow templates yet", "还没有 Workflow 模板")}</strong><p>{l("Publish a personal Workflow whose Agents were enabled from team roles.", "可以把使用团队角色 Agent 的个人 Workflow 发布为模板。")}</p></div>}
      </>}
    </section>
    {reader && <aside tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Template details", "模板详情")}>
      <header className="team-document-reader-head"><div><small>{summary(reader)}</small><h3>{reader.name}</h3></div><div className="team-space-actions">
        <button className="is-primary" disabled={busy || selection.busy || !graph || !local} onClick={() => void useTemplate(reader)}><Copy size={14} />{l("Use template", "使用模板")}</button>
        <button disabled={busy || selection.busy || !local} onClick={() => setPublishing(reader)}><Upload size={14} />{l("Update from a Workflow", "用个人 Workflow 更新")}</button>
        <button className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReaderId(null)}><X size={17} /></button></div></header>
      <div className="team-document-reader-body">
        {reader.description && <p>{reader.description}</p>}
        {!graph ? <p className="team-workspace-error">{l("This template cannot be read by this version.", "当前版本无法读取该模板。")}</p> : <ol className="team-template-nodes">
          {graph.nodes.map(node => <li key={node.id}><strong>{node.title}</strong><small>{node.kind === "script" ? `${l("Script", "脚本")} · ${node.runtime ?? ""}${node.permissions?.length ? ` · ${node.permissions.join(", ")}` : ""}` : node.role ? `${node.kind === "review" ? l("Review", "评审") : "Agent"} · ${roleName(node.role)}` : l("Approval", "人工审批")}</small>{node.kind === "script" && <pre>{node.source}</pre>}</li>)}
        </ol>}
      </div>
    </aside>}
    {publishing !== undefined && local && <PublishTemplateDialog initial={publishing} templateIds={templates.map(item => item.id)} local={local} teamId={team.id} roleName={roleName} language={language} onClose={() => setPublishing(undefined)} onStage={async change => { await onStage(change); setPublishing(undefined); }} />}
  </div>;
}

function PublishTemplateDialog({ initial, templateIds, local, teamId, roleName, language, onClose, onStage }: { initial: WorkflowTemplate | null; templateIds: string[]; local: Local; teamId: string; roleName(id: string): string; language: LanguageMode; onClose(): void; onStage(change: WorkflowTemplateChange): Promise<void> }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false);
  const [workflowId, setWorkflowId] = useState(() => local.workflows.find(item => item.origin?.teamId === teamId && item.origin.templateId === initial?.id)?.id ?? local.workflows[0]?.id ?? "");
  const [id, setId] = useState(initial?.id ?? `workflow-${crypto.randomUUID().slice(0, 8)}`), [name, setName] = useState(initial?.name ?? ""), [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { alive.current = true; const element = dialog.current; element?.showModal(); return () => { alive.current = false; element?.close(); }; }, []);
  const workflow = local.workflows.find(item => item.id === workflowId);
  const converted = workflow ? templateFromWorkflow(workflow, local.agents, teamId) : null;
  async function submit() {
    if (!workflow || !converted?.content || busy) return;
    const parsed = workflowTemplateChangeSchema.safeParse({ kind: "workflowTemplates", operation: templateIds.includes(id.trim()) ? "update" : "create", value: { id: id.trim(), name: name.trim() || workflow.name, description: description.trim(), content: converted.content } });
    if (!parsed.success) { setError(l("Check the identifier (lowercase letters, digits and dashes) and the Workflow contents.", "请检查标识（小写字母、数字与连字符）和 Workflow 内容。")); return; }
    setBusy(true); setError("");
    try { await onStage(parsed.data); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not save the template.", "模板保存失败，请重试。")); }
    finally { if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Publish a Workflow template", "发布 Workflow 模板")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><div><h2>{initial ? l("Update “", "更新“") + initial.name + l("”", "”") : l("Publish a Workflow template", "发布 Workflow 模板")}</h2><p>{l("Agent steps are saved as the team roles their Agents were enabled from; channels and local paths are not shared.", "Agent 节点保存为其 Agent 对应的团队角色；渠道和本机路径不会共享。")}</p></div><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Close", "关闭")} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="team-workspace-error">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {!local.workflows.length ? <p className="team-workspace-error" role="alert">{l("You have no personal Workflows yet. Create one on the Workflow page first.", "还没有个人 Workflow，请先在 Workflow 页创建。")}</p> : <div className="team-editor-fields">
          <label>Workflow<select disabled={busy} value={workflowId} onChange={event => { const next = local.workflows.find(item => item.id === event.currentTarget.value); setWorkflowId(event.currentTarget.value); if (next && !initial) { setName(next.name); setDescription(next.description); } }}>{local.workflows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>{l("Identifier", "标识")}<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={64} value={id} disabled={busy || Boolean(initial)} onChange={event => setId(event.currentTarget.value)} /></label>
          <label>{l("Name", "名称")}<input required maxLength={200} value={name} placeholder={workflow?.name} disabled={busy} onChange={event => setName(event.currentTarget.value)} /></label>
          <label>{l("Description", "说明")}<textarea rows={3} maxLength={4096} value={description} disabled={busy} onChange={event => setDescription(event.currentTarget.value)} /></label>
        </div>}
        {converted && !converted.content && <p role="alert" className="team-workspace-error">{l("These Agents were not enabled from a team role, so other members could not run them: ", "这些 Agent 不是从团队角色启用的，其他成员无法运行：")}{converted.missing.map(item => `${item.name}（${item.nodes.join("、")}）`).join("；")}{l(". Publish them as roles and enable them first.", "。请先把它们发布为角色并启用到本机。")}</p>}
        {converted?.content && workflow && <small>{l("Roles used: ", "使用的角色：")}{[...new Set(workflow.nodes.flatMap(node => node.kind === "agent" || node.kind === "review" ? [local.agents.find(agent => agent.id === node.agentId)?.tags.find(tag => tag.startsWith(`team-role:${teamId}/`))?.slice(`team-role:${teamId}/`.length) ?? ""] : []))].filter(Boolean).map(roleName).join("、") || l("none", "无")}{workflow.nodes.some(node => node.kind === "script") ? l(". Script nodes are shared as written; members confirm them before their first run.", "。脚本节点按原样共享，其他成员首次运行前需要确认。") : ""}</small>}
        <footer className="team-space-actions"><button type="button" disabled={busy} onClick={onClose}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={busy || !converted?.content}>{busy ? l("Saving…", "正在保存…") : l("Save to shared space", "保存到共享空间")}</button></footer>
      </form>
    </section>
  </dialog>;
}
