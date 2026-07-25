import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdateManifest, AppUpdateProgress } from "../../core/app-update-types";
import {
  launchDetachedUpdateWindow,
  runDetachedUpdate,
  type StagedAppUpdate,
} from "./detached-update-window";

function manifest(version = "0.32.0"): AppUpdateManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    title: "自动更新",
    publishedAt: "2026-07-25T00:00:00.000Z",
    releaseUrl: `https://github.com/zszz3/AgentRecall/releases/tag/v${version}`,
    notes: { features: [], fixes: ["恢复后台更新。"] },
    package: {
      name: `agent-recall-${version}.tgz`,
      url: `https://github.com/zszz3/AgentRecall/releases/download/v${version}/agent-recall-${version}.tgz`,
      sha256: "a".repeat(64),
      checksumUrl: "",
    },
  };
}

function stagedUpdate(): StagedAppUpdate {
  return {
    version: "0.32.0",
    stageRoot: "/tmp/stage",
    archivePath: "/tmp/stage/update.tgz",
    stagedPackagePath: "/tmp/stage/node_modules/agent-recall",
    livePackagePath: "/npm/node_modules/agent-recall",
    backupPath: "/npm/node_modules/.agent-recall-backup",
    statusPath: "/home/.agent-recall/update-install-status.json",
  };
}

describe("detached update window launcher", () => {
  it("writes a temporary manifest and launches Electron independently", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const updateManifest = manifest();

    await launchDetachedUpdateWindow(updateManifest, {
      electronExecutable: "/app/node_modules/electron/dist/Electron",
      updateWindowEntry: "/app/out/main/update-window.js",
      applyUpdatePath: "/app/bin/apply-update.cjs",
      stableNodePath: "/usr/local/bin/node",
      processId: 456,
      environment: {
        EXISTING_VALUE: "kept",
        ELECTRON_RUN_AS_NODE: "1",
      },
      spawnProcess,
    });

    expect(invocation?.command).toBe("/app/node_modules/electron/dist/Electron");
    expect(invocation?.args).toEqual([
      "/app/out/main/update-window.js",
      "--manifest",
      expect.stringMatching(/agent-recall-app-update-.*update\.json$/),
      "--wait-pid",
      "456",
    ]);
    expect(invocation?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: {
        EXISTING_VALUE: "kept",
        AGENT_RECALL_NODE_PATH: "/usr/local/bin/node",
        AGENT_RECALL_APPLY_UPDATE_PATH: "/app/bin/apply-update.cjs",
      },
    });
    expect(invocation?.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(child.unref).toHaveBeenCalledOnce();

    const manifestPath = invocation?.args[2];
    expect(JSON.parse(await readFile(manifestPath!, "utf8"))).toEqual(updateManifest);
    await rm(path.dirname(manifestPath!), { recursive: true, force: true });
  });

  it("removes the control directory when Electron cannot start", async () => {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = vi.fn();
    let manifestPath = "";
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      manifestPath = args[2];
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    await expect(launchDetachedUpdateWindow(manifest(), {
      electronExecutable: "/app/electron",
      updateWindowEntry: "/app/update-window.js",
      applyUpdatePath: "/app/apply-update.cjs",
      stableNodePath: "/app/node",
      spawnProcess,
    })).rejects.toThrow("spawn failed");

    await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before spawning when the npm launcher did not provide a stable Node path", async () => {
    const spawnProcess = vi.fn();

    await expect(launchDetachedUpdateWindow(manifest(), {
      electronExecutable: "/app/electron",
      updateWindowEntry: "/app/update-window.js",
      applyUpdatePath: "/app/apply-update.cjs",
      environment: { EXISTING_VALUE: "kept" },
      spawnProcess,
    })).rejects.toThrow("stable Node executable");

    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe("detached update lifecycle", () => {
  it("waits for the main app, stages the package, then hands off to stable Node", async () => {
    const order: string[] = ["window-ready"];
    const progress: AppUpdateProgress[] = [];
    const staged = stagedUpdate();
    let applyInvocation: { stagedPath: string; waitPid: number } | undefined;

    await runDetachedUpdate({
      manifest: manifest(),
      manifestPath: "/tmp/control/update.json",
      mainProcessId: 456,
      updaterProcessId: 789,
      stableNodePath: "/usr/local/bin/node",
      applyUpdatePath: "/app/bin/apply-update.cjs",
      waitForProcessExit: vi.fn(async (pid) => {
        expect(pid).toBe(456);
        order.push("wait-main-pid");
      }),
      stageUpdate: vi.fn(async (_manifest, options) => {
        order.push("stage-update");
        options.onProgress?.({ phase: "downloading", version: "0.32.0", percent: 25 });
        return staged;
      }),
      writeStagedDescriptor: vi.fn(async (value) => {
        expect(value).toEqual(staged);
        return "/tmp/control/staged.json";
      }),
      launchApply: vi.fn(async (stagedPath, waitPid) => {
        order.push("spawn-node-apply");
        applyInvocation = { stagedPath, waitPid };
      }),
      publishProgress: (value) => progress.push(value),
      formatUpdateError: (error) => String(error),
      showNativeUpdateFailure: vi.fn(),
      launchInstalledApp: vi.fn(),
    });
    order.push("quit-updater");

    expect(order).toEqual([
      "window-ready",
      "wait-main-pid",
      "stage-update",
      "spawn-node-apply",
      "quit-updater",
    ]);
    expect(applyInvocation).toEqual({ stagedPath: "/tmp/control/staged.json", waitPid: 789 });
    expect(progress).toEqual([
      { phase: "downloading", version: "0.32.0", percent: 25 },
      {
        phase: "restarting",
        version: "0.32.0",
        message: "更新准备完成，正在重新启动…",
      },
    ]);
  });

  it("shows the native fallback and reopens the installed app when staging fails", async () => {
    const showNativeUpdateFailure = vi.fn();
    const launchInstalledApp = vi.fn();
    const launchApply = vi.fn();
    const progress: AppUpdateProgress[] = [];

    await expect(runDetachedUpdate({
      manifest: manifest(),
      manifestPath: "/tmp/control/update.json",
      mainProcessId: 456,
      updaterProcessId: 789,
      stableNodePath: "/usr/local/bin/node",
      applyUpdatePath: "/app/bin/apply-update.cjs",
      waitForProcessExit: vi.fn(async () => undefined),
      stageUpdate: vi.fn(async () => {
        throw new Error("npm staging failed");
      }),
      writeStagedDescriptor: vi.fn(),
      launchApply,
      publishProgress: (value) => progress.push(value),
      formatUpdateError: (error) => error instanceof Error ? error.message : String(error),
      showNativeUpdateFailure,
      launchInstalledApp,
      cleanupControlDirectory: vi.fn(async () => undefined),
    })).rejects.toThrow("npm staging failed");

    expect(launchApply).not.toHaveBeenCalled();
    expect(showNativeUpdateFailure).toHaveBeenCalledWith("npm staging failed");
    expect(launchInstalledApp).toHaveBeenCalledOnce();
    expect(progress.at(-1)).toEqual({
      phase: "error",
      version: "0.32.0",
      error: "npm staging failed",
    });
  });

  it("spawns the stable Node apply process with the updater pid", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await runDetachedUpdate({
      manifest: manifest(),
      manifestPath: "/tmp/control/update.json",
      mainProcessId: 456,
      updaterProcessId: 789,
      stableNodePath: "/usr/local/bin/node",
      applyUpdatePath: "/app/bin/apply-update.cjs",
      waitForProcessExit: vi.fn(async () => undefined),
      stageUpdate: vi.fn(async () => stagedUpdate()),
      writeStagedDescriptor: vi.fn(async () => "/tmp/control/staged.json"),
      publishProgress: vi.fn(),
      formatUpdateError: (error) => String(error),
      showNativeUpdateFailure: vi.fn(),
      launchInstalledApp: vi.fn(),
      environment: {
        EXISTING_VALUE: "kept",
        ELECTRON_RUN_AS_NODE: "1",
      },
      spawnProcess,
    });

    expect(invocation).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "/app/bin/apply-update.cjs",
        "--staged",
        "/tmp/control/staged.json",
        "--wait-pid",
        "789",
      ],
      options: {
        detached: true,
        stdio: "ignore",
        env: { EXISTING_VALUE: "kept" },
      },
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
