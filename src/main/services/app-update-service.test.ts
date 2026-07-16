import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdateManifest, AppUpdateStatus } from "../../core/app-update-types";
import {
  AppUpdateService,
  launchDetachedAppUpdateInstaller,
  type AppUpdateClient,
  type AppUpdateServiceDependencies,
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
} = {}) {
  const client = options.client ?? createClient();
  const published: AppUpdateStatus[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const launchInstaller = vi.fn(async () => undefined);
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

  it("launches the validated manifest before scheduling application quit", async () => {
    const availableManifest = manifest();
    const client = createClient({
      checkForUpdate: vi.fn(async () => updateStatus({ updateAvailable: true, manifest: availableManifest })),
    });
    const harness = createHarness({ client });
    await harness.service.getStatus(true);

    await expect(harness.service.install()).resolves.toEqual({ started: true, version: "0.2.0" });
    expect(client.parseUpdateManifest).toHaveBeenCalledWith(availableManifest);
    expect(harness.launchInstaller).toHaveBeenCalledWith(availableManifest);
    expect(harness.requestQuit).not.toHaveBeenCalled();
    expect(harness.scheduled.at(-1)?.delayMs).toBe(100);
    harness.scheduled.at(-1)?.callback();
    expect(harness.requestQuit).toHaveBeenCalledOnce();
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
  it("writes a temporary manifest and launches Node-mode Electron before returning", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await launchDetachedAppUpdateInstaller(manifest(), {
      applyUpdatePath: "/app/bin/apply-update.cjs",
      executablePath: "/app/Electron",
      processId: 456,
      environment: { EXISTING_VALUE: "kept" },
      spawnProcess,
    });

    expect(invocation?.command).toBe("/app/Electron");
    expect(invocation?.args).toEqual([
      "/app/bin/apply-update.cjs",
      "--manifest",
      expect.stringMatching(/agent-recall-app-update-.*update\.json$/),
      "--wait-pid",
      "456",
    ]);
    expect(invocation?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: { EXISTING_VALUE: "kept", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(child.unref).toHaveBeenCalledOnce();

    const manifestPath = invocation?.args[2];
    expect(JSON.parse(await readFile(manifestPath!, "utf8"))).toEqual(manifest());
    await rm(path.dirname(manifestPath!), { recursive: true, force: true });
  });
});
