import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, Cloud, CloudUpload, Copy, Eye, FolderOpen, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import type { RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus } from "../../../core/remote-session-sync";
import type { MigrationAgent, SessionMigrationResult } from "../../../core/types";
import { formatRelativeTime } from "../../../core/format-session";
import { localize, type LanguageMode } from "../language";
import { migrationAgentLabel, SOURCE_LABEL, sourceUiFamily } from "../session-ui";
import type { ActionStatus } from "../app-types";

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy"];
type RemoteSourceFilter = "all" | MigrationAgent;
const SOURCE_FILTERS: RemoteSourceFilter[] = ["all", ...RESTORE_TARGETS];

export function RemoteSessionsDialog({
  language,
  onClose,
  onRestored,
  onOpenDetail,
  onUploadVisible,
  visibleUploadCount,
}: {
  language: LanguageMode;
  onClose: () => void;
  onRestored: (result: SessionMigrationResult) => void;
  onOpenDetail: (detail: RemoteSessionDetailSnapshot, query: string) => void;
  onUploadVisible: () => Promise<void>;
  visibleUploadCount: number;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [status, setStatus] = useState<RemoteSessionStatus | null>(null);
  const [sessions, setSessions] = useState<RemoteSessionListItem[]>([]);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<RemoteSourceFilter>("all");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<ActionStatus | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MigrationAgent>("claude");
  const [localProjectPath, setLocalProjectPath] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (sourceFilter !== "all" && session.sourceAgent !== sourceFilter) return false;
      if (!normalized) return true;
      return [session.title, session.projectPath, session.aiSummary ?? "", session.tags.join(" "), session.searchText]
        .join("\n")
        .toLowerCase()
        .includes(normalized);
    });
  }, [query, sessions, sourceFilter]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const nextStatus = await window.sessionSearch.getRemoteSessionStatus();
      setStatus(nextStatus);
      if (nextStatus.kind === "ready") {
        setSessions(await window.sessionSearch.listRemoteSessions(""));
        setFeedback(null);
      } else {
        setSessions([]);
        setFeedback({ kind: nextStatus.kind === "error" ? "error" : "success", message: nextStatus.message });
      }
    } catch (error) {
      setSessions([]);
      setStatus(null);
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function copySetupSql(): Promise<void> {
    try {
      await window.sessionSearch.copyRemoteSessionSetupSql();
      setFeedback({ kind: "success", message: l("Supabase setup SQL copied.", "Supabase 初始化 SQL 已复制。") });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function uploadVisible(): Promise<void> {
    setFeedback({ kind: "running", message: l(`Saving ${visibleUploadCount} visible sessions...`, `正在保存 ${visibleUploadCount} 个当前可见会话...`) });
    try {
      await onUploadVisible();
      await refresh();
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function openDetail(remote: RemoteSessionListItem): Promise<void> {
    setDetailLoadingId(remote.id);
    try {
      onOpenDetail(await window.sessionSearch.getRemoteSessionDetail(remote.id), query);
      setFeedback(null);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function chooseProject(): Promise<void> {
    const selected = await window.sessionSearch.chooseRemoteRestoreProject();
    if (selected) setLocalProjectPath(selected);
  }

  async function restore(remote: RemoteSessionListItem): Promise<void> {
    let projectPath = localProjectPath.trim();
    if (!projectPath) {
      const selected = await window.sessionSearch.chooseRemoteRestoreProject();
      if (!selected) return;
      projectPath = selected;
      setLocalProjectPath(selected);
    }
    setRestoringId(remote.id);
    setFeedback({ kind: "running", message: l("Restoring remote session...", "正在恢复远程会话...") });
    try {
      const result = await window.sessionSearch.restoreRemoteSession(remote.id, restoreTarget, projectPath);
      onRestored(result);
      const message = l(`Restored to ${migrationAgentLabel(result.target)}.`, `已恢复到 ${migrationAgentLabel(result.target)}。`);
      setFeedback({ kind: "success", message });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRestoringId(null);
    }
  }

  async function restoreToSourceRemote(remote: RemoteSessionListItem): Promise<void> {
    setRestoringId(remote.id);
    setFeedback({ kind: "running", message: l("Restoring to source SSH environment...", "正在恢复到来源 SSH 环境...") });
    try {
      const result = await window.sessionSearch.restoreRemoteSessionToSourceEnvironment(remote.id, restoreTarget);
      onRestored(result);
      setFeedback({ kind: "success", message: l(`Restored to ${remote.sourceEnvironmentLabel}.`, `已恢复到 ${remote.sourceEnvironmentLabel}。`) });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRestoringId(null);
    }
  }

  async function deleteRemote(remote: RemoteSessionListItem): Promise<void> {
    setFeedback({ kind: "running", message: l("Deleting remote session...", "正在删除远程会话...") });
    try {
      await window.sessionSearch.deleteRemoteSession(remote.id);
      setSessions((current) => current.filter((item) => item.id !== remote.id));
      setFeedback({ kind: "success", message: l("Remote session deleted.", "远程会话已删除。") });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog remote-sessions-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Remote Sessions", "远程会话")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="remote-sessions-toolbar">
          <div className="remote-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={l("Search remote sessions", "搜索远程会话")} />
          </div>
          <div className="remote-filter-group" role="group" aria-label={l("Source filter", "来源筛选")}>
            <span>{l("Source", "来源")}</span>
            <div className="remote-targets compact">
              {SOURCE_FILTERS.map((source) => (
                <button key={source} type="button" className={sourceFilter === source ? "active" : ""} onClick={() => setSourceFilter(source)}>
                  {source === "all" ? l("All", "全部") : migrationAgentLabel(source)}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="settings-action-button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} />
            <span>{l("Refresh", "刷新")}</span>
          </button>
          <button type="button" className="settings-action-button" onClick={() => void uploadVisible()} disabled={loading || visibleUploadCount === 0}>
            <CloudUpload size={14} />
            <span>{l(`Save visible (${visibleUploadCount})`, `保存当前可见（${visibleUploadCount}）`)}</span>
          </button>
        </div>
        <div className="remote-restore-bar">
          <div className="remote-filter-group" role="group" aria-label={l("Restore target", "恢复目标")}>
            <span>{l("Restore to", "恢复到")}</span>
            <div className="remote-targets">
              {RESTORE_TARGETS.map((target) => (
                <button key={target} type="button" className={restoreTarget === target ? "active" : ""} onClick={() => setRestoreTarget(target)}>
                  {migrationAgentLabel(target)}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="settings-action-button" onClick={() => void chooseProject()}>
            <FolderOpen size={14} />
            <span>{localProjectPath || l("Choose project", "选择项目")}</span>
          </button>
        </div>
        {feedback ? <div className={`settings-feedback inline ${feedback.kind}`}>{feedback.message}</div> : null}
        <div className="remote-session-list">
          {loading ? <div className="remote-empty">{l("Loading remote sessions...", "正在加载远程会话...")}</div> : null}
          {!loading && status?.kind !== "ready" ? (
            <div className="remote-empty">
              <Cloud size={18} />
              <span>{status?.message ?? l("Remote sync is not configured.", "远程同步未配置。")}</span>
              {status && status.kind !== "unconfigured" ? (
                <button type="button" className="setup-copy-button" onClick={() => void copySetupSql()}>
                  <Copy size={13} />
                  <span>{l("Copy setup SQL", "复制初始化 SQL")}</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {!loading && status?.kind === "ready" && filtered.length === 0 ? <div className="remote-empty">{l("No remote sessions found.", "没有找到远程会话。")}</div> : null}
          {filtered.map((remote) => (
            <article key={remote.id} className="remote-session-row">
              <div className="remote-session-main">
                <strong>{remote.title}</strong>
                <div className="session-meta">
                  <span className={`source-badge ${sourceUiFamily(remote.sourceSource as never)}`}>
                    {SOURCE_LABEL[remote.sourceSource as keyof typeof SOURCE_LABEL] ?? remote.sourceAgent}
                  </span>
                  <span>{remote.projectPath || l("No project path", "无项目路径")}</span>
                  <span>{formatRelativeTime(remote.updatedAt)}</span>
                  <span>{l(`${remote.messageCount} messages`, `${remote.messageCount} 条消息`)}</span>
                  {remote.traceEventCount > 0 ? <span>{l(`${remote.traceEventCount} trace events`, `${remote.traceEventCount} 条轨迹`)}</span> : null}
                </div>
                {remote.aiSummary ? <p>{remote.aiSummary}</p> : null}
                {remote.tags.length > 0 ? (
                  <div className="row-tags">
                    {remote.tags.slice(0, 5).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="remote-session-actions">
                <button type="button" className="remote-session-action" onClick={() => void openDetail(remote)} disabled={detailLoadingId === remote.id || restoringId === remote.id}>
                  <Eye size={14} />
                  <span>{detailLoadingId === remote.id ? l("Loading...", "加载中...") : l("View", "查看")}</span>
                </button>
                <button type="button" className="remote-session-action" onClick={() => void restore(remote)} disabled={restoringId === remote.id}>
                  <ArrowRightLeft size={14} />
                  <span>{restoringId === remote.id ? l("Restoring...", "恢复中...") : l("Restore", "恢复")}</span>
                </button>
                {remote.sourceEnvironmentKind === "ssh" ? (
                  <button type="button" className="remote-session-action" onClick={() => void restoreToSourceRemote(remote)} disabled={restoringId === remote.id} title={l("Restore to the original SSH environment", "恢复到原 SSH 环境")}>
                    <Server size={14} />
                    <span>{l("Restore SSH", "恢复 SSH")}</span>
                  </button>
                ) : null}
                <button type="button" className="remote-session-action icon-only danger" onClick={() => void deleteRemote(remote)} disabled={restoringId === remote.id} aria-label={l("Delete remote session", "删除远程会话")}>
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
