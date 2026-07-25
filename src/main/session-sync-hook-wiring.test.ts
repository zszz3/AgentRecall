import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The service remains available for legacy data compatibility, but is no
// longer composed by the production Core entrypoint.
const source = fs.readFileSync(
  path.resolve("src", "main", "legacy-application.ts"),
  "utf8",
);

describe("session sync composition wiring", () => {
  it("loads the packaged Hook setup through the RemoteSessionService boundary", () => {
    expect(source).toContain("setup-session-sync-hook.cjs");
    expect(source).toContain("getHookSetup: loadSessionSyncHookSetup");
    expect(source).toContain("registerRemoteSessionsIpc(ipcMain, remoteSessionService)");
  });

  it("starts and stops the service-owned queue with the application lifecycle", () => {
    expect(source).toContain("remoteSessionService.startQueue()");
    expect(source).toContain("remoteSessionService.stopQueue()");
  });

  it("disables session sync before persisting the disabled setting", () => {
    const start = source.indexOf('ipcMain.handle("settings:set"');
    const end = source.indexOf("registerSkillsIpc", start);
    const settingsHandler = source.slice(start, end);
    const disableIndex = settingsHandler.indexOf("remoteSessionService.disableSync()");
    const persistIndex = settingsHandler.indexOf("settingsStore.set");

    expect(settingsHandler).toContain('"remoteSyncEnabled" in settings');
    expect(disableIndex).toBeGreaterThanOrEqual(0);
    expect(persistIndex).toBeGreaterThan(disableIndex);
  });
});
