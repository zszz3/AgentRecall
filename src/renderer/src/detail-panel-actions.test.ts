import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailPanelSource = readFileSync(new URL("./components/detail-panel.tsx", import.meta.url), "utf8");
const sessionUiSource = readFileSync(new URL("./session-ui.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");

function mainHandlerSource(channel: string): string {
  const marker = `ipcMain.handle("${channel}"`;
  const start = mainSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf('  ipcMain.handle("', start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

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

  it("loads the visible message window before trace events when opening detail", () => {
    const openDetail = appSource.slice(appSource.indexOf("async function openDetail"), appSource.indexOf("function closeDetail"));
    const freshIndex = openDetail.indexOf("const fresh = await window.sessionSearch.getSession(sessionKey)");
    const messagesIndex = openDetail.indexOf(
      "window.sessionSearch.getMessages(sessionKey, initialOffset, INITIAL_MESSAGE_LIMIT)",
    );
    const traceIndex = openDetail.indexOf("window.sessionSearch.getTraceEvents(sessionKey, traceWindowForMessages(loadedMessages))");

    expect(freshIndex).toBeGreaterThanOrEqual(0);
    expect(messagesIndex).toBeGreaterThan(freshIndex);
    expect(traceIndex).toBeGreaterThan(messagesIndex);
    expect(openDetail).not.toContain("const [fresh, loadedTraceEvents] = await Promise.all");
  });

  it("keeps title rename icon but removes the duplicate rename action from the detail toolbar", () => {
    const detailActions = detailPanelSource.slice(detailPanelSource.indexOf('<div className="detail-actions">'), detailPanelSource.indexOf('<div className="detail-tags">'));

    expect(detailPanelSource).toContain("detail-title-edit");
    expect(detailPanelSource).toContain("<Edit3 size={14} />");
    expect(detailActions).not.toContain("Clipboard size={15}");
    expect(detailActions).not.toContain('l("Rename", "重命名")');
  });

  it("exposes remote environment management IPC through preload and main", () => {
    for (const channel of [
      "environments:list",
      "ssh-config:list-hosts",
      "environment:save",
      "environment:delete",
      "environment:refresh",
      "environment:diagnose",
      "environments-updated",
    ]) {
      expect(preloadSource).toContain(channel);
      expect(mainSource).toContain(channel);
    }
    expect(preloadSource).toContain("listEnvironments");
    expect(preloadSource).toContain("listSshConfigHosts");
    expect(preloadSource).toContain("saveEnvironment");
    expect(preloadSource).toContain("deleteEnvironment");
    expect(preloadSource).toContain("refreshEnvironment");
    expect(preloadSource).toContain("diagnoseEnvironment");
    expect(preloadSource).toContain("onEnvironmentsUpdated");
  });

  it("marks local-only detail actions disabled for remote sessions", () => {
    const detailPanel = detailPanelSource;

    expect(detailPanel).toContain("isRemoteSession(session)");
    expect(sessionUiSource).toContain("remote paths cannot be revealed locally");
    expect(detailPanel).toContain("disabled={actionRunning || localOnlyDisabled}");
    expect(detailPanel).toContain("environment-badge");
  });

  it("marks local-only context menu actions disabled for remote sessions", () => {
    const contextMenu = appSource.slice(appSource.indexOf("function ContextMenu"), appSource.indexOf("function SettingsDialog"));

    expect(contextMenu).toContain("isRemoteSession(state.session)");
    expect(sessionUiSource).toContain("remote sessions do not open local native apps");
    expect(sessionUiSource).toContain("remote paths cannot be revealed locally");
    expect(contextMenu).toContain("disabled={localOnlyDisabled}");
  });

  it("guards local-only commands and passes ssh args in main command handlers", () => {
    expect(mainSource).toContain("function sshArgsForSession");
    expect(mainSource).toContain("buildSshArgs(environment, \"\")");
    expect(mainSource).toContain("getResumeCommand(session, getSettings(), { sshArgs: requireSshArgsForRemoteSession(session) })");
    expect(mainSource).toContain("throw new Error(\"SSH environment is not available for this remote session.\")");
    expect(mainSource).toContain("openResumeInTerminal(session, getSettings(), { sshArgs })");
    expect(mainSource).toContain("openResumeInSpecificTerminal(session, getSettings(), \"iTerm\", { sshArgs })");
    expect(mainSource).toContain("if (!isLocalSession(session)) return false");
    expect(mainSource).toContain("if (!isLocalSession(session)) {");
    expect(mainSource).toContain("return { route: \"resume\" as const };");
  });

  it("loads remote session details on demand before returning messages, trace events, or exports", () => {
    expect(mainSource).toContain("ensureRemoteSessionDetailsLoaded");
    expect(mainSource).toContain("fetchRemoteSessionFilePayload");
    expect(mainSource).toContain("loadRemoteSessionDetailPayload");
    expect(mainSource).toContain("await ensureRemoteSessionDetailsLoaded(sessionKey)");
  });

  it("does not hydrate remote session details before building resume commands", () => {
    for (const channel of ["command:copy-resume", "command:resume", "command:resume-iterm"]) {
      const handler = mainHandlerSource(channel);
      expect(handler).not.toContain("ensureRemoteSessionDetailsLoaded(sessionKey)");
      expect(handler).toContain("const session = store.getSession(sessionKey)");
    }
    expect(mainHandlerSource("command:copy-resume")).toContain("async (_event, sessionKey: string)");
  });

  it("uses lightweight remote message paging for unhydrated remote detail views", () => {
    const messagesHandler = mainHandlerSource("session:messages");
    const traceHandler = mainHandlerSource("session:trace-events");

    expect(messagesHandler).toContain("fetchRemoteSessionMessagePage");
    expect(messagesHandler.indexOf("fetchRemoteSessionMessagePage")).toBeLessThan(
      messagesHandler.indexOf("await ensureRemoteSessionDetailsLoaded(sessionKey)"),
    );
    expect(traceHandler).toContain("return []");
    expect(traceHandler).toContain("store.getTraceEvents(sessionKey, options)");
  });

  it("exposes cross-agent session migration through IPC", () => {
    expect(preloadSource).toContain("migrateSession");
    expect(preloadSource).toContain("session:migrate");
    expect(preloadSource).toContain("onMigrationProgress");
    expect(preloadSource).toContain("session:migration-progress");
    expect(mainSource).toContain('ipcMain.handle("session:migrate"');
    expect(mainSource).toContain('event.sender.send("session:migration-progress"');
    expect(mainHandlerSource("session:migrate")).not.toContain("ensureRemoteSessionDetailsLoaded");
    expect(mainHandlerSource("session:migrate")).not.toContain("runIndexSync");
    expect(mainHandlerSource("session:migrate")).toContain("indexMigratedSessionFile");
    expect(mainHandlerSource("session:migrate")).toContain("fallbackMigrationResumeDisplayCommand");
  });

  it("preflights remote resume before opening terminals", () => {
    expect(mainSource).toContain("preflightRemoteSessionResume");
    expect(mainSource).toContain("ensureRemoteResumePreflight");
    expect(mainSource).toContain("Remote resume preflight failed:");

    for (const channel of ["command:resume", "command:resume-iterm"]) {
      const handler = mainHandlerSource(channel);
      expect(handler).toContain("await ensureRemoteResumePreflight(session)");
      expect(handler.indexOf("await ensureRemoteResumePreflight(session)")).toBeLessThan(
        handler.indexOf("openResumeIn"),
      );
    }
    expect(mainHandlerSource("command:copy-resume")).not.toContain("ensureRemoteResumePreflight");
  });

  it("hydrates profile defaults before resolving AI summary providers", () => {
    const resolverStart = mainSource.indexOf("async function resolveSummaryEndpointFromSettings");
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    const resolverEnd = mainSource.indexOf("const SUMMARY_HEAD_MESSAGES", resolverStart);
    const resolver = mainSource.slice(resolverStart, resolverEnd);

    expect(resolver).toContain("await getHydratedSettings()");
    expect(resolver).toContain('settings.summarySource === "claude"');
    expect(resolver).toContain("claude_exec");
    expect(resolver).toContain("codex_exec");
    expect(mainHandlerSource("session:summarize")).toContain("await resolveSummaryEndpointFromSettings()");
    expect(mainHandlerSource("session:summarize-missing")).toContain("await resolveSummaryEndpointFromSettings()");
  });

  it("renders remote environment diagnostics in settings", () => {
    const settingsDialog = appSource.slice(appSource.indexOf("function SettingsDialog"), appSource.indexOf("function SettingsSection"));

    expect(appSource).toContain("environmentHealthReports");
    expect(appSource).toContain("diagnosingEnvironmentId");
    expect(appSource).toContain("window.sessionSearch.diagnoseEnvironment(environment.id)");
    expect(settingsDialog).toContain("onDiagnoseEnvironment");
    expect(settingsDialog).toContain("connection-diagnostics");
    expect(settingsDialog).toContain("connection-diagnostic-check");
  });

  it("does not route the selected-session resume shortcut for unsupported sources", () => {
    const shortcutHandler = appSource.slice(
      appSource.indexOf('if ((event.metaKey || event.ctrlKey) && event.key === "Enter")'),
      appSource.indexOf('if (event.key === "ArrowDown" || event.key === "ArrowUp")'),
    );

    expect(shortcutHandler).toContain("supportsResumeSource(session.source)");
    expect(shortcutHandler.indexOf("supportsResumeSource(session.source)")).toBeLessThan(
      shortcutHandler.indexOf("window.sessionSearch.resumeSession(session.sessionKey)"),
    );
  });
});
