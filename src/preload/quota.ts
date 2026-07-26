import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { UsageQuotaSnapshot } from "../core/types";
import { QUOTA_EVENTS, QUOTA_IPC } from "../shared/ipc/quota";

export type QuotaIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createQuotaApi(ipc: QuotaIpcRenderer) {
  return {
    getQuotas: (force = false): Promise<UsageQuotaSnapshot> =>
      ipc.invoke(QUOTA_IPC.get.channel, force),
    onQuotaUpdated: (callback: (snapshot: UsageQuotaSnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: UsageQuotaSnapshot) => callback(snapshot);
      ipc.on(QUOTA_EVENTS.updated, listener);
      return () => ipc.removeListener(QUOTA_EVENTS.updated, listener);
    },
  };
}

export type QuotaApi = ReturnType<typeof createQuotaApi>;
