import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { IndexStatus } from "../../../../core/indexer";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus, ContextMenuState, DialogState, RefreshFeedback } from "../../app-types";
import { reduceIndexFeedback } from "../../index-status-feedback";
import { errorText, showTransientSuccess } from "../status/status-messages";

export interface UseSessionActionsOptions {
  load: () => Promise<void>;
  loadSidebarMetadata: () => Promise<void>;
  loadStats: (force?: boolean) => Promise<void>;
  refreshDetail: () => Promise<void>;
  applyUpdatedDetail: (session: SessionSearchResult) => void;
  refreshLiveSessions: () => Promise<void>;
  tag: string | undefined;
  setTag: (tag: string | undefined) => void;
  setIndexStatus: Dispatch<SetStateAction<IndexStatus | null>>;
  setRemoteSessionsOpen: (open: boolean) => void;
  queueRemoteUploads: (items: Array<{ itemId: string; sessionKey: string; title: string }>) => void;
  ensureRemoteSessionsLoaded: () => Promise<void>;
  t: (en: string, zh: string) => string;
}

export function useSessionActions(options: UseSessionActionsOptions) {
  const {
    load,
    loadSidebarMetadata,
    loadStats,
    refreshDetail,
    applyUpdatedDetail,
    refreshLiveSessions,
    tag,
    setTag,
    setIndexStatus,
    setRemoteSessionsOpen,
    queueRemoteUploads,
    ensureRemoteSessionsLoaded,
    t,
  } = options;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const refreshAfterAction = useCallback(async (refreshOptions: { metadata?: boolean; stats?: boolean } = {}): Promise<void> => {
    await Promise.all([
      load(),
      refreshOptions.metadata ? loadSidebarMetadata() : Promise.resolve(),
      refreshOptions.stats ? loadStats(true) : Promise.resolve(),
    ]);
    await refreshDetail();
  }, [load, loadSidebarMetadata, loadStats, refreshDetail]);

  const beginRename = useCallback((session: SessionSearchResult): void => {
    setContextMenu(null);
    setDialog({ kind: "rename", session, value: session.customTitle || session.displayTitle, useDefaultTitle: false });
  }, []);

  const beginAddTag = useCallback((session: SessionSearchResult): void => {
    setContextMenu(null);
    setDialog({ kind: "tag", session, value: "" });
  }, []);

  const submitDialog = useCallback(async (valueOverride?: string): Promise<void> => {
    if (!dialog) return;
    const dialogKind = dialog.kind;
    const value = (valueOverride ?? dialog.value).trim();
    if (dialog.kind === "rename") {
      await window.sessionSearch.setCustomTitle(dialog.session.sessionKey, dialog.useDefaultTitle ? null : value || null);
    } else if (value) {
      await window.sessionSearch.addTag(dialog.session.sessionKey, value);
    }
    setDialog(null);
    await refreshAfterAction({ metadata: dialogKind === "tag" && Boolean(value) });
  }, [dialog, refreshAfterAction]);

  const removeTag = useCallback(async (session: SessionSearchResult, tagName: string): Promise<void> => {
    await window.sessionSearch.removeTag(session.sessionKey, tagName);
    await refreshAfterAction({ metadata: true });
  }, [refreshAfterAction]);

  const toggleFavorite = useCallback(async (session: SessionSearchResult): Promise<void> => {
    await window.sessionSearch.setFavorited(session.sessionKey, !session.favorited);
    await refreshAfterAction();
  }, [refreshAfterAction]);

  const summarizeDetail = useCallback(async (session: SessionSearchResult): Promise<void> => {
    if (summarizing) return;
    setSummarizing(true);
    setActionStatus({ kind: "running", message: t("Generating AI summary...", "正在生成 AI 摘要...") });
    try {
      const updated = await window.sessionSearch.summarizeSession(session.sessionKey);
      if (updated) applyUpdatedDetail(updated);
      await refreshAfterAction();
      showTransientSuccess(setActionStatus, t("AI summary generated.", "AI 摘要已生成。"), 4000);
    } catch (error) {
      setActionStatus({ kind: "error", message: errorText(error) });
    } finally {
      setSummarizing(false);
    }
  }, [summarizing, applyUpdatedDetail, refreshAfterAction, t]);

  const deleteTagGlobally = useCallback(async (tagName: string): Promise<void> => {
    await window.sessionSearch.deleteTag(tagName);
    setDeleteTagName(null);
    if (tag === tagName) setTag(undefined);
    else await load();
    await loadSidebarMetadata();
    await refreshDetail();
  }, [tag, setTag, load, loadSidebarMetadata, refreshDetail]);

  const runAction = useCallback(async <T,>(
    label: string,
    action: () => Promise<T>,
    successMessage: string | ((result: T) => string),
  ): Promise<void> => {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: `${label}...` });
    try {
      const result = await action();
      await refreshAfterAction();
      await refreshLiveSessions();
      window.setTimeout(() => void refreshLiveSessions(), 1200);
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      showTransientSuccess(setActionStatus, message);
    } catch (error) {
      setActionStatus({ kind: "error", message: errorText(error) });
    }
  }, [refreshAfterAction, refreshLiveSessions]);

  const runUtilityAction = useCallback(async (
    label: string,
    action: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: `${label}...` });
    try {
      await action();
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1600);
    } catch (error) {
      setActionStatus({ kind: "error", message: errorText(error) });
    }
  }, []);

  const uploadRemoteSession = useCallback((session: SessionSearchResult): void => {
    queueRemoteUploads([{
      itemId: session.sessionKey,
      sessionKey: session.sessionKey,
      title: session.displayTitle,
    }]);
    showTransientSuccess(
      setActionStatus,
      t("Session upload started in the background.", "会话已开始在后台上传。"),
    );
  }, [queueRemoteUploads, t]);

  const continueRemoteSessionsInBackground = useCallback((): void => {
    const message = t(
      "Remote sessions are continuing to load in the background.",
      "已转到后台，远程会话会继续加载。",
    );
    void ensureRemoteSessionsLoaded();
    setRemoteSessionsOpen(false);
    showTransientSuccess(setActionStatus, message, 2400);
  }, [ensureRemoteSessionsLoaded, setRemoteSessionsOpen, t]);

  const exportMarkdown = useCallback(async (sessionKey: string, includeToolTrace: boolean): Promise<void> => {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: t("Exporting markdown...", "正在导出 Markdown...") });
    try {
      const exported = await window.sessionSearch.exportMarkdown(sessionKey, { includeToolTrace });
      if (!exported) {
        setActionStatus(null);
        return;
      }
      const successMessage = t("Markdown exported.", "Markdown 已导出。");
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1800);
    } catch (error) {
      setActionStatus({ kind: "error", message: errorText(error) });
    }
  }, [t]);

  const exportJson = useCallback(async (sessionKey: string): Promise<void> => {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: t("Exporting JSON...", "正在导出 JSON...") });
    try {
      const result = await window.sessionSearch.exportJson(sessionKey);
      if (!result.exported) {
        setActionStatus(null);
        return;
      }
      const successMessage = result.fidelity === "exact-trace"
        ? t("Exact Codex request JSON exported.", "已导出 Codex 真实请求体 JSON。")
        : result.fidelity === "reconstructed"
          ? t("Reconstructed request JSON exported.", "已导出重建的请求体 JSON。")
          : t("Normalized request JSON exported.", "已导出标准化请求体 JSON。");
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1800);
    } catch (error) {
      setActionStatus({ kind: "error", message: errorText(error) });
    }
  }, [t]);

  const refreshNow = useCallback(async (): Promise<void> => {
    setContextMenu(null);
    setRefreshFeedback((current) => reduceIndexFeedback(current, {
      type: "start",
      message: t("Refreshing index...", "正在更新索引..."),
    }));
    try {
      const status = await window.sessionSearch.refreshIndex();
      setIndexStatus(status);
      await Promise.all([load(), loadSidebarMetadata(), loadStats(true)]);
      const successMessage = t(
        `Index refreshed: ${status.indexed} updated, ${status.skipped} skipped, ${status.total} total.`,
        `索引已更新：更新 ${status.indexed} 个，跳过 ${status.skipped} 个，共 ${status.total} 个。`,
      );
      setRefreshFeedback((current) => reduceIndexFeedback(current, {
        type: "manual-result",
        status,
        successMessage,
      }));
      if (status.error) return;
      window.setTimeout(() => {
        setRefreshFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 2200);
    } catch (error) {
      setRefreshFeedback((current) => reduceIndexFeedback(current, {
        type: "manual-error",
        message: errorText(error),
      }));
    }
  }, [load, loadSidebarMetadata, loadStats, setIndexStatus, t]);

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    dialog,
    setDialog,
    deleteTagName,
    setDeleteTagName,
    actionStatus,
    setActionStatus,
    summarizing,
    refreshFeedback,
    setRefreshFeedback,
    beginRename,
    beginAddTag,
    submitDialog,
    removeTag,
    toggleFavorite,
    summarizeDetail,
    deleteTagGlobally,
    runAction,
    runUtilityAction,
    uploadRemoteSession,
    continueRemoteSessionsInBackground,
    exportMarkdown,
    exportJson,
    refreshNow,
  };
}
