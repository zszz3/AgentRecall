import { contextBridge, ipcRenderer } from "electron";
import type { AiChatMessage } from "../core/ai-assistant";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type { IndexStatus } from "../core/indexer";
import type { RemoteHealthReport } from "../core/remote-health";
import type { ResumeRouteResult } from "../core/resume-router";
import type { TraceEventQueryOptions } from "../core/session-store";
import type { SshConfigHost } from "../core/ssh-config";
import type {
  EnvironmentUpsertInput,
  LiveSessionSnapshot,
  MigrationTarget,
  ProjectSummary,
  ProjectQueryOptions,
  ProjectTagEntry,
  SearchOptions,
  SessionEnvironment,
  SessionMessage,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionSearchPage,
  SessionSearchResult,
  SessionStats,
  SessionStatsOptions,
  SessionTraceEvent,
  TagListOptions,
  UsageQuotaSnapshot,
} from "../core/types";
import { createAppUpdateApi } from "./app-update";
import { createProvidersApi } from "./providers";
import { createRemoteSessionsApi } from "./remote-sessions";
import { createMemoriesApi } from "./memories";
import { createRulesApi } from "./rules";
import { createSkillsApi } from "./skills";

export interface AiAssistantReply {
  reply: string;
  sessions: SessionSearchResult[];
}

const api = {
  platform: process.platform as NodeJS.Platform,
  askAiAssistant: (messages: AiChatMessage[]): Promise<AiAssistantReply> => ipcRenderer.invoke("ai:assistant-chat", messages),
  searchSessions: (options: SearchOptions): Promise<SessionSearchResult[]> => ipcRenderer.invoke("search:sessions", options),
  searchSessionPage: (options: SearchOptions): Promise<SessionSearchPage> => ipcRenderer.invoke("search:session-page", options),
  getSession: (sessionKey: string): Promise<SessionSearchResult | null> => ipcRenderer.invoke("session:get", sessionKey),
  getMessages: (sessionKey: string, offset?: number, limit?: number): Promise<SessionMessage[]> =>
    ipcRenderer.invoke("session:messages", sessionKey, offset, limit),
  getTraceEvents: (sessionKey: string, options?: TraceEventQueryOptions): Promise<SessionTraceEvent[]> =>
    ipcRenderer.invoke("session:trace-events", sessionKey, options),
  getLiveSessions: (): Promise<LiveSessionSnapshot> => ipcRenderer.invoke("sessions:live"),
  summarizeSession: (sessionKey: string): Promise<SessionSearchResult | null> =>
    ipcRenderer.invoke("session:summarize", sessionKey),
  summarizeMissingSessions: (): Promise<{ processed: number; failed: number; total: number }> =>
    ipcRenderer.invoke("session:summarize-missing"),
  onSummaryProgress: (callback: (progress: { processed: number; failed: number; total: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: { processed: number; failed: number; total: number }) => callback(progress);
    ipcRenderer.on("summary:progress", listener);
    return () => ipcRenderer.removeListener("summary:progress", listener);
  },
  getStats: (options?: SessionStatsOptions): Promise<SessionStats> => ipcRenderer.invoke("stats:get", options),
  getMcpStatus: (): Promise<boolean> => ipcRenderer.invoke("mcp:status"),
  setMcpEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("mcp:set-enabled", enabled),
  getQuotas: (): Promise<UsageQuotaSnapshot> => ipcRenderer.invoke("quota:get"),
  listTags: (options?: TagListOptions): Promise<string[]> => ipcRenderer.invoke("tags:list", options),
  listProjects: (options?: ProjectQueryOptions): Promise<ProjectSummary[]> => ipcRenderer.invoke("projects:list", options),
  listTagsByProject: (): Promise<ProjectTagEntry[]> => ipcRenderer.invoke("tags:by-project"),
  listEnvironments: (): Promise<SessionEnvironment[]> => ipcRenderer.invoke("environments:list"),
  listSshConfigHosts: (): Promise<SshConfigHost[]> => ipcRenderer.invoke("ssh-config:list-hosts"),
  saveEnvironment: (environment: EnvironmentUpsertInput): Promise<SessionEnvironment> =>
    ipcRenderer.invoke("environment:save", environment),
  deleteEnvironment: (environmentId: string): Promise<void> => ipcRenderer.invoke("environment:delete", environmentId),
  refreshEnvironment: (environmentId: string): Promise<void> => ipcRenderer.invoke("environment:refresh", environmentId),
  diagnoseEnvironment: (environmentId: string): Promise<RemoteHealthReport> => ipcRenderer.invoke("environment:diagnose", environmentId),
  setCustomTitle: (sessionKey: string, title: string | null): Promise<void> => ipcRenderer.invoke("title:set", sessionKey, title),
  addTag: (sessionKey: string, tagName: string): Promise<void> => ipcRenderer.invoke("tag:add", sessionKey, tagName),
  removeTag: (sessionKey: string, tagName: string): Promise<void> => ipcRenderer.invoke("tag:remove", sessionKey, tagName),
  deleteTag: (tagName: string): Promise<void> => ipcRenderer.invoke("tag:delete", tagName),
  setFavorited: (sessionKey: string, favorited: boolean): Promise<void> => ipcRenderer.invoke("favorite:set", sessionKey, favorited),
  setPinned: (sessionKey: string, pinned: boolean): Promise<void> => ipcRenderer.invoke("pin:set", sessionKey, pinned),
  setHidden: (sessionKey: string, hidden: boolean): Promise<void> => ipcRenderer.invoke("hide:set", sessionKey, hidden),
  deleteSession: (sessionKey: string): Promise<boolean> => ipcRenderer.invoke("session:delete", sessionKey),
  refreshIndex: (): Promise<IndexStatus> => ipcRenderer.invoke("index:refresh"),
  getIndexStatus: (): Promise<IndexStatus> => ipcRenderer.invoke("index:status"),
  ...createAppUpdateApi(ipcRenderer),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  setSettings: (settings: AppSettingsUpdate): Promise<AppSettings> => ipcRenderer.invoke("settings:set", settings),
  ...createProvidersApi(ipcRenderer),
  ...createSkillsApi(ipcRenderer),
  ...createRulesApi(ipcRenderer),
  ...createMemoriesApi(ipcRenderer),
  ...createRemoteSessionsApi(ipcRenderer),
  copyCombinedSyncSetupSql: (): Promise<void> => ipcRenderer.invoke("supabase:copy-combined-setup-sql"),
  openSupabaseSqlEditor: (target: "sessions" | "skills"): Promise<void> => ipcRenderer.invoke("supabase:open-sql-editor", target),
  copyResumeCommand: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-resume", sessionKey),
  resumeSession: (sessionKey: string): Promise<ResumeRouteResult> => ipcRenderer.invoke("command:resume", sessionKey),
  resumeSessionInIterm: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:resume-iterm", sessionKey),
  migrateSession: (sessionKey: string, target: MigrationTarget): Promise<SessionMigrationResult> =>
    ipcRenderer.invoke("session:migrate", sessionKey, target),
  openNativeApp: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:open-app", sessionKey),
  revealSession: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:reveal", sessionKey),
  copyMarkdown: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-markdown", sessionKey),
  exportMarkdown: (sessionKey: string): Promise<boolean> => ipcRenderer.invoke("command:export-markdown", sessionKey),
  copyPlainText: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-plain", sessionKey),
  openExternalLink: (url: string): Promise<void> => ipcRenderer.invoke("markdown:open-external", url),
  onIndexStatus: (callback: (status: IndexStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: IndexStatus) => callback(status);
    ipcRenderer.on("index-status", listener);
    return () => ipcRenderer.removeListener("index-status", listener);
  },
  onMigrationProgress: (callback: (progress: SessionMigrationProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SessionMigrationProgress) => callback(progress);
    ipcRenderer.on("session:migration-progress", listener);
    return () => ipcRenderer.removeListener("session:migration-progress", listener);
  },
  onEnvironmentsUpdated: (callback: (environments: SessionEnvironment[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, environments: SessionEnvironment[]) => callback(environments);
    ipcRenderer.on("environments-updated", listener);
    return () => ipcRenderer.removeListener("environments-updated", listener);
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
