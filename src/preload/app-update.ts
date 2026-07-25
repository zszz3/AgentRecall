import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { AppUpdateInstallResult, AppUpdateStatus } from "../core/app-update-types";
import { APP_UPDATE_EVENTS, APP_UPDATE_IPC } from "../shared/ipc/app-update";

export type AppUpdateIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createAppUpdateApi(ipc: AppUpdateIpcRenderer) {
  return {
    getAppUpdateStatus: (force = false): Promise<AppUpdateStatus> =>
      ipc.invoke(APP_UPDATE_IPC.getStatus.channel, force),
    installAppUpdate: (): Promise<AppUpdateInstallResult> =>
      ipc.invoke(APP_UPDATE_IPC.install.channel),
    skipAppUpdate: (untilNextVersion = false): Promise<AppUpdateStatus> =>
      ipc.invoke(APP_UPDATE_IPC.skip.channel, untilNextVersion),
    onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, status: AppUpdateStatus) => callback(status);
      ipc.on(APP_UPDATE_EVENTS.status, listener);
      return () => ipc.removeListener(APP_UPDATE_EVENTS.status, listener);
    },
  };
}

export type AppUpdateApi = ReturnType<typeof createAppUpdateApi>;
