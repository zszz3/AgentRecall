import type { IpcRenderer } from "electron";
import { LEGACY_MEMORY_DATA_IPC, type LegacyMemoryDataStatus } from "../shared/ipc/legacy-memory-data";

export function createLegacyMemoryDataApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    getLegacyMemoryDataStatus: (): Promise<LegacyMemoryDataStatus> =>
      ipc.invoke(LEGACY_MEMORY_DATA_IPC.getStatus.channel),
    removeLegacyMemoryData: (): Promise<LegacyMemoryDataStatus> =>
      ipc.invoke(LEGACY_MEMORY_DATA_IPC.remove.channel),
  };
}
