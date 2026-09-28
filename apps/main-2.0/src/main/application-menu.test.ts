import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, BrowserWindow, Menu } from "electron";
import { installApplicationMenu, refreshApplicationMenuZoom } from "./application-menu";

interface MenuEntry { id?: string; enabled?: boolean; label?: string; role?: string; accelerator?: string; submenu?: MenuEntry[]; click?: () => void }

const state = vi.hoisted(() => ({
  factor: 1, destroyed: false,
  template: [] as MenuEntry[],
  events: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => {
  const menu = { getMenuItemById: (id: string) => state.template.flatMap(item => item.submenu ?? []).find(item => item.id === id) };
  return {
    app: { setAboutPanelOptions: vi.fn(), quit: vi.fn(), on: vi.fn((event, callback) => state.events.set(event, callback)) },
    BrowserWindow: { getFocusedWindow: vi.fn(() => ({
      isDestroyed: () => state.destroyed,
      webContents: { getZoomFactor: () => state.factor, setZoomFactor: (factor: number) => { state.factor = factor; } },
    })) },
    Menu: { setApplicationMenu: vi.fn(), getApplicationMenu: vi.fn(() => menu),
      buildFromTemplate: vi.fn((template: MenuEntry[]) => { state.template = template; return menu; }) },
  };
});
beforeEach(() => { vi.clearAllMocks(); state.factor = 1; state.destroyed = false; state.template = []; state.events.clear(); });

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
