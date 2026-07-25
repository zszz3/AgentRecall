import { contextBridge, ipcRenderer } from "electron";
import { createCoreApi } from "./core-api";

const api = createCoreApi(ipcRenderer, process.platform);

contextBridge.exposeInMainWorld("sessionSearch", api);

export type SessionSearchApi = typeof api;
export type { CoreApi } from "../shared/core-api";
