import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageBoxOptions } from "electron";
import type { AppUpdateInstallResult, AppUpdateManifest, AppUpdateStatus } from "../../core/app-update-types";

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
}

export interface AppUpdateServiceDependencies {
  getClient(): AppUpdateClient;
  releaseRuntime: boolean;
  getAutoCheckEnabled(): boolean;
  autoCheckDisabled(): boolean;
  publishStatus(status: AppUpdateStatus): void;
  launchInstaller(manifest: AppUpdateManifest): Promise<void>;
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
    const manifest = this.dependencies.getClient().parseUpdateManifest(this.status?.manifest);
    await this.dependencies.launchInstaller(manifest);
    this.dependencies.schedule(() => this.dependencies.requestQuit(), 100);
    return { started: true, version: manifest.version };
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
  manifest: AppUpdateManifest,
  options: DetachedAppUpdateInstallerOptions,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-app-update-"));
  const manifestPath = path.join(directory, "update.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let child: ReturnType<typeof spawnProcess>;
  try {
    child = spawnProcess(
      options.executablePath ?? process.execPath,
      [
        options.applyUpdatePath,
        "--manifest",
        manifestPath,
        "--wait-pid",
        String(options.processId ?? process.pid),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...(options.environment ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
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
