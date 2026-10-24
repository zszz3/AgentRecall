import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ReviewRules } from "@agentrecall/workspace-core";
import { reviewRulesChangeSchema } from "../../../../../../../packages/workspace-core/src/review-rules";
import type { TeamPayload } from "../../../../shared/ipc/team-workspace";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import { TeamChangePreview } from "./team-change-preview";
import type { TeamSelection } from "./team-workspace-page";

type Loaded = { commit: string; rules: ReviewRules | null };
type Preview = Extract<TeamPayload, { kind: "configuration-preview" }>["value"];
type Draft = { resources: string; owners: string };

const kindLabels: Record<string, [string, string]> = {
  skills: ["Skills", "Skills"], documents: ["Documents", "文档"], instructions: ["Shared instructions", "共享指令"], mcp: ["MCP", "MCP"],
  environment: ["Env", "Env"], organization: ["Folders", "资源目录"], agentRoles: ["Agent roles", "Agent 角色"], workflowTemplates: ["Workflow templates", "Workflow 模板"], outcomes: ["Outcomes", "运行成果"], reviewRules: ["Review rules", "审核规则"],
};

/**
 * Edits OWNERS.json. Review rules are published directly (or through review
 * when the rules protect themselves) instead of the local working copy, because
 * they decide how every later Push is routed.
 */
export function TeamReviewRulesPanel({ selection, language, api }: { selection: TeamSelection; language: LanguageMode; api: TeamWorkspaceApi }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  const [loaded, setLoaded] = useState<Loaded | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null), [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null), alive = useRef(true);
  const describe = (resource: string) => { const [kind, id] = resource.split(":"); const label = kindLabels[kind!] ? l(...kindLabels[kind!]!) : kind; return id ? `${label} · ${id}` : l(`All ${label}`, `全部${/^[A-Za-z]/.test(label ?? "") ? " " : ""}${label}`); };
  async function load() {
    setLoading(true); setError("");
    try {
      const reply = await api.request({ action: "review-rules", scope });
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "review-rules") setLoaded(reply.data.value);
    } catch { if (alive.current) setError(l("Could not read review rules. Try again.", "审核规则读取失败，请重试。")); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; if (token.current) void api.request({ action: "configuration-discard", token: token.current }).catch(() => undefined); }; // Tokens also expire server-side.
  }, [api, selection.team.id, selection.team.repository]);
  function discard() { if (token.current) void api.request({ action: "configuration-discard", token: token.current }).catch(() => undefined); token.current = null; setPreview(null); } // Expiration covers a lost request.
  async function submit() {
    if (!loaded || !drafts || busy) return;
    setBusy(true); setError("");
    try {
      if (preview) {
        const reply = await api.request({ action: "configuration-publish", scope, token: preview.token });
        if (!alive.current) return;
        if (!reply.ok) { setError(reply.error.message); return; }
        if (reply.data.kind !== "configuration-published") return;
        token.current = null; setPreview(null); setDrafts(null);
        const review = "review" in reply.data.value ? reply.data.value.review : undefined;
        setNotice(review ? { text: l(`Sent for review by ${review.owners.join(", ")}. The rules apply after the pull request merges.`, `已提交审核，等待 ${review.owners.join("、")} 批准；合并后规则才生效。`), url: review.url } : { text: l("Review rules published.", "审核规则已发布。") });
        await load();
        return;
      }
      const rules = drafts.map(draft => ({ resources: draft.resources.split(/[\s,，]+/).filter(Boolean), owners: draft.owners.split(/[\s,，]+/).filter(Boolean).map(owner => owner.startsWith("@") ? owner : `@${owner}`) }));
      const parsed = reviewRulesChangeSchema.safeParse({ kind: "reviewRules", operation: loaded.rules ? "update" : "create", value: { id: "review-rules", name: l("Review rules", "审核规则"), rules } });
      if (!parsed.success) { setError(l("Each rule needs resources such as mcp or skills:review and GitHub owners such as @name or @org/team.", "每条规则需要填写资源（如 mcp、skills:review）和 GitHub 审核人（如 @name 或 @org/team）。")); return; }
      const reply = await api.request({ action: "configuration-preview", scope, revision: loaded.commit, change: parsed.data });
      if (!alive.current) { if (reply.ok && reply.data.kind === "configuration-preview") void api.request({ action: "configuration-discard", token: reply.data.value.token }).catch(() => undefined); return; } // A late preview must not outlive the panel.
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "configuration-preview") { token.current = reply.data.value.token; setPreview(reply.data.value); }
    } catch { if (alive.current) setError(l("The operation was not confirmed. Refresh and try again.", "操作未确认，请刷新后重试。")); }
    finally { if (alive.current) setBusy(false); }
  }
  const rules = loaded?.rules?.rules ?? [];
  return <section className="team-review-rules" aria-label={l("Review rules", "审核规则")}>
    <header className="team-space-actions"><h3><ShieldCheck size={16} />{l("Review rules", "审核规则")}</h3>
      <button className="team-icon-button" disabled={loading || busy} aria-label={l("Refresh review rules", "刷新审核规则")} onClick={() => void load()}><RefreshCw size={14} /></button>
      {!drafts && loaded && <button disabled={busy} onClick={() => { setNotice(null); setDrafts(rules.length ? rules.map(rule => ({ resources: rule.resources.join(" "), owners: rule.owners.join(" ") })) : [{ resources: "mcp", owners: "" }]); }}>{loaded.rules ? l("Edit rules", "编辑规则") : l("Add review rules", "设置审核规则")}</button>}
    </header>
    <p className="team-review-help">{l("Changes to protected resources are pushed to a separate branch and opened as a pull request for the listed owners. Other changes still publish directly. AgentRecall also writes .github/CODEOWNERS so GitHub branch protection can require the same reviewers.", "命中规则的资源修改会推送到单独的审核分支，由列出的审核人在 GitHub Pull Request 中批准；其他修改仍直接发布。AgentRecall 同时生成 .github/CODEOWNERS，开启分支保护后 GitHub 会要求同样的审核人。")}</p>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}
    {notice && <p role="status" className="team-workspace-notice">{notice.text}{notice.url && <button onClick={() => void window.sessionSearch.openExternalLink(notice.url!)}>{l("Open pull request", "打开 Pull Request")}</button>}</p>}
    {loading && !loaded && <p role="status">{l("Reading review rules…", "正在读取审核规则…")}</p>}
    {!drafts && loaded && (rules.length === 0 ? <p className="team-empty">{l("No review rules. Every member with write access publishes directly.", "还没有审核规则，有写权限的成员都可直接发布。")}</p>
      : <table className="team-review-table"><thead><tr><th>{l("Resources", "资源")}</th><th>{l("Reviewers", "审核人")}</th></tr></thead><tbody>{rules.map((rule, index) => <tr key={index}><td>{rule.resources.map(describe).join("、")}</td><td>{rule.owners.join(" ")}</td></tr>)}</tbody></table>)}
    {drafts && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {!preview ? <>
        {drafts.map((draft, index) => <div className="team-review-rule" key={index}>
          <label>{l("Resources", "资源")}<input aria-label={l(`Resources of rule ${index + 1}`, `规则 ${index + 1} 的资源`)} required disabled={busy} value={draft.resources} placeholder="mcp skills:review" onChange={event => setDrafts(drafts.map((item, i) => i === index ? { ...item, resources: event.currentTarget.value } : item))} /></label>
          <label>{l("Reviewers", "审核人")}<input aria-label={l(`Reviewers of rule ${index + 1}`, `规则 ${index + 1} 的审核人`)} required disabled={busy} value={draft.owners} placeholder="@acme/platform @alice" onChange={event => setDrafts(drafts.map((item, i) => i === index ? { ...item, owners: event.currentTarget.value } : item))} /></label>
          <button type="button" className="team-icon-button" disabled={busy} aria-label={l(`Remove rule ${index + 1}`, `删除规则 ${index + 1}`)} onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}><X size={15} /></button>
        </div>)}
        <button type="button" disabled={busy || drafts.length >= 64} onClick={() => setDrafts([...drafts, { resources: "", owners: "" }])}><Plus size={14} />{l("Add rule", "添加规则")}</button>
        <small>{l("Resources: skills, documents, instructions, mcp, environment, organization, agentRoles, workflowTemplates, outcomes, reviewRules; add :id for one item, e.g. skills:review or environment:API_URL.", "资源可写 skills、documents、instructions、mcp、environment、organization、agentRoles、workflowTemplates、outcomes、reviewRules；加 :标识 只保护单项，如 skills:review、environment:API_URL。")}</small>
      </> : <TeamChangePreview preview={preview} language={language} />}
      {preview?.review && <p role="status" className="team-workspace-notice">{l(`The current rules protect review rules, so this change goes to review by ${preview.review.owners.join(", ")}.`, `当前规则保护审核规则本身，此修改将提交给 ${preview.review.owners.join("、")} 审核。`)}</p>}
      <footer className="team-space-actions">
        {preview ? <button type="button" disabled={busy} onClick={discard}>{l("Back to edit", "返回编辑")}</button> : <button type="button" disabled={busy} onClick={() => setDrafts(null)}>{l("Cancel", "取消")}</button>}
        <button className="is-primary" disabled={busy}>{busy ? l("Working…", "正在处理…") : preview ? (preview.review ? l("Submit for review", "提交审核") : l("Publish to team", "发布到团队")) : l("Preview changes", "预览变更")}</button>
      </footer>
    </form>}
  </section>;
}
