import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageBoxOptions } from "electron";
import type {
  AppUpdateInstallResult,
  AppUpdateManifest,
  AppUpdateProgress,
  AppUpdateStatus,
} from "../../core/app-update-types";

export interface StagedAppUpdate {
  version: string;
  stageRoot: string;
  archivePath: string;
  stagedPackagePath: string;
  livePackagePath: string;
  backupPath: string;
  statusPath: string;
}

export interface AppUpdateClient {
  LATEST_RELEASE_URL: string;
  checkForUpdate(options?: { currentVersion?: string; force?: boolean; showSkipped?: boolean }): Promise<AppUpdateStatus>;
  clearAppProcess(pid?: number): Promise<void>;
  clearInstallStatus(): Promise<void>;
  currentVersion(): string;
  formatUpdateError(error: unknown): string;
  manualInstallCommand(): string;
  parseUpdateManifest(value: unknown): AppUpdateManifest;
  readInstallStatus(): Promise<{ status?: string; version?: string; error?: string | null } | null>;
  skipUpdateVersion(version: string): Promise<void>;
  snoozeUpdatePrompt(version: string): Promise<void>;
  writeAppProcess(pid?: number): Promise<string>;
  writeUpdatePreference(enabled: boolean): Promise<void>;
  stageUpdate(
    manifest: AppUpdateManifest,
    options?: {
      nodePath?: string;
      onProgress?: (progress: AppUpdateProgress) => void;
    },
  ): Promise<StagedAppUpdate>;
}

export interface AppUpdateServiceDependencies {
  getClient(): AppUpdateClient;
  releaseRuntime: boolean;
  getAutoCheckEnabled(): boolean;
  autoCheckDisabled(): boolean;
  publishStatus(status: AppUpdateStatus): void;
  publishProgress(progress: AppUpdateProgress): void;
  stageInstaller(
    manifest: AppUpdateManifest,
    onProgress: (progress: AppUpdateProgress) => void,
  ): Promise<StagedAppUpdate>;
  launchInstaller(staged: StagedAppUpdate): Promise<void>;
  requestQuit(): void;
  schedule(callback: () => void, delayMs: number): unknown;
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
  copyText(text: string): void;
  openExternal(url: string): Promise<unknown>;
  processId: number;
  logError(message: string): void;
}

export class AppUpdateService {
  private status: AppUpdateStatus | null = null;
  private activeCheck: Promise<AppUpdateStatus> | null = null;
  private activeInstall: { version: string; task: Promise<void> } | null = null;
  private previousResultShown = false;

  constructor(private readonly dependencies: AppUpdateServiceDependencies) {}

  async getStatus(force = false): Promise<AppUpdateStatus> {
    if (!this.dependencies.releaseRuntime) return this.developmentStatus();
    if (!force && this.dependencies.autoCheckDisabled()) return this.status ?? this.emptyStatus();
    if (!force && !this.dependencies.getAutoCheckEnabled()) return this.status ?? this.emptyStatus();
    if (!force && this.status) return this.status;
    return this.refreshStatus(force);
  }

  async install(): Promise<AppUpdateInstallResult> {
    if (!this.dependencies.releaseRuntime) {
      throw new Error("Application updates are unavailable in development builds.");
    }
    if (this.activeInstall) {
      return { started: true, version: this.activeInstall.version };
    }
    const manifest = this.dependencies.getClient().parseUpdateManifest(this.status?.manifest);
    const task = this.runInstall(manifest);
    this.activeInstall = { version: manifest.version, task };
    void task.then(
      () => this.clearActiveInstall(task),
      (error) => {
        this.reportInstallFailure(manifest.version, error);
        this.clearActiveInstall(task);
      },
    );
    return { started: true, version: manifest.version };
  }

  private async runInstall(manifest: AppUpdateManifest): Promise<void> {
    const staged = await this.dependencies.stageInstaller(
      manifest,
      (progress) => this.dependencies.publishProgress(progress),
    );
    this.dependencies.publishProgress({
      phase: "restarting",
      version: manifest.version,
      message: "更新准备完成，正在重新启动…",
    });
    await this.dependencies.launchInstaller(staged);
    this.dependencies.schedule(() => this.dependencies.requestQuit(), 300);
  }

  private clearActiveInstall(task: Promise<void>): void {
    if (this.activeInstall?.task === task) this.activeInstall = null;
  }

  private reportInstallFailure(version: string, error: unknown): void {
    let formatted = "Unknown update error";
    try {
      formatted = this.dependencies.getClient().formatUpdateError(error);
    } catch {
      try {
        formatted = error instanceof Error ? error.message : String(error);
      } catch {
        // Keep the generic fallback when even converting an unusual thrown value fails.
      }
    }
    try {
      this.dependencies.publishProgress({
        phase: "error",
        version,
        error: formatted,
      });
    } catch (publishError) {
      try {
        this.dependencies.logError(`Failed to publish app update error: ${String(publishError)}`);
      } catch {
        // Background failure reporting must never reject the detached install task.
      }
    }
    try {
      this.dependencies.logError(`App update installation failed: ${formatted}`);
    } catch {
      // Background failure reporting must never reject the detached install task.
    }
  }

  async skip(untilNextVersion: boolean): Promise<AppUpdateStatus> {
    const current = this.status?.updateAvailable ? this.status : await this.getStatus(false);
    const version = current.manifest?.version;
    if (!current.updateAvailable || !version) return current;
    const client = this.dependencies.getClient();
    if (untilNextVersion) await client.skipUpdateVersion(version);
    else await client.snoozeUpdatePrompt(version);
    return this.refreshStatus(false);
  }

  async registerRunningProcess(): Promise<void> {
    if (!this.dependencies.releaseRuntime) return;
    const client = this.dependencies.getClient();
    await Promise.all([
      client.writeAppProcess(this.dependencies.processId).catch((error) => {
        this.dependencies.logError(`Failed to write app process state: ${String(error)}`);
      }),
      client.writeUpdatePreference(this.dependencies.getAutoCheckEnabled()).catch((error) => {
        this.dependencies.logError(`Failed to write update preference: ${String(error)}`);
      }),
    ]);
  }

  async clearRunningProcess(): Promise<void> {
    if (!this.dependencies.releaseRuntime) return;
    await this.dependencies.getClient().clearAppProcess(this.dependencies.processId).catch(() => undefined);
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    if (!this.dependencies.releaseRuntime) return;
    await this.dependencies.getClient().writeUpdatePreference(enabled);
    if (enabled) void this.getStatus(false);
  }

  scheduleInitialCheck(): void {
    if (!this.dependencies.releaseRuntime) return;
    if (!this.dependencies.getAutoCheckEnabled() || this.dependencies.autoCheckDisabled()) return;
    this.dependencies.schedule(() => void this.getStatus(false), 1_000);
  }

  async showPreviousUpdateResult(): Promise<void> {
    if (!this.dependencies.releaseRuntime || this.previousResultShown) return;
    const client = this.dependencies.getClient();
    const status = await client.readInstallStatus().catch(() => null);
    const currentVersion = client.currentVersion();
    const installed = status?.status === "installed" && status.version === currentVersion;
    const failed = status?.status === "error" && Boolean(status.error);
    if (!installed && !failed) return;
    this.previousResultShown = true;

    if (installed) {
      await this.dependencies.showMessageBox({
        type: "info",
        title: "更新完成",
        message: `AgentRecall v${currentVersion} 已安装完成。`,
        detail: "应用已经使用新版本重新启动。",
      });
    } else {
      const command = client.manualInstallCommand();
      const result = await this.dependencies.showMessageBox({
        type: "error",
        title: "更新失败",
        message: "自动更新未能完成，可以手动安装最新版本。",
        detail: `${client.formatUpdateError(status?.error)}\n\n可以复制命令手动覆盖安装，或打开 GitHub Release 页面下载：\n${command}`,
        buttons: ["复制安装命令", "打开 Release 页面", "稍后处理"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 0) this.dependencies.copyText(command);
      if (result.response === 1) await this.dependencies.openExternal(client.LATEST_RELEASE_URL);
    }
    await client.clearInstallStatus().catch(() => undefined);
  }

  private emptyStatus(): AppUpdateStatus {
    return {
      currentVersion: this.dependencies.getClient().currentVersion(),
      developmentBuild: false,
      checkedAt: 0,
      fromCache: false,
      updateAvailable: false,
      manifest: null,
      error: null,
    };
  }

  private developmentStatus(): AppUpdateStatus {
    return { ...this.emptyStatus(), developmentBuild: true };
  }

  private refreshStatus(force: boolean): Promise<AppUpdateStatus> {
    if (!this.dependencies.releaseRuntime) return Promise.resolve(this.developmentStatus());
    if (this.activeCheck) return this.activeCheck;
    const client = this.dependencies.getClient();
    this.activeCheck = client
      .checkForUpdate({ currentVersion: client.currentVersion(), force })
      .then(async (status) => {
        const installStatus = await client.readInstallStatus().catch(() => null);
        const releaseStatus = { ...status, developmentBuild: false };
        const nextStatus = installStatus?.status === "error" && installStatus.error
          ? { ...releaseStatus, error: `上次更新失败：${installStatus.error}` }
          : releaseStatus;
        this.status = nextStatus;
        this.dependencies.publishStatus(nextStatus);
        return nextStatus;
      })
      .finally(() => {
        this.activeCheck = null;
      });
    return this.activeCheck;
  }
}

export interface DetachedAppUpdateInstallerOptions {
  applyUpdatePath: string;
  executablePath?: string;
  processId?: number;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    once(event: "spawn", listener: () => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    unref(): void;
  };
}

export async function launchDetachedAppUpdateInstaller(
  staged: StagedAppUpdate,
  options: DetachedAppUpdateInstallerOptions,
): Promise<void> {
  const environment = { ...(options.environment ?? process.env) };
  const executablePath = options.executablePath ?? environment.AGENT_RECALL_NODE_PATH;
  if (!executablePath) {
    throw new Error("The npm launcher did not provide a stable Node executable for the update.");
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-app-update-"));
  const stagedPath = path.join(directory, "staged.json");
  await fs.writeFile(stagedPath, `${JSON.stringify(staged, null, 2)}\n`, "utf8");
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let child: ReturnType<typeof spawnProcess>;
  try {
    child = spawnProcess(
      executablePath,
      [
        options.applyUpdatePath,
        "--staged",
        stagedPath,
        "--wait-pid",
        String(options.processId ?? process.pid),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: environment,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  child.unref();
}

interface RuntimeFileFingerprint {
  device: number;
  inode: number;
  size: number;
  modifiedAt: number;
}

export interface InstalledRuntimeMonitorOptions {
  appEntryPath: string;
  electronPath: string;
  launcherPath: string;
  nodePath: string;
  processId?: number;
  intervalMs?: number;
  statFile?: (filePath: string) => Promise<RuntimeFileFingerprint | null>;
  launchReplacement?: (options: {
    nodePath: string;
    launcherPath: string;
    processId: number;
  }) => Promise<void>;
  requestQuit(): void;
  logError(message: string): void;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

async function runtimeFileFingerprint(filePath: string): Promise<RuntimeFileFingerprint | null> {
  try {
    const stat = await fs.stat(filePath);
    return {
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameRuntimeFile(
  left: RuntimeFileFingerprint | null,
  right: RuntimeFileFingerprint | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt,
  );
}

export async function launchInstalledRuntimeReplacement(
  options: {
    nodePath: string;
    launcherPath: string;
    processId: number;
    spawnProcess?: typeof spawn;
  },
): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env, AGENT_RECALL_NO_UPDATE_CHECK: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = (options.spawnProcess ?? spawn)(
    options.nodePath,
    [
      options.launcherPath,
      "--no-update-check",
      "--wait-pid",
      String(options.processId),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: environment,
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export class InstalledRuntimeMonitor {
  private baselineEntry: RuntimeFileFingerprint | null = null;
  private baselineElectron: RuntimeFileFingerprint | null = null;
  private staleRuntimeDetected = false;
  private checking = false;
  private restarting = false;
  private readyReplacementEntry: RuntimeFileFingerprint | null = null;
  private readyReplacementLauncher: RuntimeFileFingerprint | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: InstalledRuntimeMonitorOptions) {}

  async start(): Promise<void> {
    if (this.timer) return;
    const statFile = this.options.statFile ?? runtimeFileFingerprint;
    [this.baselineEntry, this.baselineElectron] = await Promise.all([
      statFile(this.options.appEntryPath),
      statFile(this.options.electronPath),
    ]);
    if (!this.baselineEntry || !this.baselineElectron) {
      this.staleRuntimeDetected = true;
    }
    const schedule = this.options.setInterval ?? setInterval;
    this.timer = schedule(() => void this.checkNow(), this.options.intervalMs ?? 2_000);
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<void> {
    if (this.checking || this.restarting) return;
    this.checking = true;
    try {
      const statFile = this.options.statFile ?? runtimeFileFingerprint;
      const [entry, electron, launcher] = await Promise.all([
        statFile(this.options.appEntryPath),
        statFile(this.options.electronPath),
        statFile(this.options.launcherPath),
      ]);
      if (
        !sameRuntimeFile(this.baselineEntry, entry) ||
        !sameRuntimeFile(this.baselineElectron, electron)
      ) {
        this.staleRuntimeDetected = true;
      }
      if (!this.staleRuntimeDetected || !entry || !launcher) return;
      if (
        !sameRuntimeFile(this.readyReplacementEntry, entry) ||
        !sameRuntimeFile(this.readyReplacementLauncher, launcher)
      ) {
        this.readyReplacementEntry = entry;
        this.readyReplacementLauncher = launcher;
        return;
      }

      this.restarting = true;
      const launchReplacement = this.options.launchReplacement ?? launchInstalledRuntimeReplacement;
      await launchReplacement({
        nodePath: this.options.nodePath,
        launcherPath: this.options.launcherPath,
        processId: this.options.processId ?? process.pid,
      });
      this.stop();
      this.options.requestQuit();
    } catch (error) {
      this.restarting = false;
      this.options.logError(
        `Failed to restart AgentRecall after its installed runtime changed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.checking = false;
    }
  }
}
