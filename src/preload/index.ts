import { contextBridge, ipcRenderer } from "electron";
import type { ApiConfig, ClaudeApiConfig } from "../core/api-config";
import type { ApplyClaudeProfileResult } from "../core/claude-profile";
import type { ApplyCodexProfileResult } from "../core/codex-profile";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type { IndexStatus } from "../core/indexer";
import type { ResumeRouteResult } from "../core/resume-router";
import type { DeleteInstalledSkillResult, InstalledSkillsSnapshot } from "../core/skill-manager";
import type { SkillUsageRefreshStatus } from "../core/skill-usage";
import type {
  LiveSessionSnapshot,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionTraceEvent,
  UsageQuotaSnapshot,
} from "../core/types";

const api = {
  platform: process.platform as NodeJS.Platform,
  searchSessions: (options: SearchOptions): Promise<SessionSearchResult[]> => ipcRenderer.invoke("search:sessions", options),
  getSession: (sessionKey: string): Promise<SessionSearchResult | null> => ipcRenderer.invoke("session:get", sessionKey),
  getMessages: (sessionKey: string, offset?: number, limit?: number): Promise<SessionMessage[]> =>
    ipcRenderer.invoke("session:messages", sessionKey, offset, limit),
  getTraceEvents: (sessionKey: string): Promise<SessionTraceEvent[]> => ipcRenderer.invoke("session:trace-events", sessionKey),
  getLiveSessions: (): Promise<LiveSessionSnapshot> => ipcRenderer.invoke("sessions:live"),
  getStats: (options?: SessionStatsOptions): Promise<SessionStats> => ipcRenderer.invoke("stats:get", options),
  getQuotas: (): Promise<UsageQuotaSnapshot> => ipcRenderer.invoke("quota:get"),
  listTags: (projectPath?: string): Promise<string[]> => ipcRenderer.invoke("tags:list", projectPath),
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
  setSettings: (settings: AppSettingsUpdate): Promise<AppSettings> => ipcRenderer.invoke("settings:set", settings),
  applyCodexProfile: (apiConfig: ApiConfig): Promise<ApplyCodexProfileResult> => ipcRenderer.invoke("codex-profile:apply", apiConfig),
  applyClaudeProfile: (apiConfig: ClaudeApiConfig): Promise<ApplyClaudeProfileResult> => ipcRenderer.invoke("claude-profile:apply", apiConfig),
  getApiProviderKey: (target: "codex" | "claude", providerId: string): Promise<string> =>
    ipcRenderer.invoke("api-provider-key:get", target, providerId),
  listSkills: (): Promise<InstalledSkillsSnapshot> => ipcRenderer.invoke("skills:list"),
  refreshSkillUsage: (): Promise<SkillUsageRefreshStatus> => ipcRenderer.invoke("skills:refresh-usage"),
  copySkillPath: (skillPath: string): Promise<void> => ipcRenderer.invoke("skills:copy-path", skillPath),
  revealSkill: (skillPath: string): Promise<void> => ipcRenderer.invoke("skills:reveal", skillPath),
  deleteSkill: (skillPath: string): Promise<DeleteInstalledSkillResult> => ipcRenderer.invoke("skills:delete", skillPath),
  getSkillUsageHookStatus: (): Promise<boolean> => ipcRenderer.invoke("skills:usage-hook-status"),
  installSkillUsageHook: (): Promise<string> => ipcRenderer.invoke("skills:install-usage-hook"),
  uninstallSkillUsageHook: (): Promise<string> => ipcRenderer.invoke("skills:uninstall-usage-hook"),
  copyResumeCommand: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-resume", sessionKey),
  resumeSession: (sessionKey: string): Promise<ResumeRouteResult> => ipcRenderer.invoke("command:resume", sessionKey),
  resumeSessionInIterm: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:resume-iterm", sessionKey),
  openNativeApp: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:open-app", sessionKey),
  revealSession: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:reveal", sessionKey),
  copyMarkdown: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-markdown", sessionKey),
  exportMarkdown: (sessionKey: string): Promise<boolean> => ipcRenderer.invoke("command:export-markdown", sessionKey),
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
  onOpenSettings: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("open-settings", listener);
    return () => ipcRenderer.removeListener("open-settings", listener);
  },
};

contextBridge.exposeInMainWorld("sessionSearch", api);

export type SessionSearchApi = typeof api;
