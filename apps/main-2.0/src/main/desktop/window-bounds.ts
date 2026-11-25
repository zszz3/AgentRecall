import { screen, type BrowserWindow } from "electron";
import Store from "electron-store";

type SavedWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 820;
export const MIN_WINDOW_WIDTH = 860;
export const MIN_WINDOW_HEIGHT = 560;

export interface WindowBounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface WindowBoundsController {
  getRestoredBounds(): WindowBounds;
  shouldRestoreMaximized(): boolean;
  attach(window: BrowserWindow): void;
}

export function createWindowBoundsController(): WindowBoundsController {
  const windowStateStore = new Store<SavedWindowState>({
    name: "window-state",
    defaults: { width: 0, height: 0 },
  });

  const getPreferredWindowBounds = (): WindowBounds => {
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
  };

  return {
    getRestoredBounds(): WindowBounds {
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
    },

    shouldRestoreMaximized(): boolean {
      return windowStateStore.get("isMaximized") === true;
    },

    attach(window: BrowserWindow): void {
      let persistTimer: ReturnType<typeof setTimeout> | null = null;

      const persistWindowState = (): void => {
        if (window.isDestroyed()) return;
        if (window.isMaximized() || window.isFullScreen()) {
          windowStateStore.set("isMaximized", true);
          return;
        }
        const bounds = window.getBounds();
        windowStateStore.set({
          width: bounds.width,
          height: bounds.height,
          x: bounds.x,
          y: bounds.y,
          isMaximized: false,
        });
      };

      const schedulePersist = (): void => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          persistTimer = null;
          persistWindowState();
        }, 250);
        persistTimer.unref();
      };

      const flushPersist = (): void => {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        persistWindowState();
      };

      window.on("close", flushPersist);
      window.on("closed", () => {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
      });
      window.on("resize", schedulePersist);
      window.on("move", schedulePersist);
      window.on("maximize", schedulePersist);
      window.on("unmaximize", schedulePersist);
    },
  };
}
