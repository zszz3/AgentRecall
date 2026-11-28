import { TeamSessionDownloads } from "./services/team-session-downloads";
import { connectSqliteDatabase, createTeamSessionRepository } from "./services/sqlite-storage";
import type { SqliteDatabase } from "../core/sqlite/database";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import Store from "electron-store";
import { TeamSessionSharing } from "./services/team-session-sharing";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { mergeCodexDesktopProjects, readCodexDesktopProjects } from "../core/codex-projects";
import { indexMigratedSessionFile } from "../core/indexer";
import { connectDesktopSessionBackend, type DesktopSessionBackend, type SessionDatabaseRuntime } from "./session-backend-client";
import { createStartupTaskScheduler } from "./startup-tasks";
import { createInterfaceZoomController } from "./interface-zoom";
import { installApplicationMenu, refreshApplicationMenuZoom } from "./application-menu";
import {
  defaultSettings,
  mergeAppSettings,
  stampExperienceCardsEnabledAt,
  normalizeTerminal,
  revealInFileManager,
  type AppSettings,
  type AppSettingsUpdate,
} from "../core/platform";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { repairLegacyAgentRecallCodexRollouts } from "../core/codex-migration-repair";
import { setLiveSessionTerminalTitle } from "../core/session-focus";
import { setSessionCustomTitleAndSyncTerminal } from "../core/session-title-sync";
import { writeMigratedSession } from "../core/session-migration-writers";
import { assertMigrationTargetEnabled, migrationTargetDescriptor } from "../core/migration-targets";
import {
  legacyMemoryManifestPointerPath,
  writeDatabaseUrlPointer,
  writeSkillLibraryPointer,
} from "../core/app-paths";
import { fetchRemoteSessionMessagePage } from "../core/remote-sync";
import { SessionStore } from "../core/session-store";
import {
  INITIAL_INDEX_DELAY_MS,
  INITIAL_PROVIDER_RESTORE_DELAY_MS,
  INITIAL_SESSION_SYNC_QUEUE_START_DELAY_MS,
} from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";
import { QUOTA_EVENTS } from "../shared/ipc/quota";
import { combineIpcDisposers } from "./ipc/register-ipc-handler";
import { registerCoreIpc } from "./ipc/core-ipc";
import { registerLegacyMemoryDataIpc } from "./ipc/legacy-memory-data";
import { registerAgentModelIpc } from "./ipc/agent-model";
import { registerInstructionsIpc } from "./ipc/instructions";
import { registerAgentMcpIpc } from "./ipc/agent-mcp";
import { registerIslandIpc } from "./ipc/island";
import { IslandService } from "./services/island-service";
import { ISLAND_SNAPSHOT_CHANNEL, SHARE_SESSION_TO_TEAM_CHANNEL } from "../shared/ipc/island";
import { registerModelGatewayIpc } from "./ipc/model-gateway";
import { ModelGatewayService } from "./services/model-gateway-service";
import { GATEWAY_SNAPSHOT_CHANNEL } from "../shared/ipc/model-gateway";
import { registerExperienceCardsIpc } from "./ipc/experience-cards";
import { registerAutomationIpc } from "./ipc/automation";
import { registerAppUpdateIpc } from "./ipc/app-update";
import { registerQuotaIpc } from "./ipc/quota";
import { registerProvidersIpc } from "./ipc/providers";
import { registerRemoteSessionsIpc } from "./ipc/remote-sessions";
import { registerDiscoveryIpc, type DiscoveryIpcService } from "./ipc/discovery";
import { registerSkillsIpc } from "./ipc/skills";
import { registerTeamWorkspaceIpc } from "./ipc/team-workspace";
import { TeamWorkspaceService } from "./services/team-workspace-service";
import { registerSessionCatalogIpc } from "./ipc/session-catalog";
import { registerSessionCommandIpc } from "./ipc/session-commands";
import {
  AppUpdateService,
  InstalledRuntimeMonitor,
  launchDetachedAppUpdateInstaller,
  type AppUpdateClient,
} from "./services/app-update-service";
import { SshCommandService } from "./services/ssh-command-service";
import { SshCredentialService } from "./services/ssh-credential-service";
import { AgentModelService } from "./services/agent-model-service";
import { completeWithAgentModel, type AgentModelReply } from "../core/agent-model";
import { AGENT_MODEL_CUSTOM_PROVIDER } from "../core/agent-model-config";
import { InstructionCatalogService } from "./services/instruction-catalog-service";
import { AgentMcpCatalogService } from "./services/agent-mcp-catalog-service";
import { scanAgentModelImports } from "../core/agent-model-imports";
import { ExperienceCardService } from "./services/experience-card-service";
import { LegacyMemoryDataService } from "./services/legacy-memory-data-service";
import type { NativeAutomationService } from "./services/automation-service";
import { materializeEvaluationArtifactFile } from "./services/evaluation-artifact-file";
import { createEvaluationArtifactReader } from "./services/evaluation-artifact-reader";
import { createConfiguredAutomationService, createMcpClientManager, type McpSetup } from "./services/automation-bootstrap";
import { createSessionAiService } from "./services/session-ai-service";
import { createSessionIndexingRuntime, enabledRemoteOptionalSources } from "./services/session-indexing-runtime";
import { createSessionMigrationCoordinator, pathIsDirectory } from "./services/remote-session-migration";
import { ProviderService } from "./services/provider-service";
import {
  codexAuthPath,
  createQuotaCache,
  QuotaService,
  readCodexAuthIdentity,
  watchQuotaAuthFile,
} from "./services/quota-service";
import { RemoteSessionService, type SessionSyncHookSetup } from "./services/remote-session-service";
import { SkillService, type SkillUsageHookSetup } from "./services/skill-service";
import { SessionCatalogService } from "./services/session-catalog-service";
import { SessionCommandService } from "./services/session-command-service";
import { RemoteSessionAccess } from "./services/remote-session-access";
import { bootstrapApplicationPaths } from "./app-path-bootstrap";
import { createWindowBoundsController, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from "./desktop/window-bounds";
import { createNativeDialogs } from "./desktop/native-dialogs";
import { createIslandOverlayWindowPort, islandConfigFromSettings } from "./desktop/island-overlay";
import { createDeepSeekWebWindowController, createQuickSearchWindowController } from "./desktop/quick-search-window";
import { applyDockVisibility, createTrayController } from "./desktop/tray-and-dock";
import type {
  ProjectQueryOptions,
  ProjectSummary,
  SearchOptions,
  SessionEnvironment,
  SessionStatsOptions,
} from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(__dirname, "../preload/index.mjs");
const PRODUCT_NAME = "AgentRecall";
// Electron's internal name also participates in persistent/native identity.
// Keep it independent of the visible product name and packaged plist labels.
const APPLICATION_IDENTITY = "agent-recall-v2";
const releaseUpdateRuntime = process.env.AGENT_RECALL_RELEASE_BUILD === "1";

// Shared CommonJS installers in bin/ (sibling of out/) are loaded lazily so the
// bundler leaves them external and generated hooks point back at bin/*.cjs.
const requireCjs = createRequire(import.meta.url);
const SKILL_USAGE_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-skill-usage-hook.cjs");
const SESSION_SYNC_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-session-sync-hook.cjs");
const LEGACY_MEMORY_HOOK_CLEANUP_PATH = path.join(__dirname, "../../bin/remove-legacy-memory-hooks.cjs");
const MCP_SETUP_PATH = path.join(__dirname, "../../bin/setup-mcp.cjs");
const UPDATE_CLIENT_PATH = path.join(__dirname, "../../bin/update-client.cjs");
const APPLY_UPDATE_PATH = path.join(__dirname, "../../bin/apply-update.cjs");
const APP_ENTRY_PATH = fileURLToPath(import.meta.url);
const NPM_LAUNCHER_PATH = path.join(__dirname, "../../bin/agent-recall.cjs");

interface LegacyMemoryHookCleanup {
  removeLegacyMemoryHooks(options: { homeDir: string }):
    | { status: "removed" | "unchanged" }
    | { status: "error"; detail: string };
}

const loadSkillUsageHookSetup = (): SkillUsageHookSetup => requireCjs(SKILL_USAGE_HOOK_SETUP_PATH) as SkillUsageHookSetup;
const loadSessionSyncHookSetup = (): SessionSyncHookSetup => requireCjs(SESSION_SYNC_HOOK_SETUP_PATH) as SessionSyncHookSetup;
const loadMcpSetup = (): McpSetup => requireCjs(MCP_SETUP_PATH) as McpSetup;
const loadUpdateClient = (): AppUpdateClient => requireCjs(UPDATE_CLIENT_PATH) as AppUpdateClient;

if (process.env.AGENT_RECALL_USE_MOCK_KEYCHAIN === "1") {
  app.commandLine.appendSwitch("use-mock-keychain");
}
app.setName(APPLICATION_IDENTITY);
app.setAppUserModelId("dev.zszz3.agent-recall-v2");
bootstrapApplicationPaths({
  app,
  userDataName: APPLICATION_IDENTITY,
  legacyProductNames: [],
});

let mainWindow: BrowserWindow | null = null;
let islandService: IslandService | null = null;
let modelGatewayService: ModelGatewayService | null = null;
let lastGatewayRunning = false;
let automationService: NativeAutomationService | null = null;
let experienceCardService: ExperienceCardService | null = null;
let teamWorkspaceService: TeamWorkspaceService | null = null;
let disposeRegisteredIpc: (() => void) | null = null;
let automationQuitReady = false;
let automationQuitStarted = false;
let databaseRuntime: SessionDatabaseRuntime | null = null;
let databaseRuntimeStartup: Promise<SessionDatabaseRuntime> | null = null;
let appDatabase: SqliteDatabase | null = null;
let sessionBackend: DesktopSessionBackend | null = null;
let store: SessionStore;
let quotaService: QuotaService;
let registeredGlobalShortcut: string | null = null;

const startupTasks = createStartupTaskScheduler(() => automationQuitStarted);
const windowBounds = createWindowBoundsController();
const nativeDialogs = createNativeDialogs({ getMainWindow: () => mainWindow });
const deepSeekWebWindow = createDeepSeekWebWindowController();
const quickSearchWindow = createQuickSearchWindowController({
  preloadPath: PRELOAD_PATH,
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  rendererHtmlPath: path.join(__dirname, "../renderer/quick-search.html"),
  onDidFinishLoad: (window) => interfaceZoomController.applyTo(window),
});
const interfaceZoomController = createInterfaceZoomController(() => [mainWindow, quickSearchWindow.getWindow()]);

const settingsStore = new Store<AppSettings>({ defaults: defaultSettings });
const modelGatewayStore = new Store<Record<string, unknown>>({ name: "model-gateway", defaults: {} });
const sshCredentialStore = new Store<{ passwords: Record<string, string> }>({
  name: "ssh-credentials",
  defaults: { passwords: {} },
});
const sshCredentialService = new SshCredentialService(sshCredentialStore, safeStorage);
const sshCommandService = new SshCommandService({
  getPassword: (environmentId) => sshCredentialService.getPassword(environmentId),
});

const runSshSessionCommand = (environment: SessionEnvironment, remoteCommand: string): Promise<string> =>
  sshCommandService.run(environment, remoteCommand);
const runSshHealthCommand = (environment: SessionEnvironment, remoteCommand: string): Promise<string> =>
  sshCommandService.run(environment, remoteCommand, { maxBuffer: 512 * 1024, timeout: 20_000 });
const runSshWithInput = (environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> =>
  sshCommandService.run(environment, remoteCommand, { input, maxBuffer: 128 * 1024 * 1024, timeout: 90_000 });

const mcpClients = createMcpClientManager({ loadMcpSetup, homePath: app.getPath("home") });

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

const indexingRuntime = createSessionIndexingRuntime({
  mainDir: __dirname,
  isQuitting: () => automationQuitStarted,
  getStore: () => store,
  getSettings,
  getSessionBackend: () => sessionBackend,
  sshCommandService,
  sshCredentialService,
  sendIndexStatus: (status) => mainWindow?.webContents.send("index-status", status),
  sendEnvironmentsUpdated: (environments) => mainWindow?.webContents.send("environments-updated", environments),
  onIndexCompleted: () => {
    void sessionAiService.maybeAutoBackfillSummaries();
    // The service owns this run and aborts it on quit; it never rejects.
    void experienceCardService?.afterIndexRun();
  },
});

async function applySettingsUpdate(settings: AppSettingsUpdate): Promise<AppSettings> {
  const previous = getSettings();
  const next = stampExperienceCardsEnabledAt(previous, mergeAppSettings(previous, settings), new Date());
  if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
    throw new Error(
      `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
    );
  }
  if ("remoteSyncEnabled" in settings && !next.remoteSyncEnabled) remoteSessionService.disableSync();
  if ("evalEnabled" in settings && next.evalEnabled && !previous.evalEnabled) {
    try {
      if (skillService.getUsageHookStatus()) {
        skillService.uninstallUsageHook();
        skillService.installUsageHook();
      }
    } catch (error) {
      console.error(`Failed to refresh the skill usage hook for Eval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await providerService.persistKeysFromUpdate(settings, next);
  settingsStore.set(providerService.removeStoredKeys(next));
  if ("wslPollingIntervalMs" in settings) indexingRuntime.updateWslPollingInterval(next.wslPollingIntervalMs);
  if ("autoCheckUpdates" in settings) await appUpdateService.setAutoCheckEnabled(next.autoCheckUpdates);
  await indexingRuntime.pruneDisabledOptionalSources(next);
  if ("showInDock" in settings) applyDockVisibility(next.showInDock, __dirname);
  if (
    "islandEnabled" in settings
    || "islandSoundEnabled" in settings
    || "islandSuppressWhenFocused" in settings
    || "islandAutoCollapseSeconds" in settings
  ) {
    islandService?.applyConfig(islandConfigFromSettings(next));
    trayController.refreshMenu();
  }
  experienceCardService?.settingsChanged();
  return providerService.addStoredKeys(next);
}

const trayController = createTrayController({
  productName: PRODUCT_NAME,
  mainDir: __dirname,
  getSettings,
  isGatewayRunning: () => lastGatewayRunning,
  onOpenMain: () => showWindow(),
  onShowQuickSearch: () => quickSearchWindow.show(),
  onToggleIsland: (nextEnabled) => void applySettingsUpdate({ islandEnabled: nextEnabled }),
  onToggleGateway: (nextEnabled) => {
    void modelGatewayService?.setEnabled(nextEnabled).catch((error) => {
      console.error(`Failed to toggle local model gateway: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
  onRefresh: () => void indexingRuntime.runIndexSync(true),
  onQuit: () => app.quit(),
});

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
  showMessageBox: (options) => (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)),
  copyText: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
  processId: process.pid,
  logError: (message) => console.error(message),
});

const installedRuntimeMonitor = releaseUpdateRuntime && process.env.AGENT_RECALL_NODE_PATH
  ? new InstalledRuntimeMonitor({
      appEntryPath: APP_ENTRY_PATH,
      electronPath: process.execPath,
      launcherPath: NPM_LAUNCHER_PATH,
      nodePath: process.env.AGENT_RECALL_NODE_PATH,
      requestQuit: () => app.quit(),
      logError: (message) => console.error(message),
    })
  : null;

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

const agentModelService = new AgentModelService({
  config: () => getSettings().agentModel,
  keys: {
    get: (providerId) => store.getApiProviderKey("agent", providerId),
    set: (providerId, apiKey) => store.setApiProviderKey("agent", providerId, apiKey),
  },
  scanImports: () => scanAgentModelImports(app.getPath("home"), process.env),
});

async function completeForAgentRecall(prompt: string, signal?: AbortSignal): Promise<AgentModelReply> {
  const gatewayRoute = await modelGatewayService?.resolveAgentRecallRoute();
  if (gatewayRoute) {
    const api = gatewayRoute.protocol === "anthropic"
      ? "anthropic-messages"
      : gatewayRoute.protocol === "openai_responses"
        ? "openai-responses"
        : "openai-completions";
    const timeout = AbortSignal.timeout(5 * 60_000);
    return completeWithAgentModel(
      { provider: AGENT_MODEL_CUSTOM_PROVIDER, api, baseUrl: gatewayRoute.baseUrl, model: gatewayRoute.model },
      gatewayRoute.apiKey,
      prompt,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
  }
  return agentModelService.complete(prompt, signal);
}

const visibleSearchOptions = (options: SearchOptions = {}): SearchOptions => ({ ...options, excludeSubagents: true });
const visibleStatsOptions = (options: SessionStatsOptions = {}): SessionStatsOptions => ({ ...options, excludeSubagents: true });
const visibleProjectOptions = (): { excludeSubagents: boolean } => ({ excludeSubagents: true });
const codexDesktopHome = (): string => process.env.CODEX_HOME?.trim() || path.join(app.getPath("home"), ".codex");

async function listVisibleProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
  const indexed = await store.listProjects(options);
  if (options.origin === "agentrecall") return indexed;
  if (options.environmentId && options.environmentId !== "all" && options.environmentId !== "local") return indexed;
  return mergeCodexDesktopProjects(indexed, await readCodexDesktopProjects(codexDesktopHome()));
}

const fileCatalogDependencies = {
  home: app.getPath("home"),
  env: process.env,
  localProjects: async () => (await listVisibleProjects({ environmentId: "local" }))
    .filter((project) => project.environmentId === "local")
    .map((project) => project.path),
  openPath: (file: string) => shell.openPath(file),
  revealPath: (file: string) => shell.showItemInFolder(file),
};
const instructionCatalogService = new InstructionCatalogService(fileCatalogDependencies);
const agentMcpCatalogService = new AgentMcpCatalogService(fileCatalogDependencies);

const skillLibraryRoot = path.join(app.getPath("userData"), "skills");
const skillService = new SkillService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSkillUsageHookSetup,
  getEvaluationService: () => {
    if (!automationService) throw new Error("Runtime is not ready.");
    return automationService.evaluations;
  },
  libraryRoot: skillLibraryRoot,
  skillsShCachePath: path.join(app.getPath("userData"), "cache", "skills-sh.json"),
  homeDir: app.getPath("home"),
  codexHome: process.env.CODEX_HOME,
  executeAiSearch: async (prompt) => (await completeForAgentRecall(prompt)).text,
  copyText: (text) => clipboard.writeText(text),
  revealPath: (targetPath) => revealInFileManager(targetPath),
  openPath: (targetPath) => shell.openPath(targetPath),
  pickSkillFolder: async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options = { properties: ["openDirectory"] as Array<"openDirectory"> };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

try {
  skillService.ensureBuiltinSkills(path.join(app.getAppPath(), "assets", "bundled-skills"));
} catch (error) {
  console.error(`Failed to seed built-in Skills: ${error instanceof Error ? error.message : String(error)}`);
}

const remoteSessionAccess = new RemoteSessionAccess({
  getStore: () => store,
  runSshCommand: runSshSessionCommand,
  runSshHealthCommand,
});

const sessionAiService = createSessionAiService({
  getStore: () => store,
  getSettings,
  getGatewayService: () => modelGatewayService,
  providerService,
  remoteSessionAccess,
  visibleSearchOptions,
  visibleProjectOptions,
  listVisibleProjects,
});

const sessionMigration = createSessionMigrationCoordinator({
  getStore: () => store,
  getSettings,
  hydrateSettings: () => providerService.hydrateSettings(),
  resolveSummaryEndpoint: () => sessionAiService.resolveSummaryEndpoint(),
  buildCodexExecEndpoint: (settings) => sessionAiService.buildCodexExecEndpoint(settings),
  remoteSessionAccess,
  runSshSessionCommand,
  runSshWithInput,
  enabledRemoteOptionalSources,
  tempDir: () => app.getPath("temp"),
  onIndexStatusUpdated: (status) => indexingRuntime.setIndexStatus(status),
  onEnvironmentsUpdated: (environments) => indexingRuntime.emitEnvironmentsUpdated(environments),
});

const remoteSessionService = new RemoteSessionService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSessionSyncHookSetup,
  ensureSessionDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
  runIndexSync: () => indexingRuntime.runIndexSync(),
  chooseLocalProject: () => nativeDialogs.chooseLocalProjectDirectory(),
  createLocalRestoreDependencies: (onProgress) => sessionMigration.createLocalRemoteRestoreDependencies(onProgress),
  createSourceRestoreDependencies: (environment, onProgress) =>
    sessionMigration.createSourceRemoteRestoreDependencies(environment, onProgress),
  copyText: (text) => clipboard.writeText(text),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

const evaluationArtifacts = createEvaluationArtifactReader({
  getStore: () => store,
  isSkillUsageObservable: () => skillService.getUsageHookStatus(),
});

function createQuotaService(): QuotaService {
  const authFile = codexAuthPath(process.env, homedir());
  const cache = createQuotaCache(path.join(app.getPath("userData"), "quota-cache.json"));
  return new QuotaService({
    load: (settings) => loadUsageQuotaSnapshot(settings),
    getSettings: () => {
      const settings = getSettings();
      return { hideCodexQuota: settings.hideCodexQuota, hideClaudeQuota: settings.hideClaudeQuota };
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
    getSessionFamily: (sessionKey) => store.getSessionFamily(sessionKey),
  };
}

/** Removes hooks the retired directory Memory feature registered; never touches other entries. */
function removeLegacyMemoryHooks(): void {
  const cleanup = requireCjs(LEGACY_MEMORY_HOOK_CLEANUP_PATH) as LegacyMemoryHookCleanup;
  const result = cleanup.removeLegacyMemoryHooks({ homeDir: app.getPath("home") });
  if (result.status === "error") console.error(`Could not remove the retired memory hooks: ${result.detail}`);
}

function createWindow(): void {
  const initialBounds = windowBounds.getRestoredBounds();
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
      preload: PRELOAD_PATH,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (windowBounds.shouldRestoreMaximized()) mainWindow.maximize();

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error("[renderer]", details.message, `${details.sourceId}:${details.lineNumber}`);
    else console.log("[renderer]", details.message);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  windowBounds.attach(mainWindow);
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

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
  if (globalShortcut.register(accelerator, toggleWindow)) {
    registeredGlobalShortcut = accelerator;
    return true;
  }
  if (previous && globalShortcut.register(previous, toggleWindow)) {
    registeredGlobalShortcut = previous;
  }
  return false;
}

function liveSessionOptionsFromSettings(fresh = false) {
  const settings = getSettings();
  return {
    fresh,
    includeTrae: settings.includeTrae,
    includeQoder: settings.includeQoder,
    includeOpenClaw: settings.includeOpenClaw,
    includeHermes: settings.includeHermes,
    includeOpenCode: settings.includeOpenCode,
    includeZcode: settings.includeZcode,
    includeCursor: settings.includeCursorAgent,
    includeCodeBuddy: settings.includeCodeBuddyCli,
    includeCodeWiz: settings.includeCodeWizCli,
    includeOmp: settings.includeOmp,
  };
}

function registerIpc(): void {
  if (!automationService) throw new Error("Automation service must be created before IPC registration.");
  if (!experienceCardService) throw new Error("Experience card service must be created before IPC registration.");
  if (!islandService) throw new Error("Island service must be created before IPC registration.");
  if (!modelGatewayService) throw new Error("Model gateway service must be created before IPC registration.");

  const teamSharing = new TeamSessionSharing({
    cache: createTeamSessionRepository(appDatabase!),
    store,
    ensureDetails: (key) => remoteSessionAccess.ensureDetails(key),
    confirm: (owner, message) => nativeDialogs.confirmTeamOperation(owner, message),
    restore: async (owner, target, session, signal) => {
      assertMigrationTargetEnabled(target, getSettings());
      const projectPath = await nativeDialogs.chooseFolderFromOwnerWindow(
        owner,
        {
          title: `导出为 ${migrationTargetDescriptor(target).label} Session`,
          message: "选择继续工作时使用的目录。会在本机创建新的 Agent 会话，原会话保持不变；历史工具记录不执行。",
          buttonLabel: "创建 Session",
          properties: ["openDirectory"],
        },
        signal,
      );
      if (!projectPath) return null;
      if (!(await pathIsDirectory(projectPath))) throw new Error("工作目录不存在，请重新选择。");
      signal.throwIfAborted();
      const written = await writeMigratedSession({
        target,
        session: { ...session, projectPath },
        ...(process.env.AGENT_RECALL_MIGRATION_HOME ? { homeDir: process.env.AGENT_RECALL_MIGRATION_HOME } : {}),
      });
      // The native file is committed. Index failure must not invite a duplicate export.
      try {
        indexingRuntime.setIndexStatus(await indexMigratedSessionFile(store, target, written.filePath, written.sessionId));
      } catch (error) {
        console.warn("Shared session created; local indexing failed", error);
        return `Session 已创建，但列表更新失败。请刷新 Session 页面，无需再次导出。文件：${written.filePath}`;
      }
      return `已创建 ${migrationTargetDescriptor(target).label} Session「${session.title}」，可在 Session 页面选择 Resume。`;
    },
    save: (owner, bytes, suggestedName) =>
      nativeDialogs.saveFromOwnerWindow(owner, bytes, { title: "导出共享会话", defaultPath: suggestedName }),
  });

  teamWorkspaceService = new TeamWorkspaceService(
    process.env.AGENTRECALL_HOME ?? path.join(homedir(), ".agentrecall-cli"),
    {
      chooseFolder: (owner) => nativeDialogs.chooseFolderFromOwnerWindow(owner, { title: "选择本地目录", properties: ["openDirectory"] }),
      confirm: (owner, message) => nativeDialogs.confirmTeamOperation(owner, message),
      saveFile: (owner, bytes, suggestedName) => nativeDialogs.saveFromOwnerWindow(owner, bytes, {
        title: "导出 Skill",
        defaultPath: suggestedName,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      }),
    },
    teamSharing,
    TeamSessionDownloads.worker(path.join(__dirname, "team-session-download-worker.js"), databaseRuntime!.connectionUrl),
    {
      add: (input) => skillService.importSkillFiles(input),
      locate: (managedId) => skillService.librarySkillLocation(managedId),
    },
  );

  registerSessionCatalogIpc(ipcMain, new SessionCatalogService({
    store,
    listProjects: listVisibleProjects,
    visibleSearchOptions,
    visibleStatsOptions,
    visibleProjectOptions,
    ensureRemoteDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
    hasRemoteDetails: (sessionKey) => remoteSessionAccess.hasHydratedDetails(sessionKey),
    requireWslEnvironment: (session) => remoteSessionAccess.requireWslEnvironment(session),
    requireSshEnvironment: (session) => remoteSessionAccess.requireRemoteSshEnvironment(session),
    fetchRemoteMessages: (environment, session, offset, limit) =>
      fetchRemoteSessionMessagePage(environment, session, offset, limit, {
        ...(environment.kind === "ssh" ? { runSsh: runSshSessionCommand } : {}),
      }),
    loadLiveSessions: (fresh = false) => indexingRuntime.loadAllLiveSessions(liveSessionOptionsFromSettings(fresh)),
    refreshIndex: () => indexingRuntime.runIndexSync(true),
    getIndexStatus: () => indexingRuntime.getIndexStatus(),
    setCustomTitle: (sessionKey, title) =>
      setSessionCustomTitleAndSyncTerminal(sessionKey, title, {
        getSession: (key) => store.getSession(key),
        setCustomTitle: (key, customTitle) => store.setCustomTitle(key, customTitle),
        loadLiveSessions: () => indexingRuntime.loadLocalLiveSessions(liveSessionOptionsFromSettings()),
        setLiveTerminalTitle: (pid, displayTitle) => setLiveSessionTerminalTitle(pid, displayTitle),
        onSyncError: (error) => console.warn("[terminal-title] Could not synchronize live terminal title.", error),
      }),
  }));

  registerAppUpdateIpc(ipcMain, appUpdateService);
  registerQuotaIpc(ipcMain, quotaService);
  registerProvidersIpc(ipcMain, providerService, (target, defaultPath) =>
    nativeDialogs.chooseProviderConfigDirectory(target, defaultPath),
  );
  registerSkillsIpc(ipcMain, skillService);
  registerDiscoveryIpc(ipcMain, createDiscoveryService());
  registerRemoteSessionsIpc(ipcMain, remoteSessionService);
  registerSessionCommandIpc(ipcMain, new SessionCommandService({
    store,
    remoteAccess: remoteSessionAccess,
    getSettings,
    loadLiveSessions: () => indexingRuntime.loadLocalLiveSessions({
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
    }),
    copyText: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    openDeepSeekWebSession: (sessionId) => deepSeekWebWindow.showSession(sessionId),
    chooseMarkdownPath: (defaultFileName) => nativeDialogs.chooseMarkdownExportPath(defaultFileName),
    chooseJsonFormat: () => nativeDialogs.chooseJsonExportFormat(),
    chooseJsonPath: (defaultFileName) => nativeDialogs.chooseJsonExportPath(defaultFileName),
    writeTextFile: (filePath, content) => fs.writeFile(filePath, content, "utf-8"),
    showJsonExportNotice: (exportPath, fidelity) => nativeDialogs.showJsonExportNotice(exportPath, fidelity),
  }));

  disposeRegisteredIpc = combineIpcDisposers([
    registerAutomationIpc({
      ipc: ipcMain,
      service: automationService,
      send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
      pickDirectory: (defaultPath) => nativeDialogs.pickAutomationDirectory(defaultPath),
      openEvaluationArtifact: async ({ runId, resultId }) => {
        const run = await automationService!.evaluations.getRun(runId);
        if (!run) throw new Error(`Evaluation run was not found: ${runId}`);
        const experiment = (await automationService!.evaluations.listExperiments())
          .find((item) => item.id === run.experimentId);
        const filePath = await materializeEvaluationArtifactFile({
          userDataPath: app.getPath("userData"),
          run,
          experimentName: experiment?.name || run.experimentId,
          resultId,
        });
        const error = await shell.openPath(filePath);
        if (error) throw new Error(`The evaluation artifact could not be opened: ${error}`);
        return filePath;
      },
    }),
    registerCoreIpc(ipcMain, {
      store,
      providerService,
      remoteSessionAccess,
      sessionAiService,
      sessionMigration,
      ensureRemoteEnvironmentLifecycle: () => indexingRuntime.ensureRemoteEnvironmentLifecycle(),
      runSshHealthCommand,
      getSettings,
      applySettingsUpdate,
      setInterfaceZoom: (factor) => interfaceZoomController.set(factor),
      refreshApplicationMenuZoom,
      openQuickSearchSession: async (sessionKey) => {
        const session = await store.getSession(sessionKey);
        if (!session) throw new Error("Session was not found.");
        await store.markOpened(sessionKey);
        quickSearchWindow.hide();
        showWindow();
        mainWindow?.webContents.send("open-session", sessionKey);
      },
      appDataPath: app.getPath("appData"),
      userDataPath: app.getPath("userData"),
      emitEnvironmentsUpdated: () => indexingRuntime.emitEnvironmentsUpdated(),
    }),
    registerLegacyMemoryDataIpc(ipcMain, new LegacyMemoryDataService({
      dataDir: path.join(app.getPath("userData"), "openviking"),
      pointerPath: legacyMemoryManifestPointerPath(app.getPath("home")),
    })),
    registerExperienceCardsIpc(ipcMain, experienceCardService),
    registerAgentModelIpc(ipcMain, agentModelService),
    registerInstructionsIpc(ipcMain, instructionCatalogService),
    registerAgentMcpIpc(ipcMain, agentMcpCatalogService),
    registerIslandIpc(ipcMain, islandService),
    registerModelGatewayIpc(ipcMain, modelGatewayService),
    registerTeamWorkspaceIpc(ipcMain, teamWorkspaceService),
  ]);
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
  void installedRuntimeMonitor?.start();
  databaseRuntimeStartup = connectDesktopSessionBackend({
    userDataPath: app.getPath("userData"),
    homeDir: app.getPath("home"),
    nodePath: process.env.AGENT_RECALL_NODE_PATH,
    onError: (message) => console.error(`Session search backend: ${message}`),
  }).then((backend) => {
    sessionBackend = backend;
    return backend;
  });
  databaseRuntime = await databaseRuntimeStartup;
  if (automationQuitStarted) return;
  // Schema initialization and database backend lifetime belong to the shared backend.
  // Desktop services retain their own connection for UI and automation queries.
  appDatabase = connectSqliteDatabase(databaseRuntime.connectionUrl);
  store = new SessionStore(
    appDatabase,
    Promise.resolve(),
    path.join(app.getPath("userData"), "session-attachments"),
  );
  quotaService = createQuotaService();
  try {
    removeLegacyMemoryHooks();
  } catch (error) {
    console.error(`Could not remove the retired memory hooks: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Publish the live endpoint so standalone MCP clients use the same store.
  try {
    writeDatabaseUrlPointer(databaseRuntime.connectionUrl, app.getPath("home"));
  } catch {
    // Non-fatal: the MCP server can still use AGENT_RECALL_DATABASE_URL.
  }
  try {
    writeSkillLibraryPointer(skillLibraryRoot, app.getPath("home"));
  } catch {
    // Non-fatal: the MCP server can still use AGENT_RECALL_SKILL_LIBRARY.
  }
  try {
    mcpClients.ensureClients();
  } catch (error) {
    console.error(`Failed to configure AgentRecall Gateway MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  await providerService.migrateLegacyKeys();
  await indexingRuntime.pruneDisabledOptionalSources(getSettings());
  if (automationQuitStarted) return;

  automationService = createConfiguredAutomationService({
    mainDir: __dirname,
    database: appDatabase,
    connectionUrl: () => databaseRuntime?.connectionUrl ?? null,
    userDataPath: app.getPath("userData"),
    homePath: app.getPath("home"),
    appDataPath: app.getPath("appData"),
    skillLibraryRoot,
    store,
    skillService,
    evaluationArtifacts,
    getTeamWorkspaceService: () => teamWorkspaceService,
    getSettings,
    setSetting: (key, value) => settingsStore.set(key, value),
    loadMcpSetup,
    mcpClients,
    credentialEncryption: safeStorage,
    openExternal: (url) => shell.openExternal(url),
    chooseEvaluationDatasetDirectory: (mode) => nativeDialogs.chooseEvaluationDatasetDirectory(mode),
  });
  experienceCardService = new ExperienceCardService({
    repository: () => store.memoryCardRepository(),
    settings: getSettings,
    complete: (prompt, signal) => completeForAgentRecall(prompt, signal),
  });
  islandService = new IslandService({
    homeDir: app.getPath("home"),
    env: process.env,
    getConfig: () => islandConfigFromSettings(getSettings()),
    window: createIslandOverlayWindowPort({
      preloadPath: PRELOAD_PATH,
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererHtmlPath: path.join(__dirname, "../renderer/island.html"),
    }),
    broadcastSnapshot: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(ISLAND_SNAPSHOT_CHANNEL, snapshot);
      }
    },
    findSessionByRawId: (rawId) => store.findByRawId(rawId),
    refreshIndex: () => indexingRuntime.runIndexSync(true),
    loadLiveSessions: () => indexingRuntime.loadLocalLiveSessions({
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
    }),
    openSessionInMain: (sessionKey) => {
      showWindow();
      mainWindow?.webContents.send("open-session", sessionKey);
    },
    shareSessionToTeamInMain: (sessionKey) => {
      showWindow();
      mainWindow?.webContents.send(SHARE_SESSION_TO_TEAM_CHANNEL, sessionKey);
    },
    openSessionsPageInMain: () => showWindow({ focusSearch: true }),
    onDisable: () => applySettingsUpdate({ islandEnabled: false }),
    logError: (message) => console.error(message),
  });
  modelGatewayService = new ModelGatewayService({
    homeDir: app.getPath("home"),
    userDataPath: app.getPath("userData"),
    env: process.env,
    settings: {
      get: (key) => modelGatewayStore.get(key),
      set: (key, value) => modelGatewayStore.set(key, value),
    },
    keys: {
      get: (providerId) => store.getApiProviderKey("gateway", providerId),
      set: (providerId, apiKey) => store.setApiProviderKey("gateway", providerId, apiKey),
    },
    scanImports: () => scanAgentModelImports(app.getPath("home"), process.env),
    onIslandEvent: (event) => {
      void islandService?.ingestEvent(event);
    },
    onSnapshotChanged: (snapshot) => {
      lastGatewayRunning = snapshot.status.running;
      trayController.refreshMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(GATEWAY_SNAPSHOT_CHANNEL, snapshot);
      }
    },
    logError: (message) => console.error(message),
  });

  registerIpc();
  islandService.start();
  void modelGatewayService.startIfEnabled().then((snapshot) => {
    lastGatewayRunning = snapshot.status.running;
    trayController.refreshMenu();
  }).catch((error) => {
    console.error(`Local model gateway startup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  quotaService.start();
  installApplicationMenu({
    productName: PRODUCT_NAME,
    openSettings: () => {
      showWindow();
      mainWindow?.webContents.send("open-settings");
    },
    refresh: () => void indexingRuntime.runIndexSync(true),
  });
  createWindow();
  trayController.create();
  applyDockVisibility(getSettings().showInDock, __dirname);
  void appUpdateService.showPreviousUpdateResult();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }

  const initialIndexSettled = new Promise<void>((resolve) => {
    startupTasks.schedule(INITIAL_INDEX_DELAY_MS, () => {
      void (async () => {
        try {
          const repair = await repairLegacyAgentRecallCodexRollouts(homedir());
          if (repair.failedFiles > 0) {
            console.warn(`[session-migration] ${repair.failedFiles} legacy Codex rollout(s) could not be repaired; they will be retried on the next startup.`);
          }
        } catch (error) {
          console.warn("[session-migration] Legacy Codex rollout repair failed; startup indexing will continue.", error);
        }
        await indexingRuntime.runIndexSync();
      })().then(() => resolve(), () => resolve());
    });
  });
  indexingRuntime.startAutoIndexRefresh();
  startupTasks.whenSettled(initialIndexSettled, () => skillService.startUsageRefresh());
  startupTasks.schedule(INITIAL_SESSION_SYNC_QUEUE_START_DELAY_MS, () => {
    startupTasks.whenSettled(initialIndexSettled, () => remoteSessionService.startQueue());
  });
  startupTasks.schedule(INITIAL_PROVIDER_RESTORE_DELAY_MS, () => {
    startupTasks.whenSettled(initialIndexSettled, () => providerService.restoreCodexChatProxy());
  });
  startupTasks.whenSettled(initialIndexSettled, () => appUpdateService.scheduleInitialCheck());
}).catch(async (error) => {
  console.error(`Failed to start AgentRecall: ${error instanceof Error ? error.message : String(error)}`);
  await appDatabase?.close().catch(() => undefined);
  await databaseRuntime?.stop().catch(() => undefined);
  appDatabase = null;
  databaseRuntime = null;
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
  if (automationQuitStarted) return;
  automationQuitStarted = true;
  startupTasks.cancelAll();
  installedRuntimeMonitor?.stop();
  indexingRuntime.stop();
  islandService?.stop();
  islandService = null;
  skillService.stopUsageRefresh();
  remoteSessionService.stopQueue();
  quotaService?.stop();
  disposeRegisteredIpc?.();
  disposeRegisteredIpc = null;
  globalShortcut.unregisterAll();
  void Promise.allSettled([
    teamWorkspaceService?.close() ?? Promise.resolve(),
    appUpdateService.clearRunningProcess(),
    // Extraction calls a Runtime, so it stops before the automation service shuts down.
    (experienceCardService?.stop() ?? Promise.resolve()).then(() => automationService?.shutdown()),
    modelGatewayService?.shutdown() ?? Promise.resolve(),
    providerService.shutdown(),
  ]).then(async () => {
    // Quit can land during backend startup. Adopt the pending desktop lease
    // and release it only after all desktop database users have closed.
    if (!databaseRuntime && databaseRuntimeStartup) {
      databaseRuntime = await databaseRuntimeStartup.catch(() => null);
    }
    await appDatabase?.close().catch((error) => {
      console.error(`Failed to close AgentRecall data store: ${error instanceof Error ? error.message : String(error)}`);
    });
    appDatabase = null;
    await databaseRuntime?.stop().catch((error) => {
      console.error(`Failed to release AgentRecall search backend: ${error instanceof Error ? error.message : String(error)}`);
    });
    databaseRuntime = null;
    sessionBackend = null;
  }).finally(() => {
    automationQuitReady = true;
    app.quit();
  });
});
