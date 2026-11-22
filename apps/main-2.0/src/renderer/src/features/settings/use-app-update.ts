import { useCallback, useEffect, useState } from "react";
import type { AppUpdateApi } from "../../../../preload/app-update";
import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";

export interface AppUpdateController {
  status: AppUpdateStatus | null;
  progress: AppUpdateProgress | null;
  busy: boolean;
  error: string | null;
  /** True while an update is available and the user has neither skipped nor snoozed it. */
  signal: boolean;
  check(): Promise<void>;
  install(): Promise<void>;
  skip(untilNextVersion: boolean): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the App update status for the whole window: the cached status, pushed events and user actions. */
export function useAppUpdate(api: AppUpdateApi): AppUpdateController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const offStatus = api.onAppUpdateStatus(setStatus);
    const offProgress = api.onAppUpdateProgress(setProgress);
    // A failed cached read leaves the status unknown; the About page offers a manual check.
    api.getAppUpdateStatus(false).then((next) => { if (active) setStatus(next); }).catch(() => undefined);
    return () => {
      active = false;
      offStatus();
      offProgress();
    };
  }, [api]);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      setStatus(await api.getAppUpdateStatus(true));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      // On success the installer restarts the App, so the busy state is kept until then.
      await api.installAppUpdate();
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  }, [api]);

  const skip = useCallback(async (untilNextVersion: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.skipAppUpdate(untilNextVersion));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  const signal = Boolean(status?.updateAvailable && !status.updateSkipped && !status.promptSnoozed);
  return { status, progress, busy, error, signal, check, install, skip };
}
