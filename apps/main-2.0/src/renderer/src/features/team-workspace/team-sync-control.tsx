import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, LoaderCircle } from "lucide-react";
import type { TeamPullReport, TeamSpace, TrustDecision, TrustItem } from "@agentrecall/workspace-core";
import { TeamTrustDialog } from "./team-trust-dialog";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";

export function TeamSyncControl({ team, enabled, externalBusy, language, api, onBusy, onSynced, onPush, pendingCount = 0 }: { pendingCount?: number; team: TeamSpace; enabled: boolean; externalBusy: boolean; language: LanguageMode; api: TeamWorkspaceApi; onBusy(value: boolean): void; onPush(): void; onSynced(report: TeamPullReport): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [report, setReport] = useState<TeamPullReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [trust, setTrust] = useState<TrustItem[] | null>(null), [notice, setNotice] = useState("");
  const alive = useRef(false), running = useRef(false), version = useRef(0);
  const scope = { teamId: team.id, repository: team.repository };
  useEffect(() => {
    alive.current = true; const current = ++version.current;
    void api.request({ action: "sync-status", scope }).then((reply) => {
      if (!alive.current || current !== version.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "sync-status") setReport(reply.data.value);
    }).catch(() => { if (alive.current && current === version.current) setError(l("Could not read the last sync result.", "无法读取上次同步结果。")); });
    return () => { alive.current = false; version.current++; if (running.current) void api.request({ action: "cancel-sync" }).catch(() => undefined); };
  }, [api, team.id, team.repository]);
  async function sync(decision?: TrustDecision) {
    if (running.current) return;
    running.current = true; version.current++; setBusy(true); setError(""); setNotice(""); onBusy(true);
    try {
      const reply = await api.request({ action: "sync", scope, ...(decision ? { trust: decision } : {}) });
      if (!alive.current) return;
      if (!reply.ok && reply.error.code === "TRUST_REQUIRED" && Array.isArray(reply.error.details?.items)) setTrust(reply.error.details.items as TrustItem[]);
      else if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "sync-result") { setReport(reply.data.value); onSynced(reply.data.value); }
    } catch { if (alive.current) setError(l("Sync result is uncertain. Retry to check the files already written.", "同步结果未确认。重试会重新核对已写入的文件。")); }
    finally { running.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  }
  async function resetTrust() {
    const reply = await api.request({ action: "trust-reset", scope }).catch(() => null);
    if (!alive.current) return;
    if (!reply) setError(l("Trust records could not be reset.", "信任记录未能清除，请重试。"));
    else if (!reply.ok) setError(reply.error.message);
    else setNotice(l("Trust decisions cleared. The next Pull asks again.", "已清除信任记录，下次 Pull 会重新询问。"));
  }
  const counts = report?.directories.flatMap((directory) => directory.items) ?? [];
  const changed = counts.filter((item) => ["installed", "updated", "retired"].includes(item.status)).length;
  const issues = counts.filter((item) => item.status === "conflict" || item.status === "failed").length;
  const skipped = [...new Set(counts.filter((item) => item.status === "skipped").map((item) => `${item.kind === "mcp" ? "MCP" : "Skill"} ${item.id}`))];
  return <section className="team-sync-control" aria-label={l("Team synchronization", "团队同步")}>
    <div className="team-sync-control-main"><div className="team-space-actions">
      {busy && <button className="team-text-button" onClick={() => void api.request({ action: "cancel-sync" }).catch(() => setError(l("Cancellation could not be confirmed.", "取消未确认，请等待操作结束。")))}>{l("Cancel", "取消")}</button>}
      <div className="team-transfer-actions" role="group" aria-label={l("Team resource actions", "团队资源操作")}>
        <button type="button" aria-label={busy ? l("Pulling team resources", "拉取中…") : l("Pull team resources", "Pull 拉取")} title={l("Pull · Update local team resources", "Pull 拉取 · 更新本地团队资源")} disabled={!enabled || busy || externalBusy} onClick={() => void sync()}>
          {busy ? <LoaderCircle size={14} className="team-transfer-spinner" aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}<span>{busy ? "Pulling…" : "Pull"}</span>
        </button>
        <button type="button" aria-label={l("Push selected resources", "Push 推送")} title={l("Push · Choose changes to publish", "Push 推送 · 选择要发布的变更")} disabled={!enabled || busy || externalBusy} onClick={onPush}><ArrowUp size={14} aria-hidden="true" /><span>Push{pendingCount > 0 ? ` · ${pendingCount}` : ""}</span></button>
      </div>
    </div></div>
    {error && <p className="team-workspace-error" role="alert">{error}</p>}
    {notice && <p className="team-workspace-notice" role="status">{notice}</p>}
    {trust && <TeamTrustDialog items={trust} language={language} onClose={() => setTrust(null)} onConfirm={(decision) => { setTrust(null); void sync(decision); }} />}
    {report && <details className="team-sync-results"><summary title={l("Sync details", "同步详情")}><span role="status">{report.status === "complete" ? l(`Synced · ${changed} changes`, `已同步 · ${changed} 项`) : report.status === "no-directories" ? l("Fetched · no directories", "已拉取 · 未接入目录") : report.status === "cancelled" ? l("Cancelled", "同步已取消") : l(`Some updates pending · ${issues}`, `部分内容未同步 · ${issues} 项`)}</span></summary><div className="team-sync-result-popover"><time>{new Date(report.finishedAt).toLocaleString()}</time>{skipped.length > 0 && <p>{l("Skipped as untrusted: ", "未信任而跳过：")}{skipped.join("、")}</p>}<button type="button" className="team-text-button" onClick={() => void resetTrust()}>{l("Review Skill and MCP trust again", "重新确认 Skill 与 MCP 信任")}</button>{report.directories.map((directory) => <div key={directory.id}><strong>{directory.path}</strong><small>{directory.status === "complete" ? l("Completed", "已完成") : directory.status === "skipped" ? l("Disabled, skipped", "已停用，未同步") : directory.status === "cancelled" ? l("Cancelled", "已取消") : l("Needs attention", "需要处理")}</small>{directory.items.filter((item) => item.status === "failed" || item.status === "conflict" || item.backup).map((item, index) => <p key={index}>{item.id}{item.target ? ` · ${item.target}` : ""} — {item.message ?? (item.status === "retired" ? l("Retired, backup kept", "已退役，备份保留") : l("Updated, backup kept", "已更新，备份保留"))}{item.backup && <small>{l("Backup: ", "备份：")}{item.backup}</small>}</p>)}</div>)}</div></details>}
  </section>;
}
