import type { IpcRenderer } from "electron";

import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
  OpenVikingModelStatus,
  OpenVikingRuntimeStatus,
  OpenVikingWorkspace,
} from "../core/openviking-memory";
import type { OpenVikingImportJob } from "../core/postgres/openviking-memory-repository";
import type {
  OpenVikingDirectoryPreview,
  OpenVikingImportSessionPreview,
} from "../main/services/openviking-memory-service";
import type { SaveOpenVikingMemoryInput } from "../main/services/openviking-client";
import { OPENVIKING_MEMORY_IPC } from "../shared/ipc/openviking-memory";

type OpenVikingMemoryIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createOpenVikingMemoryApi(ipc: OpenVikingMemoryIpcRenderer) {
  return {
    getOpenVikingMemorySnapshot: (): Promise<OpenVikingMemorySnapshot> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.snapshot.channel),
    getOpenVikingDiagnostics: (): Promise<OpenVikingDiagnosticsSnapshot> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.diagnostics.channel),
    chooseOpenVikingDirectory: (): Promise<OpenVikingDirectoryPreview | null> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.chooseDirectory.channel),
    previewOpenVikingDirectory: (rootPath: string): Promise<OpenVikingDirectoryPreview> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.previewDirectory.channel, rootPath),
    addOpenVikingWorkspace: (rootPath: string): Promise<OpenVikingWorkspace> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.addWorkspace.channel, rootPath),
    listOpenVikingImportSessions: (workspaceId: string): Promise<OpenVikingImportSessionPreview[]> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.listImportSessions.channel, workspaceId),
    importOpenVikingWorkspace: (
      workspaceId: string,
      selectedSessionKeys?: string[],
    ): Promise<OpenVikingImportJob> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.importWorkspace.channel, workspaceId, selectedSessionKeys),
    pauseOpenVikingImport: (workspaceId: string): Promise<OpenVikingImportJob> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.pauseImport.channel, workspaceId),
    resumeOpenVikingImport: (workspaceId: string): Promise<OpenVikingImportJob> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.resumeImport.channel, workspaceId),
    searchOpenVikingMemories: (
      workspaceId: string,
      query: string,
      limit?: number,
    ): Promise<OpenVikingMemoryItem[]> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.search.channel, workspaceId, query, limit),
    readOpenVikingMemory: (workspaceId: string, uri: string): Promise<string> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.read.channel, workspaceId, uri),
    saveOpenVikingMemory: (
      workspaceId: string,
      input: SaveOpenVikingMemoryInput,
    ): Promise<OpenVikingMemoryItem> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.save.channel, workspaceId, input),
    deleteOpenVikingMemory: (workspaceId: string, uri: string): Promise<void> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.deleteMemory.channel, workspaceId, uri),
    stopManagingOpenVikingWorkspace: (workspaceId: string): Promise<OpenVikingWorkspace> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.stopManaging.channel, workspaceId),
    deleteOpenVikingWorkspace: (workspaceId: string): Promise<void> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.deleteWorkspace.channel, workspaceId),
    installOpenVikingRuntime: (): Promise<OpenVikingRuntimeStatus> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.installRuntime.channel),
    startOpenVikingRuntime: (): Promise<OpenVikingRuntimeStatus> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.startRuntime.channel),
    restartOpenVikingRuntime: (): Promise<OpenVikingRuntimeStatus> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.restartRuntime.channel),
    stopOpenVikingRuntime: (): Promise<OpenVikingRuntimeStatus> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.stopRuntime.channel),
    installOpenVikingModel: (
      model: "BAAI/bge-small-zh-v1.5",
    ): Promise<OpenVikingModelStatus> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.installModel.channel, model),
  };
}

export type OpenVikingMemoryApi = ReturnType<typeof createOpenVikingMemoryApi>;
