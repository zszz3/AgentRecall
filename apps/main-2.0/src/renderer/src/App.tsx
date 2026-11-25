import type { TeamPushDraft } from "../../shared/team-push";
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../../core/session-sources";
import type {
  ProjectSummary,
  ProjectTagEntry,
  SessionEnvironment,
  SessionMatchHit,
  SessionSearchResult,
} from "../../core/types";
import { localize } from "./language";
import { useAppIpcSubscriptions } from "./features/app/use-app-ipc-subscriptions";
import { useAppPreferences } from "./features/app/use-app-preferences";
import { useAppShortcuts } from "./features/app/use-app-shortcuts";
import { useWorkbenchFeeds } from "./features/app/use-workbench-feeds";
import { buildSidebarTree, findSelectedProject } from "./features/sessions/build-sidebar-tree";
import { SessionDetailHost } from "./features/sessions/session-detail-host";
import { useSessionActions } from "./features/sessions/use-session-actions";
import { SessionOverlaysHost } from "./features/sessions/session-overlays-host";
import { useSessionDelete } from "./features/sessions/use-session-delete";
import { usePageNavigation } from "./features/navigation/use-page-navigation";
import { useBulkSessionDelete } from "./features/sessions/use-bulk-session-delete";
import { useSessionMigration } from "./features/sessions/use-session-migration";
import { errorText } from "./features/status/status-messages";
import { useAppSettings } from "./features/settings/use-app-settings";
import { useSessionSyncHook } from "./features/settings/use-session-sync-hook";
import { useEnvironmentActions } from "./features/settings/use-environment-actions";
import { checkLiveSessionsBeforeDelete } from "./features/sessions/live-session-check";
import { useAppUpdate } from "./features/settings/use-app-update";
import { AppNavigation, type AppPage } from "./components/app-navigation";
import { useSkillsController } from "./features/skills/use-skills-controller";
import { useRemoteSessionsCache } from "./features/remote-sessions/use-remote-sessions-cache";
import { SessionsPage } from "./features/sessions/sessions-page";
import { useSessionCatalog } from "./features/sessions/use-session-catalog";
import { sessionReadCache } from "./features/sessions/session-read-cache";
import { useSessionDetail } from "./features/sessions/use-session-detail";
import type { SettingsSection } from "./features/settings/settings-dialog";
import { WorkbenchPage } from "./features/workbench/workbench-page";
import { useWorkbenchOverview } from "./features/workbench/use-workbench-overview";
import { useAutomation } from "./features/automation/automation-provider";
import { displayTagName, resumeActionLabel, resumeRouteMessage } from "./session-ui";

const TeamWorkspacePage = lazy(() =>
  import("./features/team-workspace/team-workspace-page").then((module) => ({ default: module.TeamWorkspacePage })));
const SkillsPage = lazy(() =>
  import("./features/skills/skills-page").then((module) => ({ default: module.SkillsPage })));
const EvaluationFeaturePage = lazy(() =>
  import("./features/eval/eval-page").then((module) => ({ default: module.EvalPage })));
const RuntimeFeaturePage = lazy(() =>
  import("./features/automation/runtime-feature-page").then((module) => ({ default: module.RuntimeFeaturePage })));
const McpFeaturePage = lazy(() =>
  import("./features/automation/mcp-feature-page").then((module) => ({ default: module.McpFeaturePage })));
const InstructionsPage = lazy(() =>
  import("./features/instructions/instructions-page").then((module) => ({ default: module.InstructionsPage })));
const MemoryPage = lazy(() =>
  import("./features/memory/memory-page").then((module) => ({ default: module.MemoryPage })));
const ProviderPage = lazy(() =>
  import("./features/providers/provider-page").then((module) => ({ default: module.ProviderPage })));

const RUNTIME_PLATFORM: NodeJS.Platform = window.sessionSearch.platform;
const IS_MAC = RUNTIME_PLATFORM === "darwin";
const FILE_MANAGER_LABEL = IS_MAC ? "Finder" : RUNTIME_PLATFORM === "win32" ? "Explorer" : "File Manager";

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  filter: descriptor.optionalSetting === "includeStepcode" ? "stepcode" : descriptor.id,
}));

// Keeps visited pages mounted for instant tab switching while preventing hidden pages
// from re-rendering whenever the active page triggers state updates in App.
const KeepAlivePane = memo(
  function KeepAlivePane({ active, children }: { active: boolean; children: ReactNode }): ReactElement {
    return <div className="app-page-slot" hidden={!active}>{children}</div>;
  },
  (prev, next) => !prev.active && !next.active,
);

export function App(): ReactElement {
  const automation = useAutomation();
  const {
    theme,
    resolvedTheme,
    setTheme,
    language,
    setLanguage,
    messageFontSize,
    setMessageFontSize,
    t,
  } = useAppPreferences();

  const skills = useSkillsController(language);
  const remoteSessions = useRemoteSessionsCache();
  const {
    activePage,
    navigate: navigateToPage,
    open: openPage,
    request: pageRequest,
    consumeRequest: consumePageRequest,
    setGuard: setPageNavigationGuard,
  } = usePageNavigation();
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<AppPage>>(() => new Set<AppPage>(["workbench"]));
  useEffect(() => {
    setVisitedPages((current) => {
      if (current.has(activePage)) return current;
      const next = new Set(current);
      next.add(activePage);
      return next;
    });
  }, [activePage]);

  const evaluationRequest = pageRequest?.page === "evaluation" ? pageRequest : null;
  const evaluationRun = evaluationRequest && !("skill" in evaluationRequest) ? evaluationRequest : null;
  const [teamPushDrafts, setTeamPushDrafts] = useState<TeamPushDraft[]>([]);
  const [teamUploadKeys, setTeamUploadKeys] = useState<string[] | null>(null);
  const openTeamSpace = useCallback(() => { void navigateToPage("team-space"); }, [navigateToPage]);
  const openAgentModel = useCallback(() => { void openPage({ page: "providers", view: "gateway-overview" }); }, [openPage]);

  const workbench = useWorkbenchOverview(language, activePage === "workbench");
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectTags, setProjectTags] = useState<ProjectTagEntry[]>([]);
  const [environments, setEnvironments] = useState<SessionEnvironment[]>([]);
  const catalog = useSessionCatalog({
    active: activePage === "sessions",
    liveSessions: workbench.liveSessions,
    projects,
    environments,
    tags,
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("terminal");
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [wslDialogOpen, setWslDialogOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
  const metadataLoadSeqRef = useRef(0);
  const appUpdate = useAppUpdate(window.sessionSearch);
  const refreshSessionHookRef = useRef<() => void>(() => undefined);

  const loadSidebarMetadata = useCallback(async () => {
    const requestId = ++metadataLoadSeqRef.current;
    const [nextTags, nextProjects, nextEnvironments, nextProjectTags] = await Promise.all([
      window.sessionSearch.listTags(),
      window.sessionSearch.listProjects({ origin: catalog.origin }),
      window.sessionSearch.listEnvironments(),
      window.sessionSearch.listTagsByProject(),
    ]);
    if (requestId !== metadataLoadSeqRef.current) return;
    setTags(nextTags);
    setProjects(nextProjects);
    setEnvironments(nextEnvironments);
    setProjectTags(nextProjectTags);
  }, [catalog.origin]);

  const {
    settings: appSettings,
    feedback: settingsFeedback,
    setFeedback: setSettingsFeedback,
    visibleSourceFilters,
    update: updateSettings,
    importV1Data,
  } = useAppSettings({
    api: window.sessionSearch,
    reloadSessions: async () => {
      await Promise.all([catalog.load(), loadSidebarMetadata(), workbench.loadStats(true)]);
    },
    setEnvironments,
    invalidateRemoteSessions: () => remoteSessions.invalidate(),
    refreshSessionHookStatus: () => refreshSessionHookRef.current(),
    loadQuotas: () => workbench.loadQuotas(),
    t,
  });

  const sessionSyncHook = useSessionSyncHook({
    settingsOpen,
    setFeedback: setSettingsFeedback,
    t,
  });
  refreshSessionHookRef.current = sessionSyncHook.refresh;

  const feeds = useWorkbenchFeeds({
    activePage,
    listMcpServers: automation.api.listMcpServers,
    evalEnabled: Boolean(appSettings?.evalEnabled),
    skillsSnapshot: skills.snapshot,
  });

  const actionStatusSetterRef = useRef<(status: { kind: "error"; message: string }) => void>(() => undefined);
  const reportSessionDetailError = useCallback((error: unknown): void => {
    actionStatusSetterRef.current({ kind: "error", message: errorText(error) });
  }, []);
  const sessionDetail = useSessionDetail(reportSessionDetailError);

  const indexStatusSetterRef = useRef<Parameters<typeof useSessionActions>[0]["setIndexStatus"]>(() => undefined);
  const sessionActions = useSessionActions({
    load: catalog.load,
    loadSidebarMetadata,
    loadStats: workbench.loadStats,
    refreshDetail: sessionDetail.refreshLocal,
    applyUpdatedDetail: sessionDetail.applyUpdatedLocal,
    refreshLiveSessions: workbench.refreshLiveSessions,
    tag: catalog.tag,
    setTag: catalog.setTag,
    setIndexStatus: useCallback((next) => indexStatusSetterRef.current(next), []),
    setRemoteSessionsOpen,
    queueRemoteUploads: remoteSessions.queueUploads,
    ensureRemoteSessionsLoaded: remoteSessions.ensureLoaded,
    t,
  });
  actionStatusSetterRef.current = sessionActions.setActionStatus;

  const { indexStatus, setIndexStatus, sessionFamilyRefreshVersion } = useAppIpcSubscriptions({
    activePage,
    searchRef: catalog.searchRef,
    load: catalog.load,
    loadSidebarMetadata,
    loadStats: workbench.loadStats,
    loadWorkbenchSessions: workbench.loadSessions,
    navigateToPage,
    openDetail: sessionDetail.openLocal,
    refreshDetail: sessionDetail.refreshLocal,
    reportSessionDetailError,
    setSelectedKey: catalog.setSelectedKey,
    setRefreshFeedback: sessionActions.setRefreshFeedback,
    setTeamUploadKeys,
    setSettingsInitialSection,
    setSettingsOpen,
    setEnvironments,
  });
  indexStatusSetterRef.current = setIndexStatus;

  useEffect(() => {
    void window.sessionSearch.setOpenSession(sessionDetail.detail?.sessionKey);
  }, [sessionDetail.detail?.sessionKey]);

  const checkLiveSessions = useCallback(
    () => checkLiveSessionsBeforeDelete(window.sessionSearch, (message) => sessionActions.setActionStatus({ kind: "error", message }), t),
    [sessionActions.setActionStatus, t],
  );

  const sessionDelete = useSessionDelete({
    api: window.sessionSearch,
    openSessionKey: sessionDetail.detail?.sessionKey,
    checkLiveSessions,
    setStatus: sessionActions.setActionStatus,
    onDeleted: async (session) => {
      sessionReadCache(window.sessionSearch).clear();
      if (sessionDetail.detail?.sessionKey === session.sessionKey) sessionDetail.closeLocal();
      else void sessionDetail.refreshLocal();
      catalog.setSelectedKey((current) => (current === session.sessionKey ? null : current));
      await Promise.all([catalog.load(), loadSidebarMetadata(), workbench.loadStats(true)]);
    },
    onAlreadyDeleted: catalog.load,
    t,
  });

  const bulkDelete = useBulkSessionDelete({
    api: window.sessionSearch,
    openSessionKey: sessionDetail.detail?.sessionKey,
    sessions: catalog.displayedResults,
    searchAllMatching: catalog.searchAllMatching,
    checkLiveSessions,
    setStatus: sessionActions.setActionStatus,
    onSelectionStarted: sessionActions.closeContextMenu,
    onDeleted: async (deletedSessionKeys) => {
      if (deletedSessionKeys.length) sessionReadCache(window.sessionSearch).clear();
      if (sessionDetail.detail && deletedSessionKeys.includes(sessionDetail.detail.sessionKey)) sessionDetail.closeLocal();
      else if (deletedSessionKeys.length) void sessionDetail.refreshLocal();
      await Promise.all([catalog.load(), loadSidebarMetadata(), workbench.loadStats(true), workbench.loadSessions()]);
    },
    t,
  });

  const migration = useSessionMigration({
    api: window.sessionSearch,
    environments,
    language,
    setStatus: sessionActions.setActionStatus,
    onStarted: sessionActions.closeContextMenu,
    onMigrated: async () => {
      await Promise.all([catalog.load(), loadSidebarMetadata(), workbench.loadStats(true)]);
      await workbench.refreshLiveSessions();
    },
    t,
  });

  const reloadEnvironmentData = useCallback(async (): Promise<void> => {
    setEnvironments(await window.sessionSearch.listEnvironments());
    await catalog.load();
  }, [catalog.load]);

  const environmentActions = useEnvironmentActions({
    api: window.sessionSearch,
    setStatus: setSettingsFeedback,
    reload: reloadEnvironmentData,
    onRemoved: (environment) => {
      if (catalog.environmentId === environment.id) catalog.setEnvironmentId("all");
      if (catalog.projectEnvironmentId === environment.id) catalog.clearProjectFilter();
    },
    t,
  });

  useEffect(() => {
    void loadSidebarMetadata();
  }, [loadSidebarMetadata]);

  useEffect(() => {
    bulkDelete.exit();
  }, [
    bulkDelete.exit,
    catalog.query,
    catalog.source,
    catalog.environmentId,
    catalog.tag,
    catalog.projectPath,
    catalog.projectEnvironmentId,
    catalog.visibility,
    catalog.dateRange,
    catalog.customDateRange,
    catalog.sortBy,
    catalog.liveStatus,
  ]);

  useEffect(() => {
    if (!remoteSessionsOpen || remoteSessions.cache.initialized) return;
    let timeoutId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => void remoteSessions.ensureLoaded(), 0);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [remoteSessions.cache.initialized, remoteSessions.ensureLoaded, remoteSessionsOpen]);

  useEffect(() => {
    if (activePage === "skills") skills.ensureLoaded();
  }, [activePage, skills.ensureLoaded]);

  useEffect(() => {
    if (!settingsOpen) return;
    void automation.ensureDetailsLoaded().catch(() => undefined);
  }, [automation.ensureDetailsLoaded, settingsOpen]);

  useEffect(() => {
    if (!appSettings) return;
    if (OPTIONAL_SOURCE_SETTINGS.some((item) => catalog.source === item.filter && !appSettings[item.key])) {
      catalog.setSource("all");
    }
  }, [catalog.source, appSettings, catalog.setSource]);

  const deleteSessionCandidate = sessionDelete.request?.session ?? null;
  const anyOverlayOpen = Boolean(
    sessionDetail.detail
    || sessionDetail.remoteDetail
    || sessionActions.dialog
    || migration.dialog
    || deleteSessionCandidate
    || bulkDelete.dialog
    || sessionActions.deleteTagName
    || sessionActions.contextMenu
    || aiAssistantOpen
    || settingsOpen
    || sshDialogOpen
    || wslDialogOpen
    || remoteSessionsOpen,
  );
  const modalOverlayOpen = Boolean(
    sessionDetail.detail
    || sessionDetail.remoteDetail
    || bulkDelete.dialog
    || aiAssistantOpen
    || settingsOpen
    || sshDialogOpen
    || wslDialogOpen
    || remoteSessionsOpen,
  );

  const handleEscapeOverlay = useCallback((): boolean => {
    // Esc backs out of the frontmost layer, one at a time.
    if (sshDialogOpen) setSshDialogOpen(false);
    else if (wslDialogOpen) setWslDialogOpen(false);
    else if (migration.dialog) migration.close();
    else if (sessionActions.dialog) sessionActions.setDialog(null);
    else if (bulkDelete.dialog) bulkDelete.closeDialog();
    else if (deleteSessionCandidate && !sessionDelete.deleting) sessionDelete.cancel();
    else if (sessionActions.deleteTagName) sessionActions.setDeleteTagName(null);
    else if (sessionActions.contextMenu) sessionActions.setContextMenu(null);
    else if (aiAssistantOpen) setAiAssistantOpen(false);
    else if (settingsOpen) setSettingsOpen(false);
    else if (sessionDetail.remoteDetail) sessionDetail.closeRemote();
    else if (remoteSessionsOpen) setRemoteSessionsOpen(false);
    else if (sessionDetail.detail) sessionDetail.closeLocal();
    else return false;
    return true;
  }, [
    sshDialogOpen,
    wslDialogOpen,
    migration.dialog,
    migration.close,
    sessionActions.dialog,
    sessionActions.setDialog,
    bulkDelete.dialog,
    bulkDelete.closeDialog,
    deleteSessionCandidate,
    sessionDelete.deleting,
    sessionDelete.cancel,
    sessionActions.deleteTagName,
    sessionActions.setDeleteTagName,
    sessionActions.contextMenu,
    sessionActions.setContextMenu,
    aiAssistantOpen,
    settingsOpen,
    sessionDetail.remoteDetail,
    sessionDetail.closeRemote,
    remoteSessionsOpen,
    sessionDetail.detail,
    sessionDetail.closeLocal,
  ]);

  useAppShortcuts({
    platform: RUNTIME_PLATFORM,
    searchRef: catalog.searchRef,
    navigateToPage,
    displayedResults: catalog.displayedResults,
    selectedKey: catalog.selectedKey,
    setSelectedKey: catalog.setSelectedKey,
    actionStatus: sessionActions.actionStatus,
    anyOverlayOpen,
    modalOverlayOpen,
    onOpenSettingsShortcut: useCallback(() => {
      sessionActions.setContextMenu(null);
      setSettingsInitialSection("terminal");
      setSettingsOpen(true);
    }, [sessionActions.setContextMenu]),
    onEscapeOverlay: handleEscapeOverlay,
    onResumeSession: useCallback((session: SessionSearchResult) => {
      void sessionActions.runAction(
        resumeActionLabel(session.source, language),
        () => window.sessionSearch.resumeSession(session.sessionKey),
        (result) => resumeRouteMessage(result, language),
      );
    }, [language, sessionActions.runAction]),
    onOpenSession: useCallback((session: SessionSearchResult) => {
      void sessionDetail.openLocal(session);
    }, [sessionDetail.openLocal]),
  });

  const selectedProject = useMemo(
    () => findSelectedProject(projects, catalog.projectPath, catalog.projectEnvironmentId),
    [projects, catalog.projectPath, catalog.projectEnvironmentId],
  );
  const sidebarTree = useMemo(
    () => buildSidebarTree(projects, environments, projectTags, catalog.projectPath, catalog.projectEnvironmentId),
    [projects, environments, projectTags, catalog.projectPath, catalog.projectEnvironmentId],
  );
  const searchPlaceholder = catalog.projectPath
    ? t(`Search within ${selectedProject?.label || "project"}`, `在 ${selectedProject?.label || "项目"} 中搜索`)
    : catalog.tag
      ? t(`Search within ${displayTagName(catalog.tag)}`, `在 ${displayTagName(catalog.tag)} 中搜索`)
      : t("Search titles, first questions, full text, paths, or ids", "搜索标题、首个问题、全文、路径或 ID");

  // Stable callbacks for SessionRow so memoized rows don't re-render on every App render.
  const rowHandlersRef = useRef({
    openDetail: sessionDetail.openLocal,
    beginRename: sessionActions.beginRename,
    toggleFavorite: sessionActions.toggleFavorite,
  });
  rowHandlersRef.current = {
    openDetail: sessionDetail.openLocal,
    beginRename: sessionActions.beginRename,
    toggleFavorite: sessionActions.toggleFavorite,
  };
  const handleRowSelect = useCallback((sessionKey: string) => catalog.setSelectedKey(sessionKey), [catalog.setSelectedKey]);
  const handleRowOpen = useCallback((session: SessionSearchResult) => void rowHandlersRef.current.openDetail(session), []);
  const handleRowOpenMatch = useCallback(
    (session: SessionSearchResult, hit: SessionMatchHit) => void rowHandlersRef.current.openDetail(session, hit),
    [],
  );
  const handleRowRename = useCallback((session: SessionSearchResult) => rowHandlersRef.current.beginRename(session), []);
  const handleRowFavorite = useCallback((session: SessionSearchResult) => void rowHandlersRef.current.toggleFavorite(session), []);
  const handleRowContextMenu = useCallback((event: ReactMouseEvent, session: SessionSearchResult) => {
    event.preventDefault();
    catalog.setSelectedKey(session.sessionKey);
    sessionActions.setContextMenu({ x: event.clientX, y: event.clientY, session });
  }, [catalog.setSelectedKey, sessionActions.setContextMenu]);

  return (
    <main className="app" data-theme={resolvedTheme} data-platform={RUNTIME_PLATFORM} onClick={() => sessionActions.setContextMenu(null)}>
      <div className="titlebar-drag" />
      <AppNavigation
        activePage={activePage}
        settingsOpen={settingsOpen}
        signalUpdate={appUpdate.signal}
        language={language}
        onNavigate={(page) => void navigateToPage(page)}
        onOpenSettings={() => {
          setSettingsInitialSection(appUpdate.signal ? "about" : "terminal");
          setSettingsOpen(true);
        }}
      />

      <section className="app-workspace">
        <div className="app-page-host">
          {visitedPages.has("workbench") || activePage === "workbench" ? (
            <KeepAlivePane active={activePage === "workbench"}>
              <WorkbenchPage
                stats={workbench.stats}
                statsPeriod={workbench.statsPeriod}
                statsRefreshing={workbench.statsRefreshing}
                statsFeedback={workbench.statsFeedback}
                quotas={workbench.quotas}
                quotaLoading={workbench.quotaLoading}
                quotaFeedback={workbench.quotaFeedback}
                sessions={workbench.sessions}
                sessionQuery={workbench.query}
                liveSessionKeys={catalog.liveSessionKeys}
                liveDetectionFailed={catalog.liveDetectionFailed}
                platform={RUNTIME_PLATFORM}
                language={language}
                onStatsPeriodChange={workbench.setStatsPeriod}
                onRefreshStats={() => void workbench.refreshStats()}
                onRefreshQuotas={() => void workbench.loadQuotas("manual")}
                onOpenSettings={() => { setSettingsInitialSection("usage"); setSettingsOpen(true); }}
                onSearchSessions={workbench.setQuery}
                onOpenSession={(session) => void sessionDetail.openLocal(session)}
                onResumeSession={(session) => void sessionActions.runAction(resumeActionLabel(session.source, language), () => window.sessionSearch.resumeSession(session.sessionKey), (result) => resumeRouteMessage(result, language))}
                onShowSessions={(submittedQuery) => {
                  catalog.setQuery(submittedQuery);
                  void navigateToPage("sessions");
                  catalog.setLiveStatus("all");
                }}
                onSelectTrendDay={(day) => {
                  catalog.setQuery("");
                  catalog.setSource("all");
                  catalog.selectEnvironment("all");
                  catalog.clearProjectFilter();
                  catalog.setTag(undefined);
                  catalog.setVisibility("default");
                  catalog.setLiveStatus("all");
                  catalog.setDateRange("all");
                  catalog.setCustomDateRange({ dayStart: day.dayStart, dayEndExclusive: day.dayEndExclusive });
                  void navigateToPage("sessions");
                }}
                mcpServers={feeds.workbenchMcpServers}
                skills={feeds.workbenchSkills ?? []}
                skillsLoading={feeds.workbenchSkills === null}
                onShowMcp={() => void navigateToPage("mcp")}
                onShowSkills={() => void navigateToPage("skills")}
                islandSnapshot={feeds.islandSnapshot}
                gatewaySnapshot={feeds.gatewaySnapshot}
                onShowGateway={() => void navigateToPage("providers")}
                onFocusIslandTask={(taskId) => { void window.sessionSearch.focusIslandTask?.(taskId).catch(() => undefined); }}
                onOpenIslandTrajectory={(taskId) => { void window.sessionSearch.openIslandTrajectory?.(taskId).catch(() => undefined); }}
                onShareIslandTaskToTeam={(taskId) => { void window.sessionSearch.shareIslandTaskToTeam?.(taskId).catch(() => undefined); }}
              />
            </KeepAlivePane>
          ) : null}

          {visitedPages.has("sessions") || activePage === "sessions" ? (
            <KeepAlivePane active={activePage === "sessions"}>
              <SessionsPage
                model={{
                  language,
                  indexStatus,
                  sessionTotalCount: catalog.sessionTotalCount,
                  environmentId: catalog.environmentId,
                  projectPath: catalog.projectPath,
                  projectEnvironmentId: catalog.projectEnvironmentId,
                  tag: catalog.tag,
                  tags,
                  sidebarTree,
                  source: catalog.source,
                  origin: catalog.origin,
                  originCounts: catalog.originCounts,
                  invocationSurface: catalog.invocationSurface,
                  invocationSurfaceCounts: catalog.invocationSurfaceCounts,
                  sourceFilters: visibleSourceFilters,
                  visibility: catalog.visibility,
                  searchRef: catalog.searchRef,
                  searchPlaceholder,
                  query: catalog.query,
                  liveStatus: catalog.liveStatus,
                  customDateRange: catalog.customDateRange,
                  dateRange: catalog.dateRange,
                  sortBy: catalog.sortBy,
                  aiAssistantOpen,
                  remoteSessionsOpen,
                  selected: catalog.selected,
                  sessions: catalog.displayedResults,
                  currentPage: catalog.currentPage,
                  totalPages: catalog.totalPages,
                  liveSessionKeys: catalog.liveSessionKeys,
                  liveDetectionFailed: catalog.liveDetectionFailed,
                  bulkSelectionActive: bulkDelete.selectionActive,
                  bulkSelectedKeys: bulkDelete.selectedKeys,
                }}
                actions={{
                  refresh: () => void sessionActions.refreshNow(),
                  selectAllSessions: () => {
                    catalog.selectEnvironment("all");
                    catalog.clearProjectFilter();
                    catalog.setTag(undefined);
                  },
                  selectEnvironment: (nextEnvironmentId) => {
                    catalog.selectEnvironment(nextEnvironmentId);
                    catalog.clearProjectFilter();
                    catalog.setTag(undefined);
                  },
                  selectProject: catalog.selectProject,
                  deleteTag: sessionActions.setDeleteTagName,
                  setSource: catalog.setSource,
                  setOrigin: catalog.setOrigin,
                  setInvocationSurface: catalog.setInvocationSurface,
                  setTag: catalog.setTag,
                  setVisibility: catalog.setVisibility,
                  search: catalog.setQuery,
                  setLiveStatus: catalog.setLiveStatus,
                  clearCustomDateRange: () => catalog.setCustomDateRange(null),
                  setCustomDateRange: (nextRange) => {
                    catalog.setDateRange("all");
                    catalog.setCustomDateRange(nextRange);
                  },
                  setDateRange: (nextRange) => {
                    catalog.setCustomDateRange(null);
                    catalog.setDateRange(nextRange);
                  },
                  setSortBy: catalog.setSortBy,
                  openAiAssistant: () => {
                    setSettingsOpen(false);
                    setRemoteSessionsOpen(false);
                    setAiAssistantOpen(true);
                  },
                  openRemoteSessions: () => {
                    setSettingsOpen(false);
                    setRemoteSessionsOpen(true);
                  },
                  selectSession: handleRowSelect,
                  openSession: handleRowOpen,
                  openMatch: handleRowOpenMatch,
                  renameSession: handleRowRename,
                  toggleFavorite: handleRowFavorite,
                  openContextMenu: handleRowContextMenu,
                  goToPage: catalog.goToPage,
                  toggleBulkSession: bulkDelete.toggle,
                  toggleLoadedSelection: bulkDelete.toggleShown,
                  exitBulkSelection: bulkDelete.exit,
                  selectAllMatching: () => void bulkDelete.selectAllMatching(),
                  deleteSelected: () => void bulkDelete.previewSelected(),
                  openDateCleanup: bulkDelete.openDateCleanup,
                  openOrphanCleanup: () => void bulkDelete.openOrphanCleanup(),
                }}
              />
            </KeepAlivePane>
          ) : null}

          <Suspense fallback={<div className="app-page-loading" role="status">{t("Loading feature...", "正在加载功能...")}</div>}>
            {visitedPages.has("skills") || activePage === "skills" ? (
              <KeepAlivePane active={activePage === "skills"}>
                <SkillsPage
                  onOpenTeamSpace={openTeamSpace}
                  snapshot={skills.snapshot}
                  syncSnapshot={skills.syncSnapshot}
                  loading={skills.loading}
                  feedback={skills.feedback}
                  localSnapshot={skills.localSnapshot}
                  localLoading={skills.localLoading}
                  localError={skills.localError}
                  language={language}
                  revealLabel={FILE_MANAGER_LABEL}
                  onRefresh={() => void skills.load({ refreshUsage: true })}
                  onEnsureLocalLoaded={skills.ensureLocalLoaded}
                  onRefreshLoadedLocal={skills.refreshLoadedLocal}
                  onRefreshLocal={skills.refreshLocal}
                  onUpload={(skill, force) => skills.upload(skill, force)}
                  onInstallRemote={(remoteSkillId) => skills.installRemote(remoteSkillId)}
                  onFetchVersion={(remoteSkillId) => skills.fetchVersion(remoteSkillId)}
                  onRefreshRemote={() => void skills.load({ silent: true })}
                  onCopySetupSql={() => void skills.copySetupSql()}
                  onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("skills")}
                  onCopyPath={(skillPath) =>
                    void sessionActions.runUtilityAction(t("Copying skill path", "正在复制 Skill 路径"), () => window.sessionSearch.copySkillPath(skillPath), t("Skill path copied.", "Skill 路径已复制。"))
                  }
                  onReveal={(skillPath) =>
                    void sessionActions.runUtilityAction(`Opening ${FILE_MANAGER_LABEL}`, () => window.sessionSearch.revealSkill(skillPath), `${FILE_MANAGER_LABEL} opened.`)
                  }
                  onDelete={(skill) => skills.deleteSkill(skill)}
                  evalBadgeCounts={Boolean(appSettings?.evalEnabled) ? feeds.evalFindingCounts : undefined}
                  onNavigateToEval={(skillName) => void openPage({ page: "evaluation", skill: skillName })}
                  initialDiscoveryOpen={pageRequest?.page === "skills"}
                  onInitialDiscoveryConsumed={consumePageRequest}
                />
              </KeepAlivePane>
            ) : null}

            {activePage === "evaluation" ? (
              <EvaluationFeaturePage
                language={language}
                enabled={Boolean(appSettings?.evalEnabled)}
                preselectedSkill={evaluationRequest && "skill" in evaluationRequest ? evaluationRequest.skill : null}
                onPreselectedConsumed={consumePageRequest}
                initialRunId={evaluationRun?.runId}
                initialCaseId={evaluationRun?.caseId}
                initialEvaluatorId={evaluationRun?.evaluatorId}
                onInitialRunConsumed={consumePageRequest}
                onOpenSettings={() => { setSettingsInitialSection("eval"); setSettingsOpen(true); }}
                onOpenSession={(sessionKey) => {
                  void (async () => {
                    const session = await window.sessionSearch.getSession(sessionKey);
                    if (session) await sessionDetail.openLocal(session);
                  })();
                }}
                onNavigationGuardChange={setPageNavigationGuard}
              />
            ) : null}

            {activePage === "runtimes" ? (
              <RuntimeFeaturePage
                language={language}
                initialChannelId={pageRequest?.page === "runtimes" ? pageRequest.channelId : undefined}
                onInitialChannelConsumed={consumePageRequest}
                initialAgentId={pageRequest?.page === "runtimes" ? pageRequest.agentId : undefined}
                onInitialAgentConsumed={consumePageRequest}
                onNavigationGuardChange={setPageNavigationGuard}
              />
            ) : null}

            {visitedPages.has("mcp") || activePage === "mcp" ? (
              <KeepAlivePane active={activePage === "mcp"}>
                <McpFeaturePage language={language} onOpenTeamSpace={openTeamSpace} />
              </KeepAlivePane>
            ) : null}

            {visitedPages.has("memories") || activePage === "memories" ? (
              <KeepAlivePane active={activePage === "memories"}>
                <MemoryPage
                  language={language}
                  settings={appSettings}
                  gatewayModelLabel={feeds.gatewayBuiltInModelLabel}
                  onSettingsChange={updateSettings}
                  onOpenAgentModel={openAgentModel}
                  onViewSource={(sessionKey, turnIndex) => {
                    void (async () => {
                      const session = await window.sessionSearch.getSession(sessionKey);
                      if (!session) throw new Error(localize(language, "The source Session is no longer indexed.", "来源会话已不在索引中。"));
                      const turn = (await window.sessionSearch.listSessionTurns(sessionKey)).find((item) => item.turnIndex === turnIndex);
                      if (!(await navigateToPage("sessions"))) return;
                      window.requestAnimationFrame(() => void sessionDetail.openLocal(session, turn ? {
                        messageIndex: turn.sourceMessageIndex ?? 0,
                        role: "user",
                        timestamp: turn.startedAt ?? "",
                        snippet: "",
                        matchedTerms: [],
                        turnId: turn.id,
                        turnIndex,
                      } : undefined));
                    })().catch(reportSessionDetailError);
                  }}
                />
              </KeepAlivePane>
            ) : null}

            {visitedPages.has("instructions") || activePage === "instructions" ? (
              <KeepAlivePane active={activePage === "instructions"}>
                <InstructionsPage language={language} onOpenTeamSpace={openTeamSpace} />
              </KeepAlivePane>
            ) : null}

            {visitedPages.has("providers") || activePage === "providers" ? (
              <KeepAlivePane active={activePage === "providers"}>
                <ProviderPage
                  language={language}
                  requestedView={pageRequest?.page === "providers" ? pageRequest.view : null}
                  onRequestedViewConsumed={consumePageRequest}
                />
              </KeepAlivePane>
            ) : null}
          </Suspense>

          {visitedPages.has("team-space") || activePage === "team-space" ? (
            <KeepAlivePane active={activePage === "team-space"}>
              <Suspense fallback={<p role="status">{t("Loading team space…", "正在读取团队空间…")}</p>}>
                <TeamWorkspacePage
                  drafts={teamPushDrafts}
                  onPushed={(keys) => setTeamPushDrafts((previous) => previous.filter((item) => !keys.includes(item.item.key)))}
                  language={language}
                  settingsOpen={settingsOpen}
                  onOpenSettings={() => { setSettingsInitialSection("team"); setSettingsOpen(true); }}
                />
              </Suspense>
            </KeepAlivePane>
          ) : null}
        </div>
      </section>

      <SessionDetailHost
        sessionDetail={sessionDetail}
        sessionActions={sessionActions}
        query={catalog.query}
        liveSessionKeys={catalog.liveSessionKeys}
        liveDetectionFailed={catalog.liveDetectionFailed}
        language={language}
        revealLabel={FILE_MANAGER_LABEL}
        showItermAction={IS_MAC}
        familyRefreshVersion={sessionFamilyRefreshVersion}
        t={t}
        reportSessionDetailError={reportSessionDetailError}
        onMigrate={migration.begin}
        onDeleteSession={sessionDelete.requestDelete}
        setTeamPushDrafts={setTeamPushDrafts}
        setTeamUploadKeys={setTeamUploadKeys}
        navigateToPage={navigateToPage}
        openPage={openPage}
        setActionStatus={sessionActions.setActionStatus}
      />

      <SessionOverlaysHost
        platform={RUNTIME_PLATFORM}
        language={language}
        revealLabel={FILE_MANAGER_LABEL}
        showMacActions={IS_MAC}
        t={t}
        tags={tags}
        environments={environments}
        appSettings={appSettings}
        sessionDetail={sessionDetail}
        sessionActions={sessionActions}
        load={catalog.load}
        loadSidebarMetadata={loadSidebarMetadata}
        teamPushDrafts={teamPushDrafts}
        setTeamPushDrafts={setTeamPushDrafts}
        teamUploadKeys={teamUploadKeys}
        setTeamUploadKeys={setTeamUploadKeys}
        sessionDelete={sessionDelete}
        bulkDelete={bulkDelete}
        migration={migration}
        remoteSessions={remoteSessions}
        appUpdate={appUpdate}
        environmentActions={environmentActions}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        settingsInitialSection={settingsInitialSection}
        setSettingsInitialSection={setSettingsInitialSection}
        settingsFeedback={settingsFeedback}
        updateSettings={updateSettings}
        importV1Data={importV1Data}
        theme={theme}
        setTheme={setTheme}
        setLanguage={setLanguage}
        messageFontSize={messageFontSize}
        setMessageFontSize={setMessageFontSize}
        sessionHookStatus={sessionSyncHook.status}
        sessionHookBusy={sessionSyncHook.busy}
        toggleSessionSyncHook={sessionSyncHook.toggle}
        gatewayBuiltInModelLabel={feeds.gatewayBuiltInModelLabel}
        onOpenProviders={() => void navigateToPage("providers")}
        onOpenAgentModel={openAgentModel}
        sshDialogOpen={sshDialogOpen}
        setSshDialogOpen={setSshDialogOpen}
        wslDialogOpen={wslDialogOpen}
        setWslDialogOpen={setWslDialogOpen}
        remoteSessionsOpen={remoteSessionsOpen}
        setRemoteSessionsOpen={setRemoteSessionsOpen}
        aiAssistantOpen={aiAssistantOpen}
        setAiAssistantOpen={setAiAssistantOpen}
      />
    </main>
  );
}
