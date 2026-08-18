import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main process startup wiring", () => {
  it("waits for full application initialization before showing a second-instance window", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const secondInstanceBlock = source.match(
      /app\.on\("second-instance",[\s\S]*?\n\s*}\);\n/,
    )?.[0];

    expect(secondInstanceBlock).toBeDefined();
    expect(secondInstanceBlock).toContain("applicationReady.then(() => showWindow())");
    expect(secondInstanceBlock).not.toContain("app.whenReady().then(() => showWindow())");
  });

  it("only sends focus-search when the caller asks for it", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const showWindowBody = source.match(/function showWindow\([\s\S]*?\n}\n/)?.[0];

    expect(showWindowBody).toBeDefined();
    expect(showWindowBody).toContain("options: { focusSearch?: boolean } = {}");
    expect(showWindowBody).toContain(
      'if (options.focusSearch) mainWindow.webContents.send("focus-search")',
    );
  });

  it("does not steal search focus when the window is opened from the tray", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const trayBlock = source.match(/function createTray\([\s\S]*?\n}\n/)?.[0];

    expect(trayBlock).toBeDefined();
    // Electron passes (menuItem, window, event) to click handlers and the
    // clicked event to tray listeners, so showWindow must never be used as a
    // bare callback now that its first argument carries options.
    expect(trayBlock).toContain("click: () => showWindow()");
    expect(trayBlock).toContain('tray.on("click", () => showWindow())');
    expect(trayBlock).not.toContain("click: showWindow");
    expect(trayBlock).not.toContain('tray.on("click", showWindow)');
  });

  it("keeps the global shortcut focusing the search box", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const toggleBlock = source.match(/function toggleWindow\([\s\S]*?\n}\n/)?.[0];

    expect(toggleBlock).toBeDefined();
    expect(toggleBlock).toContain("showWindow({ focusSearch: true })");
  });

  it("migrates SSH sessions through remote writeback and SSH Resume", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('session.environmentKind === "wsl" || session.environmentKind === "ssh"');
    expect(source).toContain('target !== sshMigrationTarget(session.source)');
    expect(source).toContain('{ allowSsh: session.environmentKind === "ssh" }');
    expect(source).toContain("createSourceRemoteRestoreDependencies(environment, progress)");
    expect(source).toContain('environment.kind === "ssh" ? inspectSshMigrationCli(environment, target)');
    expect(source).toContain('const sshArgs = buildRemoteSyncSshArgs(environment, "").slice(0, -1)');
    expect(source).toContain("await openResumeInTerminal(session, getSettings(), { sshArgs })");
  });

  it("guards single-session deletion through the shared read-only source policy", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const deleteBlock = source.match(
      /ipcMain\.handle\("session:delete",[\s\S]*?\n\s*}\);\n/,
    )?.[0];

    expect(deleteBlock).toBeDefined();
    expect(deleteBlock).toContain("isReadOnlySessionSource(session.source)");
    expect(deleteBlock).toContain("session source files are read-only");
  });
});
