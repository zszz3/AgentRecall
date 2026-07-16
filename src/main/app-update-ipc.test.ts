import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");

describe("application update IPC", () => {
  it("exposes shared update status and installation through main and preload", () => {
    for (const channel of ["app-update:get-status", "app-update:install", "app-update:skip"]) {
      expect(mainSource).toContain(`ipcMain.handle("${channel}"`);
      expect(preloadSource).toContain(`ipcRenderer.invoke("${channel}"`);
    }
    expect(mainSource).toContain('webContents.send("app-update:status"');
    expect(preloadSource).toContain('ipcRenderer.on("app-update:status"');
    expect(mainSource).toContain("skipCurrentAppUpdate");
    expect(mainSource).toContain("skipUpdateVersion");
    expect(mainSource).toContain("snoozeUpdatePrompt");
    expect(mainSource).toContain("refreshAppUpdateStatus(false)");
  });

  it("lets local launches disable only automatic update checks", () => {
    expect(mainSource).toContain("function updateAutoCheckDisabledByEnvironment");
    expect(mainSource).toContain('process.env.AGENT_SESSION_SEARCH_NO_UPDATE_CHECK === "1"');
    expect(mainSource).toContain("if (!force && updateAutoCheckDisabledByEnvironment()) return appUpdateStatus ?? emptyAppUpdateStatus()");
  });

  it("runs the installer outside Electron before quitting the current app", () => {
    expect(mainSource).toContain("ELECTRON_RUN_AS_NODE: \"1\"");
    expect(mainSource).toContain("APPLY_UPDATE_PATH");
    expect(mainSource).toContain("setTimeout(() => app.quit(), 100)");
  });

  it("shows and clears the previous installation result after relaunch", () => {
    expect(mainSource).toContain("showPreviousUpdateResult");
    expect(mainSource).toContain('title: "更新完成"');
    expect(mainSource).toContain('title: "更新失败"');
    expect(mainSource).toContain("clearInstallStatus");
    expect(mainSource).toContain("dialog.showMessageBox");
    expect(mainSource).toContain("可以手动安装最新版本");
    expect(mainSource).toContain("manualInstallCommand");
    expect(mainSource).toContain("复制安装命令");
    expect(mainSource).toContain("shell.openExternal(client.LATEST_RELEASE_URL)");
  });

  it("does not check or install releases from an Electron development build", () => {
    expect(mainSource).toContain("function developmentAppUpdateStatus(): AppUpdateStatus");
    expect(mainSource).toContain('const releaseUpdateRuntime = app.isPackaged || process.env.AGENT_SESSION_SEARCH_RELEASE_BUILD === "1"');
    expect(mainSource).toContain("if (!releaseUpdateRuntime) return developmentAppUpdateStatus();");
    expect(mainSource).toContain('throw new Error("Application updates are unavailable in development builds.")');
    expect(mainSource).toContain("if (releaseUpdateRuntime && getSettings().autoCheckUpdates)");
  });
});
