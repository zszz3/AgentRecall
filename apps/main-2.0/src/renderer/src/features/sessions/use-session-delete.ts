import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionSearchApi } from "../../../../preload";
import {
  isSessionDeleteConfirmationRequiredMessage,
  isSessionDeleteLiveCheckConfirmationRequiredMessage,
} from "../../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";

/** One pending single-Session deletion and the preview that its confirmation must match. */
export interface SessionDeleteRequest {
  session: SessionSearchResult;
  /** Increases with every request so the dialog can reset its confirmation step. */
  version: number;
  /** Sessions removed together with this one; null until the preview arrives. */
  cascadeCount: number | null;
  hasLiveSession: boolean;
  liveCheckFailed: boolean;
  confirmationFingerprint?: string;
  blockedMessage: string | null;
}

export interface SessionDeleteController {
  request: SessionDeleteRequest | null;
  deleting: boolean;
  requestDelete(session: SessionSearchResult, forceUnverifiedLiveSessionConfirmation?: boolean): void;
  confirm(): Promise<void>;
  cancel(): void;
}

interface SessionDeleteOptions {
  api: Pick<SessionSearchApi, "previewBulkDelete" | "deleteSession">;
  openSessionKey: string | undefined;
  checkLiveSessions(): Promise<{ liveSessionKeys: string[]; liveSessionCheckFailed: boolean }>;
  setStatus: Dispatch<SetStateAction<ActionStatus | null>>;
  /** Refreshes the views after the Session was removed; the controller reports success afterwards. */
  onDeleted(session: SessionSearchResult): Promise<void>;
  onAlreadyDeleted(): Promise<void>;
  t(en: string, zh: string): string;
}

const SUCCESS_NOTICE_MS = 1800;

export function useSessionDelete({
  api,
  openSessionKey,
  checkLiveSessions,
  setStatus,
  onDeleted,
  onAlreadyDeleted,
  t,
}: SessionDeleteOptions): SessionDeleteController {
  const [request, setRequest] = useState<SessionDeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const latestVersion = useRef(0);

  const requestDelete = useCallback((session: SessionSearchResult, forceUnverifiedLiveSessionConfirmation = false) => {
    const version = ++latestVersion.current;
    setRequest({
      session,
      version,
      cascadeCount: null,
      hasLiveSession: false,
      liveCheckFailed: forceUnverifiedLiveSessionConfirmation,
      blockedMessage: null,
    });
    const update = (change: Partial<SessionDeleteRequest>) =>
      setRequest((current) => (current?.version === version ? { ...current, ...change } : current));
    void checkLiveSessions()
      .then((liveCheck) => api.previewBulkDelete({
        sessionKeys: [session.sessionKey],
        ...liveCheck,
        liveSessionCheckFailed: forceUnverifiedLiveSessionConfirmation || liveCheck.liveSessionCheckFailed,
        protectFavorites: false,
        openSessionKey,
      }))
      .then((preview) => update({
        cascadeCount: preview.expandedCount,
        hasLiveSession: preview.skipped.some((issue) => issue.reason === "live"),
        liveCheckFailed: preview.liveSessionCheckFailed,
        confirmationFingerprint: preview.confirmationFingerprint,
      }))
      .catch((error: unknown) => update({ blockedMessage: error instanceof Error ? error.message : String(error) }));
  }, [api, checkLiveSessions, openSessionKey]);

  const cancel = useCallback(() => {
    latestVersion.current += 1;
    setRequest(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!request || deleting || request.cascadeCount === null || request.blockedMessage) return;
    const { session, cascadeCount, hasLiveSession, liveCheckFailed, confirmationFingerprint } = request;
    const confirmed = cascadeCount > 1 || hasLiveSession || liveCheckFailed || openSessionKey === session.sessionKey;
    setDeleting(true);
    setStatus({ kind: "running", message: t("Deleting session...", "正在删除会话...") });
    try {
      const removed = await api.deleteSession(session.sessionKey, confirmed ? {
        confirmed: true,
        allowLiveSessions: hasLiveSession || liveCheckFailed,
        allowUnverifiedLiveSessions: liveCheckFailed,
        confirmationFingerprint,
      } : undefined);
      cancel();
      if (!removed) {
        setStatus({ kind: "error", message: t("Session was already deleted.", "会话已经被删除。") });
        await onAlreadyDeleted();
        return;
      }
      await onDeleted(session);
      const message = session.sourceAvailable === false
        ? t("Cached session deleted.", "会话缓存已删除。")
        : session.source === "zcode-cli"
          ? t("ZCode session deleted from the local database.", "ZCode 会话已从本地数据库删除。")
          : t("Session file deleted.", "会话文件已删除。");
      setStatus({ kind: "success", message });
      window.setTimeout(() => {
        setStatus((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, SUCCESS_NOTICE_MS);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const liveCheckChanged = isSessionDeleteLiveCheckConfirmationRequiredMessage(rawMessage);
      if (!liveCheckChanged && !isSessionDeleteConfirmationRequiredMessage(rawMessage)) {
        setStatus({ kind: "error", message: rawMessage });
        return;
      }
      setStatus({
        kind: "error",
        message: liveCheckChanged
          ? t(
              "Running sessions could not be verified. Review the updated deletion warning and confirm again.",
              "无法确认会话是否仍在运行，请检查更新后的删除警告并重新确认。",
            )
          : t(
              "The session tree changed. Review the updated deletion warning and confirm again.",
              "会话树状态已变化，请检查更新后的删除警告并重新确认。",
            ),
      });
      requestDelete(session, liveCheckChanged);
    } finally {
      setDeleting(false);
    }
  }, [api, cancel, deleting, onAlreadyDeleted, onDeleted, openSessionKey, request, requestDelete, setStatus, t]);

  return { request, deleting, requestDelete, confirm, cancel };
}
