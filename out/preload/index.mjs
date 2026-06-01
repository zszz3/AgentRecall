import { contextBridge, ipcRenderer } from "electron";
const api = {
  searchSessions: (options) => ipcRenderer.invoke("search:sessions", options),
  getSession: (sessionKey) => ipcRenderer.invoke("session:get", sessionKey),
  getMessages: (sessionKey, offset, limit) => ipcRenderer.invoke("session:messages", sessionKey, offset, limit),
  getStats: (options) => ipcRenderer.invoke("stats:get", options),
  getQuotas: () => ipcRenderer.invoke("quota:get"),
  listTags: () => ipcRenderer.invoke("tags:list"),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  setCustomTitle: (sessionKey, title) => ipcRenderer.invoke("title:set", sessionKey, title),
  addTag: (sessionKey, tagName) => ipcRenderer.invoke("tag:add", sessionKey, tagName),
  removeTag: (sessionKey, tagName) => ipcRenderer.invoke("tag:remove", sessionKey, tagName),
  deleteTag: (tagName) => ipcRenderer.invoke("tag:delete", tagName),
  setFavorited: (sessionKey, favorited) => ipcRenderer.invoke("favorite:set", sessionKey, favorited),
  setPinned: (sessionKey, pinned) => ipcRenderer.invoke("pin:set", sessionKey, pinned),
  setHidden: (sessionKey, hidden) => ipcRenderer.invoke("hide:set", sessionKey, hidden),
  refreshIndex: () => ipcRenderer.invoke("index:refresh"),
  getIndexStatus: () => ipcRenderer.invoke("index:status"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings) => ipcRenderer.invoke("settings:set", settings),
  copyResumeCommand: (sessionKey) => ipcRenderer.invoke("command:copy-resume", sessionKey),
  resumeSession: (sessionKey) => ipcRenderer.invoke("command:resume", sessionKey),
  resumeSessionInIterm: (sessionKey) => ipcRenderer.invoke("command:resume-iterm", sessionKey),
  openNativeApp: (sessionKey) => ipcRenderer.invoke("command:open-app", sessionKey),
  revealSession: (sessionKey) => ipcRenderer.invoke("command:reveal", sessionKey),
  copyMarkdown: (sessionKey) => ipcRenderer.invoke("command:copy-markdown", sessionKey),
  copyPlainText: (sessionKey) => ipcRenderer.invoke("command:copy-plain", sessionKey),
  onIndexStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("index-status", listener);
    return () => ipcRenderer.removeListener("index-status", listener);
  },
  onFocusSearch: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("focus-search", listener);
    return () => ipcRenderer.removeListener("focus-search", listener);
  }
};
contextBridge.exposeInMainWorld("sessionSearch", api);
