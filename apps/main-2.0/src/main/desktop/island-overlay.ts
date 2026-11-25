import { BrowserWindow, screen } from "electron";
import type { AppSettings } from "../../core/platform";
import type { IslandOverlayWindowPort } from "../services/island-service";
import { ISLAND_SNAPSHOT_CHANNEL, type IslandSnapshot } from "../../shared/ipc/island";

const ISLAND_OVERLAY_WIDTH = 468;
const ISLAND_OVERLAY_HEIGHT = 440;

export function islandConfigFromSettings(settings: AppSettings) {
  return {
    enabled: Boolean(settings.islandEnabled),
    soundEnabled: settings.islandSoundEnabled !== false,
    suppressWhenFocused: settings.islandSuppressWhenFocused !== false,
    autoCollapseSeconds: settings.islandAutoCollapseSeconds,
  };
}

export function createIslandOverlayWindowPort(options: {
  preloadPath: string;
  rendererUrl?: string;
  rendererHtmlPath: string;
}): IslandOverlayWindowPort {
  let islandWindow: BrowserWindow | null = null;
  let pendingSnapshot: IslandSnapshot | null = null;
  let interactive = false;
  const supportsForwardClickThrough = process.platform === "darwin" || process.platform === "win32";

  const positionTopCenter = (window: BrowserWindow): void => {
    const display = screen.getPrimaryDisplay();
    const x = Math.round(display.workArea.x + (display.workArea.width - ISLAND_OVERLAY_WIDTH) / 2);
    // Keep a fixed-size transparent surface centered below the macOS menu bar so animations
    // run purely in Chromium without reallocating the native backing surface via setBounds.
    const y = Math.round(display.workArea.y + 2);
    window.setBounds({ x, y, width: ISLAND_OVERLAY_WIDTH, height: ISLAND_OVERLAY_HEIGHT }, false);
  };

  const applyMouseIgnore = (window: BrowserWindow, nextInteractive: boolean): void => {
    if (!supportsForwardClickThrough) return;
    if (nextInteractive) {
      window.setIgnoreMouseEvents(false);
    } else {
      window.setIgnoreMouseEvents(true, { forward: true });
    }
  };

  const handleDisplayChanged = (): void => {
    if (islandWindow && !islandWindow.isDestroyed()) {
      positionTopCenter(islandWindow);
    }
  };

  const ensureCreated = (): void => {
    if (islandWindow && !islandWindow.isDestroyed()) return;
    const window = new BrowserWindow({
      width: ISLAND_OVERLAY_WIDTH,
      height: ISLAND_OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      focusable: false,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      backgroundColor: "#00000000",
      webPreferences: {
        preload: options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setAlwaysOnTop(true, process.platform === "darwin" ? "screen-saver" : "floating");
    if (process.platform === "darwin") {
      // skipTransformProcessType prevents Electron from switching the app to UIElementApplication,
      // which would hide the macOS Dock icon whenever the Dynamic Island joins fullscreen Spaces.
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    interactive = false;
    applyMouseIgnore(window, false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("did-finish-load", () => {
      if (pendingSnapshot && !window.isDestroyed()) {
        window.webContents.send(ISLAND_SNAPSHOT_CHANNEL, pendingSnapshot);
        if (pendingSnapshot.enabled) {
          positionTopCenter(window);
          if (!window.isVisible()) window.showInactive();
        }
      }
    });
    screen.on("display-metrics-changed", handleDisplayChanged);
    screen.on("display-added", handleDisplayChanged);
    screen.on("display-removed", handleDisplayChanged);
    window.on("closed", () => {
      screen.removeListener("display-metrics-changed", handleDisplayChanged);
      screen.removeListener("display-added", handleDisplayChanged);
      screen.removeListener("display-removed", handleDisplayChanged);
      if (islandWindow === window) islandWindow = null;
    });
    positionTopCenter(window);
    if (options.rendererUrl) {
      void window.loadURL(new URL("island.html", options.rendererUrl).toString());
    } else {
      void window.loadFile(options.rendererHtmlPath);
    }
    islandWindow = window;
  };

  return {
    ensureCreated,
    showInactive() {
      ensureCreated();
      if (!islandWindow || islandWindow.isDestroyed()) return;
      if (!islandWindow.isVisible()) {
        positionTopCenter(islandWindow);
        islandWindow.showInactive();
      }
    },
    hide() {
      interactive = false;
      if (islandWindow && !islandWindow.isDestroyed()) {
        applyMouseIgnore(islandWindow, false);
        if (islandWindow.isVisible()) islandWindow.hide();
      }
    },
    destroy() {
      interactive = false;
      if (islandWindow && !islandWindow.isDestroyed()) {
        islandWindow.destroy();
      }
      islandWindow = null;
    },
    setInteractive(nextInteractive: boolean) {
      if (interactive === nextInteractive) return;
      interactive = nextInteractive;
      if (!islandWindow || islandWindow.isDestroyed()) return;
      applyMouseIgnore(islandWindow, nextInteractive);
    },
    sendSnapshot(snapshot: IslandSnapshot) {
      pendingSnapshot = snapshot;
      if (!islandWindow || islandWindow.isDestroyed() || islandWindow.webContents.isLoading()) return;
      islandWindow.webContents.send(ISLAND_SNAPSHOT_CHANNEL, snapshot);
    },
  };
}
