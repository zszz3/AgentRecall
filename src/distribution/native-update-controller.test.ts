import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NativeUpdateController, type NativeUpdateControllerOptions } from "./native-update-controller";
import type { NativeAutoUpdater, NativeUpdatePreferences } from "./native-update-types";

function createHarness(overrides: Partial<NativeUpdateControllerOptions> = {}) {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  }) as unknown as NativeAutoUpdater & EventEmitter;
  let enabled = true;
  const preferences: NativeUpdatePreferences = {
    isAutomaticCheckEnabled: () => enabled,
    setAutomaticCheckEnabled: vi.fn(async (value: boolean) => {
      enabled = value;
    }),
  };
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const copyText = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  const backupLifecycle = {
    prepareForUpdate: vi.fn(async () => ({ backupPath: "/synthetic/backups/from-0.1.0-to-1.0.0" })),
  };
  const controller = new NativeUpdateController({
    updater,
    currentVersion: "0.1.0",
    preferences,
    backupLifecycle,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    copyText,
    openExternal,
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  });
  return {
    controller,
    updater,
    preferences,
    scheduled,
    copyText,
    openExternal,
    backupLifecycle,
  };
}

describe("NativeUpdateController", () => {
  it("never auto-downloads and waits for the first usable window before checking", async () => {
    const harness = createHarness();

    expect(harness.updater.autoDownload).toBe(false);
    expect(harness.updater.autoInstallOnAppQuit).toBe(false);
    expect(harness.updater.checkForUpdates).not.toHaveBeenCalled();

    harness.controller.firstUsableWindowReady();
    harness.controller.firstUsableWindowReady();
    expect(harness.scheduled).toEqual([{ callback: expect.any(Function), delayMs: 1_000 }]);

    harness.scheduled[0].callback();
    await vi.waitFor(() => expect(harness.updater.checkForUpdates).toHaveBeenCalledOnce());
  });

  it("performs no scheduled network request after automatic checks are disabled", async () => {
    const harness = createHarness();
    harness.controller.firstUsableWindowReady();
    await harness.controller.setAutomaticChecksEnabled(false);

    harness.scheduled[0].callback();
    await Promise.resolve();
    expect(harness.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(harness.controller.getState().phase).toBe("disabled");

    await harness.controller.check(true);
    expect(harness.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("requires an explicit download and reports progress", async () => {
    const harness = createHarness();
    harness.updater.emit("update-available", { version: "1.0.0" });

    expect(harness.controller.getState()).toMatchObject({
      phase: "available",
      targetVersion: "1.0.0",
    });
    expect(harness.updater.downloadUpdate).not.toHaveBeenCalled();

    await harness.controller.download();
    expect(harness.updater.downloadUpdate).toHaveBeenCalledOnce();
    harness.updater.emit("download-progress", { percent: 51.5 });
    expect(harness.controller.getState().progressPercent).toBe(51.5);
    harness.updater.emit("update-downloaded", { version: "1.0.0" });
    expect(harness.controller.getState().phase).toBe("downloaded");
  });

  it("prepares the versioned database backup before starting the installer", async () => {
    const order: string[] = [];
    const harness = createHarness({
      backupLifecycle: {
        prepareForUpdate: vi.fn(async () => {
          order.push("backup");
          return { backupPath: "/synthetic/backup" };
        }),
      },
    });
    harness.updater.quitAndInstall = vi.fn(() => order.push("install"));
    harness.updater.emit("update-downloaded", { version: "1.0.0" });

    await harness.controller.installDownloadedUpdate();

    expect(order).toEqual(["backup", "install"]);
    expect(harness.controller.getState()).toMatchObject({
      phase: "installing",
      backupPath: "/synthetic/backup",
    });
    expect(harness.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("blocks installation on backup failure and exposes retry, diagnostics and safe URLs", async () => {
    const backupLifecycle = {
      prepareForUpdate: vi
        .fn()
        .mockRejectedValueOnce(new Error("token=private-value at /Users/example/AgentRecall/session.sqlite"))
        .mockResolvedValueOnce({ backupPath: "/synthetic/backup" }),
    };
    const harness = createHarness({ backupLifecycle });
    harness.updater.emit("update-downloaded", { version: "1.0.0" });

    await harness.controller.installDownloadedUpdate();
    expect(harness.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(harness.controller.getState().failure).toMatchObject({
      code: "NATIVE_UPDATE_BACKUP_FAILED",
      retryable: true,
      releaseUrl: "https://github.com/zszz3/AgentRecall/releases",
    });

    harness.controller.copyFailureDiagnostics();
    expect(harness.copyText).toHaveBeenCalledWith(expect.stringContaining("NATIVE_UPDATE_BACKUP_FAILED"));
    expect(harness.copyText).toHaveBeenCalledWith(expect.not.stringContaining("private-value"));
    expect(harness.copyText).toHaveBeenCalledWith(expect.not.stringContaining("/Users/"));
    await harness.controller.openFailureHelp();
    await harness.controller.openReleases();
    expect(harness.openExternal).toHaveBeenNthCalledWith(
      1,
      "https://github.com/zszz3/AgentRecall/issues/new?template=bug_report.yml",
    );
    expect(harness.openExternal).toHaveBeenNthCalledWith(
      2,
      "https://github.com/zszz3/AgentRecall/releases",
    );

    await harness.controller.retry();
    expect(backupLifecycle.prepareForUpdate).toHaveBeenCalledTimes(2);
    expect(harness.updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("reopens the database when starting the native installer throws", async () => {
    const recover = vi.fn();
    const harness = createHarness({
      backupLifecycle: {
        prepareForUpdate: vi.fn(async () => ({ backupPath: "/synthetic/backup" })),
        recoverAfterInstallLaunchFailure: recover,
      },
    });
    harness.updater.quitAndInstall = vi.fn(() => {
      throw new Error("installer unavailable");
    });
    harness.updater.emit("update-downloaded", { version: "1.0.0" });

    await harness.controller.installDownloadedUpdate();

    expect(recover).toHaveBeenCalledOnce();
    expect(harness.controller.getState().failure?.code).toBe("NATIVE_UPDATE_INSTALL_FAILED");
  });

  it("classifies updater errors during preparation as install failures", () => {
    const harness = createHarness();
    harness.updater.emit("update-downloaded", { version: "1.0.0" });
    const pending = new Promise<{ backupPath: string }>(() => undefined);
    harness.backupLifecycle.prepareForUpdate.mockReturnValue(pending);
    void harness.controller.installDownloadedUpdate();

    harness.updater.emit("error", new Error("installer event failed"));
    expect(harness.controller.getState().failure?.code).toBe("NATIVE_UPDATE_INSTALL_FAILED");
  });
});
