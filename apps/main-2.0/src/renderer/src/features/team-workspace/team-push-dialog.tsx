import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, RefreshCw, X } from "lucide-react";
import type { DirectoryConnection } from "@agentrecall/workspace-core";
import type { TeamCatalog, TeamLocalCatalog } from "../../../../shared/ipc/team-workspace";
import type { TeamPushDraft, TeamPushPreview, TeamPushResult } from "../../../../shared/team-push";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamChangePreview } from "./team-change-preview";
import { TeamSessionContentView } from "./team-session-content";

export function TeamPushDialog({ selection, directories, drafts, language, api, onClose, onBusy, onPublished }: {
  selection: TeamSelection; directories: DirectoryConnection[]; drafts: TeamPushDraft[]; language: LanguageMode; api: TeamWorkspaceApi;
  onClose(): void; onBusy(value: boolean): void; onPublished(keys: string[]): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const choices = directories.filter(item => item.enabled);
  const [directoryId, setDirectoryId] = useState(choices[0]?.id ?? ""), [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [resources, setResources] = useState<TeamPushDraft[]>([]), [selected, setSelected] = useState(() => new Set(drafts.map(draft => draft.item.key)));
  const [completed, setCompleted] = useState(new Set<string>()), [active, setActive] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, TeamPushPreview["items"][number]>>({}), [outcomes, setOutcomes] = useState<Record<string, TeamPushResult["items"][number]>>({});
  const [plan, setPlan] = useState<TeamPushPreview | null>(null), [reviewed, setReviewed] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [view, setView] = useState<"diff" | "conversation">("diff");
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false), token = useRef<string | null>(null);
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  const directory = choices.find(item => item.id === directoryId);
  const items = [...drafts, ...resources].filter(item => !completed.has(item.item.key));
  const checked = items.filter(item => selected.has(item.item.key)), selectionKey = JSON.stringify(checked.map(item => item.item.key));
  const focused = items.find(item => item.item.key === active), diff = active ? diffs[active] : undefined;
  const ready = plan !== null && reviewed === selectionKey;
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement, element = dialog.current; element?.showModal();
    void api.request({ action: "catalog", scope }).then(reply => {
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "catalog") setCatalog(reply.data.value);
    }).catch(() => { if (alive.current) setError(l("Could not read team resources.", "无法读取团队资源，请关闭后重试。")); });
    return () => {
      alive.current = false; element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      if (running.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); // Cancel this window's active plan on navigation.
      if (token.current) void api.request({ action: "push-discard", token: token.current }).catch(() => undefined); // Server expiry covers a disconnected window.
      onBusy(false);
    };
  }, [api, onBusy]);
  useEffect(() => {
    let current = true;
    if (!directory || !catalog?.assets) return;
    setLoading(true);
    const source = { ...scope, connectionId: directory.id, directory: directory.path };
    void Promise.all((["skills", "documents"] as const).map(async kind => {
      const reply = await api.request({ action: "local-assets", scope: source, kind });
      if (!reply.ok) throw new Error(reply.error.message);
      if (reply.data.kind !== "local-assets") throw new Error(l("Invalid resource list.", "资源列表无效。"));
      return { kind, value: reply.data.value };
    })).then(listings => {
      if (!current) return;
      const found: TeamPushDraft[] = [];
      for (const { kind, value } of listings) {
        for (const entry of value.entries) {
          const existing = kind === "documents" ? catalog.assets?.documents.find(item => item.target.normalize("NFC").toLowerCase() === entry.path.normalize("NFC").toLowerCase()) : undefined;
          let hash = 2166136261; for (const char of entry.path) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
          const id = kind === "skills" ? entry.name : existing?.id ?? `doc-${entry.path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "")}-${hash.toString(16)}`;
          found.push({ item: { kind: "resource", resource: kind, key: `${directory.id}:${kind}:${entry.path}`, connectionId: directory.id, directory: directory.path, file: entry.path, id, name: existing?.name ?? entry.name, ...(kind === "documents" ? { destination: existing?.target ?? (entry.path.startsWith("docs/") ? entry.path.replace(/\.md$/i, ".md") : `docs/team/${id}.md`) } : {}) }, title: existing?.name ?? entry.name, subtitle: `${kind === "skills" ? "Skill" : l("Document", "文档")} · ${directory.path} / ${entry.path}` });
        }
      }
      setResources(previous => [...previous.filter(item => item.item.kind !== "resource" || item.item.connectionId !== directory.id), ...found]);
      if (listings.some(({ value }: { value: TeamLocalCatalog }) => value.limited || value.skipped > 0)) setNotice(l("Some paths were skipped or the scan limit was reached.", "部分路径已跳过或达到扫描上限，列表可能不完整。"));
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : l("Could not read local resources.", "读取本地资源失败。")); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, catalog, directory?.id, directory?.path]);
  function invalidate() {
    if (token.current) void api.request({ action: "push-discard", token: token.current }).catch(() => undefined);
    token.current = null; setPlan(null); setReviewed("");
  }
  async function preview(entries: TeamPushDraft[], forPush: boolean) {
    if (running.current || !entries.length) return;
    running.current = true; setBusy(true); onBusy(true); setError(""); invalidate();
    try {
      const reply = await api.request({ action: "push-preview", scope, revision: catalog?.assets?.commit, items: entries.map(entry => entry.item) });
      if (!alive.current) { if (reply.ok && reply.data.kind === "push-preview") void api.request({ action: "push-discard", token: reply.data.value.token }).catch(() => undefined); return; }
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "push-preview") {
        const value = reply.data.value;
        token.current = value.token; setPlan(value); setReviewed(forPush ? JSON.stringify(entries.map(entry => entry.item.key)) : "");
        setDiffs(previous => ({ ...previous, ...Object.fromEntries(value.items.map(item => [item.key, item])) }));
        if (forPush) { setActive(entries[0]!.item.key); setView(entries[0]!.item.kind === "turn" ? "conversation" : "diff"); }
      }
    } catch { if (alive.current) setError(l("Could not build Diff. Try again.", "Diff 读取失败，请重试。")); }
    finally { running.current = false; onBusy(false); if (alive.current) setBusy(false); }
  }
  async function publish() {
    if (!ready || running.current || !plan) return;
    running.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const reply = await api.request({ action: "push-publish", scope, token: plan.token });
      if (!alive.current) return;
      if (!reply.ok) { setError(reply.error.message); invalidate(); }
      else if (reply.data.kind === "push-result") {
        const results = reply.data.value.items, successful = results.filter(item => item.status === "published" || item.status === "unchanged").map(item => item.key);
        setOutcomes(previous => ({ ...previous, ...Object.fromEntries(results.map(item => [item.key, item])) }));
        setCompleted(previous => new Set([...previous, ...successful]));
        setSelected(previous => new Set([...previous].filter(key => !successful.includes(key))));
        onPublished(successful); invalidate();
        setNotice(l(`${results.filter(item => item.status === "published").length} items pushed. Unchanged items were skipped; unfinished items remain selected.`, `已推送 ${results.filter(item => item.status === "published").length} 项；无变化项已跳过，未完成项保留勾选。`));
        const latest = await api.request({ action: "catalog", scope });
        if (alive.current && latest.ok && latest.data.kind === "catalog") setCatalog(latest.data.value);
      }
    } catch { if (alive.current) setError(l("Push result was not confirmed. Check the team before retrying.", "推送结果未确认，请先核对团队资源后再重试。")); }
    finally { running.current = false; onBusy(false); if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="team-share-dialog team-push-dialog" aria-label={l("Push selected items", "按项推送")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Changes", "待上传变更")}</h2><p>{selection.team.name} · {l("Team → selected local version", "团队版本 → 所选本地版本")}</p></div><button className="team-icon-button" disabled={busy} aria-label={l("Close push", "关闭推送")} onClick={onClose}><X size={18} /></button></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}{notice && <p role="status" className="team-workspace-notice">{notice}</p>}
    <div className="team-push-layout"><aside className="team-push-list" aria-label={l("Changes to upload", "待上传项")}>
      {choices.length > 0 && <label>{l("Read resources from", "读取资源目录")}<select disabled={busy} value={directoryId} onChange={event => { invalidate(); setDirectoryId(event.currentTarget.value); }}>{choices.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></label>}
      <div className="team-push-select-all"><label><input type="checkbox" aria-label={l("Select all items", "全选待上传项")} checked={items.length > 0 && checked.length === items.length} disabled={busy || !items.length} onChange={event => { invalidate(); setSelected(event.currentTarget.checked ? new Set(items.map(item => item.item.key)) : new Set()); }} />{l("Select all", "全选")}</label><small>{checked.length} / {items.length}</small></div>
      {catalog && !catalog.assets && <p>{catalog.notice ?? l("Pull to load the team baseline for local resource comparison.", "请先 Pull 获取团队版本，再比较本地 Skills 和文档。")}</p>}
      {loading && <p role="status">{l("Reading resources…", "正在读取资源…")}</p>}
      {items.map(entry => { const item = diffs[entry.item.key], outcome = outcomes[entry.item.key]; return <div key={entry.item.key} className={`team-push-row${active === entry.item.key ? " active" : ""}`}>
        <input type="checkbox" aria-label={l("Select ", "选择 ") + entry.title} checked={selected.has(entry.item.key)} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; invalidate(); setSelected(previous => { const next = new Set(previous); if (checked) next.add(entry.item.key); else next.delete(entry.item.key); return next; }); }} />
        <button disabled={busy} onClick={() => { setActive(entry.item.key); setView(entry.item.kind === "turn" ? "conversation" : "diff"); if (!ready || !item) void preview([entry], false); }} aria-pressed={active === entry.item.key}><span className={`team-diff-status ${item?.status ?? "pending"}`}>{item?.status === "added" ? "A" : item?.status === "modified" ? "M" : item?.status === "unchanged" ? "=" : "·"}</span><span><strong>{entry.title}</strong><small>{entry.subtitle}</small>{outcome && <small className="team-push-outcome">{outcome.message ?? (outcome.status === "cancelled" ? l("Cancelled", "已取消") : l("Needs retry", "等待重试"))}</small>}</span></button>
      </div>; })}
      {!items.length && !loading && <p>{l("No pending items. Add Turns from their right-click menu, or connect a working directory for Skills and documents.", "暂无待上传项。可从 Turn 右键加入轮次，或接入工作目录读取 Skills 和文档。")}</p>}
    </aside><section className="team-push-diff" aria-label={l("Current Diff", "当前 Diff")}>
      {focused ? <><header><h3>{focused.title}</h3><button className="team-icon-button" disabled={busy} aria-label={l("Refresh Diff", "刷新 Diff")} onClick={() => void preview([focused], false)}><RefreshCw size={14} /></button></header>{busy && <p role="status">{l("Working…", "正在处理…")}</p>}{diff && <>{diff.session && <div className="team-space-actions"><button aria-pressed={view === "diff"} onClick={() => setView("diff")}>Diff</button><button aria-pressed={view === "conversation"} onClick={() => setView("conversation")}>{l("Conversation", "会话视图")}</button><small>{l("New snapshot; previous shares are preserved.", "新增快照，历史分享保留。")}</small></div>}{diff.status === "unchanged" ? <p>{l("Matches the team version. Nothing to upload.", "与团队版本一致，无需上传。")}</p> : view === "conversation" && diff.session ? <TeamSessionContentView content={diff.session} language={language} /> : <TeamChangePreview key={focused.item.key + (plan?.token ?? "")} preview={diff} language={language} />}</>}</> : <div className="team-empty"><FileText size={25} /><p>{l("Select an item to inspect its Diff.", "点击左侧条目查看当前 Diff。")}</p></div>}
    </section></div>
    <footer className="team-push-footer"><span>{l(`${checked.length} selected`, `已选 ${checked.length} 项`)}</span><div className="team-space-actions">{busy && <button onClick={() => void api.request({ action: "cancel-sync" }).catch(() => { if (alive.current) setError(l("Cancellation could not be confirmed.", "取消未确认，请等待操作结束。")); })}>{l("Cancel operation", "取消操作")}</button>}<button className="is-primary" disabled={busy || loading || checked.length === 0 || checked.length > 64} onClick={() => ready ? void publish() : void preview(checked, true)}><ArrowUp size={14} />{ready ? l(`Push ${checked.length} items`, `Push 所选 ${checked.length} 项`) : l("Review selected Diff", "查看所选 Diff")}</button></div></footer>
    {checked.length > 64 && <p role="alert">{l("Select at most 64 items per Push.", "一次最多选择 64 项。")}</p>}
  </section></dialog>;
}
