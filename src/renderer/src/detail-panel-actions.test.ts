import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailPanelSource = readFileSync(new URL("./components/detail-panel.tsx", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");

describe("detail panel actions", () => {
  it("keeps resume routed and removes standalone terminal focus from the detail panel", () => {
    const detailPanel = detailPanelSource;

    expect(detailPanel).toContain("onResume");
    expect(detailPanel).toContain("onExportMarkdown");
    expect(detailPanel).not.toContain("onFocusTerminal");
    expect(detailPanel).not.toMatch(/Bring to Front/);
    expect(detailPanel).toMatch(/Export MD/);
  });

  it("keeps right-click resume and markdown export without standalone terminal focus or plain text copy", () => {
    const contextMenu = appSource.slice(appSource.indexOf("function ContextMenu"), appSource.indexOf("function SettingsDialog"));

    expect(contextMenu).toMatch(/Resume in Terminal/);
    expect(contextMenu).not.toMatch(/Bring to Front/);
    expect(contextMenu).not.toContain("onFocusTerminal");
    expect(contextMenu).toMatch(/Export Markdown/);
    expect(contextMenu).not.toMatch(/Copy Plain Text/);
  });

  it("routes resume through one IPC command and hides direct terminal focus IPC", () => {
    expect(preloadSource).toContain("resumeSession");
    expect(preloadSource).toContain("command:resume");
    expect(preloadSource).not.toContain("focusLiveTerminal");
    expect(preloadSource).not.toContain("command:focus-live-terminal");
    expect(mainSource).toContain("routeResumeSession");
    expect(mainSource).toContain("command:resume");
    expect(mainSource).not.toContain("command:focus-live-terminal");
  });

  it("wires markdown export through IPC to a save dialog", () => {
    expect(preloadSource).toContain("exportMarkdown");
    expect(preloadSource).toContain("command:export-markdown");
    expect(mainSource).toContain("command:export-markdown");
    expect(mainSource).toContain("showSaveDialog");
    expect(mainSource).toContain("formatSessionMarkdown");
  });

  it("opens detail on the newest message window and pages older messages backward", () => {
    expect(appSource).toContain("Math.max(0, fresh.messageCount - INITIAL_MESSAGE_LIMIT)");
    expect(appSource).toContain("window.sessionSearch.getMessages(sessionKey, initialOffset, INITIAL_MESSAGE_LIMIT)");
    expect(appSource).toContain("const nextOffset = Math.max(0, messageOffset - MESSAGE_PAGE_SIZE)");
    expect(appSource).toContain("setMessages((current) => [...nextMessages, ...current])");
    expect(detailPanelSource).toContain("olderMessageCount > 0");
    expect(detailPanelSource).toContain("Show ${Math.min(messagePageSize, olderMessageCount)} older messages");
  });

  it("keeps title rename icon but removes the duplicate rename action from the detail toolbar", () => {
    const detailActions = detailPanelSource.slice(detailPanelSource.indexOf('<div className="detail-actions">'), detailPanelSource.indexOf('<div className="detail-tags">'));

    expect(detailPanelSource).toContain("detail-title-edit");
    expect(detailPanelSource).toContain("<Edit3 size={14} />");
    expect(detailActions).not.toContain("Clipboard size={15}");
    expect(detailActions).not.toContain('l("Rename", "重命名")');
  });
});
