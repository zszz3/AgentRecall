import type { UsageQuotaSnapshot } from "../../core/types";
import { QUOTA_IPC } from "../../shared/ipc/quota";
import { registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface QuotaIpcService {
  getSnapshot(force: boolean): Promise<UsageQuotaSnapshot>;
}

export function registerQuotaIpc(ipc: IpcMainRegistrar, service: QuotaIpcService): () => void {
  return registerIpcHandler(ipc, QUOTA_IPC.get, (_event, force) => service.getSnapshot(force));
}
