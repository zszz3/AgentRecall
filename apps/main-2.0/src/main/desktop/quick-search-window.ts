import { BrowserWindow, screen, shell } from "electron";
import { normalizeExternalLink } from "../../core/external-link";
import { DEEPSEEK_WEB_URL, openDeepSeekWebSessionPage } from "../deepseek-web-session";

export interface QuickSearchWindowController {
  show(): void;
  hide(): void;
  getWindow(): BrowserWindow | null;
}

export function createQuickSearchWindowController(options: {
  preloadPath: string;
  rendererUrl?: string;
  rendererHtmlPath: string;
  onDidFinishLoad: (window: BrowserWindow) => void;
}): QuickSearchWindowController {
  let quickSearchWindow: BrowserWindow | null = null;

  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 560,
      height: 430,
      minWidth: 560,
      minHeight: 430,
      maxWidth: 560,
      maxHeight: 430,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("did-finish-load", () => options.onDidFinishLoad(window));
    window.on("blur", () => window.hide());
    window.on("closed", () => {
      if (quickSearchWindow === window) quickSearchWindow = null;
    });
    if (options.rendererUrl) {
      void window.loadURL(new URL("quick-search.html", options.rendererUrl).toString());
    } else {
      void window.loadFile(options.rendererHtmlPath);
    }
    return window;
  };

  return {
    show(): void {
      if (!quickSearchWindow || quickSearchWindow.isDestroyed()) {
        quickSearchWindow = createWindow();
      }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const bounds = quickSearchWindow.getBounds();
      quickSearchWindow.setPosition(
        Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
        Math.round(display.workArea.y + Math.min(72, display.workArea.height * 0.08)),
      );
      quickSearchWindow.show();
      quickSearchWindow.focus();
    },

    hide(): void {
      quickSearchWindow?.hide();
    },

    getWindow(): BrowserWindow | null {
      return quickSearchWindow;
    },
  };
}

export interface DeepSeekWebWindowController {
  showSession(sessionId: string): Promise<void>;
}

export function createDeepSeekWebWindowController(): DeepSeekWebWindowController {
  let deepSeekWebWindow: BrowserWindow | null = null;

  const getWindow = (): BrowserWindow => {
    if (deepSeekWebWindow && !deepSeekWebWindow.isDestroyed()) return deepSeekWebWindow;
    const allowedOrigin = new URL(DEEPSEEK_WEB_URL).origin;
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 860,
      minHeight: 600,
      show: false,
      title: "DeepSeek Harness",
      backgroundColor: "#0a0b0d",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:deepseek-harness-web",
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const externalUrl = normalizeExternalLink(url);
      if (externalUrl) void shell.openExternal(externalUrl);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin === allowedOrigin) return;
      } catch {
        // Invalid URLs are denied below.
      }
      event.preventDefault();
      const externalUrl = normalizeExternalLink(url);
      if (externalUrl) void shell.openExternal(externalUrl);
    });
    window.on("closed", () => {
      if (deepSeekWebWindow === window) deepSeekWebWindow = null;
    });
    deepSeekWebWindow = window;
    return window;
  };

  return {
    async showSession(sessionId: string): Promise<void> {
      const window = getWindow();
      window.hide();
      await openDeepSeekWebSessionPage(
        {
          loadURL: (url) => window.loadURL(url),
          executeJavaScript: (script) => window.webContents.executeJavaScript(script),
          show: () => window.show(),
          focus: () => window.focus(),
        },
        sessionId,
      );
    },
  };
}
