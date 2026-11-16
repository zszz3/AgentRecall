import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, BrowserWindow, Menu, type Input } from "electron";
import { installApplicationMenu, refreshApplicationMenuZoom } from "./application-menu";

interface MenuEntry { id?: string; enabled?: boolean; label?: string; role?: string; accelerator?: string; submenu?: MenuEntry[]; click?: () => void }
type MockListener = (...args: unknown[]) => void;

interface MockWindow {
  destroyed: boolean;
  fullScreen: boolean;
  factor: number;
  listeners: Map<string, MockListener[]>;
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  setFullScreen: ReturnType<typeof vi.fn>;
  webContents: {
    getZoomFactor: () => number;
    setZoomFactor: ReturnType<typeof vi.fn>;
    reloadIgnoringCache: ReturnType<typeof vi.fn>;
    toggleDevTools: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emitBeforeInput: (overrides: Partial<Input>) => { defaultPrevented: boolean; listenerCount: number };
}

const state = vi.hoisted(() => ({
  factor: 1,
  destroyed: false,
  template: [] as MenuEntry[],
  events: new Map<string, MockListener>(),
  windows: [] as MockWindow[],
}));

function createMockWindow(options: { destroyed?: boolean; fullScreen?: boolean; factor?: number } = {}): MockWindow {
  const listeners = new Map<string, MockListener[]>();
  const win: MockWindow = {
    destroyed: options.destroyed ?? false,
    fullScreen: options.fullScreen ?? false,
    factor: options.factor ?? 1,
    listeners,
    isDestroyed: () => win.destroyed,
    isFullScreen: () => win.fullScreen,
    setFullScreen: vi.fn((flag: boolean) => {
      win.fullScreen = flag;
    }),
    webContents: {
      getZoomFactor: () => win.factor,
      setZoomFactor: vi.fn((factor: number) => {
        win.factor = factor;
      }),
      reloadIgnoringCache: vi.fn(),
      toggleDevTools: vi.fn(),
      on: vi.fn((event: string, listener: MockListener) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      }),
      removeListener: vi.fn((event: string, listener: MockListener) => {
        const list = listeners.get(event) ?? [];
        listeners.set(event, list.filter(item => item !== listener));
      }),
    },
    emitBeforeInput: (overrides) => {
      let defaultPrevented = false;
      const event = { preventDefault: () => { defaultPrevented = true; } };
      const input: Input = {
        type: "keyDown",
        key: "",
        code: "",
        isAutoRepeat: false,
        isComposing: false,
        shift: false,
        control: false,
        alt: false,
        meta: false,
        location: 0,
        modifiers: [],
        ...overrides,
      };
      const registered = [...(listeners.get("before-input-event") ?? [])];
      for (const listener of registered) listener(event, input);
      return { defaultPrevented, listenerCount: registered.length };
    },
  };
  return win;
}

vi.mock("electron", () => {
  const menu = { getMenuItemById: (id: string) => state.template.flatMap(item => item.submenu ?? []).find(item => item.id === id) };
  return {
    app: {
      setAboutPanelOptions: vi.fn(),
      quit: vi.fn(),
      on: vi.fn((event: string, callback: MockListener) => state.events.set(event, callback)),
      removeListener: vi.fn((event: string, callback: MockListener) => {
        if (state.events.get(event) === callback) state.events.delete(event);
      }),
    },
    BrowserWindow: {
      getFocusedWindow: vi.fn(() => ({
        isDestroyed: () => state.destroyed,
        webContents: { getZoomFactor: () => state.factor, setZoomFactor: (factor: number) => { state.factor = factor; } },
      })),
      getAllWindows: vi.fn(() => state.windows),
    },
    Menu: {
      setApplicationMenu: vi.fn(),
      getApplicationMenu: vi.fn(() => menu),
      buildFromTemplate: vi.fn((template: MenuEntry[]) => { state.template = template; return menu; }),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  state.factor = 1;
  state.destroyed = false;
  state.template = [];
  state.events.clear();
  state.windows = [];
});

function install(platform: NodeJS.Platform) {
  const events: string[] = [];
  const runIndexSync = vi.fn();
  installApplicationMenu({
    productName: "AgentRecall",
    openSettings: () => { events.push("show", "open-settings"); },
    refresh: () => { runIndexSync(true); },
  }, platform);
  return { app, Menu, runIndexSync, events };
}

describe("application menu characterization", () => {
  it("preserves native roles, accelerators and command routing on macOS", () => {
    const h = install("darwin");
    const template = vi.mocked(h.Menu.buildFromTemplate).mock.calls[0][0] as MenuEntry[];
    expect(template.map(item => item.label)).toEqual(["AgentRecall", "File", "Edit", "View", "Window"]);
    expect(h.app.setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: "AgentRecall" });
    const settings = template[0].submenu!.find(item => item.label === "Settings...")!;
    expect(settings.accelerator).toBe("Command+,");
    settings.click!();
    expect(h.events).toEqual(["show", "open-settings"]);
    const refresh = template[3].submenu!.find(item => item.label === "Refresh Now")!;
    expect(refresh.accelerator).toBe("CmdOrCtrl+R");
    refresh.click!();
    expect(h.runIndexSync).toHaveBeenCalledWith(true);
    template[0].submenu!.find(item => item.label === "Quit AgentRecall")!.click!();
    expect(h.app.quit).toHaveBeenCalledOnce();
    expect(template[2].submenu!.filter(item => item.role).map(item => item.role)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    expect(h.Menu.setApplicationMenu).toHaveBeenCalledWith(Menu.getApplicationMenu());
  });

  it.each(["linux", "win32"] as const)("keeps the application menu absent on %s", platform => {
    const h = install(platform);
    expect(h.Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(h.Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(h.app.setAboutPanelOptions).not.toHaveBeenCalled();
  });
});

it("keeps the displayed percentage in sync with zoom menu actions and reset", () => {
  install("darwin");
  const view = state.template.find(item => item.label === "View")!.submenu!;
  const indicator = view.find(item => item.id === "interface-zoom")!;
  expect(indicator.enabled).toBe(false);
  expect(indicator.label).toBe("Zoom: 100%");
  view.find(item => item.label === "Zoom In")!.click!();
  expect(indicator.label).toBe("Zoom: 110%");
  view.find(item => item.label === "Zoom Out")!.click!();
  expect(indicator.label).toBe("Zoom: 100%");
  state.factor = 4 / 3;
  refreshApplicationMenuZoom();
  expect(indicator.label).toBe("Zoom: 133%");
  const reset = view.find(item => item.label === "Actual Size")!;
  expect(reset.accelerator).toBe("CmdOrCtrl+0");
  reset.click!();
  expect(state.factor).toBe(1);
  expect(indicator.label).toBe("Zoom: 100%");
});

it("reads the actual focused window zoom and safely handles destroyed windows", () => {
  install("darwin");
  state.factor = 0.75;
  state.events.get("browser-window-focus")!();
  expect(Menu.getApplicationMenu()!.getMenuItemById("interface-zoom")!.label).toBe("Zoom: 75%");
  state.destroyed = true;
  state.template.find(item => item.label === "View")!.submenu!.find(item => item.label === "Zoom In")!.click!();
  expect(state.factor).toBe(0.75);
  expect(BrowserWindow.getFocusedWindow).toHaveBeenCalled();
});

describe("Windows and Linux keyboard shortcuts without application menu", () => {
  it("does not attach before-input-event shortcut handlers on macOS", () => {
    const win = createMockWindow();
    state.windows = [win];
    install("darwin");
    state.events.get("browser-window-created")?.({}, win);
    expect(win.listeners.get("before-input-event") ?? []).toHaveLength(0);
    expect(win.listeners.get("did-finish-load")).toHaveLength(1);
    expect(win.listeners.get("zoom-changed")).toHaveLength(1);
  });

  it.each(["win32", "linux"] as const)("handles zoom, settings, refresh, devtools, and fullscreen shortcuts on %s", platform => {
    const existing = createMockWindow();
    const destroyed = createMockWindow({ destroyed: true });
    state.windows = [existing, destroyed];
    const h = install(platform);

    expect(existing.listeners.get("before-input-event")).toHaveLength(1);
    expect(destroyed.listeners.get("before-input-event") ?? []).toHaveLength(0);

    // Re-emitting browser-window-created for an already-attached window does not duplicate listeners.
    state.events.get("browser-window-created")?.({}, existing);
    expect(existing.listeners.get("before-input-event")).toHaveLength(1);

    const created = createMockWindow();
    state.events.get("browser-window-created")?.({}, created);
    expect(created.listeners.get("before-input-event")).toHaveLength(1);

    // Zoom in: Ctrl+=, Ctrl++, Ctrl+numadd (code and key variants)
    expect(created.emitBeforeInput({ key: "=", code: "Equal", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(Math.pow(1.2, 0.5), 5);

    expect(created.emitBeforeInput({ key: "+", code: "Equal", control: true, shift: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(1.2, 5);

    expect(created.emitBeforeInput({ key: "+", code: "NumpadAdd", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(Math.pow(1.2, 1.5), 5);

    expect(created.emitBeforeInput({ key: "numadd", code: "NumpadAdd", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(Math.pow(1.2, 2), 5);

    // Zoom out: Ctrl+-, Ctrl+numsub
    expect(created.emitBeforeInput({ key: "-", code: "Minus", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(Math.pow(1.2, 1.5), 5);

    expect(created.emitBeforeInput({ key: "numsub", code: "NumpadSubtract", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(1.2, 5);

    // Zoom reset: Ctrl+0 and Ctrl+num0 (not Ctrl+Shift+0)
    expect(created.emitBeforeInput({ key: "0", code: "Digit0", control: true, shift: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(created.factor).toBeCloseTo(1.2, 5);

    expect(created.emitBeforeInput({ key: "0", code: "Digit0", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBe(1);

    created.factor = 1.5;
    expect(created.emitBeforeInput({ key: "num0", code: "Numpad0", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.factor).toBe(1);

    // Settings: Ctrl+,
    expect(created.emitBeforeInput({ key: ",", code: "Comma", control: true, shift: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(h.events).toEqual([]);
    expect(created.emitBeforeInput({ key: ",", code: "Comma", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(h.events).toEqual(["show", "open-settings"]);

    // Refresh: Ctrl+R vs Force Reload: Ctrl+Shift+R
    expect(created.emitBeforeInput({ key: "r", code: "KeyR", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(h.runIndexSync).toHaveBeenCalledTimes(1);
    expect(h.runIndexSync).toHaveBeenCalledWith(true);
    expect(created.webContents.reloadIgnoringCache).not.toHaveBeenCalled();

    expect(created.emitBeforeInput({ key: "R", code: "KeyR", control: true, shift: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(h.runIndexSync).toHaveBeenCalledTimes(1);

    // DevTools: Ctrl+Shift+I and F12 (no modifiers)
    expect(created.emitBeforeInput({ key: "I", code: "KeyI", control: true, shift: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.webContents.toggleDevTools).toHaveBeenCalledTimes(1);

    expect(created.emitBeforeInput({ key: "F12", code: "F12", control: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(created.emitBeforeInput({ key: "F12", code: "F12", shift: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(created.emitBeforeInput({ key: "F12", code: "F12" })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.webContents.toggleDevTools).toHaveBeenCalledTimes(2);

    // Fullscreen: F11 (no modifiers) toggles state
    expect(created.emitBeforeInput({ key: "F11", code: "F11", control: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(created.emitBeforeInput({ key: "F11", code: "F11", shift: true })).toEqual({ defaultPrevented: false, listenerCount: 1 });
    expect(created.emitBeforeInput({ key: "F11", code: "F11" })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.fullScreen).toBe(true);
    expect(created.emitBeforeInput({ key: "F11", code: "F11" })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(created.fullScreen).toBe(false);

    // Existing non-destroyed window also handles shortcuts independently of focused window
    expect(existing.emitBeforeInput({ key: "=", code: "Equal", control: true })).toEqual({ defaultPrevented: true, listenerCount: 1 });
    expect(existing.factor).toBeCloseTo(Math.pow(1.2, 0.5), 5);
  });

  it("ignores keyUp, Alt/Meta/AltGr modifiers, auto-repeat utility keys, and destroyed windows", () => {
    const win = createMockWindow();
    state.windows = [win];
    const h = install("win32");

    expect(win.emitBeforeInput({ type: "keyUp", key: "=", code: "Equal", control: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "=", code: "Equal", control: true, alt: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "=", code: "Equal", control: true, meta: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "r", code: "KeyR", control: true, isAutoRepeat: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "F11", code: "F11", isAutoRepeat: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "s", code: "KeyS", control: true }).defaultPrevented).toBe(false);
    expect(win.emitBeforeInput({ key: "=", code: "Equal" }).defaultPrevented).toBe(false);

    win.destroyed = true;
    expect(win.emitBeforeInput({ key: "r", code: "KeyR", control: true }).defaultPrevented).toBe(false);

    expect(h.runIndexSync).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(win.factor).toBe(1);
    expect(win.setFullScreen).not.toHaveBeenCalled();
    expect(win.webContents.toggleDevTools).not.toHaveBeenCalled();
  });

  it("replaces rather than duplicates listeners when installApplicationMenu runs twice", () => {
    const win = createMockWindow();
    state.windows = [win];
    const first = install("win32");
    const second = install("win32");

    expect(win.listeners.get("before-input-event")).toHaveLength(1);
    win.emitBeforeInput({ key: "r", code: "KeyR", control: true });
    expect(first.runIndexSync).not.toHaveBeenCalled();
    expect(second.runIndexSync).toHaveBeenCalledOnce();
  });
});
