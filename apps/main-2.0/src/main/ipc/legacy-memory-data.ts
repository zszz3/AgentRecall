import { LEGACY_MEMORY_DATA_IPC, type LegacyMemoryDataStatus } from "../../shared/ipc/legacy-memory-data";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface LegacyMemoryDataIpcService {
  status(): Promise<LegacyMemoryDataStatus>;
  remove(): Promise<LegacyMemoryDataStatus>;
}

export function registerLegacyMemoryDataIpc(
  ipc: IpcMainRegistrar,
  service: LegacyMemoryDataIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, LEGACY_MEMORY_DATA_IPC.getStatus, () => service.status()),
    registerIpcHandler(ipc, LEGACY_MEMORY_DATA_IPC.remove, () => service.remove()),
  ]);
}
