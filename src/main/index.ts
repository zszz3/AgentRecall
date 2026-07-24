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
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { loadActiveCodexSummaryEndpointDefaults } from "../core/codex-profile";
import type { CodexRequestFidelity } from "../core/codex-request-export";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import type { SessionJsonExportFormat } from "../core/format-session";
import { normalizeExternalLink } from "../core/external-link";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
  normalizeTerminal,
  openMigrationResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { setLiveSessionTerminalTitle } from "../core/session-focus";
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
import { writeDatabaseUrlPointer } from "../core/app-paths";
import { PostgresDatabase } from "../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../core/postgres/schema";
import { diagnoseRemoteEnvironment } from "../core/remote-health";
import { buildRemoteSyncSshArgs, fetchRemoteSessionMessagePage, syncRemoteEnvironment } from "../core/remote-sync";
import { REMOTE_PROCESS_EXEC_OPTIONS, runRemoteCommandWithInput } from "../core/remote-process";
import type { RemoteSessionRestoreDependencies } from "../core/remote-session-restore";
import { RemoteEnvironmentLifecycle } from "../core/remote-environment-lifecycle";
import { RemoteWatchManager } from "../core/remote-watch";
import { SessionStore } from "../core/session-store";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "../core/supabase-setup";
import { readUserSshConfig } from "../core/ssh-config";
import { listWslDistributions } from "../core/wsl";
import { deleteWslSessionFile } from "../core/wsl-session-actions";
import { AUTO_INDEX_REFRESH_INTERVAL_MS, INITIAL_INDEX_DELAY_MS } from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../core/session-sources";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";
import { registerAgentMemoryIpc } from "./ipc/agent-memory";
import { registerAutomationIpc } from "./ipc/automation";
import { registerTeamChatIpc } from "./ipc/team-chat";
import { registerAppUpdateIpc } from "./ipc/app-update";
import { registerProvidersIpc } from "./ipc/providers";
import { registerRemoteSessionsIpc } from "./ipc/remote-sessions";
import { registerMemoriesIpc, type MemoriesIpcService } from "./ipc/memories";
import { registerDiscoveryIpc, type DiscoveryIpcService } from "./ipc/discovery";
import { registerRulesIpc, type RulesIpcService } from "./ipc/rules";
import { registerSkillsIpc } from "./ipc/skills";
import { registerSessionCatalogIpc } from "./ipc/session-catalog";
import { registerSessionCommandIpc } from "./ipc/session-commands";
import {
  AppUpdateService,
  launchDetachedAppUpdateInstaller,
  type AppUpdateClient,
} from "./services/app-update-service";
import { AgentMemoryService } from "./services/agent-memory-service";
import { NativeAutomationService } from "./services/automation-service";
import { createLocalTextFilePreviewUnderRoots } from "../automation/engine/main/platform/local-file-preview";
import { ProviderService } from "./services/provider-service";
import {
  RemoteSessionService,
  type SessionSyncHookSetup,
} from "./services/remote-session-service";
import { buildMemoriesSyncSetupSql, memoryIdentity, scanLocalMemories, SupabaseMemoriesSyncClient } from "../core/memories-sync";
import { buildRulesSyncSetupSql, restoreGlobalRules, ruleIdentity, scanLocalRules, SupabaseRulesSyncClient } from "../core/rules-sync";
import { SkillService, type SkillUsageHookSetup } from "./services/skill-service";
import { SessionCatalogService } from "./services/session-catalog-service";
import { SessionCommandService } from "./services/session-command-service";
import { RemoteSessionAccess } from "./services/remote-session-access";
import { bootstrapApplicationPaths } from "./app-path-bootstrap";
import { startPostgresRuntime, type PostgresRuntime } from "./postgres/managed-postgres";
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

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-recall");
bootstrapApplicationPaths({
  app,
  productName: PRODUCT_NAME,
  legacyProductNames: [
    ["Agent", "Session", "Search"].join("-"),
    ["agent", "session", "search"].join("-"),
  ],
});

let mainWindow: BrowserWindow | null = null;
let automationService: NativeAutomationService | null = null;
let disposeAutomationIpc: (() => void) | null = null;
let disposeTeamChatIpc: (() => void) | null = null;
let automationQuitReady = false;
let postgresRuntime: PostgresRuntime | null = null;
let postgresDatabase: PostgresDatabase | null = null;
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun: Promise<IndexStatus> | null = null;
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let registeredGlobalShortcut: string | null = null;
let remoteWatchManager: RemoteWatchManager | null = null;
let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;

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

function bundledAutomationWorkflowsPath(): string {
  const candidates = [
    path.join(app.getAppPath(), "assets", "automation", "bundled-workflows"),
    path.join(app.getAppPath(), "src", "automation", "engine", "shared", "bundled-workflows"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function createAutomationService(): NativeAutomationService {
  if (!postgresDatabase) throw new Error("PostgreSQL must be ready before automation starts.");
  return new NativeAutomationService({
    database: postgresDatabase,
    userDataPath: app.getPath("userData"),
    homePath: app.getPath("home"),
    appDataPath: app.getPath("appData"),
    bundledWorkflowsPath: bundledAutomationWorkflowsPath(),
    workflowMcpServerPath: path.join(app.getAppPath(), "out", "mcp", "workflow-entry.js"),
  });
}

async function pickAutomationDirectory(defaultPath?: string): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose workflow directory",
    defaultPath: defaultPath || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

const appUpdateService = new AppUpdateService({
  getClient: loadUpdateClient,
  releaseRuntime: releaseUpdateRuntime,
  getAutoCheckEnabled: () => getSettings().autoCheckUpdates,
  autoCheckDisabled: () => process.env.AGENT_RECALL_NO_UPDATE_CHECK === "1",
  publishStatus: (status) => mainWindow?.webContents.send(APP_UPDATE_EVENTS.status, status),
  launchInstaller: (manifest) => launchDetachedAppUpdateInstaller(manifest, { applyUpdatePath: APPLY_UPDATE_PATH }),
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
  libraryRoot: path.join(app.getPath("userData"), "skills"),
  skillsShCachePath: path.join(app.getPath("userData"), "cache", "skills-sh.json"),
  homeDir: app.getPath("home"),
  codexHome: process.env.CODEX_HOME,
  resolveAiEndpoint: async () =>
    (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(await providerService.hydrateSettings()),
  copyText: (text) => clipboard.writeText(text),
  revealPath: (targetPath) => revealInFileManager(targetPath),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

const agentMemoryService = new AgentMemoryService({
  chooseDirectory: chooseAgentMemoryDirectory,
});

const remoteSessionAccess = new RemoteSessionAccess({
  getStore: () => store,
});

const remoteSessionService = new RemoteSessionService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSessionSyncHookSetup,
  ensureSessionDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
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
  const projectDirs = async () =>
    (await store.listProjects(visibleProjectOptions())).map((project) => project.path);
  const createClient = () => {
    const settings = getSettings();
    return new SupabaseRulesSyncClient({ url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey });
  };
  return {
    async getSyncSnapshot() {
      const settings = getSettings();
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
      if (!settings.rulesSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
        return { status: { kind: "unconfigured" as const, setupSql: buildRulesSyncSetupSql() }, localRules, remoteRules: [], scannedAt: Date.now() };
      }
      const client = createClient();
      const status = await client.checkStatus();
      const remoteRules = status.kind === "ready" ? await client.listRemoteRules() : [];
      return { status, localRules, remoteRules, scannedAt: Date.now() };
    },
    async upload(identity) {
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
      const rule = localRules.find((r) => ruleIdentity(r) === identity);
      if (!rule) throw new Error("Rule not found locally.");
      return createClient().uploadRule(rule);
    },
    async uploadAll() {
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
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
  };
}

function visibleStatsOptions(options: SessionStatsOptions = {}): SessionStatsOptions {
  return { ...options, excludeSubagents: getSettings().hideSubagentSessions };
}

function visibleProjectOptions(): { excludeSubagents: boolean } {
  return { excludeSubagents: getSettings().hideSubagentSessions };
}

async function pruneDisabledOptionalSources(settings: AppSettings): Promise<void> {
  const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
  await store.deleteSessionsBySource(disabledSources);
}

function enabledRemoteOptionalSources(settings: AppSettings): SessionSource[] {
  return OPTIONAL_SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.remoteCollectorOptional && settings[descriptor.optionalSetting])
    .map((descriptor) => descriptor.id);
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

async function showJsonExportNotice(
  exportPath: string,
  fidelity: CodexRequestFidelity,
): Promise<void> {
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

async function chooseAgentMemoryDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a directory for Agent memory",
    properties: ["openDirectory"],
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

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showWindow({ focusSearch: true });
}

function showWindow(options: { focusSearch?: boolean } = {}): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  if (options.focusSearch) mainWindow.webContents.send("focus-search");
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
      { label: `Open ${PRODUCT_NAME}`, click: () => showWindow() },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showWindow());
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

function emitEnvironmentsUpdated(environments: SessionEnvironment[]): void {
  mainWindow?.webContents.send("environments-updated", environments);
}

function remoteSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureRemoteWatchManager(): RemoteWatchManager {
  if (!remoteWatchManager) {
    remoteWatchManager = new RemoteWatchManager({
      syncEnvironment: (environment) => ensureRemoteEnvironmentLifecycle().syncFromWatcher(environment),
      onSyncError: (environment, error) => {
        void store.updateEnvironmentSyncState(
          environment.id,
          "error",
          { lastError: remoteSyncErrorMessage(error) },
        ).then(() => store.listEnvironments())
          .then(emitEnvironmentsUpdated)
          .catch(() => undefined);
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
      onEnvironmentsUpdated: emitEnvironmentsUpdated,
    });
  }
  return remoteEnvironmentLifecycle;
}

async function runIndexSync(): Promise<IndexStatus> {
  if (activeIndexRun) return activeIndexRun;

  const settings = getSettings();
  await pruneDisabledOptionalSources(settings);
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
      void ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
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
      void store.deleteSession(sessionKey).catch(() => undefined);
    },
  });
}

async function resolveSummaryEndpointFromSettings(): Promise<SummaryEndpoint | null> {
  const settings = await providerService.hydrateSettings();
  const onTemporarySession = (sessionKey: string): void => {
    void store.deleteSession(sessionKey).catch(() => undefined);
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
  const count = await store.getMessageCount(sessionKey);
  let excerpt;
  if (count <= SUMMARY_FULL_THRESHOLD) {
    excerpt = {
      head: await store.getMessages(sessionKey, 0, SUMMARY_FULL_THRESHOLD),
      tail: [],
      omittedCount: 0,
    };
  } else {
    excerpt = {
      head: await store.getMessages(sessionKey, 0, SUMMARY_HEAD_MESSAGES),
      tail: await store.getMessages(sessionKey, count - SUMMARY_TAIL_MESSAGES, SUMMARY_TAIL_MESSAGES),
      omittedCount: count - SUMMARY_HEAD_MESSAGES - SUMMARY_TAIL_MESSAGES,
    };
  }
  const result = await summarizeSession(excerpt, endpoint);
  await store.setAiSummary(sessionKey, result.summary, endpoint.model);
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
      indexStatus = await indexMigratedSessionFile(store, target, writtenFilePath, targetSessionId);
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
      mainWindow?.webContents.send("environments-updated", await store.listEnvironments());
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
        void store.deleteSession(temporarySessionKey).catch(() => undefined);
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
      const status = await indexMigratedSessionFile(store, migrationTarget, writtenFilePath, targetSessionId);
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
    const candidates = await store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 25);
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
  if (!automationService) throw new Error("Automation service must be created before IPC registration.");
  disposeAutomationIpc = registerAutomationIpc({
    ipc: ipcMain,
    service: automationService,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    pickDirectory: pickAutomationDirectory,
    readLocalFile: (filePath, allowedRoots) =>
      createLocalTextFilePreviewUnderRoots(filePath, allowedRoots, app.getPath("home")),
    revealPath: async (filePath) => {
      const resolvedPath = path.resolve(filePath);
      await createLocalTextFilePreviewUnderRoots(
        resolvedPath,
        automationService?.workflows.allowedFileRoots() ?? [],
        app.getPath("home"),
      );
      shell.showItemInFolder(resolvedPath);
      return resolvedPath;
    },
  });
  disposeTeamChatIpc = registerTeamChatIpc({
    ipc: ipcMain,
    service: automationService.teamChat,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    ensureReady: () => automationService!.requireReady(),
  });
  ipcMain.handle("markdown:open-external", (_event, value: unknown) => {
    const url = normalizeExternalLink(value);
    if (!url) throw new Error("Only HTTP, HTTPS, and mailto links can be opened externally.");
    return shell.openExternal(url);
  });
  registerSessionCatalogIpc(ipcMain, new SessionCatalogService({
    store,
    visibleSearchOptions,
    visibleStatsOptions,
    visibleProjectOptions,
    ensureRemoteDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
    hasRemoteDetails: (sessionKey) => remoteSessionAccess.hasHydratedDetails(sessionKey),
    requireWslEnvironment: (session) => remoteSessionAccess.requireWslEnvironment(session),
    requireSshEnvironment: (session) => remoteSessionAccess.requireRemoteSshEnvironment(session),
    fetchRemoteMessages: fetchRemoteSessionMessagePage,
    loadLiveSessions: () => loadCachedLiveSessionSnapshot({
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
    }),
    refreshIndex: runIndexSync,
    getIndexStatus: () => indexStatus,
    setCustomTitle: (sessionKey, title) =>
      setSessionCustomTitleAndSyncTerminal(sessionKey, title, {
        getSession: (key) => store.getSession(key),
        setCustomTitle: (key, customTitle) => store.setCustomTitle(key, customTitle),
        loadLiveSessions: () => loadCachedLiveSessionSnapshot({
          includeTrae: getSettings().includeTrae,
          includeQoder: getSettings().includeQoder,
        }),
        setLiveTerminalTitle: (pid, displayTitle) => setLiveSessionTerminalTitle(pid, displayTitle),
        onSyncError: (error) => console.warn(
          "[terminal-title] Could not synchronize live terminal title.",
          error,
        ),
      }),
    deleteWslSession: deleteWslSessionFile,
  }));
  ipcMain.handle("session:summarize", async (_event, sessionKey: string) => {
    await remoteSessionAccess.ensureDetails(sessionKey);
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
    const candidates = await store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 500);
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
        const sessions = await store.searchSessions(visibleSearchOptions({ query, limit: 12 }));
        return sessions.map((session) => ({
          sessionKey: session.sessionKey,
          title: session.displayTitle,
          source: session.source,
          project: session.projectPath,
          summary: session.aiSummary ?? session.firstQuestion ?? null,
        }));
      };
      const { reply, sessionKeys } = await runAiAssistantFallback(endpoint, messages, search);
      const sessions = (await Promise.all(sessionKeys
        .map((key) => store.getSession(key))))
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
          const sessions = await store.searchSessions(visibleSearchOptions({
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
          const projects = await store.listProjects(visibleProjectOptions());
          return {
            result: projects.map((project) => ({ project: project.path, sessions: project.sessionCount })),
            sessionKeys: [],
          };
        }
        case "list_tags": {
          return { result: await store.listTags(), sessionKeys: [] };
        }
        case "get_session": {
          const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
          if (!sessionKey) return { result: { error: "sessionKey is required." }, sessionKeys: [] };
          await remoteSessionAccess.ensureDetails(sessionKey);
          const session = await store.getSession(sessionKey);
          if (!session) return { result: { error: "Session not found." }, sessionKeys: [] };
          const maxMessages = typeof args.maxMessages === "number" ? Math.max(1, Math.min(200, Math.floor(args.maxMessages))) : 40;
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const messageList = await store.getMessages(sessionKey, offset, maxMessages);
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
    const sessions = (await Promise.all(sessionKeys
      .map((key) => store.getSession(key))))
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
  ipcMain.handle("quota:get", () => {
    const settings = getSettings();
    return loadUsageQuotaSnapshot({
      hideCodexQuota: settings.hideCodexQuota,
      hideClaudeQuota: settings.hideClaudeQuota,
    });
  });
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
  ipcMain.handle("environment:diagnose", async (_event, environmentId: string) => {
    const environment = await store.getEnvironment(environmentId);
    if (environment?.kind === "wsl") return diagnoseRemoteEnvironment(environment);
    return diagnoseRemoteEnvironment(await remoteSessionAccess.requireSshEnvironment(environmentId));
  });
  registerAppUpdateIpc(ipcMain, appUpdateService);
  registerAgentMemoryIpc(ipcMain, agentMemoryService);
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
    await providerService.persistKeysFromUpdate(settings, next);
    settingsStore.set(providerService.removeStoredKeys(next));
    if ("autoCheckUpdates" in settings) await appUpdateService.setAutoCheckEnabled(next.autoCheckUpdates);
    await pruneDisabledOptionalSources(next);
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
  registerSessionCommandIpc(ipcMain, new SessionCommandService({
    store,
    remoteAccess: remoteSessionAccess,
    getSettings,
    loadLiveSessions: () => loadCachedLiveSessionSnapshot({
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
    }),
    copyText: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    chooseMarkdownPath: chooseMarkdownExportPath,
    chooseJsonFormat: chooseJsonExportFormat,
    chooseJsonPath: chooseJsonExportPath,
    writeTextFile: (filePath, content) => fs.writeFile(filePath, content, "utf-8"),
    showJsonExportNotice,
  }));
  ipcMain.handle("session:migrate", async (event, sessionKey: string, target: unknown) => {
    const session = await store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    const messages = await store.getAllMessages(sessionKey);
    const settings = Object.freeze(await providerService.hydrateSettings());

    return runLocalSessionMigration({
      source: session,
      messages,
      target,
      settings,
    }, localSessionMigrationRuntime(event));
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

app.whenReady().then(async () => {
  await appUpdateService.registerRunningProcess();
  postgresRuntime = await startPostgresRuntime({ userDataPath: app.getPath("userData") });
  postgresDatabase = PostgresDatabase.connect(postgresRuntime.connectionUrl, {
    migrations: POSTGRES_MIGRATIONS,
  });
  await postgresDatabase.initialize();
  store = new SessionStore(postgresDatabase);
  // Publish the live endpoint so standalone MCP clients use the same store.
  try {
    writeDatabaseUrlPointer(postgresRuntime.connectionUrl);
  } catch {
    // Non-fatal: the MCP server can still use AGENT_RECALL_DATABASE_URL.
  }
  try {
    ensureAgentRecallMcpPreference();
  } catch (error) {
    console.error(`Failed to configure session search MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  await providerService.migrateLegacyKeys();
  await pruneDisabledOptionalSources(getSettings());
  automationService = createAutomationService();
  registerIpc();
  createApplicationMenu();
  createWindow();
  createTray();
  void appUpdateService.showPreviousUpdateResult();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  void ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
  void providerService.restoreCodexChatProxy();
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
  skillService.startUsageRefresh();
  remoteSessionService.startQueue();
  appUpdateService.scheduleInitialCheck();
}).catch(async (error) => {
  console.error(`Failed to start AgentRecall: ${error instanceof Error ? error.message : String(error)}`);
  await postgresDatabase?.close().catch(() => undefined);
  await postgresRuntime?.stop().catch(() => undefined);
  postgresDatabase = null;
  postgresRuntime = null;
  app.quit();
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", (event) => {
  if (automationQuitReady) return;
  event.preventDefault();
  stopAutoIndexRefresh();
  skillService.stopUsageRefresh();
  remoteSessionService.stopQueue();
  remoteEnvironmentLifecycle?.stopAll();
  disposeAutomationIpc?.();
  disposeAutomationIpc = null;
  disposeTeamChatIpc?.();
  disposeTeamChatIpc = null;
  globalShortcut.unregisterAll();
  void Promise.allSettled([
    appUpdateService.clearRunningProcess(),
    automationService?.shutdown() ?? Promise.resolve(),
    providerService.stopCodexChatProxy(),
  ]).then(async () => {
    await postgresDatabase?.close().catch((error) => {
      console.error(`Failed to close AgentRecall data store: ${error instanceof Error ? error.message : String(error)}`);
    });
    postgresDatabase = null;
    await postgresRuntime?.stop().catch((error) => {
      console.error(`Failed to stop AgentRecall PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
    });
    postgresRuntime = null;
  }).finally(() => {
    automationQuitReady = true;
    app.quit();
  });
});
