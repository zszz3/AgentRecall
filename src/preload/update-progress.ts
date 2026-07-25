import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AppUpdateProgress } from "../core/app-update-types";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";

const api = {
  onProgress(callback: (progress: AppUpdateProgress) => void): () => void {
    const listener = (_event: IpcRendererEvent, progress: AppUpdateProgress): void => callback(progress);
    ipcRenderer.on(APP_UPDATE_EVENTS.progress, listener);
    return () => ipcRenderer.removeListener(APP_UPDATE_EVENTS.progress, listener);
  },
};

contextBridge.exposeInMainWorld("updateProgress", api);

export type UpdateProgressApi = typeof api;
