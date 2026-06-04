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
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  mergeApiConfigWithProfileDefaults,
  mergeClaudeApiConfigWithProfileDefaults,
  type ApiConfig,
  type ClaudeApiConfig,
} from "../core/api-config";
import { applyClaudeApiConfig, loadClaudeApiConfigDefaults } from "../core/claude-profile";
import { applyCodexApiConfig, loadCodexProfileDefaults } from "../core/codex-profile";
import { syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { formatSessionMarkdown, formatSessionPlainText } from "../core/format-session";
import {
  defaultSettings,
  getResumeCommand,
  mergeAppSettings,
  normalizeTerminal,
  openNativeApp,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { focusLiveSessionTerminal } from "../core/session-focus";
import { loadLiveSessionSnapshot } from "../core/session-activity";
import { routeResumeSession } from "../core/resume-router";
import { SessionStore } from "../core/session-store";
import { listInstalledSkills, type InstalledSkillsSnapshot } from "../core/skill-manager";
import {
  listSkillUsageSources,
  readSkillUsageSourceEvents,
  usageForSkill,
  type SkillUsageRefreshStatus,
} from "../core/skill-usage";
import { AUTO_INDEX_REFRESH_INTERVAL_MS, INITIAL_INDEX_DELAY_MS } from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type { SearchOptions, SessionStatsOptions } from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "Agent-Session-Search";
type ApiProviderKeyTarget = "codex" | "claude";

// The skill-usage hook installer is a self-contained CommonJS script in bin/
// (sibling of out/), shared with the global-install path. Load it lazily via a
// runtime require so the bundler leaves it as an external dependency, and the
// hook command it writes points back at bin/skill-usage-record.cjs.
const requireCjs = createRequire(import.meta.url);
const SKILL_USAGE_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-skill-usage-hook.cjs");
interface SkillUsageHookSetup {
  installSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  skillUsageHookStatus(options?: Record<string, unknown>): { installed: boolean };
}
function loadSkillUsageHookSetup(): SkillUsageHookSetup {
  return requireCjs(SKILL_USAGE_HOOK_SETUP_PATH) as SkillUsageHookSetup;
}

// Merges skill-usage counts and hook-install state onto the scanned skill list
// so the renderer can sort by most-used.
function buildSkillsSnapshot(): InstalledSkillsSnapshot {
  const snapshot = listInstalledSkills({ projectDirs: [process.cwd()] });
  const usage = store.getSkillUsageSnapshot();
  const skills = snapshot.skills.map((skill) => {
    const stat = usageForSkill(usage, skill.name, skill.agent);
    return { ...skill, usageCount: stat?.count ?? 0, lastUsedAt: stat?.lastUsedAt ?? null };
  });

  let hookInstalled = false;
  try {
    hookInstalled = loadSkillUsageHookSetup().skillUsageHookStatus().installed;
  } catch {
    hookInstalled = false;
  }

  return { ...snapshot, skills, usage: { hookInstalled, logExists: usage.exists, totalEvents: usage.totalEvents } };
}

function refreshSkillUsageIndex(): SkillUsageRefreshStatus {
  const sources = listSkillUsageSources();
  let refreshed = 0;
  let skipped = 0;

  for (const source of sources) {
    if (store.isSkillUsageSourceFresh(source)) {
      skipped += 1;
      continue;
    }
    store.upsertSkillUsageSource(source, readSkillUsageSourceEvents(source));
    refreshed += 1;
  }

  store.pruneSkillUsageSources(sources.map((source) => source.path));
  const usage = store.getSkillUsageSnapshot();
  return {
    refreshed,
    skipped,
    total: sources.length,
    totalEvents: usage.totalEvents,
    lastRefreshedAt: Date.now(),
  };
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-session-search");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun: Promise<IndexStatus> | null = null;
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let registeredGlobalShortcut: string | null = null;

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

async function getHydratedSettings(): Promise<AppSettings> {
  const settings = getSettings();
  const [profileDefaults, claudeProfileDefaults] = await Promise.all([
    loadCodexProfileDefaults(),
    loadClaudeApiConfigDefaults(),
  ]);
  return withStoredApiProviderKeys({
    ...settings,
    apiConfig: mergeApiConfigWithProfileDefaults(settings.apiConfig, getSavedApiConfigPatch(), profileDefaults),
    claudeApiConfig: mergeClaudeApiConfigWithProfileDefaults(
      settings.claudeApiConfig,
      getSavedClaudeApiConfigPatch(),
      claudeProfileDefaults,
    ),
  });
}

function withStoredApiProviderKeys(settings: AppSettings): AppSettings {
  const next = { ...settings };
  if (next.apiConfig.activeProvider === "custom") {
    next.apiConfig = {
      ...next.apiConfig,
      customApiKey: store.getApiProviderKey("codex", next.apiConfig.customProviderId),
    };
  }
  if (next.claudeApiConfig.activeProvider === "custom") {
    next.claudeApiConfig = {
      ...next.claudeApiConfig,
      customApiKey: store.getApiProviderKey("claude", next.claudeApiConfig.customProviderId),
    };
  }
  return next;
}

function withoutApiProviderKeys(settings: AppSettings): AppSettings {
  return {
    ...settings,
    apiConfig: { ...settings.apiConfig, customApiKey: "" },
    claudeApiConfig: { ...settings.claudeApiConfig, customApiKey: "" },
  };
}

function persistApiProviderKeysFromUpdate(update: AppSettingsUpdate, next: AppSettings): void {
  if (update.apiConfig && next.apiConfig.activeProvider === "custom") {
    store.setApiProviderKey("codex", next.apiConfig.customProviderId, next.apiConfig.customApiKey);
  }
  if (update.claudeApiConfig && next.claudeApiConfig.activeProvider === "custom") {
    store.setApiProviderKey("claude", next.claudeApiConfig.customProviderId, next.claudeApiConfig.customApiKey);
  }
}

function migrateLegacyApiProviderKeys(): void {
  const settings = getSettings();
  if (
    settings.apiConfig.activeProvider === "custom" &&
    settings.apiConfig.customApiKey &&
    !store.getApiProviderKey("codex", settings.apiConfig.customProviderId)
  ) {
    store.setApiProviderKey("codex", settings.apiConfig.customProviderId, settings.apiConfig.customApiKey);
  }
  if (
    settings.claudeApiConfig.activeProvider === "custom" &&
    settings.claudeApiConfig.customApiKey &&
    !store.getApiProviderKey("claude", settings.claudeApiConfig.customProviderId)
  ) {
    store.setApiProviderKey("claude", settings.claudeApiConfig.customProviderId, settings.claudeApiConfig.customApiKey);
  }
  settingsStore.set("apiConfig.customApiKey", "");
  settingsStore.set("claudeApiConfig.customApiKey", "");
}

function normalizeApiProviderKeyTarget(target: unknown): ApiProviderKeyTarget {
  if (target === "codex" || target === "claude") return target;
  throw new Error("Unknown API provider key target.");
}

function getSavedApiConfigPatch(): Partial<ApiConfig> {
  const saved: Partial<ApiConfig> = {};
  const readSaved = <K extends keyof ApiConfig>(key: K): void => {
    const pathKey = `apiConfig.${key}` as `apiConfig.${keyof ApiConfig}`;
    if (settingsStore.has(pathKey)) saved[key] = settingsStore.get(pathKey) as ApiConfig[K];
  };

  readSaved("activeProvider");
  readSaved("customProviderId");
  readSaved("customProviderName");
  readSaved("customBaseUrl");
  readSaved("customApiKey");
  readSaved("customModel");
  readSaved("customApiFormat");
  return saved;
}

function getSavedClaudeApiConfigPatch(): Partial<ClaudeApiConfig> {
  const saved: Partial<ClaudeApiConfig> = {};
  const readSaved = <K extends keyof ClaudeApiConfig>(key: K): void => {
    const pathKey = `claudeApiConfig.${key}` as `claudeApiConfig.${keyof ClaudeApiConfig}`;
    if (settingsStore.has(pathKey)) saved[key] = settingsStore.get(pathKey) as ClaudeApiConfig[K];
  };

  readSaved("activeProvider");
  readSaved("customProviderId");
  readSaved("customProviderName");
  readSaved("customBaseUrl");
  readSaved("customApiKey");
  readSaved("customModel");
  readSaved("customHaikuModel");
  readSaved("customSonnetModel");
  readSaved("customOpusModel");
  readSaved("customApiFormat");
  readSaved("customApiKeyField");
  return saved;
}

function markdownExportFileName(title: string): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeTitle || "session"}.md`;
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

function getPreferredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const defaultWidth = 1120;
  const defaultHeight = 760;
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.min(defaultWidth, workArea.width);
  const height = Math.min(defaultHeight, workArea.height);

  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const initialBounds = getPreferredWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 860,
    minHeight: 560,
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

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error("[renderer]", message, `${sourceId}:${line}`);
    else console.log("[renderer]", message);
  });

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
  showWindow();
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  mainWindow.setBounds(getPreferredWindowBounds(), false);
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
  const image = nativeImage.createFromDataURL(
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect x='2' y='3' width='14' height='12' rx='2' fill='black'/><rect x='4' y='5' width='10' height='1.5' fill='white'/><rect x='4' y='8' width='7' height='1.5' fill='white'/><rect x='4' y='11' width='4' height='1.5' fill='white'/></svg>",
  );
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: showWindow },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
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

async function runIndexSync(): Promise<IndexStatus> {
  if (activeIndexRun) return activeIndexRun;

  indexStatus = { ...indexStatus, running: true, error: null };
  mainWindow?.webContents.send("index-status", indexStatus);

  activeIndexRun = syncDefaultSessionsInBatches(store, {
    batchSize: 2,
    loadOptions: {
      includeClaudeInternal: getSettings().includeClaudeInternal,
      includeCodexInternal: getSettings().includeCodexInternal,
      includeCodeBuddyCli: getSettings().includeCodeBuddyCli,
    },
    onProgress: (status) => {
      indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
      mainWindow?.webContents.send("index-status", indexStatus);
    },
  })
    .then((status) => {
      indexStatus = status;
      mainWindow?.webContents.send("index-status", indexStatus);
      return indexStatus;
    })
    .catch((error) => {
      indexStatus = {
        running: false,
        indexed: 0,
        total: 0,
        lastIndexedAt: indexStatus.lastIndexedAt,
        error: String(error),
      };
      mainWindow?.webContents.send("index-status", indexStatus);
      return indexStatus;
    })
    .finally(() => {
      activeIndexRun = null;
    });

  return activeIndexRun;
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
  ipcMain.handle("search:sessions", (_event, options: SearchOptions) => {
    const settings = getSettings();
    return store.searchSessions({
      ...options,
      projectGrouping: settings.projectGrouping,
      promotedProjectRoots: settings.promotedProjectRoots,
    });
  });
  ipcMain.handle("session:get", (_event, sessionKey: string) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:messages", (_event, sessionKey: string, offset?: number, limit?: number) =>
    store.getMessages(sessionKey, offset ?? 0, limit ?? 120),
  );
  ipcMain.handle("session:trace-events", (_event, sessionKey: string) => store.getTraceEvents(sessionKey));
  ipcMain.handle("sessions:live", () => loadLiveSessionSnapshot());
  ipcMain.handle("stats:get", (_event, options?: SessionStatsOptions) => store.getStats(options));
  ipcMain.handle("quota:get", () => {
    const settings = getSettings();
    return loadUsageQuotaSnapshot({
      hideCodexQuota: settings.hideCodexQuota,
      hideClaudeQuota: settings.hideClaudeQuota,
    });
  });
  ipcMain.handle("tags:list", () => store.listTags());
  ipcMain.handle("projects:list", () => {
    const settings = getSettings();
    return store.listProjects(settings.projectGrouping, settings.promotedProjectRoots);
  });
  ipcMain.handle("title:set", (_event, sessionKey: string, title: string | null) => store.setCustomTitle(sessionKey, title));
  ipcMain.handle("tag:add", (_event, sessionKey: string, tagName: string) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey: string, tagName: string) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName: string) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey: string, pinned: boolean) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey: string, hidden: boolean) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("settings:get", () => getHydratedSettings());
  ipcMain.handle("codex-profile:apply", (_event, apiConfig: Partial<ApiConfig>) => applyCodexApiConfig({ apiConfig }));
  ipcMain.handle("claude-profile:apply", (_event, apiConfig: Partial<ClaudeApiConfig>) => applyClaudeApiConfig({ apiConfig }));
  ipcMain.handle("settings:set", (_event, settings: AppSettingsUpdate) => {
    const previous = getSettings();
    const next = mergeAppSettings(previous, settings);
    if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
      throw new Error(
        `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
      );
    }
    persistApiProviderKeysFromUpdate(settings, next);
    settingsStore.set(withoutApiProviderKeys(next));
    if (previous.includeClaudeInternal && !next.includeClaudeInternal) store.deleteSessionsBySource(["claude-internal"]);
    if (previous.includeCodexInternal && !next.includeCodexInternal) store.deleteSessionsBySource(["codex-internal"]);
    if (previous.includeCodeBuddyCli && !next.includeCodeBuddyCli) store.deleteSessionsBySource(["codebuddy-cli"]);
    return withStoredApiProviderKeys(next);
  });
  ipcMain.handle("api-provider-key:get", (_event, target: unknown, providerId: string) =>
    store.getApiProviderKey(normalizeApiProviderKeyTarget(target), providerId),
  );
  ipcMain.handle("skills:list", () => buildSkillsSnapshot());
  ipcMain.handle("skills:refresh-usage", () => refreshSkillUsageIndex());
  ipcMain.handle("skills:copy-path", (_event, skillPath: string) => {
    clipboard.writeText(skillPath);
  });
  ipcMain.handle("skills:reveal", async (_event, skillPath: string) => {
    await revealInFileManager(skillPath);
  });
  ipcMain.handle("skills:usage-hook-status", () => {
    try {
      return loadSkillUsageHookSetup().skillUsageHookStatus().installed;
    } catch {
      return false;
    }
  });
  ipcMain.handle("skills:install-usage-hook", () => {
    const result = loadSkillUsageHookSetup().installSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not configure the skill usage hook.");
    return result.status;
  });
  ipcMain.handle("skills:uninstall-usage-hook", () => {
    const result = loadSkillUsageHookSetup().uninstallSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the skill usage hook.");
    return result.status;
  });
  ipcMain.handle("command:copy-resume", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(getResumeCommand(session, getSettings()));
  });
  ipcMain.handle("command:resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return { route: "resume" as const };
    const snapshot = await loadLiveSessionSnapshot();
    const route = snapshot.error ? { route: "resume" as const } : routeResumeSession(session, snapshot.sessions);
    if (route.route === "focus") {
      await focusLiveSessionTerminal(route.pid);
      store.markResumed(sessionKey);
      return route;
    }
    await openResumeInTerminal(session, getSettings());
    store.markResumed(sessionKey);
    return route;
  });
  ipcMain.handle("command:resume-iterm", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    await openResumeInSpecificTerminal(session, getSettings(), "iTerm");
    store.markResumed(sessionKey);
  });
  ipcMain.handle("command:open-app", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (session) await openNativeApp(session.source);
  });
  ipcMain.handle("command:reveal", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (session) await revealInFileManager(session.projectPath || session.filePath);
  });
  ipcMain.handle("command:copy-markdown", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
  ipcMain.handle("command:export-markdown", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    const exportPath = await chooseMarkdownExportPath(markdownExportFileName(session.displayTitle || session.originalTitle || session.rawId));
    if (!exportPath) return false;
    await fs.writeFile(exportPath, formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)), "utf-8");
    return true;
  });
  ipcMain.handle("command:copy-plain", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionPlainText(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath("userData"), "session-search.sqlite");
  store = new SessionStore(dbPath);
  migrateLegacyApiProviderKeys();
  registerIpc();
  createApplicationMenu();
  createWindow();
  createTray();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", () => {
  stopAutoIndexRefresh();
  globalShortcut.unregisterAll();
  store?.close();
});
