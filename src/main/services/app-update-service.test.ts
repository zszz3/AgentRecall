import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdateManifest, AppUpdateProgress, AppUpdateStatus } from "../../core/app-update-types";
import {
  AppUpdateService,
  InstalledRuntimeMonitor,
  launchDetachedAppUpdateInstaller,
  launchInstalledRuntimeReplacement,
  type AppUpdateClient,
  type AppUpdateServiceDependencies,
  type StagedAppUpdate,
} from "./app-update-service";

function manifest(version = "0.2.0"): AppUpdateManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    title: "自动更新",
    publishedAt: "2026-07-16T00:00:00.000Z",
    releaseUrl: `https://github.com/zszz3/AgentRecall/releases/tag/v${version}`,
    notes: { features: [], fixes: ["修复更新检查。"] },
    package: {
      name: `agent-recall-${version}.tgz`,
      url: `https://github.com/zszz3/AgentRecall/releases/download/v${version}/agent-recall-${version}.tgz`,
      sha256: "a".repeat(64),
      checksumUrl: "",
    },
  };
}

function updateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    currentVersion: "0.1.0",
    developmentBuild: false,
    checkedAt: 1,
    fromCache: false,
    updateAvailable: false,
    manifest: null,
    error: null,
    ...overrides,
  };
}

function createClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    LATEST_RELEASE_URL: "https://github.com/zszz3/AgentRecall/releases/latest",
    checkForUpdate: vi.fn(async () => updateStatus()),
    clearAppProcess: vi.fn(async () => undefined),
    clearInstallStatus: vi.fn(async () => undefined),
    currentVersion: vi.fn(() => "0.1.0"),
    formatUpdateError: vi.fn((error) => String(error ?? "unknown error")),
    manualInstallCommand: vi.fn(() => "npm install -g agent-recall.tgz"),
    parseUpdateManifest: vi.fn((value) => {
      if (!value || typeof value !== "object") throw new Error("Update manifest is missing.");
      return value as AppUpdateManifest;
    }),
    readInstallStatus: vi.fn(async () => null),
    skipUpdateVersion: vi.fn(async () => undefined),
    snoozeUpdatePrompt: vi.fn(async () => undefined),
    stageUpdate: vi.fn(async () => ({
      version: "0.2.0",
      stageRoot: "/tmp/stage",
      archivePath: "/tmp/stage/update.tgz",
      stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
      livePackagePath: "/prefix/node_modules/agent-recall",
      backupPath: "/prefix/node_modules/.agent-recall-backup",
      statusPath: "/tmp/status.json",
    })),
    writeAppProcess: vi.fn(async () => "/tmp/process.json"),
    writeUpdatePreference: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createHarness(options: {
  releaseRuntime?: boolean;
  autoCheckEnabled?: boolean;
  autoCheckDisabled?: boolean;
  client?: AppUpdateClient;
  stageInstaller?: AppUpdateServiceDependencies["stageInstaller"];
  publishProgress?: AppUpdateServiceDependencies["publishProgress"];
} = {}) {
  const client = options.client ?? createClient();
  const published: AppUpdateStatus[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const staged: StagedAppUpdate = {
    version: "0.2.0",
    stageRoot: "/tmp/stage",
    archivePath: "/tmp/stage/update.tgz",
    stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
    livePackagePath: "/prefix/node_modules/agent-recall",
    backupPath: "/prefix/node_modules/.agent-recall-backup",
    statusPath: "/tmp/status.json",
  };
  const stageInstaller = options.stageInstaller ?? vi.fn(async () => staged);
  const launchInstaller = vi.fn(async () => undefined);
  const publishedProgress: AppUpdateProgress[] = [];
  const requestQuit = vi.fn();
  const showMessageBox = vi.fn(async () => ({ response: 2 }));
  const copyText = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  const logError = vi.fn();
  const dependencies: AppUpdateServiceDependencies = {
    getClient: () => client,
    releaseRuntime: options.releaseRuntime ?? true,
    getAutoCheckEnabled: () => options.autoCheckEnabled ?? true,
    autoCheckDisabled: () => options.autoCheckDisabled ?? false,
    publishStatus: (status) => published.push(status),
    publishProgress: options.publishProgress ?? ((progress) => publishedProgress.push(progress)),
    stageInstaller,
    launchInstaller,
    requestQuit,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    showMessageBox,
    copyText,
    openExternal,
    processId: 123,
    logError,
  };
  return {
    service: new AppUpdateService(dependencies),
    client,
    published,
    publishedProgress,
    stageInstaller,
    scheduled,
    launchInstaller,
    requestQuit,
    showMessageBox,
    copyText,
    openExternal,
    logError,
  };
}

describe("AppUpdateService", () => {
  it("keeps development builds offline and refuses installation", async () => {
    const harness = createHarness({ releaseRuntime: false });

    await expect(harness.service.getStatus(true)).resolves.toMatchObject({
      developmentBuild: true,
      updateAvailable: false,
    });
    await expect(harness.service.install()).rejects.toThrow("unavailable in development builds");
    harness.service.scheduleInitialCheck();

    expect(harness.client.checkForUpdate).not.toHaveBeenCalled();
    expect(harness.scheduled).toEqual([]);
  });

  it("disables background checks without disabling a forced manual check", async () => {
    const harness = createHarness({ autoCheckDisabled: true });

    harness.service.scheduleInitialCheck();
    await harness.service.getStatus(false);
    expect(harness.scheduled).toEqual([]);
    expect(harness.client.checkForUpdate).not.toHaveBeenCalled();

    await harness.service.getStatus(true);
    expect(harness.client.checkForUpdate).toHaveBeenCalledOnce();
    expect(harness.client.checkForUpdate).toHaveBeenCalledWith({ currentVersion: "0.1.0", force: true });
  });

  it("schedules one enabled background check through the guarded status path", () => {
    const harness = createHarness();
    harness.service.scheduleInitialCheck();

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0].delayMs).toBe(1_000);
    harness.scheduled[0].callback();
    expect(harness.client.checkForUpdate).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent checks and publishes the resulting status once", async () => {
    let resolveCheck: ((status: AppUpdateStatus) => void) | undefined;
    const client = createClient({
      checkForUpdate: vi.fn(() => new Promise<AppUpdateStatus>((resolve) => {
        resolveCheck = resolve;
      })),
    });
    const harness = createHarness({ client });

    const first = harness.service.getStatus(true);
    const second = harness.service.getStatus(true);
    expect(client.checkForUpdate).toHaveBeenCalledOnce();
    resolveCheck?.(updateStatus({ checkedAt: 42 }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ checkedAt: 42 }),
      expect.objectContaining({ checkedAt: 42 }),
    ]);
    expect(harness.published).toHaveLength(1);
  });

  it("snoozes or skips the current version and refreshes its cached status", async () => {
    const available = updateStatus({ updateAvailable: true, manifest: manifest() });
    const client = createClient({ checkForUpdate: vi.fn(async () => available) });
    const harness = createHarness({ client });
    await harness.service.getStatus(true);

    await harness.service.skip(false);
    expect(client.snoozeUpdatePrompt).toHaveBeenCalledWith("0.2.0");

    await harness.service.skip(true);
    expect(client.skipUpdateVersion).toHaveBeenCalledWith("0.2.0");
    expect(client.checkForUpdate).toHaveBeenCalledTimes(3);
  });

  it("acknowledges once while installation continues in the background", async () => {
    const availableManifest = manifest();
    let resolveStage: ((staged: StagedAppUpdate) => void) | undefined;
    const stageInstaller: AppUpdateServiceDependencies["stageInstaller"] = vi.fn(() =>
      new Promise<StagedAppUpdate>((resolve) => {
        resolveStage = resolve;
      }));
    const client = createClient({
      checkForUpdate: vi.fn(async () => updateStatus({ updateAvailable: true, manifest: availableManifest })),
    });
    const harness = createHarness({ client, stageInstaller });
    await harness.service.getStatus(true);

    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    expect(client.parseUpdateManifest).toHaveBeenCalledWith(availableManifest);
    expect(harness.stageInstaller).toHaveBeenCalledWith(availableManifest, expect.any(Function));
    expect(harness.stageInstaller).toHaveBeenCalledOnce();
    expect(harness.launchInstaller).not.toHaveBeenCalled();

    resolveStage?.({
      version: "0.2.0",
      stageRoot: "/tmp/stage",
      archivePath: "/tmp/stage/update.tgz",
      stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
      livePackagePath: "/prefix/node_modules/agent-recall",
      backupPath: "/prefix/node_modules/.agent-recall-backup",
      statusPath: "/tmp/status.json",
    });
    await vi.waitFor(() => expect(harness.launchInstaller).toHaveBeenCalledOnce());
    expect(harness.launchInstaller).toHaveBeenCalledWith(expect.objectContaining({ version: "0.2.0" }));
    expect(harness.requestQuit).not.toHaveBeenCalled();
    expect(harness.scheduled.at(-1)?.delayMs).toBe(300);
    harness.scheduled.at(-1)?.callback();
    expect(harness.requestQuit).toHaveBeenCalledOnce();
  });

  it("publishes staged progress before requesting restart", async () => {
    const availableManifest = manifest();
    const stageInstaller: AppUpdateServiceDependencies["stageInstaller"] = vi.fn(async (_manifest, onProgress) => {
      onProgress({ phase: "downloading", version: "0.2.0", percent: 25 });
      onProgress({ phase: "staging", version: "0.2.0" });
      onProgress({ phase: "validating", version: "0.2.0" });
      return {
        version: "0.2.0",
        stageRoot: "/tmp/stage",
        archivePath: "/tmp/stage/update.tgz",
        stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
        livePackagePath: "/prefix/node_modules/agent-recall",
        backupPath: "/prefix/node_modules/.agent-recall-backup",
        statusPath: "/tmp/status.json",
      };
    });
    const client = createClient({
      checkForUpdate: vi.fn(async () => updateStatus({ updateAvailable: true, manifest: availableManifest })),
    });
    const harness = createHarness({ client, stageInstaller });
    await harness.service.getStatus(true);

    await harness.service.install();
    await vi.waitFor(() => expect(harness.publishedProgress.at(-1)?.phase).toBe("restarting"));

    expect(harness.publishedProgress.map((event) => event.phase)).toEqual([
      "downloading",
      "staging",
      "validating",
      "restarting",
    ]);
  });

  it("publishes background installation failures without rejecting the IPC acknowledgement", async () => {
    const availableManifest = manifest();
    const client = createClient({
      checkForUpdate: vi.fn(async () => updateStatus({ updateAvailable: true, manifest: availableManifest })),
    });
    const harness = createHarness({
      client,
      stageInstaller: vi.fn(async () => {
        throw new Error("download failed");
      }),
    });
    await harness.service.getStatus(true);

    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    await vi.waitFor(() => expect(harness.publishedProgress.at(-1)).toMatchObject({
      phase: "error",
      version: "0.2.0",
      message: "自动更新已停止，请使用命令行手动更新。",
      error: expect.stringContaining("download failed"),
    }));
    expect(harness.publishedProgress.at(-1)?.error).toContain("npm install -g agent-recall.tgz");
    expect(harness.logError).toHaveBeenCalledWith(expect.stringContaining("download failed"));
  });

  it("contains progress reporting failures and clears the active background installation", async () => {
    const availableManifest = manifest();
    const stageInstaller = vi.fn(async () => {
      throw new Error("download failed");
    });
    const client = createClient({
      checkForUpdate: vi.fn(async () => updateStatus({ updateAvailable: true, manifest: availableManifest })),
    });
    const harness = createHarness({
      client,
      stageInstaller,
      publishProgress: vi.fn(() => {
        throw new Error("renderer was destroyed");
      }),
    });
    await harness.service.getStatus(true);

    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    await vi.waitFor(() => expect(harness.logError).toHaveBeenCalledWith(expect.stringContaining("renderer was destroyed")));
    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    await vi.waitFor(() => expect(stageInstaller).toHaveBeenCalledTimes(2));
  });

  it("shows and clears a failed installation result only once", async () => {
    const client = createClient({
      readInstallStatus: vi.fn(async () => ({ status: "error", version: "0.2.0", error: "npm failed" })),
    });
    const harness = createHarness({ client });
    harness.showMessageBox.mockResolvedValue({ response: 0 });

    await harness.service.showPreviousUpdateResult();
    await harness.service.showPreviousUpdateResult();

    expect(harness.showMessageBox).toHaveBeenCalledOnce();
    expect(harness.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: "更新失败",
      message: expect.stringContaining("手动安装"),
    }));
    expect(harness.copyText).toHaveBeenCalledWith("npm install -g agent-recall.tgz");
    expect(client.clearInstallStatus).toHaveBeenCalledOnce();
  });

  it("registers and clears the running process through its lifecycle boundary", async () => {
    const harness = createHarness();
    await harness.service.registerRunningProcess();
    await harness.service.clearRunningProcess();

    expect(harness.client.writeAppProcess).toHaveBeenCalledWith(123);
    expect(harness.client.writeUpdatePreference).toHaveBeenCalledWith(true);
    expect(harness.client.clearAppProcess).toHaveBeenCalledWith(123);
  });
});

describe("detached update installer", () => {
  it("writes a temporary manifest and launches the stable npm Node before returning", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const staged: StagedAppUpdate = {
      version: "0.2.0",
      stageRoot: "/tmp/stage",
      archivePath: "/tmp/stage/update.tgz",
      stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
      livePackagePath: "/prefix/node_modules/agent-recall",
      backupPath: "/prefix/node_modules/.agent-recall-backup",
      statusPath: "/tmp/status.json",
    };
    await launchDetachedAppUpdateInstaller(staged, {
      applyUpdatePath: "/app/bin/apply-update.cjs",
      processId: 456,
      environment: {
        EXISTING_VALUE: "kept",
        AGENT_RECALL_NODE_PATH: "/usr/local/bin/node",
        ELECTRON_RUN_AS_NODE: "1",
      },
      spawnProcess,
    });

    expect(invocation?.command).toBe("/usr/local/bin/node");
    expect(invocation?.args).toEqual([
      "/app/bin/apply-update.cjs",
      "--staged",
      expect.stringMatching(/agent-recall-app-update-.*staged\.json$/),
      "--wait-pid",
      "456",
    ]);
    expect(invocation?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: {
        EXISTING_VALUE: "kept",
        AGENT_RECALL_NODE_PATH: "/usr/local/bin/node",
      },
    });
    expect(invocation?.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(child.unref).toHaveBeenCalledOnce();

    const stagedPath = invocation?.args[2];
    expect(JSON.parse(await readFile(stagedPath!, "utf8"))).toEqual(staged);
    await rm(path.dirname(stagedPath!), { recursive: true, force: true });
  });

  it("fails before spawning when the npm launcher did not provide a stable Node path", async () => {
    const spawnProcess = vi.fn();

    await expect(launchDetachedAppUpdateInstaller({
      version: "0.2.0",
      stageRoot: "/tmp/stage",
      archivePath: "/tmp/stage/update.tgz",
      stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
      livePackagePath: "/prefix/node_modules/agent-recall",
      backupPath: "/prefix/node_modules/.agent-recall-backup",
      statusPath: "/tmp/status.json",
    }, {
      applyUpdatePath: "/app/bin/apply-update.cjs",
      environment: { EXISTING_VALUE: "kept" },
      spawnProcess,
    })).rejects.toThrow("stable Node executable");

    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe("installed runtime replacement", () => {
  it("launches the npm entry through stable Node and waits for the old app process", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await launchInstalledRuntimeReplacement({
      nodePath: "/usr/local/bin/node",
      launcherPath: "/prefix/lib/node_modules/agent-recall/bin/agent-recall.cjs",
      processId: 789,
      spawnProcess: spawnProcess as never,
    });

    expect(invocation).toMatchObject({
      command: "/usr/local/bin/node",
      args: [
        "/prefix/lib/node_modules/agent-recall/bin/agent-recall.cjs",
        "--no-update-check",
        "--wait-pid",
        "789",
      ],
      options: {
        detached: true,
        stdio: "ignore",
      },
    });
    expect(invocation?.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("restarts through the repair-capable launcher after an external package replacement settles", async () => {
    const original = { device: 1, inode: 10, size: 100, modifiedAt: 1 };
    const replacement = { device: 1, inode: 20, size: 100, modifiedAt: 2 };
    const launcher = { device: 1, inode: 30, size: 50, modifiedAt: 2 };
    const files = new Map<string, typeof original | null>([
      ["/app/index.js", original],
      ["/app/Electron", original],
      ["/app/agent-recall.cjs", launcher],
    ]);
    const launchReplacement = vi.fn(async () => undefined);
    const requestQuit = vi.fn();
    const clearTimer = vi.fn();
    const monitor = new InstalledRuntimeMonitor({
      appEntryPath: "/app/index.js",
      electronPath: "/app/Electron",
      launcherPath: "/app/agent-recall.cjs",
      nodePath: "/usr/local/bin/node",
      processId: 789,
      statFile: vi.fn(async (filePath) => files.get(filePath) ?? null),
      launchReplacement,
      requestQuit,
      logError: vi.fn(),
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: clearTimer,
    });
    await monitor.start();

    files.set("/app/index.js", null);
    files.set("/app/Electron", null);
    await monitor.checkNow();
    expect(launchReplacement).not.toHaveBeenCalled();

    files.set("/app/index.js", replacement);
    await monitor.checkNow();
    expect(launchReplacement).not.toHaveBeenCalled();
    await monitor.checkNow();

    expect(launchReplacement).toHaveBeenCalledWith({
      nodePath: "/usr/local/bin/node",
      launcherPath: "/app/agent-recall.cjs",
      processId: 789,
    });
    expect(clearTimer).toHaveBeenCalledOnce();
    expect(requestQuit).toHaveBeenCalledOnce();
  });
});
