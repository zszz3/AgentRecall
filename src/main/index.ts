import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import { cpSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { loadActiveCodexSummaryEndpointDefaults } from "../core/codex-profile";
import {
  reconstructCodexResponsesRequest,
  resolveCodexResponsesRequest,
  type CodexRequestExport,
  type CodexRequestFidelity,
} from "../core/codex-request-export";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import {
  formatSessionJson,
  formatSessionMarkdown,
  formatSessionPlainText,
  type SessionJsonExportFormat,
} from "../core/format-session";
import { normalizeExternalLink } from "../core/external-link";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  getResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
  normalizeTerminal,
  openNativeApp,
  openMigrationResumeInTerminal,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { focusLiveSessionTerminal, setLiveSessionTerminalTitle } from "../core/session-focus";
import { setSessionCustomTitleAndSyncTerminal } from "../core/session-title-sync";
import { createCachedLiveSessionSnapshotLoader } from "../core/session-activity";
import { summarizeSession, type SummaryEndpoint } from "../core/session-summarizer";
import {
  buildCodexExecEndpoint as buildCodexExecEndpointShared,
  resolveSummaryEndpointFromSettings as resolveSummaryEndpointFromSettingsShared,
} from "../core/summary-endpoint";
import {
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type ToolExecutionResult,
} from "../core/ai-assistant";
import { applyMigrationLengthPolicy, createMigrationCompressor } from "../core/session-migration-compression";
import { migrateSession } from "../core/session-migration";
import { runLocalSessionMigration } from "./local-session-migration";
import { targetFilePath, writeMigratedSession } from "../core/session-migration-writers";
import { writeDbPointer } from "../core/app-paths";
import { routeResumeSession } from "../core/resume-router";
import { diagnoseRemoteEnvironment, preflightRemoteSessionResume } from "../core/remote-health";
import { buildRemoteSyncSshArgs, fetchRemoteSessionFilePayload, fetchRemoteSessionMessagePage, syncRemoteEnvironment } from "../core/remote-sync";
import { REMOTE_PROCESS_EXEC_OPTIONS, runRemoteCommandWithInput } from "../core/remote-process";
import { loadRemoteSessionDetailPayload, loadWslSessionDetailPayload } from "../core/remote-session-loader";
import type { RemoteSessionRestoreDependencies } from "../core/remote-session-restore";
import { RemoteEnvironmentLifecycle } from "../core/remote-environment-lifecycle";
import { RemoteWatchManager } from "../core/remote-watch";
import { SessionStore, type TraceEventQueryOptions } from "../core/session-store";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "../core/supabase-setup";
import { buildSshArgs, readUserSshConfig } from "../core/ssh-config";
import { listWslDistributions } from "../core/wsl";
import { deleteWslSessionFile } from "../core/wsl-session-actions";
import { AUTO_INDEX_REFRESH_INTERVAL_MS, INITIAL_INDEX_DELAY_MS } from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import { isLocalSessionEnvironment, isLocalSessionStorage } from "../core/session-environment";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../core/session-sources";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";
import { QUOTA_EVENTS } from "../shared/ipc/quota";
import { registerAppUpdateIpc } from "./ipc/app-update";
import { registerQuotaIpc } from "./ipc/quota";
import { registerProvidersIpc } from "./ipc/providers";
import { registerRemoteSessionsIpc } from "./ipc/remote-sessions";
import { registerMemoriesIpc, type MemoriesIpcService } from "./ipc/memories";
import { registerDiscoveryIpc, type DiscoveryIpcService } from "./ipc/discovery";
import { registerRulesIpc, type RulesIpcService } from "./ipc/rules";
import { registerSkillsIpc } from "./ipc/skills";
import {
  AppUpdateService,
  launchDetachedAppUpdateInstaller,
  type AppUpdateClient,
} from "./services/app-update-service";
import { ProviderService } from "./services/provider-service";
import {
  codexAuthPath,
  createQuotaCache,
  QuotaService,
  readCodexAuthIdentity,
  watchQuotaAuthFile,
} from "./services/quota-service";
import {
  RemoteSessionService,
  type SessionSyncHookSetup,
} from "./services/remote-session-service";
import { buildMemoriesSyncSetupSql, memoryIdentity, scanLocalMemories, SupabaseMemoriesSyncClient } from "../core/memories-sync";
import { buildRulesSyncSetupSql, restoreGlobalRules, ruleIdentity, scanLocalRules, SupabaseRulesSyncClient } from "../core/rules-sync";
import { SkillService, type SkillUsageHookSetup } from "./services/skill-service";
import type {
  EnvironmentUpsertInput,
  MigrationAgent,
  MigrationTarget,
  PortableSession,
  ProjectQueryOptions,
  SearchOptions,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionSearchResult,
  SessionSource,
  SessionStatsOptions,
  TagListOptions,
} from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "AgentRecall";
const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");
const releaseUpdateRuntime = app.isPackaged || process.env.AGENT_RECALL_RELEASE_BUILD === "1";

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  sources: [descriptor.id],
}));

// The skill-usage hook installer is a self-contained CommonJS script in bin/
// (sibling of out/), shared with the global-install path. Load it lazily via a
// runtime require so the bundler leaves it as an external dependency, and the
// hook command it writes points back at bin/skill-usage-record.cjs.
const requireCjs = createRequire(import.meta.url);
const SKILL_USAGE_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-skill-usage-hook.cjs");
function loadSkillUsageHookSetup(): SkillUsageHookSetup {
  return requireCjs(SKILL_USAGE_HOOK_SETUP_PATH) as SkillUsageHookSetup;
}

const SESSION_SYNC_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-session-sync-hook.cjs");
function loadSessionSyncHookSetup(): SessionSyncHookSetup {
  return requireCjs(SESSION_SYNC_HOOK_SETUP_PATH) as SessionSyncHookSetup;
}

const MCP_SETUP_PATH = path.join(__dirname, "../../bin/setup-mcp.cjs");
interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
}
function loadMcpSetup(): McpSetup {
  return requireCjs(MCP_SETUP_PATH) as McpSetup;
}

const UPDATE_CLIENT_PATH = path.join(__dirname, "../../bin/update-client.cjs");
const APPLY_UPDATE_PATH = path.join(__dirname, "../../bin/apply-update.cjs");
function loadUpdateClient(): AppUpdateClient {
  return requireCjs(UPDATE_CLIENT_PATH) as AppUpdateClient;
}

function ensureAgentRecallMcpPreference(): boolean {
  const setup = loadMcpSetup();
  if (getSettings().sessionSearchMcpEnabled) {
    if (!setup.status()) setup.run(false);
  }
  return setup.status();
}

function migrateLegacyUserData(): void {
  const target = app.getPath("userData");
  if (existsSync(target)) return;

  const parent = path.dirname(target);
  const legacyNames = [
    ["Agent", "Session", "Search"].join("-"),
    ["agent", "session", "search"].join("-"),
  ];
  for (const legacyName of legacyNames) {
    const legacy = path.join(parent, legacyName);
    if (!existsSync(legacy)) continue;
    try {
      cpSync(legacy, target, { recursive: true, errorOnExist: false });
    } catch (error) {
      console.warn(`Could not migrate existing user data to ${PRODUCT_NAME}:`, error);
    }
    return;
  }
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-recall");
migrateLegacyUserData();

let mainWindow: BrowserWindow | null = null;
let quickSearchWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun: Promise<IndexStatus> | null = null;
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let registeredGlobalShortcut: string | null = null;
let remoteWatchManager: RemoteWatchManager | null = null;
let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;
let quotaService: QuotaService;
const remoteDetailLoads = new Map<string, Promise<void>>();

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

type SavedWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

const windowStateStore = new Store<SavedWindowState>({
  name: "window-state",
  defaults: { width: 0, height: 0 },
});

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

function createQuotaService(): QuotaService {
  const authFile = codexAuthPath(process.env, homedir());
  const cache = createQuotaCache(path.join(app.getPath("userData"), "quota-cache.json"));
  return new QuotaService({
    load: (settings) => loadUsageQuotaSnapshot(settings),
    getSettings: () => {
      const settings = getSettings();
      return {
        hideCodexQuota: settings.hideCodexQuota,
        hideClaudeQuota: settings.hideClaudeQuota,
      };
    },
    authPath: () => authFile,
    identity: readCodexAuthIdentity,
    ...cache,
    publish: (snapshot) => mainWindow?.webContents.send(QUOTA_EVENTS.updated, snapshot),
    delay: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now: () => Date.now(),
    watch: watchQuotaAuthFile,
  });
}

const appUpdateService = new AppUpdateService({
  getClient: loadUpdateClient,
  releaseRuntime: releaseUpdateRuntime,
  getAutoCheckEnabled: () => getSettings().autoCheckUpdates,
  autoCheckDisabled: () => process.env.AGENT_RECALL_NO_UPDATE_CHECK === "1",
  publishStatus: (status) => mainWindow?.webContents.send(APP_UPDATE_EVENTS.status, status),
  publishProgress: (progress) => mainWindow?.webContents.send(APP_UPDATE_EVENTS.progress, progress),
  stageInstaller: (manifest, onProgress) => loadUpdateClient().stageUpdate(manifest, {
    nodePath: process.env.AGENT_RECALL_NODE_PATH,
    onProgress,
  }),
  launchInstaller: (staged) => launchDetachedAppUpdateInstaller(staged, { applyUpdatePath: APPLY_UPDATE_PATH }),
  requestQuit: () => app.quit(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  showMessageBox: (options) => mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options),
  copyText: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
  processId: process.pid,
  logError: (message) => console.error(message),
});

const providerService = new ProviderService({
  getSettings,
  keys: {
    get: (target, providerId) => store.getApiProviderKey(target, providerId),
    set: (target, providerId, apiKey) => store.setApiProviderKey(target, providerId, apiKey),
  },
  settings: {
    has: (settingPath) => settingsStore.has(settingPath as never),
    get: (settingPath) => settingsStore.get(settingPath as never),
    set: (settingPath, value) => settingsStore.set(settingPath as never, value as never),
  },
  logError: (message) => console.error(message),
});

const skillService = new SkillService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSkillUsageHookSetup,
  copyText: (text) => clipboard.writeText(text),
  revealPath: (targetPath) => revealInFileManager(targetPath),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

const remoteSessionService = new RemoteSessionService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSessionSyncHookSetup,
  ensureSessionDetails: ensureRemoteSessionDetailsLoaded,
  runIndexSync,
  chooseLocalProject: chooseLocalProjectDirectory,
  createLocalRestoreDependencies: createLocalRemoteRestoreDependencies,
  createSourceRestoreDependencies: createSourceRemoteRestoreDependencies,
  copyText: (text) => clipboard.writeText(text),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

function visibleSearchOptions(options: SearchOptions = {}): SearchOptions {
  return { ...options, excludeSubagents: getSettings().hideSubagentSessions };
}

function createRulesSyncService(): RulesIpcService {
  const projectDirs = () => store.listProjects(visibleProjectOptions()).map((p) => p.path);
  const createClient = () => {
    const settings = getSettings();
    return new SupabaseRulesSyncClient({ url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey });
  };
  return {
    async getSyncSnapshot() {
      const settings = getSettings();
      const localRules = scanLocalRules({ projectDirs: projectDirs() });
      if (!settings.rulesSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
        return { status: { kind: "unconfigured" as const, setupSql: buildRulesSyncSetupSql() }, localRules, remoteRules: [], scannedAt: Date.now() };
      }
      const client = createClient();
      const status = await client.checkStatus();
      const remoteRules = status.kind === "ready" ? await client.listRemoteRules() : [];
      return { status, localRules, remoteRules, scannedAt: Date.now() };
    },
    async upload(identity) {
      const localRules = scanLocalRules({ projectDirs: projectDirs() });
      const rule = localRules.find((r) => ruleIdentity(r) === identity);
      if (!rule) throw new Error("Rule not found locally.");
      return createClient().uploadRule(rule);
    },
    async uploadAll() {
      const localRules = scanLocalRules({ projectDirs: projectDirs() });
      const client = createClient();
      const remoteRules = await client.listRemoteRules();
      let uploaded = 0;
      let skipped = 0;
      for (const rule of localRules) {
        const remote = remoteRules.find((r) => r.agent === rule.agent && r.scope === rule.scope && r.name === rule.name && r.project_path === rule.projectPath);
        if (remote && remote.content_hash === rule.contentHash) {
          skipped++;
          continue;
        }
        await client.uploadRule(rule);
        uploaded++;
      }
      return { uploaded, skipped };
    },
    async deleteRemote(remoteId) {
      return createClient().deleteRule(remoteId);
    },
    copySetupSql() {
      clipboard.writeText(buildRulesSyncSetupSql());
    },
    async restoreGlobal() {
      const client = createClient();
      const remoteRules = await client.listRemoteRules();
      return restoreGlobalRules(remoteRules);
    },
  };
}

function createMemoriesSyncService(): MemoriesIpcService {
  const createClient = () => {
    const settings = getSettings();
    return new SupabaseMemoriesSyncClient({ url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey });
  };
  return {
    async getSyncSnapshot() {
      const settings = getSettings();
      const localMemories = scanLocalMemories();
      if (!settings.memoriesSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
        return { status: { kind: "unconfigured" as const, setupSql: buildMemoriesSyncSetupSql() }, localMemories, remoteMemories: [], scannedAt: Date.now() };
      }
      const client = createClient();
      const status = await client.checkStatus();
      const remoteMemories = status.kind === "ready" ? await client.listRemoteMemories() : [];
      return { status, localMemories, remoteMemories, scannedAt: Date.now() };
    },
    async upload(identity) {
      const localMemories = scanLocalMemories();
      const memory = localMemories.find((m) => memoryIdentity(m) === identity);
      if (!memory) throw new Error("Memory not found locally.");
      return createClient().uploadMemory(memory);
    },
    async uploadAll() {
      const localMemories = scanLocalMemories();
      const client = createClient();
      const remoteMemories = await client.listRemoteMemories();
      let uploaded = 0;
      let skipped = 0;
      for (const memory of localMemories) {
        const remote = remoteMemories.find((r) => r.agent === memory.agent && r.scope === memory.scope && r.name === memory.name && r.project_path === memory.projectPath);
        if (remote && remote.content_hash === memory.contentHash) {
          skipped++;
          continue;
        }
        await client.uploadMemory(memory);
        uploaded++;
      }
      return { uploaded, skipped };
    },
    async deleteRemote(remoteId) {
      return createClient().deleteMemory(remoteId);
    },
    copySetupSql() {
      clipboard.writeText(buildMemoriesSyncSetupSql());
    },
  };
}

function createDiscoveryService(): DiscoveryIpcService {
  return {
    listSavedSearches: () => store.listSavedSearches(),
    createSavedSearch: (name, options) => store.createSavedSearch(name, options),
    deleteSavedSearch: (id) => store.deleteSavedSearch(id),
    touchSavedSearch: (id) => store.touchSavedSearch(id),
    listRecentSearches: (limit) => store.listRecentSearches(limit),
    searchHistory: (query, limit) => store.searchHistory(query, limit),
    clearSearchHistory: () => store.clearSearchHistory(),
    recordSearch: (query, resultCount, options) => store.recordSearch(query, resultCount, options),
    getRelatedSessions: (sessionKey, limit) => store.getRelatedSessions(sessionKey, limit),
    getSessionFamily: (sessionKey) => store.getSessionFamily(sessionKey),
  };
}

function visibleStatsOptions(options: SessionStatsOptions = {}): SessionStatsOptions {
  return { ...options, excludeSubagents: getSettings().hideSubagentSessions };
}

function visibleProjectOptions(): { excludeSubagents: boolean } {
  return { excludeSubagents: getSettings().hideSubagentSessions };
}

function pruneDisabledOptionalSources(settings: AppSettings): void {
  const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
  store.deleteSessionsBySource(disabledSources);
}

function enabledRemoteOptionalSources(settings: AppSettings): SessionSource[] {
  return OPTIONAL_SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.remoteCollectorOptional && settings[descriptor.optionalSetting])
    .map((descriptor) => descriptor.id);
}

function exportFileName(title: string, extension: "md" | "json"): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeTitle || "session"}.${extension}`;
}

function sshArgsForSession(session: SessionSearchResult): string[] | undefined {
  if (isLocalSessionEnvironment(session)) return undefined;
  const environment = store.getEnvironment(session.environmentId);
  if (!environment || environment.kind !== "ssh") return undefined;
  try {
    const args = buildSshArgs(environment, "");
    return args.slice(0, -1);
  } catch {
    return undefined;
  }
}

function requireSshArgsForRemoteSession(session: SessionSearchResult): string[] | undefined {
  const sshArgs = sshArgsForSession(session);
  if (!isLocalSessionEnvironment(session) && !sshArgs) {
    throw new Error("SSH environment is not available for this remote session.");
  }
  return sshArgs;
}

function requireWslEnvironment(session: SessionSearchResult): SessionEnvironment {
  const environment = store.getEnvironment(session.environmentId);
  if (environment?.kind !== "wsl") throw new Error("WSL environment is not available for this remote session.");
  return environment;
}

function requireWslResumeOptions(session: SessionSearchResult): { wslDistribution: string } {
  const environment = requireWslEnvironment(session);
  if (!environment.wslDistribution) throw new Error("WSL distribution is not configured for this remote session.");
  return { wslDistribution: environment.wslDistribution };
}

function requireRemoteSshEnvironment(session: SessionSearchResult): SessionEnvironment | null {
  if (isLocalSessionEnvironment(session)) return null;
  const environment = store.getEnvironment(session.environmentId);
  if (!environment || environment.kind !== "ssh") throw new Error("SSH environment is not available for this remote session.");
  return environment;
}

function requireSshEnvironment(environmentId: string): SessionEnvironment {
  const environment = store.getEnvironment(environmentId);
  if (!environment) throw new Error("SSH environment was not found.");
  if (environment.kind !== "ssh") throw new Error("Diagnostics are only available for SSH environments.");
  return environment;
}

async function ensureRemoteResumePreflight(session: SessionSearchResult): Promise<void> {
  const environment = requireRemoteSshEnvironment(session);
  if (!environment) return;
  const report = await preflightRemoteSessionResume(environment, session);
  const errors = report.checks.filter((check) => check.status === "error");
  if (errors.length === 0) return;
  const detail = errors.map((check) => `${check.label}: ${check.message}`).join("; ");
  throw new Error(`Remote resume preflight failed: ${detail}`);
}

function hasHydratedRemoteDetails(sessionKey: string): boolean {
  return store.getMessages(sessionKey, 0, 1).length > 0;
}

async function ensureRemoteSessionDetailsLoaded(sessionKey: string): Promise<void> {
  const session = store.getSession(sessionKey);
  if (!session || isLocalSessionStorage(session)) return;
  if (hasHydratedRemoteDetails(sessionKey)) return;

  const active = remoteDetailLoads.get(sessionKey);
  if (active) return active;

  const load = (async () => {
    const latest = store.getSession(sessionKey);
    if (!latest || isLocalSessionStorage(latest)) return;
    if (latest.source === "codewiz-cli") return;
    const environment = store.getEnvironment(latest.environmentId);
    if (environment?.kind === "wsl") {
      const payload = await fetchRemoteSessionFilePayload(environment, latest);
      const loaded = loadWslSessionDetailPayload(environment, payload, latest);
      if (loaded) store.upsertIndexedSession(loaded.session, loaded.messages, loaded.tokenEvents, loaded.traceEvents);
      return;
    }
    if (!environment || environment.kind !== "ssh") throw new Error("SSH environment is not available for this remote session.");
    const payload = await fetchRemoteSessionFilePayload(environment, latest);
    const loaded = loadRemoteSessionDetailPayload(environment, payload, latest);
    if (loaded) store.upsertIndexedSession(loaded.session, loaded.messages, loaded.tokenEvents, loaded.traceEvents);
  })().finally(() => {
    remoteDetailLoads.delete(sessionKey);
  });

  remoteDetailLoads.set(sessionKey, load);
  return load;
}

async function chooseMarkdownExportPath(defaultFileName: string): Promise<string | null> {
  const options = {
    title: "Export Markdown",
    defaultPath: path.join(app.getPath("documents"), defaultFileName),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : `${result.filePath}.md`;
}

async function chooseJsonExportFormat(): Promise<SessionJsonExportFormat | null> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Export JSON",
    message: "Choose an API request format",
    detail: "Codex exports use an exact captured request when available, otherwise a reconstructed request. Other sessions use normalized messages.",
    buttons: ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages", "Cancel"],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  };
  const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return (["openai_chat", "openai_responses", "anthropic"] as const)[result.response] ?? null;
}

async function chooseJsonExportPath(defaultFileName: string): Promise<string | null> {
  const options = {
    title: "Export JSON",
    defaultPath: path.join(app.getPath("documents"), defaultFileName),
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : `${result.filePath}.json`;
}

async function chooseLocalProjectDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose local project directory",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
const MIN_WINDOW_WIDTH = 860;
const MIN_WINDOW_HEIGHT = 560;

function getPreferredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.min(DEFAULT_WINDOW_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_WINDOW_HEIGHT, workArea.height);

  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

function getRestoredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const saved = windowStateStore.store;
  if (saved.width >= MIN_WINDOW_WIDTH && saved.height >= MIN_WINDOW_HEIGHT) {
    const { workArea } = screen.getDisplayMatching({
      x: saved.x ?? 0,
      y: saved.y ?? 0,
      width: saved.width,
      height: saved.height,
    });
    if (
      saved.x !== undefined &&
      saved.y !== undefined &&
      saved.x + saved.width > workArea.x &&
      saved.y + saved.height > workArea.y &&
      saved.x < workArea.x + workArea.width &&
      saved.y < workArea.y + workArea.height
    ) {
      return { width: saved.width, height: saved.height, x: saved.x, y: saved.y };
    }
  }
  return getPreferredWindowBounds();
}

function persistWindowState(): void {
  if (!mainWindow) return;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) {
    windowStateStore.set("isMaximized", true);
    return;
  }
  const bounds = mainWindow.getBounds();
  windowStateStore.set({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: false,
  });
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const initialBounds = getRestoredWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: PRODUCT_NAME,
    show: false,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    backgroundColor: "#0a0b0d",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (windowStateStore.get("isMaximized") === true) {
    mainWindow.maximize();
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error("[renderer]", message, `${sourceId}:${line}`);
    else console.log("[renderer]", message);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("resize", persistWindowState);
  mainWindow.on("move", persistWindowState);
  mainWindow.on("maximize", persistWindowState);
  mainWindow.on("unmaximize", persistWindowState);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function createQuickSearchWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const window = new BrowserWindow({
    width: 560,
    height: 430,
    minWidth: 560,
    minHeight: 430,
    maxWidth: 560,
    maxHeight: 430,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("blur", () => window.hide());
  window.on("closed", () => {
    if (quickSearchWindow === window) quickSearchWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(new URL("quick-search.html", process.env.ELECTRON_RENDERER_URL).toString());
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/quick-search.html"));
  }
  return window;
}

function showQuickSearch(): void {
  if (!quickSearchWindow || quickSearchWindow.isDestroyed()) {
    quickSearchWindow = createQuickSearchWindow();
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = quickSearchWindow.getBounds();
  quickSearchWindow.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
    Math.round(display.workArea.y + Math.min(72, display.workArea.height * 0.08)),
  );
  quickSearchWindow.show();
  quickSearchWindow.focus();
}

function applyDockVisibility(showInDock: boolean): void {
  if (process.platform !== "darwin" || !app.dock) return;
  if (showInDock) app.dock.show();
  else app.dock.hide();
}

async function ensureWslResumePreflight(session: SessionSearchResult): Promise<void> {
  const environment = requireWslEnvironment(session);
  const report = await preflightRemoteSessionResume(environment, session);
  const errors = report.checks.filter((check) => check.status === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((check) => `${check.label}: ${check.message}`).join("\n"));
  }
}

async function resumeWslSession(session: SessionSearchResult): Promise<{ route: "resume" }> {
  const wslOptions = requireWslResumeOptions(session);
  await ensureWslResumePreflight(session);
  await openResumeInTerminal(session, getSettings(), wslOptions);
  store.markResumed(session.sessionKey);
  return { route: "resume" };
}

async function resumeWslSessionInIterm(session: SessionSearchResult): Promise<void> {
  await ensureWslResumePreflight(session);
  await openResumeInSpecificTerminal(session, getSettings(), "iTerm", requireWslResumeOptions(session));
  store.markResumed(session.sessionKey);
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showWindow();
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("focus-search");
}

function registerAppGlobalShortcut(accelerator: string): boolean {
  if (registeredGlobalShortcut === accelerator) return true;

  const previous = registeredGlobalShortcut;
  if (previous) {
    globalShortcut.unregister(previous);
    registeredGlobalShortcut = null;
  }

  if (!accelerator) return true;

  const registered = globalShortcut.register(accelerator, toggleWindow);
  if (registered) {
    registeredGlobalShortcut = accelerator;
    return true;
  }

  if (previous && globalShortcut.register(previous, toggleWindow)) {
    registeredGlobalShortcut = previous;
  }
  return false;
}

function createTray(): void {
  const image = loadTrayIcon();
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: showWindow },
      { label: "快速搜索会话…", click: showQuickSearch },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}

function loadTrayIcon(): Electron.NativeImage {
  const iconPath = resolveAssetPath(TRAY_ICON_RELATIVE_PATH);
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAABU0lEQVQ4Ec2Tu0pDQRCGk2iCighpJSKIVaqANvbaWQdBsZAgWFr5CD6EMRAh4FsIFmm8lIKFAa8kNqmMF6Lm+4+7um62Sghk4GNn/rNnzuzMnlhs2CzuFVQg3oQJT1fYgiMoKvBtxBGU5AAS8OLo1s3gbMAjXFoxtJ4i3kEy9NDo96za12WjjqLjPMM0VGAMrL3hrEMDQseOjmE397W6FdlEtzjbMG6EV9Yr42s4/oDMo7/lHFcswbfHMvExfBldfZqHX3OzK4lMidbArShPvApNaMMUaHpZeIdgjybRF2EBtPEMlOQQaqDJ7sIcrEBkoR7N8EQ90tQ0rROQ3UAu8n58uWkT/1t0bn3Nv0e6tA/wBLoeF1AHHXEWuqyAoiYrmfrlck38CXYItun7aJG5v4iuvRqor/hVfaCpKlVdhj1QC7ZAv1MVerYUb5Zgp+cMA32xA3OAR0Jsy3XjAAAAAElFTkSuQmCC",
  );
}

function resolveAssetPath(relativePath: string): string | null {
  const candidates = [
    path.join(__dirname, "..", "..", relativePath),
    path.join(app.getAppPath(), relativePath),
    path.join(process.resourcesPath, relativePath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function createApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });

  const template: MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { label: `About ${PRODUCT_NAME}`, role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Command+,",
          click: () => {
            showWindow();
            mainWindow?.webContents.send("open-settings");
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${PRODUCT_NAME}`, accelerator: "Command+H", role: "hide" },
        { label: "Hide Others", accelerator: "Command+Alt+H", role: "hideOthers" },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        { label: `Quit ${PRODUCT_NAME}`, accelerator: "Command+Q", click: () => app.quit() },
      ],
    },
    {
      label: "File",
      submenu: [{ role: "close" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Refresh Now", accelerator: "CmdOrCtrl+R", click: () => void runIndexSync() },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function emitEnvironmentsUpdated(): void {
  mainWindow?.webContents.send("environments-updated", store.listEnvironments());
}

function remoteSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureRemoteWatchManager(): RemoteWatchManager {
  if (!remoteWatchManager) {
    remoteWatchManager = new RemoteWatchManager({
      syncEnvironment: (environment) => ensureRemoteEnvironmentLifecycle().syncFromWatcher(environment),
      onSyncError: (environment, error) => {
        store.updateEnvironmentSyncState(environment.id, "error", { lastError: remoteSyncErrorMessage(error) });
        emitEnvironmentsUpdated();
      },
    });
  }
  return remoteWatchManager;
}

function ensureRemoteEnvironmentLifecycle(): RemoteEnvironmentLifecycle {
  if (!remoteEnvironmentLifecycle) {
    remoteEnvironmentLifecycle = new RemoteEnvironmentLifecycle({
      store,
      syncEnvironment: (environment) =>
        syncRemoteEnvironment(store, environment, {
          enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
        }).then(() => undefined),
      watchManager: ensureRemoteWatchManager(),
      onEnvironmentsUpdated: () => emitEnvironmentsUpdated(),
    });
  }
  return remoteEnvironmentLifecycle;
}

async function runIndexSync(): Promise<IndexStatus> {
  if (activeIndexRun) return activeIndexRun;

  const settings = getSettings();
  pruneDisabledOptionalSources(settings);
  indexStatus = { ...indexStatus, running: true, error: null };
  mainWindow?.webContents.send("index-status", indexStatus);

  activeIndexRun = syncDefaultSessionsInBatches(store, {
    batchSize: 2,
    loadOptions: {
      includeClaudeInternal: settings.includeClaudeInternal,
      includeCodexInternal: settings.includeCodexInternal,
      includeTclaude: settings.includeTclaude,
      includeTcodex: settings.includeTcodex,
      includeCodeBuddyCli: settings.includeCodeBuddyCli,
      includeCodeWizCli: settings.includeCodeWizCli,
      includeOpenClaw: settings.includeOpenClaw,
      includeHermes: settings.includeHermes,
      includeOpenCode: settings.includeOpenCode,
      includeZcode: settings.includeZcode,
      includeCursorAgent: settings.includeCursorAgent,
      includeTrae: settings.includeTrae,
      includeQoder: settings.includeQoder,
    },
    onEnvironmentsChanged: emitEnvironmentsUpdated,
    onProgress: (status) => {
      indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
      mainWindow?.webContents.send("index-status", indexStatus);
    },
  })
    .then((status) => {
      indexStatus = status;
      mainWindow?.webContents.send("index-status", indexStatus);
      void maybeAutoBackfillSummaries();
      return indexStatus;
    })
    .catch((error) => {
      indexStatus = {
        running: false,
        indexed: 0,
        skipped: 0,
        total: 0,
        lastIndexedAt: indexStatus.lastIndexedAt,
        error: String(error),
      };
      mainWindow?.webContents.send("index-status", indexStatus);
      return indexStatus;
    })
    .finally(() => {
      ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
      activeIndexRun = null;
    });

  return activeIndexRun;
}

const loadCachedLiveSessionSnapshot = createCachedLiveSessionSnapshotLoader();

let summaryBackfillRunning = false;

const SUMMARY_PROVIDER_ERROR =
  "AI summary has no usable provider. Select Codex, Claude Code, or configure a direct summary API provider in Settings.";

function buildCodexExecEndpoint(settings: AppSettings): SummaryEndpoint {
  return buildCodexExecEndpointShared(settings, {
    onTemporarySession: (sessionKey) => {
      try {
        store.deleteSession(sessionKey);
      } catch {
        // Best-effort cleanup if an ephemeral Codex call is indexed before it exits.
      }
    },
  });
}

async function resolveSummaryEndpointFromSettings(): Promise<SummaryEndpoint | null> {
  const settings = await providerService.hydrateSettings();
  const onTemporarySession = (sessionKey: string): void => {
    try {
      store.deleteSession(sessionKey);
    } catch {
      // Best-effort cleanup if an ephemeral summary call is indexed before it exits.
    }
  };
  if (settings.summarySource === "custom") {
    const endpoint = resolveSummaryEndpointFromSettingsShared(settings, {});
    if (endpoint) return endpoint;
    const codexDefaults = await loadActiveCodexSummaryEndpointDefaults();
    if (codexDefaults) {
      return {
        baseUrl: codexDefaults.baseUrl,
        model: codexDefaults.model,
        apiKey: codexDefaults.apiKey,
        apiFormat: codexDefaults.apiFormat,
      };
    }
    return buildCodexExecEndpointShared(settings, { onTemporarySession });
  }
  return resolveSummaryEndpointFromSettingsShared(settings, { onTemporarySession });
}

const SUMMARY_HEAD_MESSAGES = 24;
const SUMMARY_TAIL_MESSAGES = 16;
// Sessions at or below this many messages are summarized in full.
const SUMMARY_FULL_THRESHOLD = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;

// Short sessions are summarized in full; long ones use a head + tail excerpt so the
// original problem and the final resolution both survive, fetching only a bounded slice.
async function summarizeOneSession(sessionKey: string, endpoint: SummaryEndpoint): Promise<void> {
  const count = store.getMessageCount(sessionKey);
  let excerpt;
  if (count <= SUMMARY_FULL_THRESHOLD) {
    excerpt = { head: store.getMessages(sessionKey, 0, SUMMARY_FULL_THRESHOLD), tail: [], omittedCount: 0 };
  } else {
    excerpt = {
      head: store.getMessages(sessionKey, 0, SUMMARY_HEAD_MESSAGES),
      tail: store.getMessages(sessionKey, count - SUMMARY_TAIL_MESSAGES, SUMMARY_TAIL_MESSAGES),
      omittedCount: count - SUMMARY_HEAD_MESSAGES - SUMMARY_TAIL_MESSAGES,
    };
  }
  const result = await summarizeSession(excerpt, endpoint);
  store.setAiSummary(sessionKey, result.summary, endpoint.model);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function migrationResumeDisplayCommand(target: MigrationTarget, sessionId: string, projectPath: string): string {
  return getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings()).displayCommand;
}

function quotePosixToken(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function fallbackMigrationResumeDisplayCommand(target: MigrationTarget, sessionId: string, projectPath: string): string {
  return getSafeMigrationResumeCommand(target, sessionId, projectPath, getSettings());
}

async function createLocalRemoteRestoreDependencies(
  onProgress: (progress: SessionMigrationProgress) => void,
): Promise<RemoteSessionRestoreDependencies> {
  const settings = await providerService.hydrateSettings();
  const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(settings);
  const compressor = endpoint
    ? createMigrationCompressor(endpoint, undefined, settings.compressionConcurrency)
    : null;

  return {
    inspectCli: (target) => inspectMigrationCli(target, getSettings()),
    prepare: (session, listener) => applyMigrationLengthPolicy(session, compressor, listener),
    write: (target, session) => writeMigratedSession({ target, session }),
    record: (record) => store.recordSessionMigration(record),
    refreshIndex: async (target, writtenFilePath, targetSessionId) => {
      indexStatus = indexMigratedSessionFile(store, target, writtenFilePath, targetSessionId);
      mainWindow?.webContents.send("index-status", indexStatus);
    },
    launch: (target, targetSessionId, projectPath) =>
      openMigrationResumeInTerminal(target, targetSessionId, projectPath, getSettings()),
    resumeCommand: migrationResumeDisplayCommand,
    fallbackResumeCommand: fallbackMigrationResumeDisplayCommand,
    onProgress,
    idFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: pathExists,
    projectPathIsDirectory: pathIsDirectory,
  };
}

async function createSourceRemoteRestoreDependencies(
  environment: SessionEnvironment,
  onProgress: (progress: SessionMigrationProgress) => void,
): Promise<RemoteSessionRestoreDependencies> {
  const settings = await providerService.hydrateSettings();
  const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(settings);
  const compressor = endpoint
    ? createMigrationCompressor(endpoint, undefined, settings.compressionConcurrency)
    : null;

  return {
    inspectCli: async () => undefined,
    prepare: (session, listener) => applyMigrationLengthPolicy(session, compressor, listener),
    write: (target, session) => writeMigratedSessionToSshEnvironment(environment, target, session),
    record: (record) => store.recordSessionMigration(record),
    refreshIndex: async () => {
      await syncRemoteEnvironment(store, environment, {
        enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
      });
      mainWindow?.webContents.send("environments-updated", store.listEnvironments());
    },
    launch: async () => undefined,
    resumeCommand: (target, targetSessionId, projectPath) =>
      remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
    fallbackResumeCommand: (target, targetSessionId, projectPath) =>
      remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
    onProgress,
    idFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: (projectPath) => remotePathExists(environment, projectPath),
    projectPathIsDirectory: (projectPath) => remotePathIsDirectory(environment, projectPath),
  };
}

function remoteMigrationResumeDisplayCommand(
  environment: SessionEnvironment,
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): string {
  const remoteCommand = getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings(), { platform: "linux" }).displayCommand;
  return ["ssh", ...buildRemoteSyncSshArgs(environment, remoteCommand).map(quotePosixToken)].join(" ");
}

function localSessionMigrationRuntime(event: IpcMainInvokeEvent) {
  return {
    resolveSummaryEndpoint: (snapshot: AppSettings) => resolveSummaryEndpointFromSettingsShared(snapshot, {
      onTemporarySession: (temporarySessionKey) => {
        try {
          store.deleteSession(temporarySessionKey);
        } catch {
          // Best-effort cleanup if an ephemeral summary call is indexed before it exits.
        }
      },
    }) ?? buildCodexExecEndpoint(snapshot),
    createCompressor: (endpoint: SummaryEndpoint, concurrency: number) =>
      createMigrationCompressor(endpoint, undefined, concurrency),
    migrate: migrateSession,
    inspectCli: (migrationTarget: MigrationTarget, snapshot: AppSettings) => inspectMigrationCli(migrationTarget, snapshot),
    prepare: (portable: PortableSession, onProgress: Parameters<typeof applyMigrationLengthPolicy>[2], compressor: ReturnType<typeof createMigrationCompressor> | null) =>
      applyMigrationLengthPolicy(portable, compressor, onProgress),
    write: (migrationTarget: MigrationTarget, portable: PortableSession) =>
      writeMigratedSession({ target: migrationTarget, session: portable }),
    record: (record: Parameters<SessionStore["recordSessionMigration"]>[0]) => store.recordSessionMigration(record),
    refreshIndex: async (migrationTarget: MigrationTarget, writtenFilePath: string, targetSessionId: string) => {
      const status = indexMigratedSessionFile(store, migrationTarget, writtenFilePath, targetSessionId);
      indexStatus = status;
      mainWindow?.webContents.send("index-status", indexStatus);
    },
    launch: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      openMigrationResumeInTerminal(migrationTarget, targetSessionId, projectPath, snapshot),
    resumeCommand: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      getMigrationResumeProcessSpec(migrationTarget, targetSessionId, projectPath, snapshot).displayCommand,
    fallbackResumeCommand: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      getSafeMigrationResumeCommand(migrationTarget, targetSessionId, projectPath, snapshot),
    onProgress: (progress: Parameters<NonNullable<import("../core/session-migration").SessionMigrationDependencies["onProgress"]>>[0]) =>
      event.sender.send("session:migration-progress", progress),
    idFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: pathExists,
    projectPathIsDirectory: pathIsDirectory,
  };
}

async function writeMigratedSessionToSshEnvironment(
  environment: SessionEnvironment,
  target: MigrationAgent,
  session: PortableSession,
): Promise<{ sessionId: string; filePath: string }> {
  const now = new Date();
  const tempHome = await fs.mkdtemp(path.join(app.getPath("temp"), "agent-session-remote-restore-"));
  try {
    const written = await writeMigratedSession({ target, session, homeDir: tempHome, now });
    const remoteHome = await remoteHomeDir(environment);
    const remotePath = targetFilePath(target, session.projectPath, written.sessionId, remoteHome, now);
    const content = await fs.readFile(written.filePath);
    await runRemotePython(environment, REMOTE_WRITE_FILE_SCRIPT, {
      path: remotePath,
      contentBase64: content.toString("base64"),
    });
    return { sessionId: written.sessionId, filePath: remotePath };
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function remoteHomeDir(environment: SessionEnvironment): Promise<string> {
  const output = await runRemotePython(environment, "from pathlib import Path\nprint(Path.home())", {});
  const home = output.trim();
  if (!home) throw new Error("Could not resolve remote home directory.");
  return home;
}

async function remotePathExists(environment: SessionEnvironment, targetPath: string): Promise<boolean> {
  return (await runRemotePathCheck(environment, targetPath, "exists")) === "true";
}

async function remotePathIsDirectory(environment: SessionEnvironment, targetPath: string): Promise<boolean> {
  return (await runRemotePathCheck(environment, targetPath, "is_dir")) === "true";
}

async function runRemotePathCheck(environment: SessionEnvironment, targetPath: string, check: "exists" | "is_dir"): Promise<string> {
  const output = await runRemotePython(
    environment,
    [
      "import json, sys",
      "from pathlib import Path",
      "payload = json.load(sys.stdin)",
      "path = Path(payload['path'])",
      "check = payload['check']",
      "print('true' if (path.exists() if check == 'exists' else path.is_dir()) else 'false')",
    ].join("\n"),
    { path: targetPath, check },
  );
  return output.trim();
}

function runRemotePython(environment: SessionEnvironment, script: string, payload: unknown): Promise<string> {
  const remoteCommand = buildPythonBase64Command(script);
  return runRemoteWithInput(environment, remoteCommand, `${JSON.stringify(payload)}\n`);
}

function runSshWithInput(environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> {
  const args = buildRemoteSyncSshArgs(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", args, { maxBuffer: 128 * 1024 * 1024, timeout: 90_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

function runRemoteWithInput(environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> {
  return environment.kind === "wsl"
    ? runRemoteCommandWithInput(environment, remoteCommand, input, REMOTE_PROCESS_EXEC_OPTIONS)
    : runSshWithInput(environment, remoteCommand, input);
}

function buildPythonBase64Command(script: string): string {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const compressed = zlib.deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  return `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
}

const REMOTE_WRITE_FILE_SCRIPT = [
  "import base64, json, os, sys, uuid",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "target = Path(payload['path'])",
  "content = base64.b64decode(payload['contentBase64'])",
  "target.parent.mkdir(parents=True, exist_ok=True)",
  "tmp = target.with_name(target.name + '.tmp-' + uuid.uuid4().hex)",
  "tmp.write_bytes(content)",
  "os.chmod(tmp, 0o600)",
  "os.replace(tmp, target)",
  "print(str(target))",
].join("\n");

async function maybeAutoBackfillSummaries(): Promise<void> {
  if (summaryBackfillRunning) return;
  const settings = getSettings();
  if (!settings.summaryAutoBackfill) return;
  const endpoint = await resolveSummaryEndpointFromSettings();
  if (!endpoint) return;
  summaryBackfillRunning = true;
  try {
    const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
    const candidates = store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 25);
    for (const candidate of candidates) {
      try {
        await summarizeOneSession(candidate.sessionKey, endpoint);
      } catch {
        // Skip sessions the provider cannot summarize; keep going.
      }
    }
  } finally {
    summaryBackfillRunning = false;
  }
}

function startAutoIndexRefresh(): void {
  if (autoIndexTimer) return;
  autoIndexTimer = setInterval(() => {
    void runIndexSync();
  }, AUTO_INDEX_REFRESH_INTERVAL_MS);
}

function stopAutoIndexRefresh(): void {
  if (!autoIndexTimer) return;
  clearInterval(autoIndexTimer);
  autoIndexTimer = null;
}

function registerIpc(): void {
  ipcMain.handle("markdown:open-external", (_event, value: unknown) => {
    const url = normalizeExternalLink(value);
    if (!url) throw new Error("Only HTTP, HTTPS, and mailto links can be opened externally.");
    return shell.openExternal(url);
  });
  ipcMain.handle("search:sessions", (_event, options: SearchOptions) => store.searchSessions(visibleSearchOptions(options)));
  ipcMain.handle("search:session-page", (_event, options: SearchOptions) => store.searchSessionPage(visibleSearchOptions(options)));
  ipcMain.handle("session:get", (_event, sessionKey: string) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:messages", async (_event, sessionKey: string, offset?: number, limit?: number) => {
    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? 120;
    const session = store.getSession(sessionKey);
    if (session && !isLocalSessionStorage(session) && !hasHydratedRemoteDetails(sessionKey)) {
      if (session.messageCount <= 0) return [];
      const environment = session.environmentKind === "wsl"
        ? requireWslEnvironment(session)
        : requireRemoteSshEnvironment(session);
      if (!environment) return [];
      return fetchRemoteSessionMessagePage(environment, session, pageOffset, pageLimit);
    }
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    return store.getMessages(sessionKey, pageOffset, pageLimit);
  });
  ipcMain.handle("attachment:preview", async (_event, sessionKey: string, attachmentId: string) => {
    const attachment = store.getAttachmentFile(sessionKey, attachmentId);
    if (!attachment) throw new Error("Attachment is unavailable.");
    if (attachment.previewKind === "image") {
      const bytes = await fs.readFile(attachment.cachePath);
      return { kind: "image", data: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
    }
    if (attachment.previewKind === "text") {
      const text = await fs.readFile(attachment.cachePath, "utf8");
      return { kind: "text", data: text.slice(0, 256 * 1024) };
    }
    const error = await shell.openPath(attachment.cachePath);
    if (error) throw new Error(error);
    return { kind: "external" };
  });
  ipcMain.handle("attachment:open", async (_event, sessionKey: string, attachmentId: string) => {
    const attachment = store.getAttachmentFile(sessionKey, attachmentId);
    if (!attachment) throw new Error("Attachment is unavailable.");
    const error = await shell.openPath(attachment.cachePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle("session:trace-events", async (_event, sessionKey: string, options?: TraceEventQueryOptions) => {
    const session = store.getSession(sessionKey);
    if (session && !isLocalSessionStorage(session) && !hasHydratedRemoteDetails(sessionKey)) return [];
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    return store.getTraceEvents(sessionKey, options);
  });
  ipcMain.handle("sessions:live", () => loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae, includeQoder: getSettings().includeQoder }));
  ipcMain.handle("session:summarize", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const endpoint = await resolveSummaryEndpointFromSettings();
    if (!endpoint) {
      throw new Error(SUMMARY_PROVIDER_ERROR);
    }
    await summarizeOneSession(sessionKey, endpoint);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:summarize-missing", async (event) => {
    const endpoint = await resolveSummaryEndpointFromSettings();
    if (!endpoint) {
      throw new Error(SUMMARY_PROVIDER_ERROR);
    }
    const settings = getSettings();
    const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
    // Cover all missing/stale sessions in the age window in one run (bounded for
    // safety). Failed ones stay missing and are retried on the next run.
    const candidates = store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 500);
    const total = candidates.length;
    let processed = 0;
    let failed = 0;
    let next = 0;
    const sendProgress = (): void => {
      event.sender.send("summary:progress", { processed, failed, total });
    };
    sendProgress();
    // A few in parallel so a large backlog finishes in reasonable wall time; each
    // request is individually time-bounded, so one slow provider can't stall it.
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const candidate = candidates[next++];
        try {
          await summarizeOneSession(candidate.sessionKey, endpoint);
          processed += 1;
        } catch {
          failed += 1;
        }
        sendProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    return { processed, failed, total };
  });
  ipcMain.handle("ai:assistant-chat", async (_event, messages: AiChatMessage[]) => {
    // The assistant shares the summary provider routing. When the user picked a
    // direct API provider but left it incomplete, fall back to the local Codex
    // CLI so the assistant still works out of the box.
    const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(await providerService.hydrateSettings());

    // Local CLI providers (codex exec / claude) can't do HTTP function calling.
    // Fall back to: keyword-search the store with the user's words, then let the
    // CLI write a grounded answer over the hits.
    if (isLocalCliEndpoint(endpoint)) {
      const search = async (query: string): Promise<FallbackSessionHit[]> => {
        const sessions = store.searchSessions(visibleSearchOptions({ query, limit: 12 }));
        return sessions.map((session) => ({
          sessionKey: session.sessionKey,
          title: session.displayTitle,
          source: session.source,
          project: session.projectPath,
          summary: session.aiSummary ?? session.firstQuestion ?? null,
        }));
      };
      const { reply, sessionKeys } = await runAiAssistantFallback(endpoint, messages, search);
      const sessions = sessionKeys
        .map((key) => store.getSession(key))
        .filter((session): session is SessionSearchResult => session !== null);
      return { reply, sessions };
    }
    // The model's tool calls run against the local SessionStore — the same data
    // the MCP server exposes. We collect surfaced sessionKeys so the renderer can
    // hydrate full results into clickable cards.
    const executeTool = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      switch (name) {
        case "search_sessions": {
          const query = typeof args.query === "string" ? args.query : "";
          const source = typeof args.source === "string" && args.source ? args.source : undefined;
          const projectPath = typeof args.project === "string" && args.project ? args.project : undefined;
          const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
          const sessions = store.searchSessions(visibleSearchOptions({
            query,
            source: source as SearchOptions["source"],
            projectPath,
            limit,
          }));
          return {
            result: sessions.map((session) => ({
              sessionKey: session.sessionKey,
              title: session.displayTitle,
              source: session.source,
              project: session.projectPath,
              timestamp: session.timestamp,
              summary: session.aiSummary ?? session.firstQuestion ?? null,
            })),
            sessionKeys: sessions.map((session) => session.sessionKey),
          };
        }
        case "list_projects": {
          const projects = store.listProjects(visibleProjectOptions());
          return {
            result: projects.map((project) => ({ project: project.path, sessions: project.sessionCount })),
            sessionKeys: [],
          };
        }
        case "list_tags": {
          return { result: store.listTags(), sessionKeys: [] };
        }
        case "get_session": {
          const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
          if (!sessionKey) return { result: { error: "sessionKey is required." }, sessionKeys: [] };
          await ensureRemoteSessionDetailsLoaded(sessionKey);
          const session = store.getSession(sessionKey);
          if (!session) return { result: { error: "Session not found." }, sessionKeys: [] };
          const maxMessages = typeof args.maxMessages === "number" ? Math.max(1, Math.min(200, Math.floor(args.maxMessages))) : 40;
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const messageList = store.getMessages(sessionKey, offset, maxMessages);
          return {
            result: {
              sessionKey: session.sessionKey,
              title: session.displayTitle,
              source: session.source,
              project: session.projectPath,
              timestamp: session.timestamp,
              summary: session.aiSummary,
              totalMessages: session.messageCount,
              messages: messageList.map((message) => ({ role: message.role, content: message.content })),
            },
            sessionKeys: [session.sessionKey],
          };
        }
        default:
          return { result: { error: `Unknown tool: ${name}` }, sessionKeys: [] };
      }
    };

    const { reply, sessionKeys } = await runAiAssistantTurn(endpoint, messages, executeTool);
    const sessions = sessionKeys
      .map((key) => store.getSession(key))
      .filter((session): session is SessionSearchResult => session !== null);
    return { reply, sessions };
  });
  ipcMain.handle("mcp:status", () => {
    try {
      return ensureAgentRecallMcpPreference();
    } catch {
      return false;
    }
  });
  ipcMain.handle("mcp:set-enabled", (_event, enabled: boolean) => {
    const setup = loadMcpSetup();
    setup.run(!enabled);
    settingsStore.set("sessionSearchMcpEnabled", enabled);
    return setup.status();
  });
  ipcMain.handle("stats:get", (_event, options?: SessionStatsOptions) => store.getStats(visibleStatsOptions(options)));
  ipcMain.handle("stats:trend", (_event, options?: SessionStatsOptions) => store.getStatsTrend(visibleStatsOptions(options)));
  ipcMain.handle("tags:list", (_event, options?: TagListOptions) =>
    store.listTags({ ...visibleProjectOptions(), ...options }),
  );
  ipcMain.handle("projects:list", (_event, options?: ProjectQueryOptions) =>
    store.listProjects({ ...visibleProjectOptions(), ...options }),
  );
  ipcMain.handle("tags:by-project", () => store.listTagsByProject(visibleProjectOptions()));
  ipcMain.handle("environments:list", () => store.listEnvironments());
  ipcMain.handle("ssh-config:list-hosts", () => readUserSshConfig());
  ipcMain.handle("wsl:list-distributions", () => listWslDistributions());
  ipcMain.handle("environment:save", (_event, input: EnvironmentUpsertInput) =>
    ensureRemoteEnvironmentLifecycle().saveEnvironment(input),
  );
  ipcMain.handle("environment:delete", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().deleteEnvironment(environmentId),
  );
  ipcMain.handle("environment:refresh", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().refreshEnvironment(environmentId),
  );
  ipcMain.handle("environment:diagnose", (_event, environmentId: string) => {
    const environment = store.getEnvironment(environmentId);
    if (environment?.kind === "wsl") return diagnoseRemoteEnvironment(environment);
    return diagnoseRemoteEnvironment(requireSshEnvironment(environmentId));
  });
  ipcMain.handle("title:set", (_event, sessionKey: string, title: string | null) =>
    setSessionCustomTitleAndSyncTerminal(sessionKey, title, {
      getSession: (key) => store.getSession(key),
      setCustomTitle: (key, customTitle) => store.setCustomTitle(key, customTitle),
      loadLiveSessions: () => loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae, includeQoder: getSettings().includeQoder }),
      setLiveTerminalTitle: (pid, displayTitle) => setLiveSessionTerminalTitle(pid, displayTitle),
      onSyncError: (error) => console.warn("[terminal-title] Could not synchronize live terminal title.", error),
    }),
  );
  ipcMain.handle("tag:add", (_event, sessionKey: string, tagName: string) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey: string, tagName: string) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName: string) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey: string, pinned: boolean) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey: string, hidden: boolean) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("session:delete", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session || session.environmentKind !== "wsl") return store.deleteSession(sessionKey);
    await deleteWslSessionFile(requireWslEnvironment(session), session.filePath);
    return store.deleteSessionRecord(sessionKey);
  });
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("quick-search:open-session", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) throw new Error("Session was not found.");
    store.markOpened(sessionKey);
    quickSearchWindow?.hide();
    showWindow();
    mainWindow?.webContents.send("open-session", sessionKey);
  });
  registerAppUpdateIpc(ipcMain, appUpdateService);
  registerQuotaIpc(ipcMain, quotaService);
  ipcMain.handle("settings:get", () => providerService.hydrateSettings());
  registerProvidersIpc(ipcMain, providerService);
  ipcMain.handle("settings:set", async (_event, settings: AppSettingsUpdate) => {
    const previous = getSettings();
    const next = mergeAppSettings(previous, settings);
    if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
      throw new Error(
        `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
      );
    }
    if ("remoteSyncEnabled" in settings && !next.remoteSyncEnabled) {
      remoteSessionService.disableSync();
    }
    providerService.persistKeysFromUpdate(settings, next);
    settingsStore.set(providerService.removeStoredKeys(next));
    if ("autoCheckUpdates" in settings) await appUpdateService.setAutoCheckEnabled(next.autoCheckUpdates);
    if ("showInDock" in settings) applyDockVisibility(next.showInDock);
    pruneDisabledOptionalSources(next);
    return providerService.addStoredKeys(next);
  });
  registerSkillsIpc(ipcMain, skillService);
  registerRulesIpc(ipcMain, createRulesSyncService());
  registerMemoriesIpc(ipcMain, createMemoriesSyncService());
  registerDiscoveryIpc(ipcMain, createDiscoveryService());
  ipcMain.handle("supabase:copy-combined-setup-sql", () => {
    clipboard.writeText(buildCombinedSupabaseSetupSql());
  });
  ipcMain.handle("supabase:open-sql-editor", (_event, target: unknown) => {
    const settings = getSettings();
    const projectUrl = target === "skills" ? settings.skillSyncSupabaseUrl : settings.remoteSyncSupabaseUrl;
    return shell.openExternal(supabaseSqlEditorUrl(projectUrl));
  });
  registerRemoteSessionsIpc(ipcMain, remoteSessionService);
  ipcMain.handle("command:copy-resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    if (session.environmentKind === "wsl") {
      clipboard.writeText(getResumeCommand(session, getSettings(), requireWslResumeOptions(session)));
      return;
    }
    clipboard.writeText(getResumeCommand(session, getSettings(), { sshArgs: requireSshArgsForRemoteSession(session) }));
  });
  ipcMain.handle("command:resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return { route: "resume" as const };
    if (session.environmentKind === "wsl") return resumeWslSession(session);
    const sshArgs = requireSshArgsForRemoteSession(session);
    if (!isLocalSessionEnvironment(session)) {
      await ensureRemoteResumePreflight(session);
      await openResumeInTerminal(session, getSettings(), { sshArgs });
      store.markResumed(sessionKey);
      return { route: "resume" as const };
    }
    const snapshot = await loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae, includeQoder: getSettings().includeQoder });
    const route = routeResumeSession(session, snapshot.error ? [] : snapshot.sessions);
    if (route.route === "app") {
      await openNativeApp(session, { openExternal: (url) => shell.openExternal(url) });
      store.markResumed(sessionKey);
      return route;
    }
    if (route.route === "focus") {
      await focusLiveSessionTerminal(route.pid);
      store.markResumed(sessionKey);
      return route;
    }
    await openResumeInTerminal(session, getSettings(), { sshArgs });
    store.markResumed(sessionKey);
    return route;
  });
  ipcMain.handle("command:resume-iterm", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    if (session.environmentKind === "wsl") return resumeWslSessionInIterm(session);
    const sshArgs = requireSshArgsForRemoteSession(session);
    await ensureRemoteResumePreflight(session);
    await openResumeInSpecificTerminal(session, getSettings(), "iTerm", { sshArgs });
    store.markResumed(sessionKey);
  });
  ipcMain.handle("session:migrate", async (event, sessionKey: string, target: unknown) => {
    const session = store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    const messages = store.getAllMessages(sessionKey);
    const settings = Object.freeze(await providerService.hydrateSettings());

    return runLocalSessionMigration({
      source: session,
      messages,
      target,
      settings,
    }, localSessionMigrationRuntime(event));
  });
  ipcMain.handle("command:open-app", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSessionEnvironment(session)) return false;
    await openNativeApp(session, { openExternal: (url) => shell.openExternal(url) });
    return true;
  });
  ipcMain.handle("command:reveal", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSessionEnvironment(session)) return false;
    await revealInFileManager(session.projectPath || session.filePath);
    return true;
  });
  ipcMain.handle("command:copy-markdown", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
  ipcMain.handle("command:export-markdown", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return false;
    const exportPath = await chooseMarkdownExportPath(exportFileName(session.displayTitle || session.originalTitle || session.rawId, "md"));
    if (!exportPath) return false;
    await fs.writeFile(exportPath, formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)), "utf-8");
    return true;
  });
  ipcMain.handle("command:export-json", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return { exported: false };
    const format = await chooseJsonExportFormat();
    if (!format) return { exported: false };
    const exportPath = await chooseJsonExportPath(exportFileName(session.displayTitle || session.originalTitle || session.rawId, "json"));
    if (!exportPath) return { exported: false };

    let codexRequest: CodexRequestExport | null = null;
    const isCodexSession = ["codex-cli", "codex-app", "codex-internal", "tcodex-cli"].includes(session.source);
    if (isCodexSession && isLocalSessionEnvironment(session)) {
      if (format === "openai_responses") {
        codexRequest = await resolveCodexResponsesRequest({
          filePath: session.filePath,
          rawId: session.rawId,
          traceRoot: process.env.CODEX_ROLLOUT_TRACE_ROOT?.trim() || undefined,
        });
      } else {
        const reconstructed = await reconstructCodexResponsesRequest(session.filePath);
        if (reconstructed) codexRequest = { body: reconstructed, fidelity: "reconstructed" };
      }
    }
    const fidelity: CodexRequestFidelity = codexRequest?.fidelity ?? "normalized";
    await fs.writeFile(
      exportPath,
      formatSessionJson(store.getAllMessages(sessionKey), format, codexRequest?.body),
      "utf-8",
    );
    const fidelityMessage = fidelity === "exact-trace"
      ? "Exact Codex request body captured from CODEX_ROLLOUT_TRACE_ROOT."
      : fidelity === "reconstructed"
        ? "Request body reconstructed from the Codex rollout history."
        : "Request body exported in normalized message format.";
    const fidelityMessageZh = fidelity === "exact-trace"
      ? "已从 CODEX_ROLLOUT_TRACE_ROOT 导出 Codex 原始请求体。"
      : fidelity === "reconstructed"
        ? "已根据 Codex rollout 历史重建请求体。"
        : "已按标准消息格式导出请求体。";
    const notice: Electron.MessageBoxOptions = {
      type: "info",
      title: "JSON Export Complete",
      message: fidelityMessage,
      detail: `${fidelityMessageZh}\n\n${exportPath}`,
      buttons: ["OK"],
      noLink: true,
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, notice);
    else await dialog.showMessageBox(notice);
    return { exported: true, fidelity };
  });
  ipcMain.handle("command:copy-plain", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionPlainText(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // second-instance can fire before whenReady resolves; defer to avoid
    // creating a BrowserWindow before Electron is fully initialized.
    app.whenReady().then(() => showWindow());
  });
}

app.whenReady().then(() => {
  void appUpdateService.registerRunningProcess();
  const dbPath = path.join(app.getPath("userData"), "session-search.sqlite");
  store = new SessionStore(dbPath);
  quotaService = createQuotaService();
  // Publish the live database path so the standalone MCP server can find it.
  try {
    writeDbPointer(dbPath);
  } catch {
    // Non-fatal: the MCP server can still be pointed at the DB via env var.
  }
  try {
    ensureAgentRecallMcpPreference();
  } catch (error) {
    console.error(`Failed to configure session search MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  providerService.migrateLegacyKeys();
  pruneDisabledOptionalSources(getSettings());
  registerIpc();
  quotaService.start();
  createApplicationMenu();
  createWindow();
  createTray();
  applyDockVisibility(getSettings().showInDock);
  void appUpdateService.showPreviousUpdateResult();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
  void providerService.restoreCodexChatProxy();
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
  skillService.startUsageRefresh();
  remoteSessionService.startQueue();
  appUpdateService.scheduleInitialCheck();
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", () => {
  void appUpdateService.clearRunningProcess();
  stopAutoIndexRefresh();
  skillService.stopUsageRefresh();
  remoteSessionService.stopQueue();
  quotaService?.stop();
  remoteEnvironmentLifecycle?.stopAll();
  void providerService.stopCodexChatProxy();
  globalShortcut.unregisterAll();
  store?.close();
});
