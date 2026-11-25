import { app, Menu, nativeImage, Tray } from "electron";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { AppSettings } from "../../core/platform";

const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");
const APP_ICON_RELATIVE_PATH = path.join("assets", "app-icon.png");

const FALLBACK_TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAABU0lEQVQ4Ec2Tu0pDQRCGk2iCighpJSKIVaqANvbaWQdBsZAgWFr5CD6EMRAh4FsIFmm8lIKFAa8kNqmMF6Lm+4+7um62Sghk4GNn/rNnzuzMnlhs2CzuFVQg3oQJT1fYgiMoKvBtxBGU5AAS8OLo1s3gbMAjXFoxtJ4i3kEy9NDo96za12WjjqLjPMM0VGAMrL3hrEMDQseOjmE397W6FdlEtzjbMG6EV9Yr42s4/oDMo7/lHFcswbfHMvExfBldfZqHX3OzK4lMidbArShPvApNaMMUaHpZeIdgjybRF2EBtPEMlOQQaqDJ7sIcrEBkoR7N8EQ90tQ0rROQ3UAu8n58uWkT/1t0bn3Nv0e6tA/wBLoeF1AHHXEWuqyAoiYrmfrlck38CXYItun7aJG5v4iuvRqor/hVfaCpKlVdhj1QC7ZAv1MVerYUb5Zgp+cMA32xA3OAR0Jsy3XjAAAAAElFTkSuQmCC";

function resolveAssetPath(relativePath: string, mainDir: string): string | null {
  const candidates = [
    path.join(mainDir, "..", "..", relativePath),
    path.join(app.getAppPath(), relativePath),
    path.join(process.resourcesPath, relativePath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function applyDockIcon(mainDir: string): void {
  if (process.platform !== "darwin" || !app.dock) return;
  const dockIconPath = resolveAssetPath(APP_ICON_RELATIVE_PATH, mainDir);
  if (!dockIconPath) return;
  const dockIcon = nativeImage.createFromPath(dockIconPath);
  if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
}

export function applyDockVisibility(showInDock: boolean, mainDir: string): void {
  if (process.platform !== "darwin" || !app.dock) return;
  if (showInDock) {
    void app.dock.show().then(() => applyDockIcon(mainDir)).catch(() => undefined);
    applyDockIcon(mainDir);
  } else {
    app.dock.hide();
  }
}

export interface TrayController {
  create(): void;
  refreshMenu(): void;
}

export function createTrayController(options: {
  productName: string;
  mainDir: string;
  getSettings: () => AppSettings;
  isGatewayRunning: () => boolean;
  onOpenMain: () => void;
  onShowQuickSearch: () => void;
  onToggleIsland: (nextEnabled: boolean) => void;
  onToggleGateway: (nextEnabled: boolean) => void;
  onRefresh: () => void;
  onQuit: () => void;
}): TrayController {
  let tray: Tray | null = null;

  const loadTrayIcon = (): Electron.NativeImage => {
    const iconPath = resolveAssetPath(TRAY_ICON_RELATIVE_PATH, options.mainDir);
    if (iconPath) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image;
    }
    return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL);
  };

  const refreshMenu = (): void => {
    if (!tray) return;
    const settings = options.getSettings();
    const gatewayRunning = options.isGatewayRunning();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${options.productName}`, click: options.onOpenMain },
        { label: "快速搜索会话…", click: options.onShowQuickSearch },
        {
          label: settings.islandEnabled ? "关闭灵动岛提醒" : "开启灵动岛提醒",
          click: () => options.onToggleIsland(!settings.islandEnabled),
        },
        {
          label: gatewayRunning ? "本地模型网关：运行中（点击停止）" : "本地模型网关：已停止（点击启动）",
          click: () => options.onToggleGateway(!gatewayRunning),
        },
        { label: "Refresh Now", click: options.onRefresh },
        { type: "separator" },
        { label: "Quit", click: options.onQuit },
      ]),
    );
  };

  return {
    create(): void {
      const image = loadTrayIcon();
      image.setTemplateImage(true);
      tray = new Tray(image);
      tray.setToolTip(options.productName);
      refreshMenu();
      tray.on("click", options.onOpenMain);
    },
    refreshMenu,
  };
}
