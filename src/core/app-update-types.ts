export interface AppUpdateManifest {
  schemaVersion: 1;
  version: string;
  tag: string;
  title: string;
  publishedAt: string;
  releaseUrl: string;
  notes: {
    features: string[];
    fixes: string[];
  };
  package: {
    name: string;
    url: string;
    sha256: string;
    checksumUrl: string;
  };
}

export interface AppUpdateStatus {
  currentVersion: string;
  developmentBuild: boolean;
  checkedAt: number;
  fromCache: boolean;
  updateAvailable: boolean;
  updateSkipped?: boolean;
  promptSnoozed?: boolean;
  manifest: AppUpdateManifest | null;
  error: string | null;
}

export interface AppUpdateInstallResult {
  started: boolean;
  version: string;
}

export type AppUpdatePhase =
  | "checking"
  | "downloading"
  | "verifying"
  | "staging"
  | "validating"
  | "restarting"
  | "completed"
  | "error";

export interface AppUpdateProgress {
  phase: AppUpdatePhase;
  version: string;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
  error?: string;
}
