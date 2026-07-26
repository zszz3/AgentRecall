import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import { existsSync } from "node:fs";
import { homedir, release as osRelease } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCoreSettingsUpdate,
  coreSettingsFromAppSettings,
} from "../core/core-settings";
import {
  syncDefaultSessionsInBatches,
  type IndexStatus,
} from "../core/indexer";
import {
  defaultSettings,
  mergeAppSettings,
  normalizeTerminal,
  openNativeApp,
  openResumeInTerminal,
  type AppSettings,
} from "../core/platform";
import {
  AUTO_INDEX_REFRESH_INTERVAL_MS,
  INITIAL_INDEX_DELAY_MS,
} from "../core/refresh-policy";
import { routeResumeSession, type ResumeRouteResult } from "../core/resume-router";
import { createCachedLiveSessionSnapshotLoader } from "../core/session-activity";
import { focusLiveSessionTerminal } from "../core/session-focus";
import { SessionStore } from "../core/session-store";
import {
  globalShortcutLabel,
  normalizeGlobalShortcut,
} from "../core/shortcuts";
import type { NativeUpdateController } from "../distribution/native-update-controller";
import { registerElectronUpdater } from "../distribution/electron-updater-registration";
import type { NativeUpdateState } from "../distribution/native-update-types";
import { createVersionedDatabaseBackupLifecycle } from "../distribution/versioned-database-backup";
import type { PrivacyIpcService } from "./ipc/privacy";
import type { CoreSettings, CoreSettingsUpdate } from "../shared/core-api";
import { CORE_EVENTS } from "../shared/ipc/core";
import { NATIVE_UPDATE_EVENTS } from "../shared/ipc/native-update";
import { CORE_SESSION_SOURCES } from "../shared/product-profile";
import { registerCoreIpc } from "./ipc/core";
import {
  isTrustedCoreIpcSender,
  isTrustedCoreRendererUrl,
  type CoreRendererLocation,
} from "./ipc/core-sender";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";
import {
  createCoreNativeUpdateService,
  sanitizeNativeUpdateStateForRenderer,
} from "./services/core-native-update-service";
import { createCorePrivacyService } from "./services/core-privacy-service";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "AgentRecall";
const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
const MIN_WINDOW_WIDTH = 860;
const MIN_WINDOW_HEIGHT = 560;

type SavedWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-recall");
app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SessionStore | null = null;
let disposeCoreIpc: (() => void) | null = null;
let nativeUpdateController: NativeUpdateController | null = null;
let disposeNativeUpdateSubscription: (() => void) | null = null;
let privacyService: PrivacyIpcService | null = null;
let registeredGlobalShortcut: string | null = null;
let firstWindowAvailable = false;
let coreBackgroundStarted = false;
let initialIndexTimer: ReturnType<typeof setTimeout> | null = null;
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let activeIndexRun: Promise<IndexStatus> | null = null;
let indexStatus: IndexStatus = {
  running: false,
  indexed: 0,
  skipped: 0,
  total: 0,
  lastIndexedAt: null,
  error: null,
};

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});
const windowStateStore = new Store<SavedWindowState>({
  name: "window-state",
  defaults: { width: 0, height: 0 },
});
const loadCachedLiveSessionSnapshot = createCachedLiveSessionSnapshotLoader();

function getStore(): SessionStore {
  if (!store) throw new Error("Core session store is not ready.");
  return store;
}

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

const nativeUpdateService = createCoreNativeUpdateService({
  currentVersion: app.getVersion(),
  getController: () => nativeUpdateController,
  copyText: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
});

function databasePath(): string {
  return path.join(app.getPath("userData"), "session-search.sqlite");
}

function currentNativeUpdateState(): NativeUpdateState {
  return nativeUpdateController?.getState() ?? {
    phase: "disabled",
    currentVersion: app.getVersion(),
    targetVersion: null,
    progressPercent: null,
    backupPath: null,
    failure: null,
  };
}

function initializeProductionServices(): void {
  if (
    app.isPackaged
    && process.env.AGENT_RECALL_NO_UPDATE_CHECK !== "1"
    && !nativeUpdateController
  ) {
    nativeUpdateController = registerElectronUpdater({
      currentVersion: app.getVersion(),
      preferences: {
        isAutomaticCheckEnabled: () => getSettings().autoCheckUpdates,
        setAutomaticCheckEnabled: (enabled) => {
          settingsStore.set({
            ...getSettings(),
            autoCheckUpdates: enabled,
          });
        },
      },
      backupLifecycle: createVersionedDatabaseBackupLifecycle({
        databasePath: databasePath(),
        backupRoot: path.join(app.getPath("userData"), "update-backups"),
        closeDatabase: closeStoreForNativeUpdate,
        reopenDatabaseAfterFailure: reopenStoreAfterNativeUpdateFailure,
      }),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      copyText: (text) => clipboard.writeText(text),
      openExternal: (url) => shell.openExternal(url),
      platform: process.platform,
      arch: process.arch,
    });
    disposeNativeUpdateSubscription = nativeUpdateController.subscribe(
      (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            NATIVE_UPDATE_EVENTS.state,
            sanitizeNativeUpdateStateForRenderer(state),
          );
        }
      },
    );
  }

  privacyService = createCorePrivacyService({
    getStore,
    getSettings,
    getNativeUpdateState: currentNativeUpdateState,
    version: app.getVersion(),
    homeDir: homedir(),
    userDataPath: app.getPath("userData"),
    databasePath: databasePath(),
    backupRoot: path.join(
      app.getPath("userData"),
      "legacy-integration-backups",
    ),
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
  });
}

async function closeStoreForNativeUpdate(): Promise<void> {
  stopCoreBackground();
  coreBackgroundStarted = false;
  await activeIndexRun;
  store?.close();
  store = null;
}

function reopenStoreAfterNativeUpdateFailure(): void {
  if (!store) store = new SessionStore(databasePath());
  if (firstWindowAvailable) startCoreBackgroundAfterFirstWindow();
}

function coreRendererLocation(): CoreRendererLocation {
  return {
    productionFile: path.join(__dirname, "../renderer/index.html"),
    developmentUrl: process.env.ELECTRON_RENDERER_URL || undefined,
  };
}

function createTrustedCoreIpcRegistrar(): IpcMainRegistrar {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        const currentWindow = mainWindow;
        if (
          !currentWindow
          || currentWindow.isDestroyed()
          || !isTrustedCoreIpcSender(
            event,
            currentWindow.webContents,
            coreRendererLocation(),
          )
        ) {
          throw new Error(`Rejected untrusted Core IPC sender for "${channel}".`);
        }
        return listener(event, ...args);
      });
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
  };
}

function registerProductionCoreIpc(): void {
  if (!privacyService) {
    throw new Error("Core privacy service is not ready.");
  }
  disposeCoreIpc = registerCoreIpc(createTrustedCoreIpcRegistrar(), {
    getStore,
    getAppSettings: getSettings,
    getCoreSettings: () => coreSettingsFromAppSettings(getSettings()),
    setCoreSettings,
    getIndexStatus: () => indexStatus,
    refreshIndex: runIndexSync,
    getLiveSessions: () =>
      loadCachedLiveSessionSnapshot({ includeTrae: false }),
    resumeSession,
    nativeUpdateService,
    privacyService,
  });
}

async function setCoreSettings(
  update: CoreSettingsUpdate,
): Promise<CoreSettings> {
  const previous = getSettings();
  const next = mergeAppSettings(
    previous,
    applyCoreSettingsUpdate(previous, update),
  );
  if (
    next.globalShortcut !== previous.globalShortcut
    && !registerAppGlobalShortcut(next.globalShortcut)
  ) {
    throw new Error(
      `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
    );
  }
  settingsStore.set(next);
  if ("autoCheckUpdates" in update) {
    await nativeUpdateController?.setAutomaticChecksEnabled(
      next.autoCheckUpdates,
    );
  }
  return coreSettingsFromAppSettings(next);
}

async function resumeSession(sessionKey: string): Promise<ResumeRouteResult> {
  const session = getStore().getSession(sessionKey);
  if (!session) {
    throw new Error(
      "This session is no longer available. Refresh the session list and try again.",
    );
  }

  const snapshot = await loadCachedLiveSessionSnapshot({ includeTrae: false });
  const route = routeResumeSession(
    session,
    snapshot.error ? [] : snapshot.sessions,
  );
  if (route.route === "app") {
    await openNativeApp(session, {
      openExternal: (url) => shell.openExternal(url),
    });
  } else if (route.route === "focus") {
    await focusLiveSessionTerminal(route.pid);
  } else {
    await openResumeInTerminal(session, getSettings());
  }
  getStore().markResumed(sessionKey);
  return route;
}

async function runIndexSync(): Promise<IndexStatus> {
  if (!firstWindowAvailable) return indexStatus;
  if (activeIndexRun) return activeIndexRun;

  indexStatus = { ...indexStatus, running: true, error: null };
  publishIndexStatus();
  activeIndexRun = syncDefaultSessionsInBatches(getStore(), {
    batchSize: 2,
    pruneMissingSessions: false,
    allowedSources: CORE_SESSION_SOURCES,
    loadOptions: {
      includeClaudeInternal: false,
      includeCodexInternal: false,
      includeTclaude: false,
      includeTcodex: false,
      includeCodeBuddyCli: false,
      includeCodeWizCli: false,
      includeOpenClaw: false,
      includeHermes: false,
      includeOpenCode: false,
      includeCursorAgent: false,
      includeTrae: false,
    },
    onProgress: (status) => {
      indexStatus = {
        ...status,
        lastIndexedAt: indexStatus.lastIndexedAt,
      };
      publishIndexStatus();
    },
  })
    .then((status) => {
      indexStatus = status;
      publishIndexStatus();
      return status;
    })
    .catch((error) => {
      indexStatus = {
        running: false,
        indexed: 0,
        skipped: 0,
        total: 0,
        lastIndexedAt: indexStatus.lastIndexedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      publishIndexStatus();
      return indexStatus;
    })
    .finally(() => {
      activeIndexRun = null;
    });
  return activeIndexRun;
}

function publishIndexStatus(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CORE_EVENTS.indexStatus, indexStatus);
  }
}

function startCoreBackgroundAfterFirstWindow(): void {
  if (coreBackgroundStarted) return;
  coreBackgroundStarted = true;
  nativeUpdateController?.firstUsableWindowReady();
  initialIndexTimer = setTimeout(() => {
    initialIndexTimer = null;
    void runIndexSync();
  }, INITIAL_INDEX_DELAY_MS);
  autoIndexTimer = setInterval(() => {
    void runIndexSync();
  }, AUTO_INDEX_REFRESH_INTERVAL_MS);
}

function markWindowAvailable(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (!window.isVisible()) window.show();
  if (firstWindowAvailable) return;
  firstWindowAvailable = true;
  startCoreBackgroundAfterFirstWindow();
}

function getPreferredWindowBounds(): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
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

function getRestoredWindowBounds(): {
  width: number;
  height: number;
  x: number;
  y: number;
} {
  const saved = windowStateStore.store;
  if (saved.width >= MIN_WINDOW_WIDTH && saved.height >= MIN_WINDOW_HEIGHT) {
    const { workArea } = screen.getDisplayMatching({
      x: saved.x ?? 0,
      y: saved.y ?? 0,
      width: saved.width,
      height: saved.height,
    });
    if (
      saved.x !== undefined
      && saved.y !== undefined
      && saved.x + saved.width > workArea.x
      && saved.y + saved.height > workArea.y
      && saved.x < workArea.x + workArea.width
      && saved.y < workArea.y + workArea.height
    ) {
      return {
        width: saved.width,
        height: saved.height,
        x: saved.x,
        y: saved.y,
      };
    }
  }
  return getPreferredWindowBounds();
}

function persistWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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

function createWindow(): BrowserWindow {
  const rendererLocation = coreRendererLocation();
  const window = new BrowserWindow({
    ...getRestoredWindowBounds(),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: PRODUCT_NAME,
    // Present the stable window surface before opening or migrating the local
    // session database below. The renderer becomes interactive after Core IPC
    // registration, while the OS can paint this background immediately.
    show: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    backgroundColor: "#0a0b0d",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;

  if (windowStateStore.get("isMaximized") === true) window.maximize();

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedCoreRendererUrl(url, rendererLocation)) {
      event.preventDefault();
    }
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[renderer] did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );
  window.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level >= 2) console.error("[renderer]", message, `${sourceId}:${line}`);
      else console.log("[renderer]", message);
    },
  );

  window.once("ready-to-show", () => markWindowAvailable(window));
  window.webContents.once("did-finish-load", () => markWindowAvailable(window));
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on("resize", persistWindowState);
  window.on("move", persistWindowState);
  window.on("maximize", persistWindowState);
  window.on("unmaximize", persistWindowState);

  if (rendererLocation.developmentUrl) {
    void window.loadURL(rendererLocation.developmentUrl);
  } else {
    void window.loadFile(rendererLocation.productionFile);
  }
  return window;
}

function showWindow(): void {
  const window = mainWindow ?? createWindow();
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
    window.webContents.send(CORE_EVENTS.focusSearch);
  }
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
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

function createTray(): void {
  if (tray) return;
  const image = loadTrayIcon();
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: showWindow },
      {
        label: "Refresh Now",
        click: () => {
          if (firstWindowAvailable) void runIndexSync();
        },
      },
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
  return nativeImage.createEmpty();
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
            mainWindow?.webContents.send(CORE_EVENTS.openSettings);
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${PRODUCT_NAME}`, accelerator: "Command+H", role: "hide" },
        {
          label: "Hide Others",
          accelerator: "Command+Alt+H",
          role: "hideOthers",
        },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        {
          label: `Quit ${PRODUCT_NAME}`,
          accelerator: "Command+Q",
          click: () => app.quit(),
        },
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
        {
          label: "Refresh Now",
          accelerator: "CmdOrCtrl+R",
          click: () => void runIndexSync(),
        },
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
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stopCoreBackground(): void {
  if (initialIndexTimer) {
    clearTimeout(initialIndexTimer);
    initialIndexTimer = null;
  }
  if (autoIndexTimer) {
    clearInterval(autoIndexTimer);
    autoIndexTimer = null;
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void app.whenReady().then(showWindow);
  });

  void app.whenReady().then(() => {
    createWindow();
    store = new SessionStore(databasePath());
    initializeProductionServices();
    registerProductionCoreIpc();
    createApplicationMenu();
    createTray();
    const shortcut = getSettings().globalShortcut;
    if (!registerAppGlobalShortcut(shortcut)) {
      console.error(
        `Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`,
      );
    }
  });
}

app.on("window-all-closed", () => {
  // The tray/menu owns application lifetime.
});

app.on("activate", showWindow);

app.on("before-quit", () => {
  stopCoreBackground();
  disposeCoreIpc?.();
  disposeCoreIpc = null;
  disposeNativeUpdateSubscription?.();
  disposeNativeUpdateSubscription = null;
  globalShortcut.unregisterAll();
  store?.close();
  store = null;
});
