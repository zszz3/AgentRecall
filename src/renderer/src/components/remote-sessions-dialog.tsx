import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, Cloud, CloudUpload, Copy, Eye, FolderOpen, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import type { RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus } from "../../../core/remote-session-sync";
import type { MigrationAgent, SessionMigrationResult } from "../../../core/types";
import { formatRelativeTime } from "../../../core/format-session";
import { localize, type LanguageMode } from "../language";
import { migrationAgentLabel, SOURCE_LABEL, sourceUiFamily } from "../session-ui";
import type { ActionStatus } from "../app-types";

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy", "codewiz", "cursor"];
type RemoteSourceFilter = "all" | MigrationAgent;
type RestoreDestination = "local" | "source";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [restoreTarget, setRestoreTarget] = useState<MigrationAgent>("claude");
  const [localProjectPath, setLocalProjectPath] = useState("");
  const [restoreRequest, setRestoreRequest] = useState<{ remote: RemoteSessionListItem; destination: RestoreDestination } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deleteCandidates, setDeleteCandidates] = useState<RemoteSessionListItem[]>([]);
  const [deleting, setDeleting] = useState(false);
  const selectVisibleRef = useRef<HTMLInputElement>(null);

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
  const selectedSessions = useMemo(() => sessions.filter((session) => selectedIds.has(session.id)), [selectedIds, sessions]);
  const selectedVisibleCount = useMemo(() => filtered.filter((session) => selectedIds.has(session.id)).length, [filtered, selectedIds]);
  const allVisibleSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const currentIds = new Set(sessions.map((session) => session.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [sessions]);

  useEffect(() => {
    if (selectVisibleRef.current) selectVisibleRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

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
    setFeedback({ kind: "running", message: l(`Saving ${visibleUploadCount} local results...`, `正在保存本地主列表中的 ${visibleUploadCount} 个会话...`) });
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

  async function confirmRestore(): Promise<void> {
    if (!restoreRequest) return;
    const { remote, destination } = restoreRequest;
    setRestoringId(remote.id);
    setFeedback({ kind: "running", message: l("Restoring remote session...", "正在恢复远程会话...") });
    try {
      let result: SessionMigrationResult;
      if (destination === "source") {
        result = await window.sessionSearch.restoreRemoteSessionToSourceEnvironment(remote.id, restoreTarget);
      } else {
        let projectPath = localProjectPath.trim();
        if (!projectPath) {
          const selected = await window.sessionSearch.chooseRemoteRestoreProject();
          if (!selected) return;
          projectPath = selected;
          setLocalProjectPath(selected);
        }
        result = await window.sessionSearch.restoreRemoteSession(remote.id, restoreTarget, projectPath);
      }
      onRestored(result);
      setRestoreRequest(null);
      setFeedback({
        kind: "success",
        message:
          destination === "source"
            ? l(`Restored to ${remote.sourceEnvironmentLabel}.`, `已恢复到 ${remote.sourceEnvironmentLabel}。`)
            : l(`Restored to ${migrationAgentLabel(result.target)}.`, `已恢复到 ${migrationAgentLabel(result.target)}。`),
      });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRestoringId(null);
    }
  }

  function toggleSession(remoteId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(remoteId)) next.delete(remoteId);
      else next.add(remoteId);
      return next;
    });
  }

  function toggleVisible(): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const remote of filtered) {
        if (allVisibleSelected) next.delete(remote.id);
        else next.add(remote.id);
      }
      return next;
    });
  }

  async function confirmDelete(): Promise<void> {
    if (deleteCandidates.length === 0) return;
    setDeleting(true);
    setFeedback({ kind: "running", message: l(`Deleting ${deleteCandidates.length} remote sessions...`, `正在删除 ${deleteCandidates.length} 个远程会话...`) });
    try {
      const result = await window.sessionSearch.deleteRemoteSessions(deleteCandidates.map((remote) => remote.id));
      const removedIds = new Set([...result.deletedIds, ...result.missingIds]);
      setSessions((current) => current.filter((remote) => !removedIds.has(remote.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !removedIds.has(id))));
      setDeleteCandidates([]);
      if (result.failures.length > 0) {
        const details = result.failures
          .slice(0, 3)
          .map((failure) => `${deleteCandidates.find((remote) => remote.id === failure.id)?.title ?? failure.id}: ${failure.message}`)
          .join(" · ");
        setFeedback({
          kind: "error",
          message: l(
            `Deleted ${result.deletedIds.length}; ${result.failures.length} failed. ${details}`,
            `已删除 ${result.deletedIds.length} 个，${result.failures.length} 个失败。${details}`,
          ),
        });
      } else {
        setFeedback({ kind: "success", message: l(`Deleted ${removedIds.size} remote sessions.`, `已删除 ${removedIds.size} 个远程会话。`) });
      }
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog remote-sessions-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title remote-sessions-title">
          <span>{l("Remote Sessions", "远程会话")}</span>
          <span className="remote-sessions-count">{l(`${sessions.length} sessions`, `${sessions.length} 个会话`)}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>

        <div className="remote-sessions-toolbar">
          <label className="remote-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={l("Search remote sessions", "搜索远程会话")} autoFocus />
          </label>
          <div className="remote-targets compact" role="group" aria-label={l("Source filter", "来源筛选")}>
            {SOURCE_FILTERS.map((source) => (
              <button key={source} type="button" className={sourceFilter === source ? "active" : ""} onClick={() => setSourceFilter(source)}>
                {source === "all" ? l("All", "全部") : migrationAgentLabel(source)}
              </button>
            ))}
          </div>
          <button type="button" className="remote-toolbar-icon" onClick={() => void refresh()} disabled={loading} title={l("Refresh remote sessions", "刷新远程会话")} aria-label={l("Refresh remote sessions", "刷新远程会话")}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="remote-local-save" onClick={() => void uploadVisible()} disabled={loading || visibleUploadCount === 0} title={l("Save sessions currently visible in the main list", "保存主列表中当前可见的会话")}>
            <CloudUpload size={14} />
            <span>{l(`Save local results (${visibleUploadCount})`, `保存本地主列表（${visibleUploadCount}）`)}</span>
          </button>
        </div>

        <div className="remote-selection-bar">
          <label className="remote-select-visible">
            <input
              ref={selectVisibleRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={loading || filtered.length === 0}
              onChange={toggleVisible}
              aria-label={l("Select visible remote sessions", "选择当前可见的远程会话")}
            />
            <span>{allVisibleSelected ? l("Clear visible", "取消当前选择") : l("Select visible", "选择当前结果")}</span>
          </label>
          <span className="remote-selection-summary">
            {selectedIds.size > 0
              ? l(`${selectedIds.size} selected · ${filtered.length} visible`, `已选 ${selectedIds.size} 个 · 当前 ${filtered.length} 个`)
              : l(`${filtered.length} visible`, `当前 ${filtered.length} 个`)}
          </span>
          <button type="button" className="remote-bulk-delete" disabled={loading || selectedSessions.length === 0} onClick={() => setDeleteCandidates(selectedSessions)}>
            <Trash2 size={14} />
            <span>{l(`Delete selected (${selectedSessions.length})`, `删除选中（${selectedSessions.length}）`)}</span>
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
            <article key={remote.id} className={`remote-session-row ${selectedIds.has(remote.id) ? "selected" : ""}`}>
              <label className="remote-session-select" title={l("Select session", "选择会话")}>
                <input type="checkbox" checked={selectedIds.has(remote.id)} onChange={() => toggleSession(remote.id)} aria-label={l(`Select ${remote.title}`, `选择 ${remote.title}`)} />
              </label>
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
                <button type="button" className="remote-session-action subtle" onClick={() => void openDetail(remote)} disabled={detailLoadingId === remote.id || restoringId === remote.id}>
                  <Eye size={14} />
                  <span>{detailLoadingId === remote.id ? l("Loading...", "加载中...") : l("View", "查看")}</span>
                </button>
                <button type="button" className="remote-session-action primary" onClick={() => setRestoreRequest({ remote, destination: "local" })} disabled={restoringId === remote.id}>
                  <ArrowRightLeft size={14} />
                  <span>{l("Restore", "恢复")}</span>
                </button>
                {remote.sourceEnvironmentKind === "ssh" ? (
                  <button type="button" className="remote-session-action icon-only subtle" onClick={() => setRestoreRequest({ remote, destination: "source" })} disabled={restoringId === remote.id} title={l("Restore to the original SSH environment", "恢复到原 SSH 环境")} aria-label={l("Restore to source SSH environment", "恢复到来源 SSH 环境")}>
                    <Server size={14} />
                  </button>
                ) : null}
                <button type="button" className="remote-session-action icon-only danger" onClick={() => setDeleteCandidates([remote])} disabled={restoringId === remote.id} aria-label={l("Delete remote session", "删除远程会话")} title={l("Delete remote session", "删除远程会话")}>
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>

        {restoreRequest ? (
          <RemoteRestoreDialog
            request={restoreRequest}
            target={restoreTarget}
            projectPath={localProjectPath}
            language={language}
            restoring={restoringId === restoreRequest.remote.id}
            onTargetChange={setRestoreTarget}
            onChooseProject={() => void chooseProject()}
            onConfirm={() => void confirmRestore()}
            onCancel={() => {
              if (!restoringId) setRestoreRequest(null);
            }}
          />
        ) : null}
        {deleteCandidates.length > 0 ? (
          <DeleteRemoteSessionsDialog
            sessions={deleteCandidates}
            language={language}
            deleting={deleting}
            onConfirm={() => void confirmDelete()}
            onCancel={() => {
              if (!deleting) setDeleteCandidates([]);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

function RemoteRestoreDialog({
  request,
  target,
  projectPath,
  language,
  restoring,
  onTargetChange,
  onChooseProject,
  onConfirm,
  onCancel,
}: {
  request: { remote: RemoteSessionListItem; destination: RestoreDestination };
  target: MigrationAgent;
  projectPath: string;
  language: LanguageMode;
  restoring: boolean;
  onTargetChange: (target: MigrationAgent) => void;
  onChooseProject: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog remote-restore-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Restore remote session", "恢复远程会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={restoring} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="remote-restore-session-title" title={request.remote.title}>{request.remote.title}</p>
        <div className="remote-restore-field">
          <span>{l("Restore to", "恢复到")}</span>
          <div className="remote-targets">
            {RESTORE_TARGETS.map((item) => (
              <button key={item} type="button" className={target === item ? "active" : ""} onClick={() => onTargetChange(item)} disabled={restoring}>
                {migrationAgentLabel(item)}
              </button>
            ))}
          </div>
        </div>
        <div className="remote-restore-field destination">
          <span>{l("Destination", "目标位置")}</span>
          {request.destination === "source" ? (
            <strong>{request.remote.sourceEnvironmentLabel}</strong>
          ) : (
            <button type="button" className="remote-project-picker" onClick={onChooseProject} disabled={restoring}>
              <FolderOpen size={14} />
              <span>{projectPath || l("Choose project", "选择项目")}</span>
            </button>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={restoring}>{l("Cancel", "取消")}</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={restoring}>
            {restoring ? l("Restoring...", "正在恢复...") : l("Restore", "恢复")}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRemoteSessionsDialog({
  sessions,
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  sessions: RemoteSessionListItem[];
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-remote-sessions-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete remote sessions", "删除远程会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={deleting} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l(`Delete ${sessions.length} selected remote sessions?`, `确定删除选中的 ${sessions.length} 个远程会话吗？`)}
        </p>
        <div className="remote-delete-preview">
          {sessions.slice(0, 4).map((session) => <span key={session.id}>{session.title}</span>)}
          {sessions.length > 4 ? <span>{l(`and ${sessions.length - 4} more`, `以及另外 ${sessions.length - 4} 个`)}</span> : null}
        </div>
        <p className="dialog-copy danger-copy">{l("This removes the remote copies and cannot be undone.", "远程副本将被永久删除，且无法撤销。")}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={deleting}>{l("Cancel", "取消")}</button>
          <button type="button" className="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? l("Deleting...", "正在删除...") : l("Delete", "删除")}
          </button>
        </div>
      </div>
    </div>
  );
}
