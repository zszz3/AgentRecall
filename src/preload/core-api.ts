import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { CoreApi } from "../shared/core-api";
import { APP_UPDATE_EVENTS, APP_UPDATE_IPC } from "../shared/ipc/app-update";
import { CORE_EVENTS, CORE_IPC } from "../shared/ipc/core";
import {
  parseIpcRequest,
  type IpcRequestContract,
} from "../shared/ipc/contract";
import { PRODUCT_PROFILE } from "../shared/product-profile";

export type CoreIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createCoreApi(
  ipc: CoreIpcRenderer,
  platform: NodeJS.Platform,
): CoreApi {
  const invoke = <Args extends unknown[]>(
    contract: IpcRequestContract<Args>,
    ...input: unknown[]
  ) => {
    const args = parseIpcRequest(contract, input);
    return ipc.invoke(contract.channel, ...args);
  };

  const api = {
    productProfile: PRODUCT_PROFILE,
    platform,
    searchSessionPage: (options) =>
      invoke(CORE_IPC.searchSessionPage, options),
    getSession: (sessionKey) =>
      invoke(CORE_IPC.getSession, sessionKey),
    getMessages: (sessionKey, offset, limit) =>
      invoke(CORE_IPC.getMessages, sessionKey, offset, limit),
    getTraceEvents: (sessionKey, options) =>
      invoke(CORE_IPC.getTraceEvents, sessionKey, options),
    getLiveSessions: () =>
      invoke(CORE_IPC.getLiveSessions),
    listTags: (options) =>
      invoke(CORE_IPC.listTags, options),
    listProjects: (options) =>
      invoke(CORE_IPC.listProjects, options),
    listTagsByProject: () =>
      invoke(CORE_IPC.listTagsByProject),
    listEnvironments: () =>
      invoke(CORE_IPC.listEnvironments),
    setCustomTitle: (sessionKey, title) =>
      invoke(CORE_IPC.setCustomTitle, sessionKey, title),
    setFavorited: (sessionKey, favorited) =>
      invoke(CORE_IPC.setFavorited, sessionKey, favorited),
    refreshIndex: () =>
      invoke(CORE_IPC.refreshIndex),
    getIndexStatus: () =>
      invoke(CORE_IPC.getIndexStatus),
    getSettings: () =>
      invoke(CORE_IPC.getSettings),
    setSettings: (settings) =>
      invoke(CORE_IPC.setSettings, settings),
    getAppUpdateStatus: (force = false) =>
      invoke(APP_UPDATE_IPC.getStatus, force),
    installAppUpdate: () =>
      invoke(APP_UPDATE_IPC.install),
    skipAppUpdate: (untilNextVersion = false) =>
      invoke(APP_UPDATE_IPC.skip, untilNextVersion),
    resumeSession: (sessionKey) =>
      invoke(CORE_IPC.resumeSession, sessionKey),
    onIndexStatus: (callback) =>
      subscribe(ipc, CORE_EVENTS.indexStatus, callback),
    onFocusSearch: (callback) =>
      subscribe(ipc, CORE_EVENTS.focusSearch, callback),
    onOpenSettings: (callback) =>
      subscribe(ipc, CORE_EVENTS.openSettings, callback),
    onAppUpdateStatus: (callback) =>
      subscribe(ipc, APP_UPDATE_EVENTS.status, callback),
  } satisfies CoreApi;

  return Object.freeze(api);
}

function subscribe<T>(
  ipc: Pick<IpcRenderer, "on" | "removeListener">,
  channel: string,
  callback: (value: T) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => callback(value);
  ipc.on(channel, listener);
  return () => ipc.removeListener(channel, listener);
}
