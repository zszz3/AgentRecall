import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trophy, X } from "lucide-react";
import type { OutcomeChange, TeamOutcome } from "@agentrecall/workspace-core";
import { outcomeChangeSchema } from "../../../../../../../packages/workspace-core/src/outcomes";
import type { AutomationApi } from "../../../../preload/automation";
import type { WorkflowRun } from "../../../../automation/engine/shared/workflow/model";
import type { TeamCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamSharedSession } from "../../../../shared/team-sessions";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";

export type OutcomeAutomationApi = Pick<AutomationApi, "getWorkflowCore">;
type Draft = { id: string; name: string; summary: string; content: string; tags: string; source: OutcomeChange["value"]["source"]; sessions: OutcomeChange["value"]["sessions"]; createdAt: number };

const date = (time: number) => new Date(time).toLocaleString();
const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Writes a readable record of a finished run: its inputs and every node's validated outputs. */
function recordFromRun(run: WorkflowRun, l: (en: string, zh: string) => string): string {
  const lines = [`# ${run.definition.name}`, "", l(`Finished ${date(run.finishedAt ?? run.startedAt)}.`, `完成于 ${date(run.finishedAt ?? run.startedAt)}。`), ""];
  const inputs = Object.entries(run.inputs);
  if (inputs.length) lines.push(`## ${l("Inputs", "输入")}`, "", ...inputs.map(([key, value]) => `- ${key}: ${show(value)}`), "");
  for (const node of run.definition.nodes) {
    const outputs = Object.entries(run.nodeRuns[node.id]?.outputs ?? {});
    if (!outputs.length) continue;
    lines.push(`## ${node.title}`, "");
    for (const [key, value] of outputs) {
      const label = node.outputs.find(field => field.key === key)?.name || key, text = show(value);
      lines.push(text.includes("\n") ? `### ${label}\n\n${text}\n` : `- ${label}: ${text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function TeamOutcomesPanel({ selection, language, refreshKey, api, automation = window.sessionSearch.automation, onStage }: {
  selection: TeamSelection; language: LanguageMode; refreshKey: number; api: TeamWorkspaceApi; automation?: OutcomeAutomationApi; onStage(change: OutcomeChange): Promise<void>;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const { team, enabled } = selection;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [readerId, setReaderId] = useState<string | null>(null), [editing, setEditing] = useState<TeamOutcome | null | undefined>(undefined);
  useEffect(() => {
    let active = true; setCatalog(null); setError("");
    if (enabled) void api.request({ action: "catalog", scope: { teamId: team.id, repository: team.repository } }).then(reply => {
      if (!active) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (active) setError(l("Could not load outcomes.", "成果读取失败，请重试。")); });
    return () => { active = false; };
  }, [api, team.id, team.repository, enabled, refreshKey, retry]);
  const assets = catalog?.assets;
  const outcomes = [...assets?.outcomes ?? []].sort((a, b) => b.createdAt - a.createdAt);
  const reader = outcomes.find(item => item.id === readerId) ?? null;
  const origin = (outcome: TeamOutcome) => outcome.source.kind === "workflow-run" ? l(`Workflow “${outcome.source.workflow}”`, `Workflow“${outcome.source.workflow}”`) : l("Written by hand", "手动记录");
  return <div className={`team-documents-layout${reader ? " has-reader" : ""}`} onKeyDown={event => { if (event.key === "Escape" && reader) { event.stopPropagation(); setReaderId(null); } }}>
    <section className="team-workspace team-documents-list" aria-label={l("Outcomes", "运行成果")}>
      <header className="team-workspace-head"><div><h2>{l("Outcomes", "运行成果")} {assets && <span className="team-count">{outcomes.length}</span>}</h2><p>{l("Results worth keeping from Workflow runs and sessions. The record lives in the team repository; full transcripts stay in shared sessions.", "值得留存的 Workflow 运行与会话结果。成果记录保存在团队仓库，完整对话通过共享会话关联。")}</p></div><button className="is-primary" disabled={!enabled || selection.busy || !assets} title={!assets ? l("Pull first", "请先Pull 拉取") : undefined} onClick={() => setEditing(null)}><Plus size={15} />{l("Record an outcome", "沉淀成果")}</button></header>
      {!enabled ? <p>{l("Enable teams in Settings to view shared resources.", "在设置中启用团队后，可查看共享资源。")}</p> : error ? <div role="alert" className="team-workspace-error">{error}<button onClick={() => setRetry(value => value + 1)}>{l("Retry", "重试")}</button></div> : !catalog ? <p role="status">{l("Loading…", "正在读取…")}</p> : <>
        {catalog.notice && <p className="team-workspace-notice">{catalog.notice}</p>}
        {outcomes.map(outcome => <button className="team-resource-row" key={outcome.id} aria-pressed={readerId === outcome.id} onClick={() => setReaderId(outcome.id)}><Trophy size={17} /><span><strong>{outcome.name}</strong><small>{[origin(outcome), date(outcome.createdAt), ...outcome.tags].join(" · ")}</small></span><span>{outcome.sessions.length ? l(`${outcome.sessions.length} sessions`, `${outcome.sessions.length} 个会话`) : ""}</span></button>)}
        {assets && !outcomes.length && <div className="team-empty"><Trophy size={26} /><strong>{l("No outcomes yet", "还没有运行成果")}</strong><p>{l("Record the result of a finished Workflow run or write one by hand.", "可以把完成的 Workflow 运行结果沉淀下来，或手动记录。")}</p></div>}
      </>}
    </section>
    {reader && <aside tabIndex={-1} className="team-document-reader team-workspace" aria-label={l("Outcome details", "成果详情")}>
      <header className="team-document-reader-head"><div><small>{origin(reader)} · {date(reader.createdAt)}</small><h3>{reader.name}</h3></div><div className="team-space-actions">
        <button disabled={selection.busy} onClick={() => setEditing(reader)}><Pencil size={14} />{l("Edit", "编辑")}</button>
        <button className="team-icon-button" aria-label={l("Close details", "关闭详情")} onClick={() => setReaderId(null)}><X size={17} /></button></div></header>
      <div className="team-document-reader-body">
        {reader.summary && <p>{reader.summary}</p>}
        {reader.sessions.length > 0 && <p className="team-outcome-sessions">{l("Shared sessions: ", "关联的共享会话：")}{reader.sessions.map(item => item.title).join("、")}{l(" — open them under Shared sessions.", "（在「共享会话」中打开）")}</p>}
        <pre>{reader.content}</pre>
      </div>
    </aside>}
    {editing !== undefined && <OutcomeDialog initial={editing} existingIds={outcomes.map(item => item.id)} selection={selection} language={language} api={api} automation={automation} onClose={() => setEditing(undefined)} onStage={async change => { await onStage(change); setEditing(undefined); setReaderId(change.value.id); }} />}
  </div>;
}

function OutcomeDialog({ initial, existingIds, selection, language, api, automation, onClose, onStage }: { initial: TeamOutcome | null; existingIds: string[]; selection: TeamSelection; language: LanguageMode; api: TeamWorkspaceApi; automation: OutcomeAutomationApi; onClose(): void; onStage(change: OutcomeChange): Promise<void> }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false);
  const [draft, setDraft] = useState<Draft>(() => initial
    ? { id: initial.id, name: initial.name, summary: initial.summary, content: initial.content, tags: initial.tags.join(", "), source: initial.source, sessions: initial.sessions, createdAt: initial.createdAt }
    : { id: `outcome-${crypto.randomUUID().slice(0, 8)}`, name: "", summary: "", content: "", tags: "", source: { kind: "manual" }, sessions: [], createdAt: Date.now() });
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null), [sessions, setSessions] = useState<TeamSharedSession[] | null>(null), [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [loadError, setLoadError] = useState("");
  const set = (patch: Partial<Draft>) => setDraft(current => ({ ...current, ...patch }));
  useEffect(() => { alive.current = true; const element = dialog.current; element?.showModal(); return () => { alive.current = false; element?.close(); }; }, []);
  useEffect(() => {
    let active = true;
    void automation.getWorkflowCore().then(core => { if (active) setRuns(core.runs.filter(run => run.status === "completed").sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)).slice(0, 30)); })
      .catch(() => { if (active) { setRuns([]); setLoadError(l("Workflow runs could not be read; you can still write the record by hand.", "Workflow 运行记录读取失败，仍可手动填写。")); } });
    void api.request({ action: "session-list", scope: { teamId: selection.team.id, repository: selection.team.repository }, page: 1 }).then(reply => {
      if (active) setSessions(reply.ok && reply.data.kind === "session-list" ? reply.data.value.items.filter(item => item.id > 0) : []);
    }).catch(() => { if (active) setSessions([]); });
    return () => { active = false; };
  }, [automation, api, selection.team.id, selection.team.repository]);
  function chooseRun(id: string) {
    setRunId(id);
    const run = runs?.find(item => item.id === id);
    if (!run) { set({ source: { kind: "manual" } }); return; }
    set({ name: draft.name || `${run.definition.name} · ${new Date(run.finishedAt ?? run.startedAt).toLocaleDateString()}`, content: recordFromRun(run, l), source: { kind: "workflow-run", workflow: run.definition.name.slice(0, 200) } });
  }
  async function submit() {
    if (busy) return;
    const tags = draft.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean);
    const parsed = outcomeChangeSchema.safeParse({ kind: "outcomes", operation: existingIds.includes(draft.id.trim()) ? "update" : "create", value: { id: draft.id.trim(), name: draft.name.trim(), summary: draft.summary.trim(), content: draft.content, tags, source: draft.source, sessions: draft.sessions, createdAt: draft.createdAt } });
    if (!parsed.success) { setError(l("Fill in the name and record, and use lowercase letters, digits and dashes for the identifier.", "请填写名称和成果记录，标识只能使用小写字母、数字与连字符。")); return; }
    setBusy(true); setError("");
    try { await onStage(parsed.data); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not save the outcome.", "成果保存失败，请重试。")); }
    finally { if (alive.current) setBusy(false); }
  }
  const toggleSession = (session: TeamSharedSession, on: boolean) => set({ sessions: on ? [...draft.sessions, { id: session.id, title: session.title.slice(0, 300) || String(session.id) }].slice(0, 16) : draft.sessions.filter(item => item.id !== session.id) });
  return <dialog ref={dialog} className="team-share-dialog" aria-label={l("Record an outcome", "沉淀成果")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="team-workspace"><header className="team-workspace-head"><div><h2>{initial ? l("Edit outcome", "编辑成果") : l("Record an outcome", "沉淀成果")}</h2><p>{l("Saved to the local shared space; publish it with Push. Session transcripts are not copied into the record.", "保存到本地共享空间，再通过 Push 发布。会话全文不会复制进成果记录。")}</p></div><button type="button" className="team-icon-button" disabled={busy} aria-label={l("Close", "关闭")} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="team-workspace-error">{error}</p>}
      {loadError && <p className="team-workspace-notice">{loadError}</p>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="team-editor-fields">
          {!initial && <label>{l("From", "来源")}<select disabled={busy || !runs} value={runId} onChange={event => chooseRun(event.currentTarget.value)}><option value="">{l("Write by hand", "手动记录")}</option>{runs?.map(run => <option key={run.id} value={run.id}>{`${run.definition.name} · ${date(run.finishedAt ?? run.startedAt)}`}</option>)}</select></label>}
          <label>{l("Identifier", "标识")}<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={64} value={draft.id} disabled={busy || Boolean(initial)} onChange={event => set({ id: event.currentTarget.value })} /></label>
          <label>{l("Name", "名称")}<input required maxLength={200} value={draft.name} disabled={busy} onChange={event => set({ name: event.currentTarget.value })} /></label>
          <label>{l("Summary", "摘要")}<textarea rows={2} maxLength={4096} value={draft.summary} disabled={busy} onChange={event => set({ summary: event.currentTarget.value })} /></label>
          <label>{l("Tags", "标签")}<input value={draft.tags} placeholder={l("Comma-separated", "用逗号分隔")} disabled={busy} onChange={event => set({ tags: event.currentTarget.value })} /></label>
          <label>{l("Record (Markdown)", "成果记录（Markdown）")}<textarea required rows={10} value={draft.content} disabled={busy} onChange={event => set({ content: event.currentTarget.value })} /></label>
        </div>
        <fieldset><legend>{l("Shared sessions", "关联共享会话")}</legend>{!sessions ? <small role="status">{l("Loading…", "正在读取…")}</small> : sessions.length ? sessions.map(session => <label className="team-client-chip" key={session.id}><input type="checkbox" disabled={busy} checked={draft.sessions.some(item => item.id === session.id)} onChange={event => toggleSession(session, event.currentTarget.checked)} /><span>{session.title}</span></label>) : <small>{l("No uploaded shared sessions yet. Share a session first to link its full transcript.", "还没有已上传的共享会话；如需附上完整对话，请先分享会话。")}</small>}</fieldset>
        <footer className="team-space-actions"><button type="button" disabled={busy} onClick={onClose}>{l("Cancel", "取消")}</button><button className="is-primary" disabled={busy}>{busy ? l("Saving…", "正在保存…") : l("Save to shared space", "保存到共享空间")}</button></footer>
      </form>
    </section>
  </dialog>;
}
