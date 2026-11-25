import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionSyncHookStatus } from "../../../../core/session-sync-queue";
import type { ActionStatus } from "../../app-types";
import { errorText, showTransientSuccess } from "../status/status-messages";

export function useSessionSyncHook(options: {
  settingsOpen: boolean;
  setFeedback: Dispatch<SetStateAction<ActionStatus | null>>;
  t: (en: string, zh: string) => string;
}) {
  const { settingsOpen, setFeedback, t } = options;
  const [status, setStatus] = useState<SessionSyncHookStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void window.sessionSearch.getSessionSyncHookStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    refresh();
  }, [refresh, settingsOpen]);

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setFeedback({
      kind: "running",
      message: enabled
        ? t("Installing session sync hooks...", "正在安装会话同步 Hook...")
        : t("Removing session sync hooks...", "正在移除会话同步 Hook..."),
    });
    try {
      const next = enabled
        ? await window.sessionSearch.installSessionSyncHooks()
        : await window.sessionSearch.uninstallSessionSyncHooks();
      setStatus(next);
      showTransientSuccess(
        setFeedback,
        enabled
          ? t("Session sync hooks installed.", "会话同步 Hook 已安装。")
          : t("Session sync hooks removed.", "会话同步 Hook 已移除。"),
      );
    } catch (error) {
      setFeedback({ kind: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }, [setFeedback, t]);

  return { status, busy, refresh, toggle };
}
