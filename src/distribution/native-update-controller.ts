import {
  NATIVE_UPDATE_FAILURE_URL,
  NATIVE_UPDATE_RELEASES_URL,
  type NativeAutoUpdater,
  type NativeUpdateBackupLifecycle,
  type NativeUpdateErrorCode,
  type NativeUpdateFailure,
  type NativeUpdateInfo,
  type NativeUpdatePreferences,
  type NativeUpdateState,
} from "./native-update-types";

export interface NativeUpdateControllerOptions {
  updater: NativeAutoUpdater;
  currentVersion: string;
  preferences: NativeUpdatePreferences;
  backupLifecycle: NativeUpdateBackupLifecycle;
  schedule(callback: () => void, delayMs: number): unknown;
  copyText(text: string): void;
  openExternal(url: string): Promise<unknown>;
  initialCheckDelayMs?: number;
  platform?: string;
  arch?: string;
  sanitizeDiagnosticDetail?(detail: string): string;
}

type RetryOperation = "check" | "download" | "install";

function sanitizeDiagnosticDetail(detail: string): string {
  return detail
    .replace(
      /((?:api[-_]?key|authorization|cookie|credential|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1<redacted>",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 <redacted>")
    .replace(/\b(?:sk|sk-ant|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(
      /(?:[A-Za-z]:\\Users\\[^\\\s"'<>]+|\/(?:Users|home)\/[^/\s"'<>]+)(?:[/\\][^\s"'<>]+)*/gi,
      "<user-path>",
    );
}

export class NativeUpdateController {
  private state: NativeUpdateState;
  private target: NativeUpdateInfo | null = null;
  private firstWindowSeen = false;
  private retryOperation: RetryOperation | null = null;
  private readonly listeners = new Set<(state: NativeUpdateState) => void>();

  constructor(private readonly options: NativeUpdateControllerOptions) {
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    this.state = {
      phase: options.preferences.isAutomaticCheckEnabled() ? "idle" : "disabled",
      currentVersion: options.currentVersion,
      targetVersion: null,
      progressPercent: null,
      backupPath: null,
      failure: null,
    };
    this.registerUpdaterEvents();
  }

  getState(): NativeUpdateState {
    return { ...this.state, failure: this.state.failure ? { ...this.state.failure } : null };
  }

  subscribe(listener: (state: NativeUpdateState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  firstUsableWindowReady(): void {
    if (this.firstWindowSeen) return;
    this.firstWindowSeen = true;
    if (!this.options.preferences.isAutomaticCheckEnabled()) {
      this.patchState({ phase: "disabled" });
      return;
    }
    this.options.schedule(() => {
      if (this.options.preferences.isAutomaticCheckEnabled()) void this.check(false);
    }, this.options.initialCheckDelayMs ?? 1_000);
  }

  async setAutomaticChecksEnabled(enabled: boolean): Promise<void> {
    await this.options.preferences.setAutomaticCheckEnabled(enabled);
    if (!enabled) {
      this.patchState({ phase: "disabled", failure: null });
      return;
    }
    if (this.state.phase === "disabled") this.patchState({ phase: "idle", failure: null });
  }

  async check(manual = true): Promise<void> {
    if (!manual && !this.options.preferences.isAutomaticCheckEnabled()) {
      this.patchState({ phase: "disabled" });
      return;
    }
    this.retryOperation = "check";
    this.patchState({ phase: "checking", failure: null, progressPercent: null });
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.fail("NATIVE_UPDATE_CHECK_FAILED", "Unable to check for an AgentRecall update.", error, true);
    }
  }

  async download(): Promise<void> {
    if (!this.target) {
      this.fail("NATIVE_UPDATE_NOT_READY", "No update is ready to download.", undefined, false);
      return;
    }
    this.retryOperation = "download";
    this.patchState({ phase: "downloading", progressPercent: 0, failure: null });
    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.fail("NATIVE_UPDATE_DOWNLOAD_FAILED", "Unable to download the update.", error, true);
    }
  }

  async installDownloadedUpdate(): Promise<void> {
    if (this.state.phase !== "downloaded" || !this.target) {
      this.fail("NATIVE_UPDATE_NOT_READY", "No downloaded update is ready to install.", undefined, false);
      return;
    }
    this.retryOperation = "install";
    this.patchState({ phase: "preparing", failure: null });
    let backupPath: string;
    try {
      const result = await this.options.backupLifecycle.prepareForUpdate({
        currentVersion: this.options.currentVersion,
        targetVersion: this.target.version,
      });
      backupPath = result.backupPath;
    } catch (error) {
      this.fail(
        "NATIVE_UPDATE_BACKUP_FAILED",
        "The database could not be closed and backed up safely. The update was not installed.",
        error,
        true,
      );
      return;
    }

    this.patchState({ phase: "installing", backupPath });
    try {
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      try {
        await this.options.backupLifecycle.recoverAfterInstallLaunchFailure?.();
      } catch (recoveryError) {
        const installDetail = error instanceof Error ? error.message : String(error);
        const recoveryDetail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        this.fail(
          "NATIVE_UPDATE_INSTALL_FAILED",
          "The native installer could not be started and the database could not be reopened.",
          `${installDetail}; recovery failed: ${recoveryDetail}`,
          true,
        );
        return;
      }
      this.fail("NATIVE_UPDATE_INSTALL_FAILED", "The native installer could not be started.", error, true);
    }
  }

  async retry(): Promise<void> {
    if (!this.state.failure?.retryable || !this.retryOperation) return;
    if (this.retryOperation === "check") await this.check(true);
    if (this.retryOperation === "download") await this.download();
    if (this.retryOperation === "install") {
      this.patchState({ phase: "downloaded" });
      await this.installDownloadedUpdate();
    }
  }

  copyFailureDiagnostics(): void {
    if (this.state.failure) this.options.copyText(this.state.failure.diagnosticText);
  }

  async openFailureHelp(): Promise<void> {
    await this.options.openExternal(this.state.failure?.failureUrl ?? NATIVE_UPDATE_FAILURE_URL);
  }

  async openReleases(): Promise<void> {
    await this.options.openExternal(NATIVE_UPDATE_RELEASES_URL);
  }

  private registerUpdaterEvents(): void {
    this.options.updater.on("checking-for-update", () => {
      this.patchState({ phase: "checking", failure: null });
    });
    this.options.updater.on("update-available", (info) => {
      this.target = info;
      this.patchState({
        phase: "available",
        targetVersion: info.version,
        progressPercent: null,
        failure: null,
      });
    });
    this.options.updater.on("update-not-available", () => {
      this.target = null;
      this.patchState({ phase: "current", targetVersion: null, progressPercent: null, failure: null });
    });
    this.options.updater.on("download-progress", ({ percent }) => {
      this.patchState({ phase: "downloading", progressPercent: Math.max(0, Math.min(100, percent)) });
    });
    this.options.updater.on("update-downloaded", (info) => {
      this.target = info;
      this.patchState({ phase: "downloaded", targetVersion: info.version, progressPercent: 100, failure: null });
    });
    this.options.updater.on("error", (error) => {
      if (this.state.phase === "downloading") {
        this.fail("NATIVE_UPDATE_DOWNLOAD_FAILED", "Unable to download the update.", error, true);
      } else if (this.state.phase === "preparing" || this.state.phase === "installing") {
        this.fail("NATIVE_UPDATE_INSTALL_FAILED", "The native installer could not be started.", error, true);
      } else if (this.state.phase !== "failed") {
        this.fail("NATIVE_UPDATE_CHECK_FAILED", "Unable to check for an AgentRecall update.", error, true);
      }
    });
  }

  private fail(
    code: NativeUpdateErrorCode,
    message: string,
    error: unknown,
    retryable: boolean,
  ): void {
    const detail = error instanceof Error ? error.message : error ? String(error) : "No additional detail.";
    const safeDetail = this.options.sanitizeDiagnosticDetail
      ? this.options.sanitizeDiagnosticDetail(detail)
      : sanitizeDiagnosticDetail(detail);
    const failure: NativeUpdateFailure = {
      code,
      message,
      retryable,
      failureUrl: NATIVE_UPDATE_FAILURE_URL,
      releaseUrl: NATIVE_UPDATE_RELEASES_URL,
      diagnosticText: JSON.stringify({
        product: "AgentRecall",
        currentVersion: this.options.currentVersion,
        targetVersion: this.target?.version ?? null,
        platform: this.options.platform ?? process.platform,
        arch: this.options.arch ?? process.arch,
        code,
        detail: safeDetail,
      }, null, 2),
    };
    this.patchState({ phase: "failed", failure });
  }

  private patchState(patch: Partial<NativeUpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  }
}
