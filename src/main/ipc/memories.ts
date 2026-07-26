import type { AgentMemory, RemoteMemory, MemoriesSyncSnapshot } from "../../core/memories-sync";
import { MEMORIES_IPC } from "../../shared/ipc/memories";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface MemoriesIpcService {
  getSyncSnapshot(): Promise<MemoriesSyncSnapshot>;
  upload(identity: string): Promise<RemoteMemory>;
  uploadAll(): Promise<{ uploaded: number; skipped: number }>;
  deleteRemote(remoteId: string): Promise<boolean>;
  copySetupSql(): void;
}

export function registerMemoriesIpc(ipc: IpcMainRegistrar, service: MemoriesIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, MEMORIES_IPC.getSyncSnapshot, () => service.getSyncSnapshot()),
    registerIpcHandler(ipc, MEMORIES_IPC.upload, (_event, identity) => service.upload(identity)),
    registerIpcHandler(ipc, MEMORIES_IPC.uploadAll, () => service.uploadAll()),
    registerIpcHandler(ipc, MEMORIES_IPC.deleteRemote, (_event, id) => service.deleteRemote(id)),
    registerIpcHandler(ipc, MEMORIES_IPC.copySetupSql, () => service.copySetupSql()),
  ]);
}
