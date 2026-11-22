// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateProgress, AppUpdateStatus } from "../../../../core/app-update-types";
import { useAppUpdate, type AppUpdateController } from "./use-app-update";

function status(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    currentVersion: "0.41.0",
    developmentBuild: false,
    checkedAt: 1,
    fromCache: false,
    updateAvailable: false,
    manifest: null,
    error: null,
    ...overrides,
  };
}

describe("useAppUpdate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: AppUpdateController;
  let emitStatus: (value: AppUpdateStatus) => void;
  let emitProgress: (value: AppUpdateProgress) => void;
  const offStatus = vi.fn();
  const offProgress = vi.fn();
  const api = {
    getAppUpdateStatus: vi.fn(),
    installAppUpdate: vi.fn(),
    skipAppUpdate: vi.fn(),
    onAppUpdateStatus: vi.fn((callback: (value: AppUpdateStatus) => void) => {
      emitStatus = callback;
      return offStatus;
    }),
    onAppUpdateProgress: vi.fn((callback: (value: AppUpdateProgress) => void) => {
      emitProgress = callback;
      return offProgress;
    }),
  };

  function Harness() {
    controller = useAppUpdate(api);
    return null;
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    api.getAppUpdateStatus.mockResolvedValue(status());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("reads the cached status once, follows pushed updates and signals an available update", async () => {
    expect(api.getAppUpdateStatus).toHaveBeenCalledWith(false);
    expect(controller.signal).toBe(false);

    await act(async () => emitStatus(status({ updateAvailable: true })));
    expect(controller.signal).toBe(true);
    await act(async () => emitStatus(status({ updateAvailable: true, promptSnoozed: true })));
    expect(controller.signal).toBe(false);

    await act(async () => emitProgress({ phase: "downloading", version: "0.42.0", percent: 40 }));
    expect(controller.progress).toMatchObject({ percent: 40 });
  });

  it("checks, skips and installs while reporting busy state and failures", async () => {
    api.getAppUpdateStatus.mockResolvedValueOnce(status({ updateAvailable: true, checkedAt: 2 }));
    await act(async () => controller.check());
    expect(api.getAppUpdateStatus).toHaveBeenLastCalledWith(true);
    expect(controller.status?.checkedAt).toBe(2);
    expect(controller.busy).toBe(false);

    api.skipAppUpdate.mockResolvedValueOnce(status({ updateAvailable: true, updateSkipped: true }));
    await act(async () => controller.skip(true));
    expect(api.skipAppUpdate).toHaveBeenCalledWith(true);
    expect(controller.signal).toBe(false);

    api.installAppUpdate.mockRejectedValueOnce(new Error("Download failed"));
    await act(async () => controller.install());
    expect(controller.error).toBe("Download failed");
    expect(controller.busy).toBe(false);
  });

  it("stays busy after the installer starts because the app is about to restart", async () => {
    api.installAppUpdate.mockResolvedValueOnce({ started: true, version: "0.42.0" });
    await act(async () => controller.install());
    expect(controller.busy).toBe(true);
    expect(controller.error).toBeNull();
  });

  it("stops listening when unmounted", async () => {
    await act(async () => root.unmount());
    expect(offStatus).toHaveBeenCalledTimes(1);
    expect(offProgress).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
