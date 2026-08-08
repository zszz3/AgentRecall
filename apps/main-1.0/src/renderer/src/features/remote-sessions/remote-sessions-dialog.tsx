import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, Cloud, CloudUpload, Eye, FolderOpen, Laptop, MoreHorizontal, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import type { RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus, SessionSyncItem, SessionSyncState } from "../../../../core/remote-session-sync";
import type { MigrationAgent, RemoteSessionAgent, SessionMigrationResult } from "../../../../core/types";
import { isSessionSource, remoteSessionAgentForSource, sessionSourceDescriptor } from "../../../../core/session-sources";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { migrationAgentLabel, sourceUiFamily } from "../../session-ui";
import type { ActionStatus } from "../../app-types";
import type {
  RemoteSessionDeleteRequest,
  RemoteSessionOperationBatch,
  RemoteSessionTaskState,
  RemoteSessionUploadRequest,
  RemoteSessionsCache,
} from "../../remote-sessions-cache";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy", "codewiz", "cursor"];
type RemoteSourceFilter = "all" | RemoteSessionAgent;
type RestoreDestination = "local" | "source";
const SOURCE_FILTERS: RemoteSourceFilter[] = ["all", ...RESTORE_TARGETS, "hermes", "pi"];
const REMOTE_SESSION_PAGE_SIZE = 50;

export type SessionPrimaryAction = "upload" | "view" | "restore" | "resolve";
export type SessionCopySummary =
  | { present: false; missing: "not-uploaded" | "no-local-copy" }
  | { present: true; updatedAt: number; messageCount: number; syncedAt?: number };

export function primarySessionAction(item: SessionSyncItem): SessionPrimaryAction {
  if (item.state === "local-only" || item.state === "local-newer") return "upload";
  if (item.state === "remote-only" || item.state === "remote-newer") return "restore";
  if (item.state === "conflict") return "resolve";
  return "view";
}

export function sessionCopySummary(item: SessionSyncItem, side: "local" | "remote"): SessionCopySummary {
  if (side === "local") {
    if (!item.local) return { present: false, missing: "no-local-copy" };
    return { present: true, updatedAt: item.local.lastActivityAt, messageCount: item.local.messageCount };
  }
  if (!item.remote) return { present: false, missing: "not-uploaded" };
  return {
    present: true,
    updatedAt: item.remote.updatedAt,
    messageCount: item.remote.messageCount,
    syncedAt: item.remote.syncedAt,
  };
}

function syncItemTitle(item: SessionSyncItem): string {
  return item.local?.displayTitle || item.remote?.title || "Untitled session";
}

function taskActive(state: RemoteSessionTaskState | undefined): boolean {
  return state === "queued" || state === "running";
}

function taskErrorSummary(error: string | null): string {
  return (error ?? "Unknown error").split(/\r?\n/, 1)[0].slice(0, 240);
}

function isCursorFullSessionUpdate(item: SessionSyncItem): boolean {
  return (
    item.state === "local-newer"
    && item.local?.source === "cursor-agent"
    && item.remote !== null
    && item.local.messageCount === item.remote.messageCount
  );
}

function syncStateLabel(item: SessionSyncItem, language: LanguageMode): string {
  if (isCursorFullSessionUpdate(item)) {
    return localize(language, "Full session changed", "完整会话有更新");
  }
  const labels: Record<SessionSyncState, [string, string]> = {
    "local-only": ["Local only", "仅本地"],
    "local-newer": ["Upload available", "待更新云端"],
    synced: ["Synced", "已同步"],
    "remote-newer": ["Cloud newer", "云端较新"],
    "remote-only": ["Cloud only", "仅云端"],
    conflict: ["Conflict", "内容冲突"],
  };
  return localize(language, ...labels[item.state]);
}

function syncStateDescription(item: SessionSyncItem, language: LanguageMode): string | undefined {
  if (!isCursorFullSessionUpdate(item)) return undefined;
  return localize(
    language,
    "Message counts cover the visible branch only. Changes elsewhere in the complete Cursor session, including hidden branches, also require a cloud update.",
    "消息数只统计当前可见分支；完整 Cursor 会话中的其他内容（包括隐藏分支）发生变化时，也需要更新云端。",
  );
}

export function RemoteSessionsDialog({
  cache,
  language,
  onRefresh,
  onQueueUploads,
  onQueueDeletions,
  onContinueInBackground,
  onClose,
  onRestored,
  onOpenDetail,
}: {
  cache: RemoteSessionsCache;
  language: LanguageMode;
  onRefresh: () => Promise<void>;
  onQueueUploads: (requests: RemoteSessionUploadRequest[]) => void;
  onQueueDeletions: (requests: RemoteSessionDeleteRequest[]) => void;
  onContinueInBackground: () => void;
  onClose: () => void;
  onRestored: (result: SessionMigrationResult) => void;
  onOpenDetail: (detail: RemoteSessionDetailSnapshot, query: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const {
    status,
    items,
    initialized,
    loading,
    refreshing,
    error: cacheError,
    uploadTasks,
    uploadBatch,
    deleteTasks,
    deleteBatch,
  } = cache;
  const initialLoading = !initialized || loading;
  const operationsRunning = uploadBatch?.running === true || deleteBatch?.running === true;
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<RemoteSourceFilter>("all");
  const [feedback, setFeedback] = useState<ActionStatus | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [restoreTarget, setRestoreTarget] = useState<MigrationAgent>("claude");
  const [localProjectPath, setLocalProjectPath] = useState("");
  const [restoreRequest, setRestoreRequest] = useState<{ remote: RemoteSessionListItem; destination: RestoreDestination } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deleteCandidates, setDeleteCandidates] = useState<SessionSyncItem[]>([]);
  const [conflictItem, setConflictItem] = useState<SessionSyncItem | null>(null);
  const [openActionsId, setOpenActionsId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(REMOTE_SESSION_PAGE_SIZE);
  const selectVisibleRef = useRef<HTMLInputElement>(null);
  const detailRequestSeqRef = useRef(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const sourceAgent = item.remote?.sourceAgent ?? (item.local ? remoteSessionAgentForSource(item.local.source) : null);
      if (sourceFilter !== "all" && sourceAgent !== sourceFilter) return false;
      if (!normalized) return true;
      return [item.local?.displayTitle, item.remote?.title, item.local?.projectPath, item.remote?.projectPath, item.local?.aiSummary, item.remote?.aiSummary, ...(item.local?.tags ?? []), ...(item.remote?.tags ?? [])]
        .join("\n")
        .toLowerCase()
        .includes(normalized);
    });
  }, [items, query, sourceFilter]);
  const selectedItems = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds]);
  const selectedRemoteItems = useMemo(() => selectedItems.filter((item) => item.remote), [selectedItems]);
  const selectedUploadItems = useMemo(() => selectedItems.filter((item) =>
    item.local
    && (item.state === "local-only" || item.state === "local-newer")
    && !taskActive(uploadTasks[item.local.sessionKey]?.state)), [selectedItems, uploadTasks]);
  const selectedDeletableItems = useMemo(() => selectedRemoteItems.filter((item) =>
    item.remote && !taskActive(deleteTasks[item.remote.id]?.state)), [deleteTasks, selectedRemoteItems]);
  const selectedVisibleCount = useMemo(() => filtered.filter((item) => selectedIds.has(item.id)).length, [filtered, selectedIds]);
  const allVisibleSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const visibleFeedback = feedback ?? (cacheError ? { kind: "error" as const, message: cacheError } : null);
  const filteredRef = useRef(filtered);
  const filteredChanged = filteredRef.current !== filtered;
  const effectiveVisibleLimit = filteredChanged ? REMOTE_SESSION_PAGE_SIZE : visibleLimit;
  const visibleItems = filtered.slice(0, effectiveVisibleLimit);

  useEffect(() => {
    return () => {
      detailRequestSeqRef.current++;
    };
  }, []);

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  useEffect(() => {
    if (selectVisibleRef.current) selectVisibleRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  useEffect(() => {
    if (filteredRef.current === filtered) return;
    filteredRef.current = filtered;
    setVisibleLimit(REMOTE_SESSION_PAGE_SIZE);
  }, [filtered]);

  async function copySetupSql(): Promise<void> {
    await window.sessionSearch.copyRemoteSessionSetupSql();
  }

  function uploadSelected(): void {
    const candidates = selectedUploadItems;
    if (candidates.length === 0) return;
    onQueueUploads(candidates.map((item) => ({
      itemId: item.id,
      sessionKey: item.local!.sessionKey,
      title: syncItemTitle(item),
    })));
    const queuedIds = new Set(candidates.map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => !queuedIds.has(id))));
    setFeedback(null);
  }

  function uploadOne(item: SessionSyncItem, force = false): void {
    if (!item.local) return;
    onQueueUploads([{
      itemId: item.id,
      sessionKey: item.local.sessionKey,
      title: syncItemTitle(item),
      force,
    }]);
    setFeedback(null);
  }

  async function openDetail(remote: RemoteSessionListItem): Promise<void> {
    const requestId = ++detailRequestSeqRef.current;
    setDetailLoadingId(remote.id);
    try {
      const detail = await window.sessionSearch.getRemoteSessionDetail(remote.id);
      if (requestId !== detailRequestSeqRef.current) return;
      onOpenDetail(detail, query);
      setFeedback(null);
    } catch (error) {
      if (requestId !== detailRequestSeqRef.current) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (requestId === detailRequestSeqRef.current) setDetailLoadingId(null);
    }
  }

  function closeRemoteSessionsDialog(): void {
    detailRequestSeqRef.current++;
    onClose();
  }

  async function chooseProject(): Promise<void> {
    try {
      const selected = await window.sessionSearch.chooseRemoteRestoreProject();
      if (selected) setLocalProjectPath(selected);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
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

  function toggleSession(itemId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleVisible(): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of filtered) {
        if (allVisibleSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

  function confirmDelete(): void {
    if (deleteCandidates.length === 0) return;
    onQueueDeletions(deleteCandidates.flatMap((item) => item.remote ? [{
      itemId: item.id,
      remoteId: item.remote.id,
      title: syncItemTitle(item),
    }] : []));
    const queuedIds = new Set(deleteCandidates.map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => !queuedIds.has(id))));
    setDeleteCandidates([]);
    setFeedback(null);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={closeRemoteSessionsDialog}>
      <section className="command-dialog remote-sessions-dialog" onMouseDown={(event) => { event.stopPropagation(); setOpenActionsId(null); }}>
        <div className="dialog-title remote-sessions-title">
          <span>{l("Session sync", "会话同步")}</span>
          <span className="remote-sessions-count">{l(`${items.length} sessions`, `${items.length} 个会话`)}</span>
          <button type="button" className="icon-button" onClick={closeRemoteSessionsDialog} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>

        <div className="remote-sessions-toolbar">
          <label className="remote-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={l("Search local and cloud sessions", "搜索本地和云端会话")} autoFocus />
          </label>
          <div className="remote-targets compact" role="group" aria-label={l("Source filter", "来源筛选")}>
            {SOURCE_FILTERS.map((source) => (
              <button key={source} type="button" className={sourceFilter === source ? "active" : ""} onClick={() => setSourceFilter(source)}>
                {source === "all" ? l("All", "全部") : remoteSourceLabel(source)}
              </button>
            ))}
          </div>
          <label className="remote-select-visible">
            <input
              ref={selectVisibleRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={initialLoading || filtered.length === 0}
              onChange={toggleVisible}
              aria-label={l("Select visible remote sessions", "选择当前可见的远程会话")}
            />
            <span>
              {allVisibleSelected
                ? l("Clear current", "取消当前选择")
                : l(`Select current (${filtered.length})`, `选择当前结果（${filtered.length}）`)}
            </span>
          </label>
          <button type="button" className="remote-local-save" disabled={selectedUploadItems.length === 0} onClick={uploadSelected}>
            <CloudUpload size={14} />
            <span>{l(`Upload to cloud (${selectedUploadItems.length})`, `上传到云端（${selectedUploadItems.length}）`)}</span>
          </button>
          <button type="button" className="remote-bulk-delete" disabled={selectedDeletableItems.length === 0} onClick={() => setDeleteCandidates(selectedDeletableItems)}>
            <Trash2 size={14} />
            <span>{l(`Delete cloud copies (${selectedDeletableItems.length})`, `删除云端副本（${selectedDeletableItems.length}）`)}</span>
          </button>
          <button type="button" className="remote-toolbar-icon" onClick={() => void onRefresh()} disabled={loading || refreshing || operationsRunning} title={l("Refresh remote sessions", "刷新远程会话")} aria-label={l("Refresh remote sessions", "刷新远程会话")}>
            <RefreshCw size={15} />
          </button>
        </div>

        {!initialLoading && status && status.kind !== "ready" ? (
          <SupabaseSetupGuide
            language={language}
            tone={status?.kind === "error" ? "error" : "warning"}
            title={l("Remote sync is not ready", "远程同步尚未准备完成")}
            message={status.remediation === "settings"
              ? l("Check the Supabase URL and anon key in Remote sync settings, then refresh.", "请检查远程同步设置中的 Supabase URL 和 anon key，然后刷新。")
              : undefined}
            detail={status.kind === "unconfigured" ? null : status.message}
            busy={operationsRunning}
            showSqlActions={status.remediation === "sql"}
            onCopySql={copySetupSql}
            onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("sessions")}
            onRefresh={onRefresh}
          />
        ) : null}

        {visibleFeedback ? <div className={`settings-feedback inline remote-session-feedback ${visibleFeedback.kind}`}>{visibleFeedback.message}</div> : null}
        {uploadBatch ? <RemoteOperationStatus kind="upload" batch={uploadBatch} failures={Object.values(uploadTasks).filter((task) => task.state === "failed").map((task) => `${task.title}: ${taskErrorSummary(task.error)}`)} language={language} /> : null}
        {deleteBatch ? <RemoteOperationStatus kind="delete" batch={deleteBatch} failures={Object.values(deleteTasks).filter((task) => task.state === "failed").map((task) => `${task.title}: ${taskErrorSummary(task.error)}`)} language={language} /> : null}
        {refreshing ? (
          <div className="remote-refreshing-status" role="status">
            <RefreshCw size={14} className="spin" />
            <span>{l("Refreshing in the background. Showing the previous results.", "正在后台刷新，当前显示上次结果。")}</span>
          </div>
        ) : null}
        <div className="remote-session-list">
          {initialLoading ? (
            <div className="remote-empty remote-loading-state">
              <span role="status">{l("Loading remote sessions...", "正在加载远程会话...")}</span>
              <span>{l("You can continue using the app while this finishes.", "加载期间可以继续使用应用。")}</span>
              <button type="button" className="remote-loading-dismiss" onClick={onContinueInBackground}>
                {l("Continue in background", "转到后台")}
              </button>
            </div>
          ) : null}
          {initialized && !loading && status?.kind === "ready" && filtered.length === 0 ? <div className="remote-empty">{l("No syncable sessions found.", "没有找到可同步的会话。")}</div> : null}
           {visibleItems.map((item) => {
             const remote = item.remote;
             const local = item.local;
             const source = remote?.sourceSource ?? local?.source ?? "";
             const sourceDescriptor = isSessionSource(source) ? sessionSourceDescriptor(source) : null;
             const title = syncItemTitle(item);
             const localCopy = sessionCopySummary(item, "local");
             const remoteCopy = sessionCopySummary(item, "remote");
             const primaryAction = primarySessionAction(item);
             const uploadTask = local ? uploadTasks[local.sessionKey] : undefined;
             const deleteTask = remote ? deleteTasks[remote.id] : undefined;
             const uploadBusy = taskActive(uploadTask?.state);
             const deleteBusy = taskActive(deleteTask?.state);
             const branchLabel = local?.gitBranch
               ? local.gitBranch.startsWith("branch:") ? local.gitBranch : `branch:${local.gitBranch}`
               : null;
             const tags = (local?.tags ?? remote?.tags ?? []).filter((tag) => tag !== branchLabel).slice(0, 5);
             return (
            <article key={item.id} className={`remote-session-row ${selectedIds.has(item.id) ? "selected" : ""} ${uploadBusy || deleteBusy ? "busy" : ""}`}>
              <label className="remote-session-select" title={l("Select session", "选择会话")}>
                <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSession(item.id)} aria-label={l(`Select ${title}`, `选择 ${title}`)} />
              </label>
              <div className="remote-session-main">
                 <div className="remote-session-heading">
                   <strong>{title}</strong>
                   <span className={`source-badge ${sourceDescriptor ? sourceUiFamily(sourceDescriptor.id) : "other"}`}>
                     {sourceDescriptor?.label ?? remote?.sourceAgent ?? (local ? remoteSessionAgentForSource(local.source) : "")}
                   </span>
                   <span className={`sync-state-badge ${item.state}`} title={syncStateDescription(item, language)}>
                     {syncStateLabel(item, language)}
                   </span>
                 </div>
                 <div className="remote-session-context">
                   <span>{local?.projectPath || remote?.projectPath || l("No project path", "无项目路径")}</span>
                 </div>
                 {uploadTask ? <div className={`remote-session-task-status ${uploadTask.state}`}>{uploadTask.state === "queued" ? l("Waiting to upload", "等待上传") : uploadTask.state === "running" ? l("Uploading in background", "正在后台上传") : uploadTask.state === "failed" ? l(`Upload failed: ${taskErrorSummary(uploadTask.error)}`, `上传失败：${taskErrorSummary(uploadTask.error)}`) : l("Uploaded", "已上传")}</div> : null}
                 {deleteTask ? <div className={`remote-session-task-status ${deleteTask.state}`}>{deleteTask.state === "queued" ? l("Waiting to delete", "等待删除") : deleteTask.state === "running" ? l("Deleting in background", "正在后台删除") : deleteTask.state === "failed" ? l(`Delete failed: ${taskErrorSummary(deleteTask.error)}`, `删除失败：${taskErrorSummary(deleteTask.error)}`) : l("Cloud copy deleted", "云端副本已删除")}</div> : null}
                 <div className="remote-session-comparison">
                   <SessionCopyCard side="local" summary={localCopy} language={language} />
                   <SessionCopyCard side="remote" summary={remoteCopy} language={language} />
                 </div>
                {local?.aiSummary || remote?.aiSummary ? <p>{local?.aiSummary ?? remote?.aiSummary}</p> : null}
                {branchLabel || tags.length > 0 ? (
                  <div className="remote-session-tags">
                    {branchLabel ? <span className="branch-tag">#{branchLabel}</span> : null}
                    {tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                ) : null}
               </div>
               <div className={`remote-session-actions ${item.state} ${remote ? "" : "cloud-empty"}`}>
                 {remote ? <button type="button" className="remote-session-action remote-session-view-action" onClick={() => void openDetail(remote)} disabled={detailLoadingId === remote.id || restoringId === remote.id || deleteBusy}>
                   <Eye size={14} />
                   <span>{detailLoadingId === remote.id ? l("Loading...", "加载中...") : l("View", "查看")}</span>
                 </button> : null}
                 {remote && item.state !== "conflict" ? <button type="button" className="remote-session-action primary remote-session-primary-action" onClick={() => setRestoreRequest({ remote, destination: "local" })} disabled={restoringId === remote.id || uploadBusy || deleteBusy}>
                   <ArrowRightLeft size={14} />
                   <span>{l("Restore", "恢复")}</span>
                 </button> : null}
                 {primaryAction === "upload" && local ? <button type="button" className="remote-session-action primary remote-session-primary-action" disabled={uploadBusy || deleteBusy} onClick={() => uploadOne(item)}>
                   {uploadBusy ? <RefreshCw size={14} className="spin" /> : <CloudUpload size={14} />}
                   <span>{uploadTask?.state === "queued" ? l("Queued", "等待中") : uploadTask?.state === "running" ? l("Uploading", "上传中") : uploadTask?.state === "failed" ? l("Retry", "重试") : remote ? l("Update", "更新") : l("Upload", "上传")}</span>
                 </button> : null}
                 {primaryAction === "resolve" ? <button type="button" className="remote-session-action primary remote-session-primary-action" disabled={uploadBusy || deleteBusy} onClick={() => setConflictItem(item)}>
                   <ArrowRightLeft size={14} />
                   <span>{l("Resolve conflict", "处理冲突")}</span>
                 </button> : null}
                 {remote ? <div className="remote-session-more">
                   <button type="button" className="remote-session-action icon-only subtle" disabled={deleteBusy} onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpenActionsId((current) => current === item.id ? null : item.id)} aria-label={l("More actions", "更多操作")} title={l("More actions", "更多操作")}>
                     <MoreHorizontal size={15} />
                   </button>
                   {openActionsId === item.id ? <div className="remote-session-more-menu" onMouseDown={(event) => event.stopPropagation()}>
                     {remote.sourceEnvironmentKind === "ssh" ? <button type="button" onClick={() => setRestoreRequest({ remote, destination: "source" })}><Server size={14} />{l("Restore to source", "恢复到来源")}</button> : null}
                     <button type="button" className="danger" disabled={uploadBusy || deleteBusy} onClick={() => setDeleteCandidates([item])}><Trash2 size={14} />{l("Delete cloud copy", "删除云端副本")}</button>
                   </div> : null}
                 </div> : null}
               </div>
            </article>
          )})}
          {!initialLoading && visibleItems.length < filtered.length ? (
            <div className="remote-session-list-more">
              <span>{l(`Showing ${visibleItems.length} of ${filtered.length} sessions.`, `当前显示 ${visibleItems.length} / ${filtered.length} 个会话。`)}</span>
              <button type="button" onClick={() => setVisibleLimit((current) => Math.min(filtered.length, current + REMOTE_SESSION_PAGE_SIZE))}>
                {l("Show more", "显示更多")}
              </button>
            </div>
          ) : null}
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
            onCancel={() => setRestoreRequest(null)}
          />
         ) : null}
         {conflictItem ? (
           <ResolveSessionConflictDialog
             item={conflictItem}
             language={language}
             busy={Boolean(conflictItem.local && taskActive(uploadTasks[conflictItem.local.sessionKey]?.state)) || restoringId === conflictItem.remote?.id}
             onOverwrite={() => { setConflictItem(null); uploadOne(conflictItem, true); }}
             onRestore={() => {
               if (conflictItem.remote) setRestoreRequest({ remote: conflictItem.remote, destination: "local" });
               setConflictItem(null);
             }}
             onCancel={() => setConflictItem(null)}
           />
         ) : null}
        {deleteCandidates.length > 0 ? (
          <DeleteRemoteSessionsDialog
            sessions={deleteCandidates.flatMap((item) => item.remote ? [item.remote] : [])}
            language={language}
            deleting={false}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteCandidates([])}
          />
        ) : null}
      </section>
    </div>
  );
}

function RemoteOperationStatus({
  kind,
  batch,
  failures,
  language,
}: {
  kind: "upload" | "delete";
  batch: RemoteSessionOperationBatch;
  failures: string[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const summary = batch.running
    ? l(
        `${kind === "upload" ? "Upload" : "Delete"} progress: ${batch.completed}/${batch.total}. You can close this window; the task will continue in the background.`,
        `${kind === "upload" ? "上传" : "删除"}进度：${batch.completed}/${batch.total}。可以关闭窗口，任务会继续在后台执行。`,
      )
    : batch.failed > 0
      ? l(
          `${batch.succeeded} succeeded, ${batch.failed} failed. ${failures.slice(0, 2).join(" · ")}`,
          `${batch.succeeded} 个成功，${batch.failed} 个失败。${failures.slice(0, 2).join(" · ")}`,
        )
      : l(
          `${batch.succeeded} sessions completed successfully.`,
          `${batch.succeeded} 个会话已${kind === "upload" ? "上传" : "删除"}完成。`,
        );
  const tone = batch.running ? "running" : batch.failed > 0 ? "error" : "success";
  return (
    <div className={`remote-operation-status ${tone}`} role="status">
      {batch.running ? <RefreshCw size={14} className="spin" /> : kind === "upload" ? <CloudUpload size={14} /> : <Trash2 size={14} />}
      <span>{summary}</span>
    </div>
  );
}

function remoteSourceLabel(source: RemoteSessionAgent): string {
  if (source === "hermes") return "Hermes";
  if (source === "pi") return "Pi";
  return migrationAgentLabel(source);
}

function SessionCopyCard({
  side,
  summary,
  language,
}: {
  side: "local" | "remote";
  summary: SessionCopySummary;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const isLocal = side === "local";
  const updatedLabel = summary.present && Number.isFinite(summary.updatedAt) && summary.updatedAt > 0
    ? formatRelativeTime(summary.updatedAt)
    : null;
  return (
    <div className={`remote-copy ${isLocal ? "local" : "cloud"}`}>
      <div className="remote-copy-title">
        {isLocal ? <Laptop size={14} /> : <Cloud size={14} />}
        <span>{isLocal ? l("Local", "本地") : l("Cloud", "云端")}</span>
      </div>
      {summary.present ? (
        <>
          {updatedLabel ? <strong>{updatedLabel}</strong> : null}
          <span>{l(`${summary.messageCount} messages`, `${summary.messageCount} 条消息`)}</span>
          {!isLocal && summary.syncedAt ? <small>{l(`Synced ${formatRelativeTime(summary.syncedAt)}`, `同步于 ${formatRelativeTime(summary.syncedAt)}`)}</small> : null}
        </>
      ) : (
        <strong className="missing">{summary.missing === "not-uploaded" ? l("Not uploaded", "未上传") : l("No local copy", "无本地副本")}</strong>
      )}
    </div>
  );
}

function ResolveSessionConflictDialog({
  item,
  language,
  busy,
  onOverwrite,
  onRestore,
  onCancel,
}: {
  item: SessionSyncItem;
  language: LanguageMode;
  busy: boolean;
  onOverwrite: () => void;
  onRestore: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog remote-conflict-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Resolve conflict", "处理内容冲突")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={busy ? l("Continue in background", "转到后台") : l("Close", "关闭")}><X size={16} /></button>
        </div>
        <p className="dialog-copy"><strong>{syncItemTitle(item)}</strong></p>
        <p className="dialog-copy">{l("Both local and cloud copies changed after the last sync. Choose which result you want to keep.", "本地与云端在上次同步后都发生了变化，请选择保留方式。")}</p>
        <div className="remote-conflict-actions">
          <button type="button" onClick={onOverwrite} disabled={busy}><CloudUpload size={14} />{l("Overwrite cloud", "用本地覆盖云端")}</button>
          <button type="button" onClick={onRestore} disabled={busy}><ArrowRightLeft size={14} />{l("Restore cloud as a new local copy", "把云端恢复为新的本地副本")}</button>
        </div>
      </div>
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
          <button type="button" className="icon-button" onClick={onCancel} aria-label={restoring ? l("Continue in background", "转到后台") : l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="remote-restore-session-summary">
          <Cloud size={16} />
          <div className="remote-restore-session-copy">
            <span>{l("Cloud session", "云端会话")}</span>
            <strong title={request.remote.title}>{request.remote.title}</strong>
          </div>
        </div>
        <div className="remote-restore-fields">
          <div className="remote-restore-field">
            <span>{l("Target Agent", "目标 Agent")}</span>
            <div className="remote-restore-targets" role="group" aria-label={l("Target Agent", "目标 Agent")}>
              {RESTORE_TARGETS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={target === item ? "active" : ""}
                  aria-pressed={target === item}
                  onClick={() => onTargetChange(item)}
                  disabled={restoring}
                >
                  {migrationAgentLabel(item)}
                </button>
              ))}
            </div>
          </div>
          <div className="remote-restore-field">
            <span>{l("Destination", "目标位置")}</span>
            {request.destination === "source" ? (
              <div className="remote-restore-destination" title={request.remote.sourceEnvironmentLabel}>
                <Server size={15} />
                <span>{request.remote.sourceEnvironmentLabel}</span>
              </div>
            ) : (
              <button type="button" className="remote-restore-destination remote-project-picker" onClick={onChooseProject} disabled={restoring}>
                <FolderOpen size={15} />
                <span>{projectPath || l("Choose project", "选择项目")}</span>
              </button>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{restoring ? l("Continue in background", "转到后台") : l("Cancel", "取消")}</button>
          <button type="button" className="primary-action" onClick={onConfirm} disabled={restoring}>
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
        <p className="dialog-copy danger-copy">{l("Only the cloud copies will be deleted. Local sessions stay on this device.", "只会删除云端副本，本地会话不会删除。")}</p>
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
