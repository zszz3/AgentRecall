import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("Resume IPC contract", () => {
  it("returns an actionable error when a selected session disappeared", () => {
    const start = mainSource.indexOf('ipcMain.handle("command:resume"');
    const end = mainSource.indexOf('ipcMain.handle("command:resume-iterm"', start);
    const handler = mainSource.slice(start, end);
    const missingSessionBlock = handler.slice(
      handler.indexOf("const session ="),
      handler.indexOf("const sshArgs"),
    );

    expect(missingSessionBlock).toContain("if (!session) {");
    expect(missingSessionBlock).toContain("This session is no longer available.");
    expect(missingSessionBlock).toContain("Refresh the session list");
    expect(missingSessionBlock).not.toContain("return");
  });
});
