import {
  app,
  BrowserWindow,
  Menu,
  type Event as ElectronEvent,
  type Input,
  type MenuItemConstructorOptions,
} from "electron";

interface ApplicationMenuActions {
  productName: string;
  openSettings(): void;
  refresh(): void;
}

type BeforeInputListener = (event: ElectronEvent, input: Input) => void;
type WindowCreatedListener = (event: ElectronEvent, window: BrowserWindow) => void;

const windowShortcutListeners = new WeakMap<object, BeforeInputListener>();
let activeWindowCreatedListener: WindowCreatedListener | undefined;

export function refreshApplicationMenuZoom(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById("interface-zoom");
  if (!item) return;
  const window = BrowserWindow.getFocusedWindow();
  const factor = window && !window.isDestroyed() ? window.webContents.getZoomFactor() : 1;
  item.label = `Zoom: ${Math.round(factor * 100)}%`;
}

function changeZoom(direction: -1 | 0 | 1, window = BrowserWindow.getFocusedWindow()): void {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  // Electron zoom levels use a 1.2 multiplier; retain half-level menu steps.
  const next = direction === 0 ? 1 : contents.getZoomFactor() * Math.pow(1.2, direction * 0.5);
  contents.setZoomFactor(Math.max(0.25, Math.min(5, next)));
  refreshApplicationMenuZoom();
}

function handleWindowShortcutInput(
  window: BrowserWindow,
  actions: ApplicationMenuActions,
  event: ElectronEvent,
  input: Input,
): void {
  if (window.isDestroyed()) return;
  if (input.type !== "keyDown" || input.alt || input.meta) return;

  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();

  if (input.control && (key === "=" || key === "+" || key === "numadd" || code === "numpadadd")) {
    event.preventDefault();
    changeZoom(1, window);
    return;
  }

  if (input.control && (key === "-" || key === "numsub" || code === "numpadsubtract")) {
    event.preventDefault();
    changeZoom(-1, window);
    return;
  }

  if (input.control && !input.shift && (key === "0" || key === "num0" || code === "numpad0")) {
    event.preventDefault();
    changeZoom(0, window);
    return;
  }

  if (input.isAutoRepeat) return;

  if (input.control && !input.shift && key === ",") {
    event.preventDefault();
    actions.openSettings();
    return;
  }

  if (input.control && !input.shift && key === "r") {
    event.preventDefault();
    actions.refresh();
    return;
  }

  if (input.control && input.shift && key === "r") {
    event.preventDefault();
    window.webContents.reloadIgnoringCache();
    return;
  }

  if (
    (input.control && input.shift && key === "i") ||
    (!input.control && !input.shift && (key === "f12" || code === "f12"))
  ) {
    event.preventDefault();
    window.webContents.toggleDevTools();
    return;
  }

  if (!input.control && !input.shift && (key === "f11" || code === "f11")) {
    event.preventDefault();
    window.setFullScreen(!window.isFullScreen());
  }
}

function installWindowShortcuts(actions: ApplicationMenuActions): void {
  const attachedContents = new WeakSet<object>();

  const attachToWindow = (window: BrowserWindow): void => {
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (!contents || typeof contents.on !== "function" || attachedContents.has(contents)) return;
    attachedContents.add(contents);

    const previous = windowShortcutListeners.get(contents);
    if (previous) {
      contents.removeListener?.("before-input-event", previous);
    }

    const listener: BeforeInputListener = (event, input) => {
      handleWindowShortcutInput(window, actions, event, input);
    };
    windowShortcutListeners.set(contents, listener);
    contents.on("before-input-event", listener);
  };

  for (const window of BrowserWindow.getAllWindows?.() ?? []) {
    attachToWindow(window);
  }

  if (activeWindowCreatedListener) {
    app.removeListener?.("browser-window-created", activeWindowCreatedListener);
  }
  activeWindowCreatedListener = (_event, window) => {
    attachToWindow(window);
  };
  app.on("browser-window-created", activeWindowCreatedListener);
}

export function installApplicationMenu(actions: ApplicationMenuActions, platform = process.platform): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null);
    installWindowShortcuts(actions);
    return;
  }

  if (activeWindowCreatedListener) {
    app.removeListener?.("browser-window-created", activeWindowCreatedListener);
    activeWindowCreatedListener = undefined;
  }

  app.setAboutPanelOptions({ applicationName: actions.productName });

  const template: MenuItemConstructorOptions[] = [
    {
      label: actions.productName,
      submenu: [
        { label: `About ${actions.productName}`, role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Command+,",
          click: actions.openSettings,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${actions.productName}`, accelerator: "Command+H", role: "hide" },
        { label: "Hide Others", accelerator: "Command+Alt+H", role: "hideOthers" },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        { label: `Quit ${actions.productName}`, accelerator: "Command+Q", click: () => app.quit() },
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
        { label: "Refresh Now", accelerator: "CmdOrCtrl+R", click: actions.refresh },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { id: "interface-zoom", label: "Zoom: 100%", enabled: false },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => changeZoom(0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => changeZoom(1) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => changeZoom(-1) },
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
  app.on("browser-window-focus", refreshApplicationMenuZoom);
  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", refreshApplicationMenuZoom);
    window.webContents.on("zoom-changed", refreshApplicationMenuZoom);
  });
  refreshApplicationMenuZoom();
}
