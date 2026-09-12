import type { IpcRenderer } from "electron";
import { MESSAGE_TOOLS_CHANNELS as C, type MessageToolsApi } from "../shared/ipc/message-tools";

export function createMessageToolsApi(ipc: IpcRenderer): MessageToolsApi {
  return {
    list: (key) => ipc.invoke(C.list, key),
    set: (key, index, saved) => ipc.invoke(C.set, key, index, saved),
    remove: (locator) => ipc.invoke(C.remove, locator),
    copyLink: (key, index) => ipc.invoke(C.copyLink, key, index),
    resolve: (locator) => ipc.invoke(C.resolve, locator),
    takePending: () => ipc.invoke(C.pending),
    open: (locator) => ipc.invoke(C.open, locator),
    onOpen: (callback) => {
      const listener = (): void => callback();
      ipc.on(C.open, listener);
      return () => { ipc.removeListener(C.open, listener); };
    },
    prepare: (key, format) => ipc.invoke(C.prepare, key, format),
    addCustom: (id, value) => ipc.invoke(C.custom, id, value),
    save: (id, choices) => ipc.invoke(C.save, id, choices),
    release: () => ipc.invoke(C.release),
  };
}
