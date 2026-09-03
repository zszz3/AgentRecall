import type { IpcRenderer } from "electron";

import type {
  OpenVikingMemoryControl,
  OpenVikingMemoryChange,
  OpenVikingMemoryDetails,
  OpenVikingMemoryFeedbackKind,
} from "../core/openviking-memory-control";
import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
  OpenVikingModelStatus,
  OpenVikingRuntimeStatus,
  OpenVikingWorkspace,
} from "../core/openviking-memory";
import type { OpenVikingDirectoryPreview } from "../main/services/openviking-memory-service";
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
    searchOpenVikingMemories: (
      workspaceId: string,
      query: string,
      limit?: number,
    ): Promise<OpenVikingMemoryItem[]> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.search.channel, workspaceId, query, limit),
    readOpenVikingMemory: (workspaceId: string, uri: string): Promise<string> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.read.channel, workspaceId, uri),
    readOpenVikingCommitChanges: (
      workspaceId: string,
      memoryDiffUri: string,
    ): Promise<OpenVikingMemoryChange[]> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.readCommitChanges.channel, workspaceId, memoryDiffUri),
    getOpenVikingMemoryDetails: (
      workspaceId: string,
      uri: string,
    ): Promise<OpenVikingMemoryDetails> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.details.channel, workspaceId, uri),
    saveOpenVikingMemory: (
      workspaceId: string,
      input: SaveOpenVikingMemoryInput,
    ): Promise<OpenVikingMemoryItem> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.save.channel, workspaceId, input),
    sendOpenVikingMemoryFeedback: (
      workspaceId: string,
      uri: string,
      feedback: OpenVikingMemoryFeedbackKind,
      note?: string,
    ): Promise<OpenVikingMemoryControl> =>
      ipc.invoke(OPENVIKING_MEMORY_IPC.feedback.channel, workspaceId, uri, { feedback, note }),
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
