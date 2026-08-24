import { describe, expect, it, vi } from "vitest";
import {
  bootstrapOpenVikingRuntime,
  type OpenVikingRuntimeBootstrapDependencies,
} from "./openviking-runtime-bootstrap";
import type { OpenVikingMemorySnapshot } from "../../core/openviking-memory";

describe("bootstrapOpenVikingRuntime", () => {
  it("installs the runtime a released revision bump left behind, then starts it", async () => {
    const dependencies = createDependencies({
      runtimeState: "not-installed",
      modelInstalled: true,
    });

    await expect(bootstrapOpenVikingRuntime(dependencies)).resolves.toEqual({
      status: "started",
      installedRuntime: true,
      installedModel: false,
    });
    expect(dependencies.installRuntime).toHaveBeenCalledTimes(1);
    expect(dependencies.installModel).not.toHaveBeenCalled();
    expect(dependencies.startRuntime).toHaveBeenCalledTimes(1);
  });

  it("downloads the missing embedding model before starting", async () => {
    const dependencies = createDependencies({ runtimeState: "stopped", modelInstalled: false });

    await expect(bootstrapOpenVikingRuntime(dependencies)).resolves.toEqual({
      status: "started",
      installedRuntime: false,
      installedModel: true,
    });
    expect(dependencies.installRuntime).not.toHaveBeenCalled();
    expect(dependencies.installModel).toHaveBeenCalledTimes(1);
  });

  it("reports the failing stage instead of leaving memory silently disabled", async () => {
    const dependencies = createDependencies({ runtimeState: "not-installed", modelInstalled: true });
    dependencies.installRuntime = vi.fn().mockRejectedValue(new Error("Download interrupted."));

    await expect(bootstrapOpenVikingRuntime(dependencies)).resolves.toEqual({
      status: "failed",
      stage: "install-runtime",
      message: "Download interrupted.",
    });
    expect(dependencies.startRuntime).not.toHaveBeenCalled();
    expect(dependencies.logError).toHaveBeenCalledWith(
      "OpenViking runtime bootstrap failed while it ran install-runtime: Download interrupted.",
    );
  });

  it("never duplicates an in-flight install or start", async () => {
    for (const runtimeState of ["installing", "starting"] as const) {
      const dependencies = createDependencies({ runtimeState, modelInstalled: true });
      await expect(bootstrapOpenVikingRuntime(dependencies)).resolves.toEqual({
        status: "skipped",
        reason: "runtime-busy",
      });
      expect(dependencies.installRuntime).not.toHaveBeenCalled();
      expect(dependencies.startRuntime).not.toHaveBeenCalled();
    }
  });

  it("stays out of the way when memory is off, unmanaged, or already running", async () => {
    const disabled = createDependencies({ runtimeState: "not-installed", modelInstalled: true });
    disabled.memoryEnabled = false;
    await expect(bootstrapOpenVikingRuntime(disabled)).resolves.toEqual({
      status: "skipped",
      reason: "memory-disabled",
    });
    expect(disabled.snapshot).not.toHaveBeenCalled();

    const unmanaged = createDependencies({ runtimeState: "stopped", modelInstalled: true, managed: false });
    await expect(bootstrapOpenVikingRuntime(unmanaged)).resolves.toEqual({
      status: "skipped",
      reason: "no-managed-workspace",
    });

    const running = createDependencies({ runtimeState: "running", modelInstalled: true });
    await expect(bootstrapOpenVikingRuntime(running)).resolves.toEqual({ status: "already-running" });
    expect(running.startRuntime).not.toHaveBeenCalled();
  });
});

function createDependencies(options: {
  runtimeState: OpenVikingMemorySnapshot["runtime"]["state"];
  modelInstalled: boolean;
  managed?: boolean;
}): OpenVikingRuntimeBootstrapDependencies & {
  snapshot: ReturnType<typeof vi.fn>;
  installRuntime: ReturnType<typeof vi.fn>;
  installModel: ReturnType<typeof vi.fn>;
  startRuntime: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const snapshot: OpenVikingMemorySnapshot = {
    runtime: { state: options.runtimeState },
    model: { model: "BAAI/bge-small-zh-v1.5", installed: options.modelInstalled },
    workspaces: [{
      id: "workspace-1",
      userId: "workspace_1",
      rootPath: "/tmp/project",
      identity: "directory:workspace-1",
      displayName: "project",
      managed: options.managed ?? true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  };
  return {
    memoryEnabled: true,
    snapshot: vi.fn().mockResolvedValue(snapshot),
    installRuntime: vi.fn().mockResolvedValue({ state: "stopped" }),
    installModel: vi.fn().mockResolvedValue({ model: "BAAI/bge-small-zh-v1.5", installed: true }),
    startRuntime: vi.fn().mockResolvedValue({ state: "running" }),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };
}
