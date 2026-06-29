import { contextBridge, ipcRenderer } from "electron";
import type { AiChatMessage } from "../core/ai-assistant";
import type { ApiConfig, ClaudeApiConfig } from "../core/api-config";
import type { ApplyClaudeProfileResult } from "../core/claude-profile";
import type { CodexChatProxyStatus } from "../core/codex-chat-proxy";
import type { ApplyCodexProfileResult } from "../core/codex-profile";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type { IndexStatus } from "../core/indexer";
import type { RemoteHealthReport } from "../core/remote-health";
import type { ResumeRouteResult } from "../core/resume-router";
import type { TraceEventQueryOptions } from "../core/session-store";
import type { SkillSyncInstallResult, SkillSyncSnapshot, SkillSyncUploadResult } from "../core/skill-sync";
import type { DeleteInstalledSkillResult, InstalledSkillsSnapshot } from "../core/skill-manager";
import type { SkillUsageRefreshStatus } from "../core/skill-usage";
import type { SshConfigHost } from "../core/ssh-config";
import type {
  EnvironmentUpsertInput,
  LiveSessionSnapshot,
  MigrationAgent,
  ProjectSummary,
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
  UsageQuotaSnapshot,
} from "../core/types";

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
  listTags: (): Promise<string[]> => ipcRenderer.invoke("tags:list"),
  listProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke("projects:list"),
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
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  setSettings: (settings: AppSettingsUpdate): Promise<AppSettings> => ipcRenderer.invoke("settings:set", settings),
  applyCodexProfile: (apiConfig: ApiConfig): Promise<ApplyCodexProfileResult> => ipcRenderer.invoke("codex-profile:apply", apiConfig),
  getCodexChatProxyStatus: (): Promise<CodexChatProxyStatus | null> => ipcRenderer.invoke("codex-chat-proxy:status"),
  stopCodexChatProxy: (): Promise<null> => ipcRenderer.invoke("codex-chat-proxy:stop"),
  applyClaudeProfile: (apiConfig: ClaudeApiConfig): Promise<ApplyClaudeProfileResult> => ipcRenderer.invoke("claude-profile:apply", apiConfig),
  getApiProviderKey: (target: "codex" | "claude" | "summary", providerId: string): Promise<string> =>
    ipcRenderer.invoke("api-provider-key:get", target, providerId),
  listSkills: (): Promise<InstalledSkillsSnapshot> => ipcRenderer.invoke("skills:list"),
  refreshSkillUsage: (): Promise<SkillUsageRefreshStatus> => ipcRenderer.invoke("skills:refresh-usage"),
  getSkillSyncSnapshot: (): Promise<SkillSyncSnapshot> => ipcRenderer.invoke("skills:sync-snapshot"),
  uploadSkillToSync: (skillPath: string): Promise<SkillSyncUploadResult> => ipcRenderer.invoke("skills:sync-upload", skillPath),
  installSyncedSkill: (remoteSkillId: string): Promise<SkillSyncInstallResult> => ipcRenderer.invoke("skills:sync-install", remoteSkillId),
  copySkillSyncSetupSql: (): Promise<void> => ipcRenderer.invoke("skills:sync-copy-setup-sql"),
  copySkillPath: (skillPath: string): Promise<void> => ipcRenderer.invoke("skills:copy-path", skillPath),
  revealSkill: (targetPath: string): Promise<void> => ipcRenderer.invoke("skills:reveal", targetPath),
  deleteSkill: (skillPath: string): Promise<DeleteInstalledSkillResult> => ipcRenderer.invoke("skills:delete", skillPath),
  getSkillUsageHookStatus: (): Promise<boolean> => ipcRenderer.invoke("skills:usage-hook-status"),
  installSkillUsageHook: (): Promise<string> => ipcRenderer.invoke("skills:install-usage-hook"),
  uninstallSkillUsageHook: (): Promise<string> => ipcRenderer.invoke("skills:uninstall-usage-hook"),
  copyResumeCommand: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:copy-resume", sessionKey),
  resumeSession: (sessionKey: string): Promise<ResumeRouteResult> => ipcRenderer.invoke("command:resume", sessionKey),
  resumeSessionInIterm: (sessionKey: string): Promise<void> => ipcRenderer.invoke("command:resume-iterm", sessionKey),
  migrateSession: (sessionKey: string, target: MigrationAgent): Promise<SessionMigrationResult> =>
    ipcRenderer.invoke("session:migrate", sessionKey, target),
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
