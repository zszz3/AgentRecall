import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings } from "../core/platform";
import type { IndexStatus } from "../core/indexer";
import type { ProjectSummary, SearchOptions, SessionMessage, SessionSearchResult } from "../core/types";

const api = {
  searchSessions: (options: SearchOptions): Promise<SessionSearchResult[]> => ipcRenderer.invoke("search:sessions", options),
  getSession: (sessionKey: string): Promise<SessionSearchResult | null> => ipcRenderer.invoke("session:get", sessionKey),
  getMessages: (sessionKey: string, offset?: number, limit?: number): Promise<SessionMessage[]> =>
    ipcRenderer.invoke("session:messages", sessionKey, offset, limit),
  listTags: (): Promise<string[]> => ipcRenderer.invoke("tags:list"),
  listProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke("projects:list"),
  setCustomTitle: (sessionKey: string, title: string | null): Promise<void> => ipcRenderer.invoke("title:set", sessionKey, title),
  addTag: (sessionKey: string, tagName: string): Promise<void> => ipcRenderer.invoke("tag:add", sessionKey, tagName),
  removeTag: (sessionKey: string, tagName: string): Promise<void> => ipcRenderer.invoke("tag:remove", sessionKey, tagName),
  deleteTag: (tagName: string): Promise<void> => ipcRenderer.invoke("tag:delete", tagName),
  setFavorited: (sessionKey: string, favorited: boolean): Promise<void> => ipcRenderer.invoke("favorite:set", sessionKey, favorited),
  setPinned: (sessionKey: string, pinned: boolean): Promise<void> => ipcRenderer.invoke("pin:set", sessionKey, pinned),
  setHidden: (sessionKey: string, hidden: boolean): Promise<void> => ipcRenderer.invoke("hide:set", sessionKey, hidden),
  refreshIndex: (): Promise<IndexStatus> => ipcRenderer.invoke("index:refresh"),
  getIndexStatus: (): Promise<IndexStatus> => ipcRenderer.invoke("index:status"),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  setSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke("settings:set", settings),
  copyResumeCommand: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-resume", sessionKey),
  resumeSession: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:resume", sessionKey),
  resumeSessionInIterm: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:resume-iterm", sessionKey),
  openNativeApp: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:open-app", sessionKey),
  revealSession: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:reveal", sessionKey),
  copyMarkdown: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-markdown", sessionKey),
  copyPlainText: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-plain", sessionKey),
  onIndexStatus: (callback: (status: IndexStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: IndexStatus) => callback(status);
    ipcRenderer.on("index-status", listener);
    return () => ipcRenderer.removeListener("index-status", listener);
  },
  onFocusSearch: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("focus-search", listener);
    return () => ipcRenderer.removeListener("focus-search", listener);
  },
};

contextBridge.exposeInMainWorld("sessionSearch", api);

export type SessionSearchApi = typeof api;
