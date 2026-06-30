import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");

describe("skill sync IPC", () => {
  it("exposes Supabase skill sync handlers through main and preload", () => {
    for (const channel of [
      "skills:sync-snapshot",
      "skills:sync-upload",
      "skills:sync-install",
      "skills:sync-copy-setup-sql",
    ]) {
      expect(mainSource).toContain(`ipcMain.handle("${channel}"`);
      expect(preloadSource).toContain(`ipcRenderer.invoke("${channel}"`);
    }
  });
});
