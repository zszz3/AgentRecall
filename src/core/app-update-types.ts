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
