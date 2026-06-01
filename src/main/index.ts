import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { formatSessionMarkdown, formatSessionPlainText } from "../core/format-session";
import {
  defaultSettings,
  getResumeCommand,
  openNativeApp,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { SessionStore } from "../core/session-store";
import type { AppSettings } from "../core/platform";
import type { SearchOptions } from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "Agent-Session-Search";

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-session-search");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun: Promise<IndexStatus> | null = null;

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

function getSettings(): AppSettings {
  return { ...defaultSettings, ...settingsStore.store };
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
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else {
    mainWindow.setBounds(getPreferredWindowBounds(), false);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("focus-search");
  }
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
      { label: `Open ${PRODUCT_NAME}`, click: toggleWindow },
      { label: "Refresh Index", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function createApplicationMenu(): void {
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });

  const appMenu: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { label: `About ${PRODUCT_NAME}`, role: "about" },
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
        ]
      : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [process.platform === "darwin" ? { role: "close" } : { label: "Quit", role: "quit" }],
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
        { label: "Refresh Index", accelerator: "CmdOrCtrl+R", click: () => void runIndexSync() },
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
      submenu:
        process.platform === "darwin"
          ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
          : [{ role: "minimize" }, { role: "close" }],
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

function registerIpc(): void {
  ipcMain.handle("search:sessions", (_event, options: SearchOptions) => store.searchSessions(options));
  ipcMain.handle("session:get", (_event, sessionKey: string) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:messages", (_event, sessionKey: string, offset?: number, limit?: number) =>
    store.getMessages(sessionKey, offset ?? 0, limit ?? 120),
  );
  ipcMain.handle("tags:list", () => store.listTags());
  ipcMain.handle("projects:list", () => store.listProjects());
  ipcMain.handle("title:set", (_event, sessionKey: string, title: string | null) => store.setCustomTitle(sessionKey, title));
  ipcMain.handle("tag:add", (_event, sessionKey: string, tagName: string) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey: string, tagName: string) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName: string) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey: string, pinned: boolean) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey: string, hidden: boolean) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_event, settings: Partial<AppSettings>) => {
    settingsStore.set({ ...getSettings(), ...settings });
    return getSettings();
  });
  ipcMain.handle("command:copy-resume", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(getResumeCommand(session, getSettings()));
  });
  ipcMain.handle("command:resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    store.markResumed(sessionKey);
    await openResumeInTerminal(session, getSettings());
  });
  ipcMain.handle("command:resume-iterm", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    store.markResumed(sessionKey);
    await openResumeInSpecificTerminal(session, getSettings(), "iTerm");
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
    clipboard.writeText(formatSessionMarkdown(session, store.getAllMessages(sessionKey)));
  });
  ipcMain.handle("command:copy-plain", (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionPlainText(session, store.getAllMessages(sessionKey)));
  });
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath("userData"), "session-search.sqlite");
  store = new SessionStore(dbPath);
  registerIpc();
  createApplicationMenu();
  createWindow();
  createTray();
  globalShortcut.register("Alt+Space", toggleWindow);
  setTimeout(() => void runIndexSync(), 750);
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  store?.close();
});
