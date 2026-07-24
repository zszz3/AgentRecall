import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../core/platform";
import type { OpenVikingMemoryService } from "./openviking-memory-service";
import type { OpenVikingRuntimeManifest } from "./openviking-runtime-service";
import { OpenVikingControlService } from "./openviking-control-service";

const runtimeManifest: OpenVikingRuntimeManifest = {
  version: "0.4.11",
  platform: "darwin",
  arch: "arm64",
  url: "https://downloads.example/runtime.tar.gz",
  sha256: "a".repeat(64),
  executablePath: "bin/openviking-server",
  archiveType: "tar.gz",
};

function harness(
  enabled = true,
  manifest: OpenVikingRuntimeManifest | null = runtimeManifest,
  resolveRuntimeManifest: (...args: unknown[]) => Promise<OpenVikingRuntimeManifest | null> = async () => manifest,
) {
  const onStateChanged = vi.fn(async () => undefined);
  const workspaces = [{
    id: "workspace-1",
    userId: "workspace_abcd",
    rootPath: "/repo",
    identity: "path:one",
    displayName: "repo",
    managed: true,
    importState: "idle" as const,
    importedTurns: 0,
    totalTurns: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];
  const runtime = {
    getStatus: vi.fn(async () => ({ state: "not-installed" as const })),
    install: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
    start: vi.fn(async () => ({ state: "running" as const, version: "0.4.11", port: 21933 })),
    stop: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
  };
  const model = {
    getStatus: vi.fn(async () => ({
      model: "BAAI/bge-small-zh-v1.5" as const,
      installed: true,
    })),
    install: vi.fn(async () => ({
      model: "BAAI/bge-small-zh-v1.5" as const,
      installed: true,
    })),
  };
  const memory = {
    listWorkspaces: vi.fn(async () => workspaces),
    previewDirectory: vi.fn(async (rootPath: string) => ({
      rootPath,
      displayName: "repo",
      identity: "path:one",
      sessionCount: 2,
      existingWorkspaceId: null,
      relinkWorkspaceId: null,
    })),
    addWorkspace: vi.fn(async () => workspaces[0]),
    importWorkspace: vi.fn(async () => ({
      workspaceId: "workspace-1",
      state: "completed" as const,
      importedTurns: 2,
      totalTurns: 2,
      cursorSessionKey: null,
      lastError: null,
      updatedAt: "2026-07-24T00:00:00.000Z",
    })),
    pauseImport: vi.fn(),
    resumeImport: vi.fn(),
    searchMemories: vi.fn(async () => []),
    readMemory: vi.fn(async () => ""),
    saveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    stopManaging: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as OpenVikingMemoryService;
  const service = new OpenVikingControlService({
    runtime,
    model,
    memory,
    getSettings: () => ({
      ...defaultSettings,
      openVikingMemoryEnabled: enabled,
    }),
    chooseDirectory: async () => "/repo",
    resolveRuntimeManifest,
    serverConfig: async () => ({
      embedding: {
        dense: {
          provider: "local",
          model: "bge-small-zh-v1.5-f16",
          dimension: 512,
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
        },
      },
      vlm: {
        provider: "openai-codex",
        model: "gpt-5.4",
        api_base: "https://chatgpt.com/backend-api/codex",
      },
    }),
    onStateChanged,
  });
  return { service, runtime, model, memory, onStateChanged };
}

describe("OpenVikingControlService", () => {
  it("exposes status while disabled but blocks data access", async () => {
    const { service, memory } = harness(false);

    await expect(service.snapshot()).resolves.toMatchObject({
      runtime: { state: "not-installed" },
      model: { installed: true },
      workspaces: expect.any(Array),
    });
    await expect(service.chooseDirectory()).rejects.toThrow("disabled");
    await expect(service.search("workspace-1", "query")).rejects.toThrow("disabled");
    expect(memory.previewDirectory).not.toHaveBeenCalled();
  });

  it("installs the selected platform artifact and starts with the managed model config", async () => {
    const { service, runtime, model } = harness();

    await service.installRuntime();
    await service.installModel("BAAI/bge-small-zh-v1.5");
    await service.startRuntime();

    expect(runtime.install).toHaveBeenCalledWith(runtimeManifest, expect.any(Function));
    expect(model.install).toHaveBeenCalledWith("BAAI/bge-small-zh-v1.5");
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      embedding: {
        dense: expect.objectContaining({
          model: "bge-small-zh-v1.5-f16",
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
          dimension: 512,
        }),
      },
    }));
  });

  it("previews the chosen directory and starts historical import after adding it", async () => {
    const { service, memory } = harness();

    await expect(service.chooseDirectory()).resolves.toMatchObject({ rootPath: "/repo", sessionCount: 2 });
    await expect(service.addWorkspace("/repo")).resolves.toMatchObject({ id: "workspace-1" });
    expect(memory.addWorkspace).toHaveBeenCalledWith("/repo");
    expect(memory.importWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("returns the workspace while historical import continues in the background", async () => {
    const { service, memory } = harness();
    vi.mocked(memory.importWorkspace).mockImplementation(() => new Promise(() => undefined));

    const outcome = await Promise.race([
      service.addWorkspace("/repo").then(() => "returned"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 10)),
    ]);

    expect(outcome).toBe("returned");
    expect(memory.importWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("reports builds that do not publish a matching runtime artifact", async () => {
    const { service: unavailable } = harness(true, null);

    await expect(unavailable.installRuntime()).rejects.toThrow("not available for this build");
  });

  it("exposes runtime preparation progress through snapshots while installation is pending", async () => {
    let finishResolution: () => void = () => undefined;
    const resolutionGate = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveRuntimeManifest = vi.fn(async (...args: unknown[]) => {
      const report = args[0] as undefined | ((progress: {
        phase: string;
        downloadedBytes?: number;
        totalBytes?: number;
      }) => void);
      report?.({
        phase: "downloading-python",
        downloadedBytes: 50,
        totalBytes: 100,
      });
      await resolutionGate;
      return runtimeManifest;
    });
    const { service } = harness(true, runtimeManifest, resolveRuntimeManifest);
    const installation = service.installRuntime();

    try {
      await expect(service.snapshot()).resolves.toMatchObject({
        runtime: {
          state: "installing",
          progress: {
            phase: "downloading-python",
            downloadedBytes: 50,
            totalBytes: 100,
          },
        },
      });
    } finally {
      finishResolution();
      await installation;
    }
  });

  it("coalesces concurrent runtime install requests into one operation", async () => {
    let finishResolution: () => void = () => undefined;
    const resolutionGate = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveRuntimeManifest = vi.fn(async () => {
      await resolutionGate;
      return runtimeManifest;
    });
    const { service, runtime } = harness(true, runtimeManifest, resolveRuntimeManifest);
    const first = service.installRuntime();
    const second = service.installRuntime();

    finishResolution();
    await Promise.all([first, second]);

    expect(resolveRuntimeManifest).toHaveBeenCalledOnce();
    expect(runtime.install).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent runtime start requests into one operation", async () => {
    let finishStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const { service, runtime } = harness();
    vi.mocked(runtime.start).mockImplementation(async () => {
      await startGate;
      return { state: "running", version: "0.4.11", port: 21933 };
    });

    const first = service.startRuntime();
    const second = service.startRuntime();
    finishStart();
    await Promise.all([first, second]);

    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it("refreshes external hook state after workspace and runtime lifecycle changes", async () => {
    const { service, memory, onStateChanged } = harness();
    vi.mocked(memory.stopManaging).mockResolvedValue({ id: "workspace-1" } as never);

    await service.addWorkspace("/repo");
    await service.startRuntime();
    await service.stopManaging("workspace-1");
    await service.stopRuntime();

    expect(onStateChanged).toHaveBeenCalledTimes(4);
  });
});
