import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionMessage, SessionTraceEvent } from "../../core/types";
import { filterConversationTimeline } from "./features/session-detail/detail-panel";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailPanelSource = readFileSync(new URL("./features/session-detail/detail-panel.tsx", import.meta.url), "utf8");
const remoteSessionsDialogSource = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");
const sessionUiSource = readFileSync(new URL("./session-ui.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");
const summaryEndpointSource = readFileSync(new URL("../../core/summary-endpoint.ts", import.meta.url), "utf8");

function mainHandlerSource(channel: string): string {
  const marker = `ipcMain.handle("${channel}"`;
  const start = mainSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf('  ipcMain.handle("', start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

describe("detail panel actions", () => {
  it("loads a separate three-message context and highlights the exact search hit", () => {
    const openDetail = appSource.slice(appSource.indexOf("async function openDetail"), appSource.indexOf("function closeDetail"));
    expect(openDetail).toContain("Math.max(0, matchHit.messageIndex - 1), 3");
    expect(openDetail).toContain("setMatchedContextMessages(loadedMatchContext)");
    expect(openDetail).toContain("setMatchedMessageIndex(matchHit?.messageIndex ?? null)");
    expect(detailPanelSource).toContain("matchedContextMessages");
    expect(detailPanelSource).toContain('target={message.index === matchedMessageIndex}');
    expect(detailPanelSource).toContain("HighlightedSearchText");
    expect(detailPanelSource).toContain('target ? "match-target"');
  });

  it("keeps resume routed and removes standalone terminal focus from the detail panel", () => {
    const detailPanel = detailPanelSource;

    expect(detailPanel).toContain("onResume");
    expect(detailPanel).toContain("onExportMarkdown");
    expect(detailPanel).not.toContain("onFocusTerminal");
    expect(detailPanel).not.toMatch(/Bring to Front/);
    expect(detailPanel).toMatch(/Export MD/);
  });

  it("omits token metadata from the detail header when usage is unknown", () => {
    expect(detailPanelSource).toContain("const detailMeta = [");
    expect(detailPanelSource).toContain("...(hasTokenUsage(session.tokenUsage) ?");
    expect(detailPanelSource).toContain('detailMeta.join(" · ")');
  });

  it("keeps right-click resume and markdown export without standalone terminal focus or plain text copy", () => {
    const contextMenu = appSource.slice(appSource.indexOf("function ContextMenu"));

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

  it("shows the full indexed message total instead of the loaded page size", () => {
    expect(detailPanelSource).toContain('`${session.messageCount} messages`');
    expect(detailPanelSource).not.toContain('`${messages.length} messages`');
  });

  it("renders truncated assistant replies as Markdown before they are expanded", () => {
    const messageBlock = detailPanelSource.slice(
      detailPanelSource.indexOf("function MessageBlock"),
      detailPanelSource.indexOf("function traceStatusSymbol"),
    );

    expect(messageBlock).toContain('const useMarkdown = message.role === "assistant" && !highlight;');
    expect(messageBlock).toContain("markdownPreview(");
    expect(messageBlock).toContain("<Markdown text={content} language={language} />");
    expect(messageBlock).not.toContain("message.content.slice(0, MESSAGE_TRUNCATE_LIMIT)");
    expect(messageBlock).not.toContain(
      'const useMarkdown = message.role === "assistant" && !highlight && (!truncated || expanded);',
    );
  });

  it("filters the loaded full conversation by role while keeping pagination available", () => {
    const showOlderIndex = detailPanelSource.indexOf("olderMessageCount > 0");
    const visibleItemsIndex = detailPanelSource.indexOf("visibleTimelineItems.map");

    expect(detailPanelSource).toContain('type ConversationRoleFilter = "all" | SessionMessage["role"]');
    expect(detailPanelSource).toContain('const CONVERSATION_ROLE_FILTERS: ConversationRoleFilter[] = ["all", "user", "assistant"]');
    expect(detailPanelSource).toContain("filterConversationTimeline(timelineItems, roleFilter, showTools)");
    expect(detailPanelSource).toContain("!messages.some((message) => message.role === roleFilter)");
    expect(detailPanelSource).toContain('setRoleFilter("all");');
    expect(detailPanelSource).toContain("conversation-role-filter");
    expect(detailPanelSource).toContain("No User messages in the loaded conversation.");
    expect(detailPanelSource).toContain("No Assistant messages in the loaded conversation.");
    expect(showOlderIndex).toBeGreaterThanOrEqual(0);
    expect(visibleItemsIndex).toBeGreaterThan(showOlderIndex);
  });

  it("composes role filtering with independent tool-event visibility", () => {
    const user = { index: 0, role: "user", content: "question", timestamp: "2026-07-11T00:00:00.000Z" } as SessionMessage;
    const toolCall = { index: 0, kind: "tool_call", title: "Read", timestamp: "2026-07-11T00:00:01.000Z" } as SessionTraceEvent;
    const assistant = { index: 1, role: "assistant", content: "answer", timestamp: "2026-07-11T00:00:02.000Z" } as SessionMessage;
    const toolResult = { index: 1, kind: "tool_result", title: "tool output", timestamp: "2026-07-11T00:00:03.000Z" } as SessionTraceEvent;
    const items = [
      { kind: "message" as const, key: "message:0", timestampMs: 0, order: 0, message: user },
      { kind: "trace" as const, key: "trace:0", timestampMs: 1, order: 1, event: toolCall },
      { kind: "message" as const, key: "message:1", timestampMs: 2, order: 2, message: assistant },
      { kind: "trace" as const, key: "trace:1", timestampMs: 3, order: 3, event: toolResult },
    ];

    expect(filterConversationTimeline(items, "all", false).map((item) => item.key)).toEqual(["message:0", "message:1"]);
    expect(filterConversationTimeline(items, "all", true).map((item) => item.key)).toEqual(["message:0", "trace:0", "message:1", "trace:1"]);
    expect(filterConversationTimeline(items, "user", true).map((item) => item.key)).toEqual(["message:0", "trace:0", "trace:1"]);
    expect(filterConversationTimeline(items, "assistant", false).map((item) => item.key)).toEqual(["message:1"]);
  });

  it("renders Tools as a separate persisted toggle beside the role filter", () => {
    expect(detailPanelSource).toContain("readInitialToolEventsVisibility");
    expect(detailPanelSource).toContain("storeToolEventsVisibility");
    expect(detailPanelSource).toContain('className={`conversation-tools-toggle ${showTools ? "active" : ""}`}');
    expect(detailPanelSource).toContain("aria-pressed={showTools}");
    expect(detailPanelSource).toContain('l("Tools", "工具")');
    expect(detailPanelSource).toContain("setShowTools");
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

  it("groups detail toolbar actions by purpose and isolates the danger action", () => {
    const detailActions = detailPanelSource.slice(detailPanelSource.indexOf('<div className="detail-actions">'), detailPanelSource.indexOf('<div className="detail-tags">'));
    const groups = detailActions.match(/detail-action-group/g) ?? [];

    expect(groups.length).toBeGreaterThanOrEqual(4);

    const firstGroup = detailActions.slice(0, detailActions.indexOf('detail-action-group', detailActions.indexOf('detail-action-group') + 1));
    expect(firstGroup).toContain("onResume");
    expect(firstGroup).toContain("onReveal");

    const lastGroup = detailActions.slice(detailActions.lastIndexOf('detail-action-group'));
    expect(lastGroup).toContain('className="danger"');
    expect(lastGroup).toContain("onDelete");
    expect(lastGroup).not.toContain("onCopyPlain");
    expect(lastGroup).not.toContain("onReveal");
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

  it("keeps ZCode remote saving visible but disabled until snapshot-only upload is supported", () => {
    expect(appSource).toContain('remoteUploadDisabled={detail.source === "zcode-cli"}');
    expect(detailPanelSource).toContain("disabled={actionRunning || remoteUploadDisabled}");
    expect(detailPanelSource).toContain("ZCode remote saving is not supported yet.");
  });

  it("marks local-only context menu actions disabled for remote sessions", () => {
    const contextMenu = appSource.slice(appSource.indexOf("function ContextMenu"));

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
    expect(mainSource).toContain("if (!isLocalSessionEnvironment(session)) return false");
    expect(mainSource).toContain("if (!isLocalSessionEnvironment(session)) {");
    expect(mainSource).toContain("return { route: \"resume\" as const };");
  });

  it("opens local Codex App resumes and Open App actions through the exact-session URL handler", () => {
    const resumeHandler = mainHandlerSource("command:resume");
    const openAppHandler = mainHandlerSource("command:open-app");

    expect(resumeHandler).toContain('if (route.route === "app")');
    expect(resumeHandler).toContain("openNativeApp(session, { openExternal: (url) => shell.openExternal(url) })");
    expect(openAppHandler).toContain("openNativeApp(session, { openExternal: (url) => shell.openExternal(url) })");
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
    expect(mainSource).toContain("indexMigratedSessionFile");
    expect(mainSource).toContain("getSafeMigrationResumeCommand");
  });

  it("keeps the migration IPC handler on one immutable settings snapshot and delegates behavior", () => {
    const handler = mainHandlerSource("session:migrate");
    expect(handler.match(/providerService\.hydrateSettings\(\)/g)).toHaveLength(1);
    expect(handler).toContain("Object.freeze(await providerService.hydrateSettings())");
    expect(handler).toContain("runLocalSessionMigration");
    expect(handler).toContain("localSessionMigrationRuntime(event)");
    expect(handler).not.toContain("getSettings()");
    expect(preloadSource).toContain("target: MigrationTarget");
  });

  it("builds remote restore commands with POSIX syntax regardless of the local platform", () => {
    const remoteCommand = mainSource.slice(
      mainSource.indexOf("function remoteMigrationResumeDisplayCommand"),
      mainSource.indexOf("async function writeMigratedSessionToSshEnvironment"),
    );
    expect(remoteCommand).toContain('getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings(), { platform: "linux" })');
    expect(remoteCommand).not.toContain("fallbackMigrationResumeDisplayCommand(target");
  });

  it("loads the independent session sync list into the app cache and exposes bulk cloud actions", () => {
    expect(appSource).not.toContain("uploadVisibleRemoteSessions");
    expect(appSource).not.toContain("CloudUpload");
    expect(remoteSessionsDialogSource).not.toContain("onUploadVisible");
    expect(appSource).toContain("listSessionSyncItems");
    expect(appSource).toContain("cache={remoteSessionsCache}");
    expect(remoteSessionsDialogSource).not.toContain("listSessionSyncItems");
    expect(remoteSessionsDialogSource).toContain("Upload to cloud");
    expect(remoteSessionsDialogSource).toContain("selectedIds");
    expect(remoteSessionsDialogSource).toContain("Select visible");
    expect(remoteSessionsDialogSource).toContain("Delete cloud copies");
    expect(remoteSessionsDialogSource).toContain("deleteRemoteSessions");
    expect(remoteSessionsDialogSource).not.toContain("Database");
    expect(remoteSessionsDialogSource).toContain("SupabaseSetupGuide");
    expect(remoteSessionsDialogSource).toContain('openSupabaseSqlEditor("sessions")');
    expect(remoteSessionsDialogSource).toContain("restoreRemoteSessionToSourceEnvironment");
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
    // The resolver now delegates to the shared summary-endpoint module, but the
    // ProviderService still hydrates profile defaults (including the DB-stored
    // API key) before resolving, and main wires the temp-session cleaner.
    const resolverStart = mainSource.indexOf("async function resolveSummaryEndpointFromSettings");
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    const resolverEnd = mainSource.indexOf("const SUMMARY_HEAD_MESSAGES", resolverStart);
    const resolver = mainSource.slice(resolverStart, resolverEnd);

    expect(resolver).toContain("await providerService.hydrateSettings()");
    expect(resolver).toContain("resolveSummaryEndpointFromSettingsShared");
    expect(resolver).toContain("loadActiveCodexSummaryEndpointDefaults");
    expect(resolver).toContain("buildCodexExecEndpointShared(settings, { onTemporarySession })");
    expect(resolver).toContain("onTemporarySession");
    // The claude/codex exec format strings live in the shared module now.
    expect(summaryEndpointSource).toContain('settings.summarySource === "claude"');
    expect(summaryEndpointSource).toContain("claude_exec");
    expect(summaryEndpointSource).toContain("codex_exec");
    expect(mainHandlerSource("session:summarize")).toContain("await resolveSummaryEndpointFromSettings()");
    expect(mainHandlerSource("session:summarize-missing")).toContain("await resolveSummaryEndpointFromSettings()");
  });

  it("renders remote environment diagnostics in settings", () => {
    const settingsDialog = settingsDialogSource;

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
