import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

interface ApplicationMenuActions {
  productName: string;
  openSettings(): void;
  refresh(): void;
}

export function refreshApplicationMenuZoom(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById("interface-zoom");
  if (!item) return;
  const window = BrowserWindow.getFocusedWindow();
  const factor = window && !window.isDestroyed() ? window.webContents.getZoomFactor() : 1;
  item.label = `Zoom: ${Math.round(factor * 100)}%`;
}

function changeZoom(direction: -1 | 0 | 1): void {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  // Electron zoom levels use a 1.2 multiplier; retain half-level menu steps.
  const next = direction === 0 ? 1 : contents.getZoomFactor() * Math.pow(1.2, direction * 0.5);
  contents.setZoomFactor(Math.max(0.25, Math.min(5, next)));
  refreshApplicationMenuZoom();
}

export function installApplicationMenu(actions: ApplicationMenuActions, platform = process.platform): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
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
