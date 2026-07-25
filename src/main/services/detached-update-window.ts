import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AppUpdateManifest, AppUpdateProgress } from "../../core/app-update-types";

interface SpawnedProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export interface StagedAppUpdate {
  version: string;
  stageRoot: string;
  archivePath: string;
  stagedPackagePath: string;
  livePackagePath: string;
  backupPath: string;
  statusPath: string;
}

export interface DetachedUpdateWindowOptions {
  electronExecutable: string;
  updateWindowEntry: string;
  applyUpdatePath: string;
  stableNodePath?: string;
  processId?: number;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
}

export async function launchDetachedUpdateWindow(
  manifest: AppUpdateManifest,
  options: DetachedUpdateWindowOptions,
): Promise<void> {
  const stableNodePath = options.stableNodePath
    ?? options.environment?.AGENT_RECALL_NODE_PATH
    ?? process.env.AGENT_RECALL_NODE_PATH;
  if (!stableNodePath) {
    throw new Error("The npm launcher did not provide a stable Node executable for the update.");
  }

  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    AGENT_RECALL_NODE_PATH: stableNodePath,
    AGENT_RECALL_APPLY_UPDATE_PATH: options.applyUpdatePath,
  };
  delete environment.ELECTRON_RUN_AS_NODE;

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-app-update-"));
  const manifestPath = path.join(directory, "update.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const spawnProcess = options.spawnProcess
    ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));

  let child: SpawnedProcess;
  try {
    child = spawnProcess(
      options.electronExecutable,
      [
        options.updateWindowEntry,
        "--manifest",
        manifestPath,
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

export interface DetachedUpdateLifecycleOptions {
  manifest: AppUpdateManifest;
  manifestPath: string;
  mainProcessId: number;
  updaterProcessId: number;
  stableNodePath: string;
  applyUpdatePath: string;
  waitForProcessExit(pid: number, timeoutMs?: number): Promise<void>;
  stageUpdate(
    manifest: AppUpdateManifest,
    options: {
      nodePath: string;
      onProgress(progress: AppUpdateProgress): void;
    },
  ): Promise<StagedAppUpdate>;
  publishProgress(progress: AppUpdateProgress): void;
  formatUpdateError(error: unknown): string;
  showNativeUpdateFailure(errorMessage: string): unknown;
  launchInstalledApp(): unknown;
  writeStagedDescriptor?(staged: StagedAppUpdate): Promise<string>;
  launchApply?(stagedPath: string, waitPid: number): Promise<void>;
  cleanupControlDirectory?(): Promise<void>;
  spawnProcess?: SpawnProcess;
  environment?: NodeJS.ProcessEnv;
}

async function spawnAndWait(
  command: string,
  args: string[],
  options: SpawnOptions,
  spawnProcess: SpawnProcess,
): Promise<void> {
  const child = spawnProcess(command, args, options);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function recordInstallFailure(staged: StagedAppUpdate | undefined, error: string): Promise<void> {
  if (!staged) return;
  await fs.mkdir(path.dirname(staged.statusPath), { recursive: true });
  await fs.writeFile(staged.statusPath, `${JSON.stringify({
    status: "error",
    version: staged.version,
    updatedAt: Date.now(),
    error,
  }, null, 2)}\n`, "utf8");
}

export async function runDetachedUpdate(options: DetachedUpdateLifecycleOptions): Promise<void> {
  let staged: StagedAppUpdate | undefined;
  try {
    await options.waitForProcessExit(options.mainProcessId, 30_000);
    staged = await options.stageUpdate(options.manifest, {
      nodePath: options.stableNodePath,
      onProgress: options.publishProgress,
    });
    const stagedPath = await (options.writeStagedDescriptor
      ? options.writeStagedDescriptor(staged)
      : (async () => {
          const filePath = path.join(path.dirname(options.manifestPath), "staged.json");
          await fs.writeFile(filePath, `${JSON.stringify(staged, null, 2)}\n`, "utf8");
          return filePath;
        })());
    options.publishProgress({
      phase: "restarting",
      version: options.manifest.version,
      message: "更新准备完成，正在重新启动…",
    });
    if (options.launchApply) {
      await options.launchApply(stagedPath, options.updaterProcessId);
    } else {
      const environment = { ...(options.environment ?? process.env) };
      delete environment.ELECTRON_RUN_AS_NODE;
      await spawnAndWait(
        options.stableNodePath,
        [
          options.applyUpdatePath,
          "--staged",
          stagedPath,
          "--wait-pid",
          String(options.updaterProcessId),
        ],
        { detached: true, stdio: "ignore", env: environment },
        options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions)),
      );
    }
  } catch (error) {
    const formatted = options.formatUpdateError(error);
    options.publishProgress({
      phase: "error",
      version: options.manifest.version,
      error: formatted,
    });
    await recordInstallFailure(staged, formatted).catch(() => undefined);
    options.showNativeUpdateFailure(formatted);
    try {
      options.launchInstalledApp();
    } catch {
      // The recorded status is shown the next time the user launches AgentRecall manually.
    }
    if (staged) await fs.rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined);
    await (options.cleanupControlDirectory
      ? options.cleanupControlDirectory()
      : fs.rm(path.dirname(options.manifestPath), { recursive: true, force: true })
    ).catch(() => undefined);
    throw error;
  }
}
