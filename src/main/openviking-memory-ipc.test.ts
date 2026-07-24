import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { OpenVikingWorkspace } from "../core/openviking-memory";
import type { OpenVikingImportJob } from "../core/postgres/openviking-memory-repository";
import { createOpenVikingMemoryApi } from "../preload/openviking-memory";
import { OPENVIKING_MEMORY_IPC } from "../shared/ipc/openviking-memory";
import { IpcInputError } from "../shared/ipc/contract";
import {
  registerOpenVikingMemoryIpc,
  type OpenVikingMemoryIpcService,
} from "./ipc/openviking-memory";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function registrar() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipc = {
    handle(channel: string, listener: RegisteredHandler) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMainRegistrar;
  return { handlers, ipc };
}

function service(): OpenVikingMemoryIpcService & Record<keyof OpenVikingMemoryIpcService, ReturnType<typeof vi.fn>> {
  const workspace: OpenVikingWorkspace = {
    id: "workspace-1",
    userId: "workspace_user",
    rootPath: "/repo",
    identity: "path:1",
    displayName: "repo",
    managed: true,
    importState: "completed",
    importedTurns: 1,
    totalTurns: 1,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  const completedJob: OpenVikingImportJob = {
    workspaceId: workspace.id,
    state: "completed",
    importedTurns: 1,
    totalTurns: 1,
    cursorSessionKey: null,
    lastError: null,
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  return {
    snapshot: vi.fn(async () => ({
      runtime: { state: "not-installed" as const },
      model: { installed: false, model: "BAAI/bge-small-zh-v1.5" as const },
      workspaces: [],
    })),
    chooseDirectory: vi.fn(async () => null),
    previewDirectory: vi.fn(async (rootPath: string) => ({
      rootPath,
      displayName: "app",
      identity: "path:1",
      sessionCount: 0,
      existingWorkspaceId: null,
      relinkWorkspaceId: null,
    })),
    addWorkspace: vi.fn(async () => workspace),
    importWorkspace: vi.fn(async () => completedJob),
    pauseImport: vi.fn(async () => ({ ...completedJob, state: "paused" as const })),
    resumeImport: vi.fn(async () => completedJob),
    search: vi.fn(async () => []),
    read: vi.fn(async () => "content"),
    save: vi.fn(async () => ({
      id: "memory-1",
      workspaceId: workspace.id,
      title: "Note",
      content: "content",
    })),
    deleteMemory: vi.fn(async () => undefined),
    stopManaging: vi.fn(async () => ({ ...workspace, managed: false })),
    deleteWorkspace: vi.fn(async () => undefined),
    installRuntime: vi.fn(async () => ({ state: "stopped" as const })),
    startRuntime: vi.fn(async () => ({ state: "running" as const })),
    stopRuntime: vi.fn(async () => ({ state: "stopped" as const })),
    installModel: vi.fn(async () => ({
      installed: true,
      model: "BAAI/bge-small-zh-v1.5" as const,
    })),
  };
}

describe("OpenViking memory IPC", () => {
  it("registers every validated operation and delegates once", async () => {
    const { handlers, ipc } = registrar();
    const target = service();
    registerOpenVikingMemoryIpc(ipc, target);
    const event = {} as IpcMainInvokeEvent;

    await handlers.get(OPENVIKING_MEMORY_IPC.snapshot.channel)?.(event);
    await handlers.get(OPENVIKING_MEMORY_IPC.chooseDirectory.channel)?.(event);
    await handlers.get(OPENVIKING_MEMORY_IPC.previewDirectory.channel)?.(event, " /repo ");
    await handlers.get(OPENVIKING_MEMORY_IPC.addWorkspace.channel)?.(event, "/repo");
    await handlers.get(OPENVIKING_MEMORY_IPC.importWorkspace.channel)?.(event, "workspace-1");
    await handlers.get(OPENVIKING_MEMORY_IPC.pauseImport.channel)?.(event, "workspace-1");
    await handlers.get(OPENVIKING_MEMORY_IPC.resumeImport.channel)?.(event, "workspace-1");
    await handlers.get(OPENVIKING_MEMORY_IPC.search.channel)?.(event, "workspace-1", "", 200);
    await handlers.get(OPENVIKING_MEMORY_IPC.read.channel)?.(
      event,
      "workspace-1",
      "viking://user/memories/one.md",
    );
    await handlers.get(OPENVIKING_MEMORY_IPC.save.channel)?.(event, "workspace-1", {
      id: "manual-1",
      title: " Note ",
      content: "content",
    });
    await handlers.get(OPENVIKING_MEMORY_IPC.deleteMemory.channel)?.(
      event,
      "workspace-1",
      "viking://user/memories/one.md",
    );
    await handlers.get(OPENVIKING_MEMORY_IPC.stopManaging.channel)?.(event, "workspace-1");
    await handlers.get(OPENVIKING_MEMORY_IPC.deleteWorkspace.channel)?.(event, "workspace-1");
    await handlers.get(OPENVIKING_MEMORY_IPC.installRuntime.channel)?.(event);
    await handlers.get(OPENVIKING_MEMORY_IPC.startRuntime.channel)?.(event);
    await handlers.get(OPENVIKING_MEMORY_IPC.stopRuntime.channel)?.(event);
    await handlers.get(OPENVIKING_MEMORY_IPC.installModel.channel)?.(
      event,
      "BAAI/bge-small-zh-v1.5",
    );

    expect(target.previewDirectory).toHaveBeenCalledWith("/repo");
    expect(target.search).toHaveBeenCalledWith("workspace-1", "", 200);
    expect(target.save).toHaveBeenCalledWith("workspace-1", {
      id: "manual-1",
      title: "Note",
      content: "content",
    });
    for (const operation of Object.values(target)) expect(operation).toHaveBeenCalledOnce();
  });

  it("rejects unsafe paths, oversized queries and out-of-scope memory URIs", () => {
    const { handlers, ipc } = registrar();
    const target = service();
    registerOpenVikingMemoryIpc(ipc, target);
    const event = {} as IpcMainInvokeEvent;

    expect(() => handlers.get(OPENVIKING_MEMORY_IPC.previewDirectory.channel)?.(event, "/repo\0secret"))
      .toThrow(IpcInputError);
    expect(() => handlers.get(OPENVIKING_MEMORY_IPC.search.channel)?.(
      event,
      "workspace-1",
      "x".repeat(2_001),
    )).toThrow(IpcInputError);
    expect(() => handlers.get(OPENVIKING_MEMORY_IPC.deleteMemory.channel)?.(
      event,
      "workspace-1",
      "viking://resources/not-memory",
    )).toThrow(IpcInputError);
    expect(() => handlers.get(OPENVIKING_MEMORY_IPC.deleteWorkspace.channel)?.(
      event,
      "../../workspace",
    )).toThrow(IpcInputError);
    expect(target.previewDirectory).not.toHaveBeenCalled();
    expect(target.search).not.toHaveBeenCalled();
    expect(target.deleteMemory).not.toHaveBeenCalled();
    expect(target.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("uses the same channels from preload", async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => undefined);
    const api = createOpenVikingMemoryApi({ invoke });

    await api.getOpenVikingMemorySnapshot();
    await api.chooseOpenVikingDirectory();
    await api.previewOpenVikingDirectory("/repo");
    await api.addOpenVikingWorkspace("/repo");
    await api.importOpenVikingWorkspace("workspace-1");
    await api.pauseOpenVikingImport("workspace-1");
    await api.resumeOpenVikingImport("workspace-1");
    await api.searchOpenVikingMemories("workspace-1", "query", 10);
    await api.readOpenVikingMemory("workspace-1", "viking://user/memories/one.md");
    await api.saveOpenVikingMemory("workspace-1", { title: "Note", content: "content" });
    await api.deleteOpenVikingMemory("workspace-1", "viking://user/memories/one.md");
    await api.stopManagingOpenVikingWorkspace("workspace-1");
    await api.deleteOpenVikingWorkspace("workspace-1");
    await api.installOpenVikingRuntime();
    await api.startOpenVikingRuntime();
    await api.stopOpenVikingRuntime();
    await api.installOpenVikingModel("BAAI/bge-small-zh-v1.5");

    expect(invoke.mock.calls.map((call) => call[0])).toEqual(
      Object.values(OPENVIKING_MEMORY_IPC).map((contract) => contract.channel),
    );
  });
});
