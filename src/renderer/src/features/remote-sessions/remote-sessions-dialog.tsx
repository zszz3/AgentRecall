import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, Cloud, CloudUpload, Eye, FolderOpen, Laptop, MoreHorizontal, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import type { RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus, SessionSyncItem, SessionSyncState } from "../../../../core/remote-session-sync";
import type { MigrationAgent, SessionMigrationResult } from "../../../../core/types";
import { migrationAgentForSource } from "../../../../core/session-migration";
import { isSessionSource, sessionSourceDescriptor } from "../../../../core/session-sources";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { migrationAgentLabel, sourceUiFamily } from "../../session-ui";
import type { ActionStatus } from "../../app-types";
import type { RemoteSessionsCache } from "../../remote-sessions-cache";
import { SupabaseSetupGuide } from "../../components/supabase-setup-guide";

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy", "codewiz", "cursor"];
type RemoteSourceFilter = "all" | MigrationAgent;
type RestoreDestination = "local" | "source";
const SOURCE_FILTERS: RemoteSourceFilter[] = ["all", ...RESTORE_TARGETS];

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

function syncStateLabel(state: SessionSyncState, language: LanguageMode): string {
  const labels: Record<SessionSyncState, [string, string]> = {
    "local-only": ["Local only", "仅本地"],
    "local-newer": ["Upload available", "待更新云端"],
    synced: ["Synced", "已同步"],
    "remote-newer": ["Cloud newer", "云端较新"],
    "remote-only": ["Cloud only", "仅云端"],
    conflict: ["Conflict", "内容冲突"],
  };
  return localize(language, ...labels[state]);
}

export function RemoteSessionsDialog({
  cache,
  language,
  onRefresh,
  onRemoteSessionUploaded,
  onRemoteSessionsDeleted,
  onClose,
  onRestored,
  onOpenDetail,
}: {
  cache: RemoteSessionsCache;
  language: LanguageMode;
  onRefresh: () => Promise<void>;
  onRemoteSessionUploaded: (localSessionKey: string, remote: RemoteSessionListItem) => void;
  onRemoteSessionsDeleted: (remoteIds: string[]) => void;
  onClose: () => void;
  onRestored: (result: SessionMigrationResult) => void;
  onOpenDetail: (detail: RemoteSessionDetailSnapshot, query: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const { status, items, loading, error: cacheError } = cache;
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
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const selectVisibleRef = useRef<HTMLInputElement>(null);
  const detailRequestSeqRef = useRef(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const sourceAgent = item.remote?.sourceAgent ?? (item.local ? migrationAgentForSource(item.local.source) : null);
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
  const selectedUploadItems = useMemo(() => selectedItems.filter((item) => item.local && (item.state === "local-only" || item.state === "local-newer")), [selectedItems]);
  const selectedVisibleCount = useMemo(() => filtered.filter((item) => selectedIds.has(item.id)).length, [filtered, selectedIds]);
  const allVisibleSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const visibleFeedback = feedback ?? (cacheError ? { kind: "error" as const, message: cacheError } : null);

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

  async function copySetupSql(): Promise<void> {
    await window.sessionSearch.copyRemoteSessionSetupSql();
  }

  async function uploadSelected(): Promise<void> {
    const candidates = selectedUploadItems;
    if (candidates.length === 0) return;
    setUploading(true);
    let succeeded = 0;
    const failures: string[] = [];
    const failedIds = new Set<string>();
    try {
      for (const [index, item] of candidates.entries()) {
        setFeedback({ kind: "running", message: l(`Uploading ${index + 1}/${candidates.length}...`, `正在上传 ${index + 1}/${candidates.length}...`) });
        try {
          const result = await window.sessionSearch.uploadRemoteSession(item.local!.sessionKey);
          onRemoteSessionUploaded(item.local!.sessionKey, result.remoteSession);
          succeeded += 1;
        } catch (error) {
          failedIds.add(item.id);
          failures.push(`${syncItemTitle(item)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      setSelectedIds(failedIds);
      setFeedback(failures.length > 0
        ? { kind: "error", message: l(`${succeeded} uploaded, ${failures.length} failed. ${failures.slice(0, 2).join(" · ")}`, `已上传 ${succeeded} 个，${failures.length} 个失败。${failures.slice(0, 2).join(" · ")}`) }
        : { kind: "success", message: l(`${succeeded} sessions uploaded.`, `已上传 ${succeeded} 个会话。`) });
    } finally {
      setUploading(false);
    }
  }

  async function uploadOne(item: SessionSyncItem, force = false): Promise<void> {
    if (!item.local) return;
    setUploading(true);
    setFeedback({ kind: "running", message: l("Uploading session…", "正在上传会话…") });
    try {
      const result = await window.sessionSearch.uploadRemoteSession(item.local.sessionKey, force);
      onRemoteSessionUploaded(item.local.sessionKey, result.remoteSession);
      setFeedback({ kind: "success", message: l("Session uploaded.", "会话已上传。") });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setUploading(false);
    }
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

  async function confirmDelete(): Promise<void> {
    if (deleteCandidates.length === 0) return;
    setDeleting(true);
    setFeedback({ kind: "running", message: l(`Deleting ${deleteCandidates.length} remote sessions...`, `正在删除 ${deleteCandidates.length} 个远程会话...`) });
    try {
      const result = await window.sessionSearch.deleteRemoteSessions(deleteCandidates.flatMap((item) => item.remote ? [item.remote.id] : []));
      const removedIds = new Set([...result.deletedIds, ...result.missingIds]);
      setDeleteCandidates([]);
      onRemoteSessionsDeleted([...removedIds]);
      const failedRemoteIds = new Set(result.failures.map((failure) => failure.id));
      setSelectedIds(new Set(deleteCandidates.flatMap((item) => item.remote && failedRemoteIds.has(item.remote.id) ? [item.id] : [])));
      if (result.failures.length > 0) {
        const details = result.failures
          .slice(0, 3)
          .map((failure) => `${deleteCandidates.find((item) => item.remote?.id === failure.id)?.remote?.title ?? failure.id}: ${failure.message}`)
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
                {source === "all" ? l("All", "全部") : migrationAgentLabel(source)}
              </button>
            ))}
          </div>
          <label className="remote-select-visible">
            <input
              ref={selectVisibleRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={loading || uploading || deleting || filtered.length === 0}
              onChange={toggleVisible}
              aria-label={l("Select visible remote sessions", "选择当前可见的远程会话")}
            />
            <span>
              {allVisibleSelected
                ? l("Clear current", "取消当前选择")
                : l(`Select current (${filtered.length})`, `选择当前结果（${filtered.length}）`)}
            </span>
          </label>
          <button type="button" className="remote-local-save" disabled={loading || uploading || deleting || selectedUploadItems.length === 0} onClick={() => void uploadSelected()}>
            <CloudUpload size={14} />
            <span>{l(`Upload to cloud (${selectedUploadItems.length})`, `上传到云端（${selectedUploadItems.length}）`)}</span>
          </button>
          <button type="button" className="remote-bulk-delete" disabled={loading || uploading || deleting || selectedRemoteItems.length === 0} onClick={() => setDeleteCandidates(selectedRemoteItems)}>
            <Trash2 size={14} />
            <span>{l(`Delete cloud copies (${selectedRemoteItems.length})`, `删除云端副本（${selectedRemoteItems.length}）`)}</span>
          </button>
          <button type="button" className="remote-toolbar-icon" onClick={() => void onRefresh()} disabled={loading || uploading || deleting} title={l("Refresh remote sessions", "刷新远程会话")} aria-label={l("Refresh remote sessions", "刷新远程会话")}>
            <RefreshCw size={15} />
          </button>
        </div>

        {!loading && status && status.kind !== "ready" ? (
          <SupabaseSetupGuide
            language={language}
            tone={status?.kind === "error" ? "error" : "warning"}
            title={l("Remote sync is not ready", "远程同步尚未准备完成")}
            message={status.remediation === "settings"
              ? l("Check the Supabase URL and anon key in Remote sync settings, then refresh.", "请检查远程同步设置中的 Supabase URL 和 anon key，然后刷新。")
              : undefined}
            detail={status.kind === "unconfigured" ? null : status.message}
            busy={uploading || deleting}
            showSqlActions={status.remediation === "sql"}
            onCopySql={copySetupSql}
            onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("sessions")}
            onRefresh={onRefresh}
          />
        ) : null}

        {visibleFeedback ? <div className={`settings-feedback inline remote-session-feedback ${visibleFeedback.kind}`}>{visibleFeedback.message}</div> : null}
        <div className="remote-session-list">
          {loading ? <div className="remote-empty">{l("Loading remote sessions...", "正在加载远程会话...")}</div> : null}
          {!loading && status?.kind === "ready" && filtered.length === 0 ? <div className="remote-empty">{l("No syncable sessions found.", "没有找到可同步的会话。")}</div> : null}
           {filtered.map((item) => {
             const remote = item.remote;
             const local = item.local;
             const source = remote?.sourceSource ?? local?.source ?? "";
             const sourceDescriptor = isSessionSource(source) ? sessionSourceDescriptor(source) : null;
             const title = syncItemTitle(item);
             const localCopy = sessionCopySummary(item, "local");
             const remoteCopy = sessionCopySummary(item, "remote");
             const primaryAction = primarySessionAction(item);
             const branchLabel = local?.gitBranch
               ? local.gitBranch.startsWith("branch:") ? local.gitBranch : `branch:${local.gitBranch}`
               : null;
             const tags = (local?.tags ?? remote?.tags ?? []).filter((tag) => tag !== branchLabel).slice(0, 5);
             return (
            <article key={item.id} className={`remote-session-row ${selectedIds.has(item.id) ? "selected" : ""}`}>
              <label className="remote-session-select" title={l("Select session", "选择会话")}>
                <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSession(item.id)} aria-label={l(`Select ${title}`, `选择 ${title}`)} />
              </label>
              <div className="remote-session-main">
                 <div className="remote-session-heading">
                   <strong>{title}</strong>
                   <span className={`source-badge ${sourceDescriptor ? sourceUiFamily(sourceDescriptor.id) : "other"}`}>
                     {sourceDescriptor?.label ?? remote?.sourceAgent ?? (local ? migrationAgentForSource(local.source) : "")}
                   </span>
                   <span className={`sync-state-badge ${item.state}`}>{syncStateLabel(item.state, language)}</span>
                 </div>
                 <div className="remote-session-context">
                   <span>{local?.projectPath || remote?.projectPath || l("No project path", "无项目路径")}</span>
                 </div>
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
                 {remote ? <button type="button" className="remote-session-action remote-session-view-action" onClick={() => void openDetail(remote)} disabled={detailLoadingId === remote.id || restoringId === remote.id}>
                   <Eye size={14} />
                   <span>{detailLoadingId === remote.id ? l("Loading...", "加载中...") : l("View", "查看")}</span>
                 </button> : null}
                 {remote && item.state !== "conflict" ? <button type="button" className="remote-session-action primary remote-session-primary-action" onClick={() => setRestoreRequest({ remote, destination: "local" })} disabled={restoringId === remote.id}>
                   <ArrowRightLeft size={14} />
                   <span>{l("Restore", "恢复")}</span>
                 </button> : null}
                 {primaryAction === "upload" && local ? <button type="button" className="remote-session-action primary remote-session-primary-action" disabled={uploading || deleting} onClick={() => void uploadOne(item)}>
                   <CloudUpload size={14} />
                   <span>{remote ? l("Update", "更新") : l("Upload", "上传")}</span>
                 </button> : null}
                 {primaryAction === "resolve" ? <button type="button" className="remote-session-action primary remote-session-primary-action" disabled={uploading || deleting} onClick={() => setConflictItem(item)}>
                   <ArrowRightLeft size={14} />
                   <span>{l("Resolve conflict", "处理冲突")}</span>
                 </button> : null}
                 {remote ? <div className="remote-session-more">
                   <button type="button" className="remote-session-action icon-only subtle" onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpenActionsId((current) => current === item.id ? null : item.id)} aria-label={l("More actions", "更多操作")} title={l("More actions", "更多操作")}>
                     <MoreHorizontal size={15} />
                   </button>
                   {openActionsId === item.id ? <div className="remote-session-more-menu" onMouseDown={(event) => event.stopPropagation()}>
                     {remote.sourceEnvironmentKind === "ssh" ? <button type="button" onClick={() => setRestoreRequest({ remote, destination: "source" })}><Server size={14} />{l("Restore to source", "恢复到来源")}</button> : null}
                     <button type="button" className="danger" onClick={() => setDeleteCandidates([item])}><Trash2 size={14} />{l("Delete cloud copy", "删除云端副本")}</button>
                   </div> : null}
                 </div> : null}
               </div>
            </article>
          )})}
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
         {conflictItem ? (
           <ResolveSessionConflictDialog
             item={conflictItem}
             language={language}
             busy={uploading || restoringId === conflictItem.remote?.id}
             onOverwrite={() => { setConflictItem(null); void uploadOne(conflictItem, true); }}
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
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label={l("Close", "关闭")}><X size={16} /></button>
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
          <button type="button" className="icon-button" onClick={onCancel} disabled={restoring} aria-label={l("Close", "关闭")}>
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
          <button type="button" onClick={onCancel} disabled={restoring}>{l("Cancel", "取消")}</button>
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
