import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, LoaderCircle } from "lucide-react";
import type { TeamPullReport, TeamSpace } from "@agentrecall/workspace-core";
import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { LanguageMode } from "../../language";

export function TeamSyncControl({ team, enabled, externalBusy, language, api, onBusy, onSynced, onPush }: { team: TeamSpace; enabled: boolean; externalBusy: boolean; language: LanguageMode; api: TeamWorkspaceApi; onBusy(value: boolean): void; onPush(): void; onSynced(report: TeamPullReport): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [report, setReport] = useState<TeamPullReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
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
  async function sync() {
    if (running.current) return;
    running.current = true; version.current++; setBusy(true); setError(""); onBusy(true);
    try {
      const reply = await api.request({ action: "sync", scope });
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "sync-result") { setReport(reply.data.value); onSynced(reply.data.value); }
    } catch { if (alive.current) setError(l("Sync result is uncertain. Retry to check the files already written.", "同步结果未确认。重试会重新核对已写入的文件。")); }
    finally { running.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  }
  const counts = report?.directories.flatMap((directory) => directory.items) ?? [];
  const changed = counts.filter((item) => ["installed", "updated", "retired"].includes(item.status)).length;
  const issues = counts.filter((item) => item.status === "conflict" || item.status === "failed").length;
  return <section className="team-sync-control" aria-label={l("Team synchronization", "团队同步")}>
    <div className="team-sync-control-main"><div><strong>{busy ? l("Syncing team assets…", "正在拉取团队资源…") : l("Team assets", "团队资源")}</strong><p role="status">{busy ? l("Updating team resources in enabled working directories.", "正在更新已启用工作目录中的团队资源。") : report ? report.status === "complete" ? l(`Last sync completed · ${changed} changes`, `上次同步完成 · ${changed} 项变更`) : report.status === "no-directories" ? l("Resources fetched. Connect a working directory to use them.", "资源已拉取，接入或启用工作目录后即可同步使用。") : report.status === "cancelled" ? l("Sync cancelled. Completed changes and backups are retained.", "同步已取消，已完成的变更和备份保留。") : l(`Some updates need attention · ${issues} issues`, `部分内容未同步 · ${issues} 项需要处理`) : l("Pull updates local team resources; Push publishes selected resources to the team.", "Pull 更新本地团队资源，Push 将所选资源发布到团队。")}</p></div><div className="team-space-actions">
      {busy && <button className="team-text-button" onClick={() => void api.request({ action: "cancel-sync" }).catch(() => setError(l("Cancellation could not be confirmed.", "取消未确认，请等待操作结束。")))}>{l("Cancel", "取消")}</button>}
      <div className="team-transfer-actions" role="group" aria-label={l("Team resource actions", "团队资源操作")}>
        <button type="button" aria-label={busy ? l("Pulling team resources", "拉取中…") : l("Pull team resources", "Pull 拉取")} title={l("Pull · Update local team resources", "Pull 拉取 · 更新本地团队资源")} disabled={!enabled || busy || externalBusy} onClick={() => void sync()}>
          {busy ? <LoaderCircle size={14} className="team-transfer-spinner" aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}<span>{busy ? "Pulling…" : "Pull"}</span>
        </button>
        <button type="button" aria-label={l("Push selected resources", "Push 推送")} title={l("Push · Choose changes to publish", "Push 推送 · 选择要发布的变更")} disabled={!enabled || busy || externalBusy} onClick={onPush}><ArrowUp size={14} aria-hidden="true" /><span>Push</span></button>
      </div>
    </div></div>
    {error && <p className="team-workspace-error" role="alert">{error}</p>}
    {report && <details className="team-sync-results"><summary>{l("Sync details", "同步详情")} · {new Date(report.finishedAt).toLocaleString()}</summary>{report.directories.map((directory) => <div key={directory.id}><strong>{directory.path}</strong><small>{directory.status === "complete" ? l("Completed", "已完成") : directory.status === "skipped" ? l("Disabled, skipped", "已停用，未同步") : directory.status === "cancelled" ? l("Cancelled", "已取消") : l("Needs attention", "需要处理")}</small>{directory.items.filter((item) => item.status === "failed" || item.status === "conflict" || item.backup).map((item, index) => <p key={index}>{item.id}{item.target ? ` · ${item.target}` : ""} — {item.message ?? (item.status === "retired" ? l("Retired, backup kept", "已退役，备份保留") : l("Updated, backup kept", "已更新，备份保留"))}{item.backup && <small>{l("Backup: ", "备份：")}{item.backup}</small>}</p>)}</div>)}</details>}
  </section>;
}
