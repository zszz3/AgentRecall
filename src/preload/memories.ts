import type { IpcRenderer } from "electron";
import type { RemoteMemory, MemoriesSyncSnapshot } from "../core/memories-sync";
import { MEMORIES_IPC } from "../shared/ipc/memories";

export type MemoriesIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createMemoriesApi(ipc: MemoriesIpcRenderer) {
  return {
    getMemoriesSyncSnapshot: (): Promise<MemoriesSyncSnapshot> => ipc.invoke(MEMORIES_IPC.getSyncSnapshot.channel),
    uploadMemoryToSync: (identity: string): Promise<RemoteMemory> => ipc.invoke(MEMORIES_IPC.upload.channel, identity),
    uploadAllMemoriesToSync: (): Promise<{ uploaded: number; skipped: number }> => ipc.invoke(MEMORIES_IPC.uploadAll.channel),
    deleteRemoteMemory: (remoteId: string): Promise<boolean> => ipc.invoke(MEMORIES_IPC.deleteRemote.channel, remoteId),
    copyMemoriesSyncSetupSql: (): Promise<void> => ipc.invoke(MEMORIES_IPC.copySetupSql.channel),
  };
}

export type MemoriesApi = ReturnType<typeof createMemoriesApi>;
