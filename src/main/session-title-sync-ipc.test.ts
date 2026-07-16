import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("session title sync IPC", () => {
  it("routes title changes through the terminal synchronization orchestrator", () => {
    const handlerStart = mainSource.indexOf('ipcMain.handle("title:set"');
    const handlerEnd = mainSource.indexOf('ipcMain.handle("tag:add"', handlerStart);
    const handler = mainSource.slice(handlerStart, handlerEnd);

    expect(handler).toContain("setSessionCustomTitleAndSyncTerminal");
    expect(handler).toContain("loadCachedLiveSessionSnapshot");
    expect(handler).toContain("setLiveSessionTerminalTitle");
    expect(handler).not.toContain("=> store.setCustomTitle(sessionKey, title)");
  });
});
