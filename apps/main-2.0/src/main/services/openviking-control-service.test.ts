import { describe, expect, it, vi } from "vitest";

import type { OpenVikingRuntimeStatus, OpenVikingWorkspace } from "../../core/openviking-memory";
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
  const workspaces: OpenVikingWorkspace[] = [{
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
    getStatus: vi.fn(async (): Promise<OpenVikingRuntimeStatus> => ({ state: "not-installed" })),
    getDiagnostics: vi.fn(async () => ({
      status: { state: "stopped" as const, version: "0.4.11" },
      health: "not-running" as const,
      events: [],
    })),
    install: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
    start: vi.fn(async () => ({ state: "running" as const, version: "0.4.11", port: 21933 })),
    startFromPersistedConfig: vi.fn(async () => ({
      state: "running" as const,
      version: "0.4.11",
      port: 21933,
    })),
    stop: vi.fn(async () => ({ state: "stopped" as const, version: "0.4.11" })),
    clearData: vi.fn(async () => undefined),
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
    waitForImportToSettle: vi.fn(async () => undefined),
    resumeImport: vi.fn(),
    searchMemories: vi.fn(async () => []),
    readMemory: vi.fn(async () => ""),
    saveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    stopManaging: vi.fn(),
    deleteWorkspace: vi.fn(),
    listImportTaskDiagnostics: vi.fn(async () => []),
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
  return { service, runtime, model, memory, onStateChanged, workspaces };
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

  it("returns one sanitized diagnostics snapshot without starting a stopped runtime", async () => {
    const { service, runtime, memory } = harness();

    await expect(service.diagnostics()).resolves.toMatchObject({
      runtime: { health: "not-running", status: { state: "stopped" } },
      model: { installed: true },
      workspaces: [{ id: "workspace-1" }],
      tasks: [],
    });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(memory.listImportTaskDiagnostics).toHaveBeenCalledWith(false);
  });

  it("restarts the runtime through one serialized stop and start lifecycle", async () => {
    const { service, runtime } = harness();

    await service.restartRuntime();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.stop.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.start.mock.invocationCallOrder[0]);
  });

  it("previews the chosen directory and waits for session selection after adding it", async () => {
    const { service, memory } = harness();

    await expect(service.chooseDirectory()).resolves.toMatchObject({ rootPath: "/repo", sessionCount: 2 });
    await expect(service.addWorkspace("/repo")).resolves.toMatchObject({ id: "workspace-1" });
    expect(memory.addWorkspace).toHaveBeenCalledWith("/repo");
    expect(memory.importWorkspace).not.toHaveBeenCalled();
  });

  it("returns the workspace without starting historical import before session selection", async () => {
    const { service, memory } = harness();

    const outcome = await Promise.race([
      service.addWorkspace("/repo").then(() => "returned"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 10)),
    ]);

    expect(outcome).toBe("returned");
    expect(memory.importWorkspace).not.toHaveBeenCalled();
  });

  it("checks managed workspaces for incremental updates without resuming paused imports", async () => {
    const { service, memory } = harness();
    const base = (await memory.listWorkspaces())[0];
    vi.mocked(memory.listWorkspaces).mockResolvedValue([
      { ...base, id: "completed", importState: "completed" },
      { ...base, id: "paused", importState: "paused" },
      { ...base, id: "stopped", managed: false },
    ]);

    await service.syncManagedWorkspaces();

    expect(memory.importWorkspace).toHaveBeenCalledOnce();
    expect(memory.importWorkspace).toHaveBeenCalledWith("completed");
  });

  it("restores paused memory access when every managed workspace is paused", async () => {
    const { service, memory } = harness();
    const paused = { ...(await memory.listWorkspaces())[0], importState: "paused" as const };
    vi.mocked(memory.listWorkspaces).mockResolvedValue([paused]);

    await service.syncManagedWorkspaces();

    await expect(service.search("workspace-1", "query")).rejects.toThrow("paused");
    expect(memory.importWorkspace).not.toHaveBeenCalled();
  });

  it("pauses one workspace without interrupting another active workspace", async () => {
    const { service, runtime, memory, workspaces } = harness();
    const pausedJob = {
      workspaceId: "workspace-1",
      state: "paused" as const,
      importedTurns: 30,
      totalTurns: 100,
      cursorSessionKey: "session-1",
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const queuedJob = { ...pausedJob, state: "queued" as const };
    const pauseImport = vi.mocked(memory.pauseImport);
    const resumeImport = vi.mocked(memory.resumeImport);
    pauseImport.mockResolvedValue(pausedJob);
    resumeImport.mockResolvedValue(queuedJob);
    workspaces.push({
      ...workspaces[0],
      id: "workspace-2",
      userId: "workspace_efgh",
      rootPath: "/repo-2",
      identity: "path:two",
      displayName: "repo-2",
      importState: "running",
    });
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });

    await expect(service.pauseImport("workspace-1")).resolves.toEqual(pausedJob);
    expect(memory.pauseImport).toHaveBeenCalledWith("workspace-1");
    expect(memory.waitForImportToSettle).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).not.toHaveBeenCalled();
    await expect(service.search("workspace-2", "query")).resolves.toEqual([]);

    await expect(service.resumeImport("workspace-1")).resolves.toEqual(queuedJob);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(memory.resumeImport).toHaveBeenCalledWith("workspace-1");
  });

  it("temporarily starts OpenViking to delete a paused workspace and stops it again", async () => {
    const { service, runtime, memory } = harness();
    vi.mocked(memory.pauseImport).mockResolvedValue({
      workspaceId: "workspace-1",
      state: "paused",
      importedTurns: 0,
      totalTurns: 100,
      cursorSessionKey: "session-1",
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    await service.pauseImport("workspace-1");
    vi.mocked(runtime.start).mockClear();
    vi.mocked(runtime.stop).mockClear();
    vi.mocked(memory.listWorkspaces).mockResolvedValue([]);

    await service.deleteWorkspace("workspace-1");

    expect(runtime.startFromPersistedConfig).toHaveBeenCalledOnce();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.startFromPersistedConfig.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(memory.deleteWorkspace).mock.invocationCallOrder[0]);
    expect(vi.mocked(memory.deleteWorkspace).mock.invocationCallOrder[0])
      .toBeLessThan(runtime.stop.mock.invocationCallOrder[0]);
  });

  it("deletes a workspace with its persisted runtime config when the current Provider is incomplete", async () => {
    const { service, runtime, memory } = harness();
    vi.mocked(memory.listWorkspaces).mockResolvedValue([]);
    vi.mocked(runtime.getStatus).mockResolvedValue({ state: "stopped", version: "0.4.11" });

    await service.deleteWorkspace("workspace-1");

    expect(runtime.startFromPersistedConfig).toHaveBeenCalledOnce();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("stops an already-running OpenViking backend after deleting the last workspace", async () => {
    const { service, runtime, memory } = harness();
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });
    vi.mocked(memory.listWorkspaces).mockResolvedValue([]);

    await service.deleteWorkspace("workspace-1");

    expect(runtime.start).not.toHaveBeenCalled();
    expect(memory.pauseImport).toHaveBeenCalledWith("workspace-1");
    expect(memory.waitForImportToSettle).toHaveBeenCalledWith("workspace-1");
    expect(runtime.startFromPersistedConfig).toHaveBeenCalledOnce();
    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(runtime.clearData).toHaveBeenCalledOnce();
    expect(runtime.stop.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(memory.waitForImportToSettle).mock.invocationCallOrder[0]);
    expect(vi.mocked(memory.waitForImportToSettle).mock.invocationCallOrder[0])
      .toBeLessThan(runtime.startFromPersistedConfig.mock.invocationCallOrder[0]);
    expect(runtime.startFromPersistedConfig.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(memory.deleteWorkspace).mock.invocationCallOrder[0]);
    expect(runtime.stop.mock.invocationCallOrder[1])
      .toBeLessThan(runtime.clearData.mock.invocationCallOrder[0]);
  });

  it("preserves shared OpenViking data after deleting one of multiple workspaces", async () => {
    const { service, runtime, memory } = harness();
    const remaining = {
      ...(await memory.listWorkspaces())[0],
      id: "workspace-2",
      managed: false,
      importState: "paused" as const,
    };
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });
    vi.mocked(memory.listWorkspaces).mockResolvedValue([remaining]);

    await service.deleteWorkspace("workspace-1");

    expect(memory.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.startFromPersistedConfig).not.toHaveBeenCalled();
    expect(runtime.clearData).not.toHaveBeenCalled();
    await expect(service.search("workspace-2", "query")).resolves.toEqual([]);
  });

  it("waits for an in-flight memory read before stopping OpenViking", async () => {
    const { service, runtime, memory } = harness();
    let finishSearch: (items: never[]) => void = () => undefined;
    const searchPending = new Promise<never[]>((resolve) => {
      finishSearch = resolve;
    });
    vi.mocked(memory.searchMemories).mockImplementation(async () => searchPending);
    vi.mocked(memory.pauseImport).mockResolvedValue({
      workspaceId: "workspace-1",
      state: "paused",
      importedTurns: 30,
      totalTurns: 100,
      cursorSessionKey: "session-1",
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    const searching = service.search("workspace-1", "", 200);
    await vi.waitFor(() => expect(memory.searchMemories).toHaveBeenCalledOnce());
    const pausing = service.pauseImport("workspace-1");
    await vi.waitFor(() => expect(memory.pauseImport).toHaveBeenCalledOnce());

    expect(runtime.stop).not.toHaveBeenCalled();
    finishSearch([]);
    await searching;
    await pausing;
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight memory read before deleting a workspace", async () => {
    const { service, runtime, memory } = harness();
    let finishSearch: (items: never[]) => void = () => undefined;
    const searchPending = new Promise<never[]>((resolve) => {
      finishSearch = resolve;
    });
    vi.mocked(memory.searchMemories).mockImplementation(async () => searchPending);
    vi.mocked(runtime.getStatus).mockResolvedValue({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });
    vi.mocked(memory.listWorkspaces).mockResolvedValue([]);

    const searching = service.search("workspace-1", "", 200);
    await vi.waitFor(() => expect(memory.searchMemories).toHaveBeenCalledOnce());
    const deleting = service.deleteWorkspace("workspace-1");
    await vi.waitFor(() => expect(memory.pauseImport).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    try {
      expect(runtime.stop).not.toHaveBeenCalled();
    } finally {
      finishSearch([]);
      await searching;
      await deleting;
    }
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it("blocks only the workspace being deleted and restores other access after cleanup fails", async () => {
    const { service, runtime, memory, workspaces } = harness();
    let finishPause: (job: Awaited<ReturnType<OpenVikingMemoryService["pauseImport"]>>) => void =
      () => undefined;
    const pausePending = new Promise<Awaited<ReturnType<OpenVikingMemoryService["pauseImport"]>>>(
      (resolve) => {
        finishPause = resolve;
      },
    );
    vi.mocked(memory.pauseImport).mockImplementation(async () => pausePending);
    const remaining = {
      ...workspaces[0],
      id: "workspace-2",
      userId: "workspace_efgh",
      rootPath: "/repo-2",
      identity: "path:two",
      displayName: "repo-2",
      importState: "paused" as const,
    };
    vi.mocked(memory.listWorkspaces).mockResolvedValue([remaining]);
    vi.mocked(runtime.startFromPersistedConfig).mockRejectedValue(new Error("broken persisted config"));

    const deleting = service.deleteWorkspace("workspace-1");
    await vi.waitFor(() => expect(memory.pauseImport).toHaveBeenCalledOnce());

    await expect(service.search("workspace-1", "", 200)).rejects.toThrow("paused");
    await expect(service.search("workspace-2", "", 200)).resolves.toEqual([]);
    finishPause({
      workspaceId: "workspace-1",
      state: "paused",
      importedTurns: 0,
      totalTurns: 0,
      cursorSessionKey: null,
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await expect(deleting).rejects.toThrow("broken persisted config");
    await expect(service.search("workspace-2", "", 200)).resolves.toEqual([]);
    expect(memory.searchMemories).toHaveBeenCalledTimes(2);
  });

  it("does not start a new memory read after pausing begins", async () => {
    const { service, memory } = harness();
    let finishPause: (job: Awaited<ReturnType<OpenVikingMemoryService["pauseImport"]>>) => void =
      () => undefined;
    const pausePending = new Promise<Awaited<ReturnType<OpenVikingMemoryService["pauseImport"]>>>(
      (resolve) => {
        finishPause = resolve;
      },
    );
    vi.mocked(memory.pauseImport).mockImplementation(async () => pausePending);

    const pausing = service.pauseImport("workspace-1");
    await vi.waitFor(() => expect(memory.pauseImport).toHaveBeenCalledOnce());

    await expect(service.search("workspace-1", "", 200)).rejects.toThrow("paused");
    expect(memory.searchMemories).not.toHaveBeenCalled();
    finishPause({
      workspaceId: "workspace-1",
      state: "paused",
      importedTurns: 30,
      totalTurns: 100,
      cursorSessionKey: "session-1",
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await pausing;
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
    const { service, memory, onStateChanged, workspaces } = harness();
    vi.mocked(memory.stopManaging).mockResolvedValue({ id: "workspace-1" } as never);
    workspaces[0].importState = "running";
    vi.mocked(memory.pauseImport).mockResolvedValue({
      workspaceId: "workspace-1",
      state: "paused",
      importedTurns: 1,
      totalTurns: 2,
      cursorSessionKey: "session-1",
      lastError: null,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    await service.addWorkspace("/repo");
    await service.startRuntime();
    await service.stopManaging("workspace-1");
    await expect(service.search("workspace-1", "query")).resolves.toEqual([]);
    await service.stopRuntime();

    expect(memory.pauseImport).toHaveBeenCalledWith("workspace-1");
    expect(memory.waitForImportToSettle).toHaveBeenCalledWith("workspace-1");
    expect(vi.mocked(memory.waitForImportToSettle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(memory.stopManaging).mock.invocationCallOrder[0]);
    expect(onStateChanged).toHaveBeenCalledTimes(4);
  });
});
