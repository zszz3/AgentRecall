import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, RefreshCw, X } from "lucide-react";
import type { DirectoryConnection } from "@agentrecall/workspace-core";
import type { TeamCatalog, TeamReply } from "../../../../shared/ipc/team-workspace";
import type { TeamPushDraft, TeamPushPreview, TeamPushResult } from "../../../../shared/team-push";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";
import type { TeamSelection } from "./team-workspace-page";
import { TeamChangePreview } from "./team-change-preview";
import { TeamSessionContentView } from "./team-session-content";

export function TeamPushDialog({ selection, drafts, language, api, onClose, onBusy, onPublished }: {
  selection: TeamSelection; directories: DirectoryConnection[]; drafts: TeamPushDraft[]; language: LanguageMode; api: TeamWorkspaceApi;
  onClose(): void; onBusy(value: boolean): void; onPublished(keys: string[]): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const sessionUpload = useRef(drafts.some(draft => draft.item.kind === "session" || draft.item.kind === "turn")).current;
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [resources, setResources] = useState<TeamPushDraft[]>([]), [selected, setSelected] = useState(() => new Set(drafts.map(draft => draft.item.key)));
  const [completed, setCompleted] = useState(new Set<string>()), [active, setActive] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, TeamPushPreview["items"][number]>>({}), [outcomes, setOutcomes] = useState<Record<string, TeamPushResult["items"][number]>>({});
  const [plan, setPlan] = useState<TeamPushPreview | null>(null), [reviewed, setReviewed] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [inspecting, setInspecting] = useState<string | null>(null);
  const inspectionVersion = useRef(0), inspectionActive = useRef(0);
  const inspectionCache = useRef(new Map<string, { source: TeamPushDraft["item"]; revision: string | undefined; value: TeamPushPreview["items"][number]; bytes: number }>());
  const [view, setView] = useState<"diff" | "conversation">("diff");
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), running = useRef(false), token = useRef<string | null>(null);
  const scope = { teamId: selection.team.id, repository: selection.team.repository };
  const items = resources.filter(item => !completed.has(item.item.key));
  const checked = items.filter(item => selected.has(item.item.key)), selectionKey = JSON.stringify(checked.map(item => item.item.key));
  const focused = items.find(item => item.item.key === active), diff = active ? diffs[active] : undefined;
  const ready = plan !== null && reviewed === selectionKey;
  const initialLoad = useRef<Promise<{ changes: TeamReply; baseline: TeamReply; keys: string[] }> | null>(null);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement, element = dialog.current; element?.showModal();
    setLoading(true);
    initialLoad.current ??= (async () => {
      let keys: string[] = [];
      if (drafts.length) {
        const saved = await api.request({ action: "workspace-stage", scope, items: drafts.map(draft => draft.item) });
        if (!saved.ok) throw new Error(saved.error.message);
        if (saved.data.kind === "workspace-changes") keys = saved.data.value.map(draft => draft.item.key);
        onPublished(drafts.map(draft => draft.item.key));
      }
      const [changes, baseline] = await Promise.all([api.request({ action: "workspace-changes", scope }), api.request({ action: "catalog", scope })]);
      return { changes, baseline, keys };
    })();
    void initialLoad.current.then(({ changes, baseline, keys }) => {
      if (!alive.current) return;
      if (!changes.ok) throw new Error(changes.error.message);
      if (!baseline.ok) throw new Error(baseline.error.message);
      if (changes.data.kind === "workspace-changes") {
        setResources(changes.data.value);
        setSelected(new Set(keys));
      }
      if (baseline.data.kind === "catalog") setCatalog(baseline.data.value);
    }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not read local changes.", "无法读取本地变更，请关闭后重试。")); }).finally(() => { if (alive.current) setLoading(false); });
    return () => {
      alive.current = false; inspectionVersion.current++; element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      if (running.current || inspectionActive.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); // Cancel this window's active plan on navigation.
      if (token.current) void api.request({ action: "push-discard", token: token.current }).catch(() => undefined); // Server expiry covers a disconnected window.
      onBusy(false);
    };
  }, [api, onBusy]);
  useEffect(() => {
    for (const [key, cached] of inspectionCache.current) if (cached.source.kind !== "turn") inspectionCache.current.delete(key);
    setDiffs(Object.fromEntries([...inspectionCache.current].map(([key, item]) => [key, item.value])));
  }, [catalog?.assets?.commit]);
  function remember(entry: TeamPushDraft, value: TeamPushPreview["items"][number], bytes: number) {
    const cache = inspectionCache.current;
    cache.delete(entry.item.key);
    cache.set(entry.item.key, { source: entry.item, revision: catalog?.assets?.commit, value, bytes });
    let retained = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (retained > 24 * 1024 * 1024 || cache.size > 32) {
      const first = cache.keys().next().value!; retained -= cache.get(first)!.bytes; cache.delete(first);
    }
    setDiffs(Object.fromEntries([...cache].map(([key, item]) => [key, item.value])));
  }
  async function inspect(entry: TeamPushDraft, refresh = false) {
    if (running.current) return;
    const cached = inspectionCache.current.get(entry.item.key);
    const current = ++inspectionVersion.current;
    const retained = ready ? plan?.items.find(item => item.key === entry.item.key) : undefined;
    if (!refresh && retained) { remember(entry, retained, new TextEncoder().encode(JSON.stringify(retained)).length); setInspecting(null); return; }
    if (!refresh && cached?.source === entry.item && (entry.item.kind === "turn" || cached.revision === catalog?.assets?.commit)) { setInspecting(null); return; }
    if (refresh) invalidate();
    inspectionActive.current = current; setInspecting(entry.item.key); setError("");
    try {
      const reply = await api.request({ action: "push-inspect", scope, revision: catalog?.assets?.commit, item: entry.item });
      if (!alive.current || current !== inspectionVersion.current) return;
      if (!reply.ok) { if (reply.error.code !== "CANCELLED") setError(reply.error.message); }
      else if (reply.data.kind === "push-inspection") remember(entry, reply.data.value.item, reply.data.value.bytes);
    } catch { if (alive.current && current === inspectionVersion.current) setError(l("Could not read this Diff. Try refreshing it.", "此项 Diff 读取失败，请刷新重试。")); }
    finally { if (inspectionActive.current === current) inspectionActive.current = 0; if (alive.current && current === inspectionVersion.current) setInspecting(null); }
  }
  function invalidate() {
    if (token.current) void api.request({ action: "push-discard", token: token.current }).catch(() => undefined);
    token.current = null; setPlan(null); setReviewed("");
  }
  async function reviewSelected(entries: TeamPushDraft[]) {
    if (running.current || !entries.length) return;
    inspectionVersion.current++; setInspecting(null); invalidate();
    running.current = true; setBusy(true); setError("");
    try {
      for (const entry of entries) {
        const reply = await api.request({ action: "push-inspect", scope, revision: catalog?.assets?.commit, item: entry.item });
        if (!alive.current) return;
        if (!reply.ok) throw new Error(reply.error.message);
        if (reply.data.kind === "push-inspection") remember(entry, reply.data.value.item, reply.data.value.bytes);
      }
      // The last inspected item is retained even when earlier large diffs were evicted.
      setActive(entries.at(-1)!.item.key); setView("diff");
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : l("Could not read Diff.", "Diff 读取失败，请重试。")); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function preparePush(entries: TeamPushDraft[]) {
    if (running.current || !entries.length) return;
    inspectionVersion.current++; setInspecting(null);
    running.current = true; setBusy(true); onBusy(true); setError(""); invalidate();
    try {
      const reply = await api.request({ action: "push-preview", scope, revision: catalog?.assets?.commit, items: entries.map(entry => entry.item) });
      if (!alive.current) { if (reply.ok && reply.data.kind === "push-preview") void api.request({ action: "push-discard", token: reply.data.value.token }).catch(() => undefined); return; }
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "push-preview") {
        const value = reply.data.value;
        token.current = value.token; setPlan(value); setReviewed(JSON.stringify(entries.map(entry => entry.item.key)));
        inspectionCache.current.clear();
        for (const item of value.items) { const entry = entries.find(entry => entry.item.key === item.key)!; remember(entry, item, new TextEncoder().encode(JSON.stringify(item)).length); }
        setActive(entries[0]!.item.key); setView(entries[0]!.item.kind === "turn" ? "conversation" : "diff");
        return value;
      }
    } catch { if (alive.current) setError(l("Could not build Diff. Try again.", "Diff 读取失败，请重试。")); }
    finally { running.current = false; onBusy(false); if (alive.current) setBusy(false); }
  }
  async function publish(prepared?: TeamPushPreview) {
    const currentPlan = prepared ?? (ready ? plan : null);
    if (!alive.current || running.current || !currentPlan) return;
    running.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const reply = await api.request({ action: "push-publish", scope, token: currentPlan.token });
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
  return <dialog ref={dialog} className="team-share-dialog team-push-dialog" aria-label={l("Push selected items", "按项推送")} onCancel={event => { event.preventDefault(); if (!busy && !loading) onClose(); }}><section className="team-workspace">
    <header className="team-workspace-head"><div><h2>{l("Changes", "待上传变更")}</h2><p>{selection.team.name} · {sessionUpload ? l("Upload only the selected conversation content. Local sessions are preserved.", "仅上传所选会话内容，本地原会话保留。") : l("Last Pull → local · remote checked before Push", "上次 Pull 版本 → 本地 · 推送前核对远端")}</p></div><button className="team-icon-button" disabled={busy || loading} aria-label={l("Close push", "关闭推送")} onClick={onClose}><X size={18} /></button></header>
    {error && <p role="alert" className="team-workspace-error">{error}</p>}{notice && <p role="status" className="team-workspace-notice">{notice}</p>}
    {items.length > 0 && <p role="status" className="team-workspace-notice">{l("Not uploaded yet. Upload checks and packages your selection before confirmation.", "内容已保存在本地共享空间。勾选条目查看差异，再 Push 到团队。")}</p>}
    <div className="team-push-layout"><aside className="team-push-list" aria-label={l("Changes to upload", "待上传项")}>

      <div className="team-push-select-all"><label><input type="checkbox" aria-label={l("Select all items", "全选待上传项")} checked={items.length > 0 && checked.length === items.length} disabled={busy || !items.length} onChange={event => { invalidate(); setSelected(event.currentTarget.checked ? new Set(items.map(item => item.item.key)) : new Set()); }} />{l("Select all", "全选")}</label><small>{checked.length} / {items.length}</small></div>
      {catalog && !catalog.assets && !sessionUpload && <p>{catalog.notice ?? l("Pull to load the team baseline for local resource comparison.", "请先 Pull 获取团队版本，再比较本地 Skills 和文档。")}</p>}
      {loading && <p role="status">{sessionUpload ? l("Saving the local snapshot…", "正在保存本地会话副本…") : l("Reading local changes…", "正在读取本地变更…")}</p>}
      {items.map(entry => { const item = diffs[entry.item.key], outcome = outcomes[entry.item.key]; return <div key={entry.item.key} className={`team-push-row${active === entry.item.key ? " active" : ""}`}>
        <input type="checkbox" aria-label={l("Select ", "选择 ") + entry.title} checked={selected.has(entry.item.key)} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; invalidate(); setSelected(previous => { const next = new Set(previous); if (checked) next.add(entry.item.key); else next.delete(entry.item.key); return next; }); }} />
        <button disabled={busy} onClick={() => { setActive(entry.item.key); setView(entry.item.kind === "turn" ? "conversation" : "diff"); void inspect(entry); }} aria-pressed={active === entry.item.key}><span className={`team-diff-status ${item?.status ?? "pending"}`}>{item?.status === "added" ? "A" : item?.status === "modified" ? "M" : item?.status === "unchanged" ? "=" : "·"}</span><span><strong>{entry.title}</strong><small>{entry.subtitle}</small>{outcome && <small className="team-push-outcome">{outcome.message ?? (outcome.status === "cancelled" ? l("Cancelled", "已取消") : l("Needs retry", "等待重试"))}</small>}</span></button>
      </div>; })}
      {!items.length && !loading && !error && <p>{l("No local changes. Add resources in the shared workspace.", "本地内容与上次同步一致。可在共享空间添加资源，或从会话右键加入内容。")}</p>}
    </aside><section className="team-push-diff" aria-label={l("Current Diff", "当前 Diff")}>
      {focused ? <><header><h3>{focused.title}</h3><button className="team-icon-button" disabled={busy} aria-label={l("Refresh Diff", "刷新 Diff")} onClick={() => void inspect(focused, true)}><RefreshCw size={14} /></button></header>{(busy || inspecting === active) && <p role="status">{l("Working…", "正在处理…")}</p>}{diff && <>{diff.session && <div className="team-space-actions"><button aria-pressed={view === "diff"} onClick={() => setView("diff")}>Diff</button><button aria-pressed={view === "conversation"} onClick={() => setView("conversation")}>{l("Conversation", "会话视图")}</button><small>{l("New snapshot; previous shares are preserved.", "新增快照，历史分享保留。")}</small></div>}{diff.status === "unchanged" ? <p>{l("Matches the team version. Nothing to upload.", "与团队版本一致，无需上传。")}</p> : view === "conversation" && diff.session ? <TeamSessionContentView content={diff.session} language={language} /> : <TeamChangePreview key={focused.item.key} preview={diff} language={language} />}</>}</> : <div className="team-empty"><FileText size={25} /><p>{completed.size > 0 && items.length === 0 ? l("Finished. Close this window to continue with your session.", "处理完成，关闭窗口即可继续查看会话。") : sessionUpload ? l("Ready to upload your selection. You can optionally inspect its Diff first.", "可直接上传所选内容，也可以先查看 Diff。") : l("Select an item to inspect its Diff.", "点击左侧条目查看当前 Diff。")}</p></div>}
    </section></div>
    <footer className="team-push-footer"><span role="status">{busy ? l("Processing selected changes…", "正在处理所选变更…") : l(`${checked.length} selected`, `已选 ${checked.length} 项`)}</span><div className="team-space-actions">{(busy || loading) && <button onClick={() => void api.request({ action: "cancel-sync" }).catch(() => { if (alive.current) setError(l("Cancellation could not be confirmed.", "取消未确认，请等待操作结束。")); })}>{l("Cancel operation", "取消操作")}</button>}{items.length === 0 && completed.size > 0 ? <button className="is-primary" onClick={onClose}>{l("Done", "完成")}</button> : <><button disabled={busy || loading || checked.length === 0 || checked.length > 64} onClick={() => void reviewSelected(checked)}>{l("Review selected Diff", "查看所选 Diff")}</button><button className="is-primary" disabled={busy || loading || inspecting !== null || checked.length === 0 || checked.length > 64} onClick={async () => { if (ready) await publish(); else { const prepared = await preparePush(checked); if (prepared) await publish(prepared); } }}><ArrowUp size={14} />{sessionUpload ? l(`Upload ${checked.length} items`, `上传所选 ${checked.length} 项`) : l(`Push ${checked.length} items`, `Push 所选 ${checked.length} 项`)}</button></>}</div></footer>
    {checked.length > 64 && <p role="alert">{l("Select at most 64 items per Push.", "一次最多选择 64 项。")}</p>}
  </section></dialog>;
}
