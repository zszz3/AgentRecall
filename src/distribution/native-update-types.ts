export const NATIVE_UPDATE_RELEASES_URL = "https://github.com/zszz3/AgentRecall/releases";
export const NATIVE_UPDATE_FAILURE_URL =
  "https://github.com/zszz3/AgentRecall/issues/new?template=bug_report.yml";

export type NativeUpdateErrorCode =
  | "NATIVE_UPDATE_DISABLED"
  | "NATIVE_UPDATE_CHECK_FAILED"
  | "NATIVE_UPDATE_DOWNLOAD_FAILED"
  | "NATIVE_UPDATE_BACKUP_FAILED"
  | "NATIVE_UPDATE_INSTALL_FAILED"
  | "NATIVE_UPDATE_NOT_READY"
  | "NATIVE_UPDATE_UNTRUSTED_ROLLBACK";

export interface NativeUpdateFailure {
  code: NativeUpdateErrorCode;
  message: string;
  retryable: boolean;
  failureUrl: string;
  releaseUrl: string;
  diagnosticText: string;
}

export type NativeUpdatePhase =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "downloaded"
  | "preparing"
  | "installing"
  | "failed";

export interface NativeUpdateState {
  phase: NativeUpdatePhase;
  currentVersion: string;
  targetVersion: string | null;
  progressPercent: number | null;
  backupPath: string | null;
  failure: NativeUpdateFailure | null;
}

export interface NativeUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: unknown;
}

export interface NativeUpdateBackupLifecycle {
  prepareForUpdate(input: {
    currentVersion: string;
    targetVersion: string;
  }): Promise<{ backupPath: string }>;
  recoverAfterInstallLaunchFailure?(): Promise<void> | void;
}

export interface NativeUpdatePreferences {
  isAutomaticCheckEnabled(): boolean;
  setAutomaticCheckEnabled(enabled: boolean): Promise<void> | void;
}

export interface NativeAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: NativeUpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
