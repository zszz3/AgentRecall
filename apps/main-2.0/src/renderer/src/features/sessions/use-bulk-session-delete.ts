import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionSearchApi } from "../../../../preload";
import {
  isSessionDeleteConfirmationRequiredMessage,
  isSessionDeleteLiveCheckConfirmationRequiredMessage,
  type SessionBulkDeletePreview,
  type SessionBulkDeleteRequest,
} from "../../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import type { LiveSessionCheck } from "./live-session-check";
import { errorText } from "../status/status-messages";

export interface BulkDeleteDialogState {
  mode: "selection" | "cleanup" | "orphans";
  /** Inactivity cutoff for date cleanup, as YYYY-MM-DD. */
  dateValue: string;
  /** The request the shown preview was computed for; confirmation sends exactly this request. */
  request: SessionBulkDeleteRequest | null;
  preview: SessionBulkDeletePreview | null;
  favoriteCount: number;
}

export interface BulkSessionDeleteController {
  selectedKeys: ReadonlySet<string>;
  selectionActive: boolean;
  dialog: BulkDeleteDialogState | null;
  busy: boolean;
  toggle(sessionKey: string): void;
  begin(sessionKey: string): void;
  exit(): void;
  /** Selects every shown Session, or clears them when all are already selected. */
  toggleShown(): void;
  selectAllMatching(): Promise<void>;
  previewSelected(): Promise<void>;
  openDateCleanup(): void;
  openOrphanCleanup(): Promise<void>;
  changeDate(dateValue: string): void;
  previewDateCleanup(): Promise<void>;
  confirm(confirmed: boolean): Promise<void>;
  closeDialog(): void;
}

interface BulkSessionDeleteOptions {
  api: Pick<SessionSearchApi, "previewBulkDelete" | "bulkDeleteSessions">;
  openSessionKey: string | undefined;
  /** Sessions on the current page. */
  sessions: readonly SessionSearchResult[];
  /** Every Session matching the current filters, optionally ignoring the date filter. */
  searchAllMatching(ignoreDate: boolean): Promise<SessionSearchResult[]>;
  checkLiveSessions(): Promise<LiveSessionCheck>;
  setStatus: Dispatch<SetStateAction<ActionStatus | null>>;
  onSelectionStarted(): void;
  /** Refreshes the views after a deletion; runs before the result is reported. */
  onDeleted(deletedSessionKeys: string[]): Promise<void>;
  t(en: string, zh: string): string;
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const CLEANUP_DEFAULT_DAYS = 30;

export function useBulkSessionDelete({
  api,
  openSessionKey,
  sessions,
  searchAllMatching,
  checkLiveSessions,
  setStatus,
  onSelectionStarted,
  onDeleted,
  t,
}: BulkSessionDeleteOptions): BulkSessionDeleteController {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionActive, setSelectionActive] = useState(false);
  const [dialog, setDialog] = useState<BulkDeleteDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const reportError = (error: unknown) => setStatus({ kind: "error", message: errorText(error) });

  const toggle = useCallback((sessionKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }, []);

  const begin = useCallback((sessionKey: string) => {
    setSelectionActive(true);
    setSelectedKeys((current) => new Set(current).add(sessionKey));
    onSelectionStarted();
  }, [onSelectionStarted]);

  const exit = useCallback(() => {
    setSelectionActive(false);
    setSelectedKeys(new Set());
  }, []);

  function toggleShown(): void {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const allSelected = sessions.length > 0 && sessions.every((session) => next.has(session.sessionKey));
      for (const session of sessions) {
        if (allSelected) next.delete(session.sessionKey);
        else next.add(session.sessionKey);
      }
      return next;
    });
  }

  async function selectAllMatching(): Promise<void> {
    try {
      const matching = await searchAllMatching(false);
      setSelectedKeys(new Set(matching.map((session) => session.sessionKey)));
    } catch (error) {
      reportError(error);
    }
  }

  async function previewSelected(): Promise<void> {
    if (selectedKeys.size === 0 || busy) return;
    setBusy(true);
    try {
      const selected = (await searchAllMatching(false)).filter((session) => selectedKeys.has(session.sessionKey));
      const liveCheck = await checkLiveSessions();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: selected.map((session) => session.sessionKey),
        ...liveCheck,
        protectFavorites: false,
        openSessionKey,
      };
      const preview = await api.previewBulkDelete(request);
      setDialog({ mode: "selection", dateValue: "", request, preview, favoriteCount: selected.filter((session) => session.favorited).length });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function openDateCleanup(): void {
    const date = new Date();
    date.setDate(date.getDate() - CLEANUP_DEFAULT_DAYS);
    setDialog({ mode: "cleanup", dateValue: formatDateInput(date), request: null, preview: null, favoriteCount: 0 });
  }

  async function openOrphanCleanup(): Promise<void> {
    if (busy) return;
    setDialog({ mode: "orphans", dateValue: "", request: null, preview: null, favoriteCount: 0 });
    setBusy(true);
    try {
      const liveCheck = await checkLiveSessions();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: [],
        ...liveCheck,
        includeOrphanedSubagents: true,
        protectFavorites: false,
        openSessionKey,
      };
      const preview = await api.previewBulkDelete(request);
      setDialog((current) => current?.mode === "orphans" ? { ...current, request, preview } : current);
    } catch (error) {
      setDialog(null);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  function changeDate(dateValue: string): void {
    setDialog((current) => current ? { ...current, dateValue, request: null, preview: null } : current);
  }

  async function previewDateCleanup(): Promise<void> {
    if (!dialog?.dateValue || busy) return;
    setBusy(true);
    try {
      const matching = await searchAllMatching(true);
      const inactiveBefore = new Date(`${dialog.dateValue}T00:00:00`).getTime();
      if (!Number.isFinite(inactiveBefore)) throw new Error(t("Choose a valid date.", "请选择有效日期。"));
      const liveCheck = await checkLiveSessions();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: matching.map((session) => session.sessionKey),
        ...liveCheck,
        inactiveBefore,
        protectFavorites: true,
        openSessionKey,
      };
      const preview = await api.previewBulkDelete(request);
      setDialog((current) => current ? { ...current, request, preview } : current);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(confirmed: boolean): Promise<void> {
    if (!dialog?.request || !dialog.preview || busy) return;
    const requestAtConfirmation = dialog.request;
    const preview = dialog.preview;
    setBusy(true);
    setStatus({ kind: "running", message: t("Deleting sessions...", "正在批量删除会话...") });
    try {
      const result = await api.bulkDeleteSessions({
        ...requestAtConfirmation,
        confirmed,
        allowUnverifiedLiveSessions: confirmed && preview.liveSessionCheckFailed,
        confirmationFingerprint: confirmed ? preview.confirmationFingerprint : undefined,
        openSessionKey,
      });
      setSelectedKeys((current) => {
        const next = new Set(current);
        for (const sessionKey of result.deletedSessionKeys) next.delete(sessionKey);
        return next;
      });
      setDialog(null);
      await onDeleted(result.deletedSessionKeys);
      setStatus({
        kind: result.failed.length > 0 ? "error" : "success",
        message: result.failed.length > 0
          ? t(`Deleted ${result.deletedSessionKeys.length}; ${result.failed.length} failed.`, `已删除 ${result.deletedSessionKeys.length} 个，${result.failed.length} 个失败。`)
          : t(`Deleted ${result.deletedSessionKeys.length} sessions.`, `已删除 ${result.deletedSessionKeys.length} 个会话。`),
      });
    } catch (error) {
      const rawMessage = errorText(error);
      const liveCheckFailed = isSessionDeleteLiveCheckConfirmationRequiredMessage(rawMessage);
      if (!liveCheckFailed && !isSessionDeleteConfirmationRequiredMessage(rawMessage)) {
        setStatus({ kind: "error", message: rawMessage });
        return;
      }
      // The risk changed after the preview: show a fresh preview for the same request.
      try {
        const {
          confirmed: _confirmed,
          allowUnverifiedLiveSessions: _allowUnverifiedLiveSessions,
          ...requestWithoutConfirmation
        } = requestAtConfirmation;
        const liveCheck = await checkLiveSessions();
        const request: SessionBulkDeleteRequest = {
          ...requestWithoutConfirmation,
          ...liveCheck,
          liveSessionCheckFailed: liveCheckFailed || liveCheck.liveSessionCheckFailed,
          openSessionKey,
        };
        const nextPreview = await api.previewBulkDelete(request);
        setDialog((current) => current?.request === requestAtConfirmation ? { ...current, request, preview: nextPreview } : current);
        setStatus({
          kind: "error",
          message: liveCheckFailed
            ? t(
                "Running sessions could not be verified. Review the updated preview and confirm again.",
                "无法确认会话是否仍在运行，请检查更新后的预览并重新确认。",
              )
            : t(
                "The deletion risk changed. Review the updated preview and confirm again.",
                "删除风险已发生变化，请检查更新后的预览并重新确认。",
              ),
        });
      } catch (refreshError) {
        reportError(refreshError);
      }
    } finally {
      setBusy(false);
    }
  }

  const closeDialog = useCallback(() => setDialog(null), []);

  return {
    selectedKeys,
    selectionActive,
    dialog,
    busy,
    toggle,
    begin,
    exit,
    toggleShown,
    selectAllMatching,
    previewSelected,
    openDateCleanup,
    openOrphanCleanup,
    changeDate,
    previewDateCleanup,
    confirm,
    closeDialog,
  };
}
