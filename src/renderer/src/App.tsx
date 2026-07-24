import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { GitBranch } from "lucide-react";
import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { IndexStatus } from "../../core/indexer";
import type { AppUpdateStatus } from "../../core/app-update-types";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { MigrationTargetSettings } from "../../core/migration-targets";
import type { RemoteHealthReport } from "../../core/remote-health";
import type { SessionSyncHookStatus } from "../../core/session-sync-queue";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../../core/session-sources";
import type {
  EnvironmentUpsertInput,
  ProjectSummary,
  ProjectTagEntry,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionMatchHit,
  SessionSearchResult,
} from "../../core/types";
import {
  getLiveSessionState,
} from "./live-filter";
import {
  readSidebarSections,
  serializeSidebarSections,
  toggleSidebarSection,
  type SidebarSectionId,
  type SidebarSectionsState,
} from "./sidebar-sections";
import { LANGUAGE_STORAGE_KEY, localize, readInitialLanguage, type LanguageMode } from "./language";
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";
import type {
  ActionStatus,
  ContextMenuState,
  DialogState,
  RefreshFeedback,
  SettingsFeedback,
  SessionMigrationDialogState,
} from "./app-types";
import { SessionMigrationDialog, SessionMigrationLaunchFailedDialog } from "./components/session-migration-dialog";
import { CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "./components/session-dialogs";
import { AppNavigation, type AppPage } from "./components/app-navigation";
import { ActionToast } from "./components/action-toast";
import { useSkillsController } from "./features/skills/use-skills-controller";
import { AiAssistantDialog } from "./components/ai-assistant-dialog";
import { RemoteSessionsDialog } from "./features/remote-sessions/remote-sessions-dialog";
import { useRemoteSessionsCache } from "./features/remote-sessions/use-remote-sessions-cache";
import { SupabaseSetupGuide } from "./components/supabase-setup-guide";
import { environmentTarget } from "./features/environments/environment-display";
import { SessionsPage } from "./features/sessions/sessions-page";
import { SessionContextMenu } from "./features/sessions/session-context-menu";
import { SessionDetails } from "./features/sessions/session-details";
import {
  migrationProgressMessage,
  migrationStrategyLabel,
} from "./features/sessions/session-migration-copy";
import { SESSION_PAGE_SIZE, useSessionCatalog } from "./features/sessions/use-session-catalog";
import { useSessionDetail } from "./features/sessions/use-session-detail";
import { SettingsDialog, type SettingsSection } from "./features/settings/settings-dialog";
import { SshEnvironmentDialog } from "./features/settings/ssh-environment-dialog";
import { WorkbenchPage } from "./features/workbench/workbench-page";
import { useWorkbenchOverview } from "./features/workbench/use-workbench-overview";
import { useAutomation } from "./features/automation/automation-provider";
import { selectWorkbenchWorkflows } from "./features/automation/workbench-workflows";
import {
  isBranchTag,
  displayTagName,
  isRemoteSession,
  resumeActionLabel,
  resumeRouteMessage,
  sourceFilters,
  supportsMigrationSource,
  supportsResumeSource,
  migrationAgentLabel,
  migrationTargetsForSession,
} from "./session-ui";

const RUNTIME_PLATFORM: NodeJS.Platform = window.sessionSearch.platform;
const IS_MAC = RUNTIME_PLATFORM === "darwin";
const FILE_MANAGER_LABEL = IS_MAC ? "Finder" : RUNTIME_PLATFORM === "win32" ? "Explorer" : "File Manager";

const SkillsPage = lazy(() =>
  import("./features/skills/skills-page").then((module) => ({ default: module.SkillsPage })));
const WorkflowFeaturePage = lazy(() =>
  import("./features/automation/workflow-feature-page").then((module) => ({ default: module.WorkflowFeaturePage })));
const TeamChatPage = lazy(() =>
  import("./features/team-chat/team-chat-page").then((module) => ({ default: module.TeamChatPage })));
const EvaluationFeaturePage = lazy(() =>
  import("./features/automation/evaluation-feature-page").then((module) => ({ default: module.EvaluationFeaturePage })));
const RuntimeFeaturePage = lazy(() =>
  import("./features/automation/runtime-feature-page").then((module) => ({ default: module.RuntimeFeaturePage })));
const McpFeaturePage = lazy(() =>
  import("./features/automation/mcp-feature-page").then((module) => ({ default: module.McpFeaturePage })));
const AgentMemoryPage = lazy(() =>
  import("./features/agent-memory/agent-memory-page").then((module) => ({ default: module.AgentMemoryPage })));
const ProviderPage = lazy(() =>
  import("./features/providers/provider-page").then((module) => ({ default: module.ProviderPage })));

const DEFAULT_MIGRATION_TARGET_SETTINGS = {
  includeTclaude: false,
  includeTcodex: false,
  includeClaudeInternal: false,
  includeCodexInternal: false,
} satisfies MigrationTargetSettings;

type PendingSourceKey = (typeof OPTIONAL_SESSION_SOURCE_DESCRIPTORS)[number]["pendingKey"];

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  pendingKey: descriptor.pendingKey,
  filter: descriptor.id,
}));

function emptyPendingPersonalSources(): Record<PendingSourceKey, boolean> {
  return Object.fromEntries(
    OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map(({ pendingKey }) => [pendingKey, false]),
  ) as Record<PendingSourceKey, boolean>;
}

const SIDEBAR_SECTIONS_STORAGE_KEY = "agent-recall-sidebar-sections";
const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "agent-recall-collapsed-project-groups";

function loadCollapsedProjectGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function loadInitialSidebarSections(): SidebarSectionsState {
  if (typeof window === "undefined") return readSidebarSections(null);
  return readSidebarSections(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY));
}

export function App(): ReactElement {
  const automation = useAutomation();
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
  const skills = useSkillsController(language);
  const remoteSessions = useRemoteSessionsCache();
  const [activePage, setActivePage] = useState<AppPage>("workbench");
  const pageNavigationGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const setPageNavigationGuard = useCallback((guard: (() => Promise<boolean>) | null): void => {
    pageNavigationGuardRef.current = guard;
  }, []);
  const navigateToPage = useCallback(async (page: AppPage): Promise<boolean> => {
    if (page === activePage) return true;
    try {
      if (pageNavigationGuardRef.current && !(await pageNavigationGuardRef.current())) return false;
      pageNavigationGuardRef.current = null;
      setActivePage(page);
      return true;
    } catch (error) {
      console.warn("Failed to leave the current page", error);
      return false;
    }
  }, [activePage]);
  const workbenchWorkflows = useMemo(
    () => selectWorkbenchWorkflows(automation.snapshot.workflowStore.workflows, automation.snapshot.workflowStore.runs),
    [automation.snapshot.workflowStore.runs, automation.snapshot.workflowStore.workflows],
  );
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionsState>(() => loadInitialSidebarSections());
  const [collapsedProjectGroups, setCollapsedProjectGroups] = useState<Set<string>>(() => loadCollapsedProjectGroups());
  const [collapsedTreeProjects, setCollapsedTreeProjects] = useState<Set<string>>(new Set());
  const {
    query: workbenchQuery,
    setQuery: setWorkbenchQuery,
    sessions: workbenchSessions,
    stats,
    statsPeriod,
    setStatsPeriod,
    statsRefreshing,
    statsFeedback,
    quotas,
    quotaLoading,
    quotaFeedback,
    liveSessions,
    loadSessions: loadWorkbenchSessions,
    loadStats,
    refreshStats,
    loadQuotas,
    refreshLiveSessions,
  } = useWorkbenchOverview(language);
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectTags, setProjectTags] = useState<ProjectTagEntry[]>([]);
  const [environments, setEnvironments] = useState<SessionEnvironment[]>([]);
  const {
    query,
    setQuery,
    source,
    setSource,
    environmentId,
    setEnvironmentId,
    tag,
    setTag,
    projectPath,
    projectEnvironmentId,
    visibility,
    setVisibility,
    dateRange,
    setDateRange,
    customDateRange,
    setCustomDateRange,
    liveStatus,
    setLiveStatus,
    sessionTotalCount,
    hasMoreSessions,
    displayedResults,
    selectedKey,
    setSelectedKey,
    selected,
    searchRef,
    liveSessionKeys,
    liveDetectionFailed,
    liveSearchKeys,
    load,
    loadMore,
    clearProjectFilter,
    clearProjectScopeFilter,
    clearEnvironmentScopeFilter,
    selectEnvironment,
    selectProject,
  } = useSessionCatalog({
    active: activePage === "sessions",
    liveSessions,
    projects,
    environments,
    tags,
  });
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [migrationDialog, setMigrationDialog] = useState<SessionMigrationDialogState>(null);
  const [migrationProgress, setMigrationProgress] = useState<SessionMigrationProgress | null>(null);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<SessionSearchResult | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("terminal");
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedback>(null);
  const [environmentHealthReports, setEnvironmentHealthReports] = useState<Record<string, RemoteHealthReport>>({});
  const [diagnosingEnvironmentId, setDiagnosingEnvironmentId] = useState<string | null>(null);
  const [skillHookInstalled, setSkillHookInstalled] = useState<boolean | null>(null);
  const [skillHookBusy, setSkillHookBusy] = useState(false);
  const [sessionHookStatus, setSessionHookStatus] = useState<SessionSyncHookStatus | null>(null);
  const [sessionHookBusy, setSessionHookBusy] = useState(false);
  const [pendingPersonalSources, setPendingPersonalSources] = useState<Record<PendingSourceKey, boolean>>(
    emptyPendingPersonalSources,
  );
  const metadataLoadSeqRef = useRef(0);
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const reportSessionDetailError = useCallback((error: unknown): void => {
    setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }, []);
  const {
    detail,
    remoteDetail,
    turns: detailTurns,
    turnsLoading,
    matchedTurnId,
    openLocal: openDetail,
    closeLocal: closeDetail,
    openRemote: openRemoteDetail,
    closeRemote: closeRemoteDetail,
    refreshLocal: refreshDetail,
    applyUpdatedLocal: applyUpdatedDetail,
  } = useSessionDetail(reportSessionDetailError);

  const loadSidebarMetadata = useCallback(async () => {
    const requestId = ++metadataLoadSeqRef.current;
    const [nextTags, nextProjects, nextEnvironments, nextProjectTags] = await Promise.all([
      window.sessionSearch.listTags(),
      window.sessionSearch.listProjects(),
      window.sessionSearch.listEnvironments(),
      window.sessionSearch.listTagsByProject(),
    ]);
    if (requestId !== metadataLoadSeqRef.current) return;
    setTags(nextTags);
    setProjects(nextProjects);
    setEnvironments(nextEnvironments);
    setProjectTags(nextProjectTags);
  }, []);

  useEffect(() => {
    void loadSidebarMetadata();
  }, [loadSidebarMetadata]);

  useEffect(() => {
    if (remoteSessionsOpen) void remoteSessions.load();
  }, [remoteSessions.load, remoteSessionsOpen]);

  useEffect(() => {
    if (activePage === "skills") skills.ensureLoaded();
  }, [activePage, skills.ensureLoaded]);

  useEffect(() => {
    if (!settingsOpen) return;
    void window.sessionSearch.getSkillUsageHookStatus().then(setSkillHookInstalled).catch(() => setSkillHookInstalled(false));
    void window.sessionSearch.getSessionSyncHookStatus().then(setSessionHookStatus).catch(() => setSessionHookStatus(null));
  }, [settingsOpen]);

  const toggleSkillUsageHook = useCallback(async (enabled: boolean) => {
    setSkillHookBusy(true);
    setSettingsFeedback({ kind: "running", message: enabled ? t("Enabling skill usage tracking...", "正在开启 Skill 使用统计...") : t("Disabling skill usage tracking...", "正在关闭 Skill 使用统计...") });
    try {
      if (enabled) await window.sessionSearch.installSkillUsageHook();
      else await window.sessionSearch.uninstallSkillUsageHook();
      setSkillHookInstalled(await window.sessionSearch.getSkillUsageHookStatus());
      if (activePage === "skills") void skills.load({ refreshUsage: true, silent: true });
      const message = enabled ? t("Skill usage tracking on.", "已开启 Skill 使用统计。") : t("Skill usage tracking off.", "已关闭 Skill 使用统计。");
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current)), 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillHookBusy(false);
    }
  }, [activePage, skills.load, t]);

  const toggleSessionSyncHook = useCallback(async (enabled: boolean) => {
    setSessionHookBusy(true);
    setSettingsFeedback({
      kind: "running",
      message: enabled ? t("Installing session sync hooks...", "正在安装会话同步 Hook...") : t("Removing session sync hooks...", "正在移除会话同步 Hook..."),
    });
    try {
      const status = enabled
        ? await window.sessionSearch.installSessionSyncHooks()
        : await window.sessionSearch.uninstallSessionSyncHooks();
      setSessionHookStatus(status);
      const message = enabled
        ? t("Session sync hooks installed.", "会话同步 Hook 已安装。")
        : t("Session sync hooks removed.", "会话同步 Hook 已移除。");
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current)), 1800);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSessionHookBusy(false);
    }
  }, [t]);

  useEffect(() => {
    void window.sessionSearch.getSettings().then(setAppSettings);
  }, []);

  useEffect(() => {
    if (!appSettings) return;
    if (OPTIONAL_SOURCE_SETTINGS.some((item) => source === item.filter && !appSettings[item.key])) setSource("all");
  }, [source, appSettings]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useLayoutEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, serializeSidebarSections(sidebarSections));
  }, [sidebarSections]);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify([...collapsedProjectGroups]));
  }, [collapsedProjectGroups]);

  const toggleProjectGroup = useCallback((environmentId: string): void => {
    setCollapsedProjectGroups((current) => {
      const next = new Set(current);
      if (next.has(environmentId)) next.delete(environmentId);
      else next.add(environmentId);
      return next;
    });
  }, []);

  const toggleTreeProject = useCallback((projectKey: string): void => {
    setCollapsedTreeProjects((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);

  useEffect(() => {
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      setIndexStatus(nextStatus);
      if (nextStatus.error) setRefreshFeedback({ kind: "error", message: nextStatus.error });
      if (!nextStatus.running) {
        if (activePage === "sessions") void load();
        void loadSidebarMetadata();
        void loadStats();
        void loadWorkbenchSessions();
      }
    });
    const offFocus = window.sessionSearch.onFocusSearch(() => {
      void navigateToPage("sessions").then((navigated) => {
        if (navigated) window.requestAnimationFrame(() => searchRef.current?.focus());
      });
    });
    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      setSettingsInitialSection("terminal");
      setSettingsOpen(true);
    });
    const offAppUpdate = window.sessionSearch.onAppUpdateStatus(setAppUpdateStatus);
    const offEnvironments = window.sessionSearch.onEnvironmentsUpdated((nextEnvironments) => {
      setEnvironments(nextEnvironments);
      if (activePage === "sessions") void load();
    });
    return () => {
      offIndex();
      offFocus();
      offOpenSettings();
      offAppUpdate();
      offEnvironments();
    };
  }, [activePage, load, loadSidebarMetadata, loadStats, loadWorkbenchSessions, navigateToPage]);

  useEffect(() => {
    void window.sessionSearch.getAppUpdateStatus(false).then(setAppUpdateStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.sessionSearch.onMigrationProgress((progress) => {
      setMigrationProgress(progress);
      setActionStatus({ kind: "running", message: migrationProgressMessage(progress, language) });
    });
  }, [language]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setContextMenu(null);
        setSettingsInitialSection("terminal");
        setSettingsOpen(true);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void navigateToPage("sessions").then((navigated) => {
          if (!navigated) return;
          window.requestAnimationFrame(() => {
            searchRef.current?.focus();
            searchRef.current?.select();
          });
        });
        return;
      }

      // Esc backs out of the frontmost layer, one at a time.
      if (event.key === "Escape") {
        if (sshDialogOpen) setSshDialogOpen(false);
        else if (migrationDialog) setMigrationDialog(null);
        else if (dialog) setDialog(null);
        else if (deleteSessionCandidate && !deletingSession) setDeleteSessionCandidate(null);
        else if (deleteTagName) setDeleteTagName(null);
        else if (contextMenu) setContextMenu(null);
        else if (aiAssistantOpen) setAiAssistantOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (remoteDetail) closeRemoteDetail();
        else if (remoteSessionsOpen) setRemoteSessionsOpen(false);
        else if (detail) closeDetail();
        else return;
        event.preventDefault();
        return;
      }

      // Leave list navigation alone while an overlay or menu is in front.
      if (detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || deleteTagName || contextMenu || aiAssistantOpen || settingsOpen || sshDialogOpen || remoteSessionsOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session && supportsResumeSource(session.source)) {
          void runAction(resumeActionLabel(session.source, language), () => window.sessionSearch.resumeSession(session.sessionKey), (result) => resumeRouteMessage(result, language));
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (displayedResults.length === 0) return;
        event.preventDefault();
        const currentIndex = displayedResults.findIndex((session) => session.sessionKey === selectedKey);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? RUNTIME_PLATFORM === "darwin" && delta === -1
              ? displayedResults.length - 1
              : 0
            : Math.min(displayedResults.length - 1, Math.max(0, currentIndex + delta));
        setSelectedKey(displayedResults[nextIndex].sessionKey);
        return;
      }

      if (event.key === " " && selectedKey) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session) {
          event.preventDefault();
          void openDetail(session);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [displayedResults, selectedKey, detail, remoteDetail, dialog, migrationDialog, deleteSessionCandidate, deletingSession, deleteTagName, contextMenu, aiAssistantOpen, settingsOpen, sshDialogOpen, remoteSessionsOpen, actionStatus, navigateToPage, t]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail || remoteDetail || aiAssistantOpen || settingsOpen || sshDialogOpen || remoteSessionsOpen));
    return () => document.body.classList.remove("overlay-open");
  }, [detail, remoteDetail, aiAssistantOpen, settingsOpen, sshDialogOpen, remoteSessionsOpen]);

  const visibleSourceFilters = useMemo(() => {
    if (!appSettings) return sourceFilters(null);
    // Reveal an extra source filter only once its background load has finished.
    const visibleSettings = { ...appSettings };
    for (const descriptor of OPTIONAL_SESSION_SOURCE_DESCRIPTORS) {
      visibleSettings[descriptor.optionalSetting] =
        appSettings[descriptor.optionalSetting] && !pendingPersonalSources[descriptor.pendingKey];
    }
    return sourceFilters(visibleSettings);
  }, [appSettings, pendingPersonalSources]);
  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.path === projectPath && project.environmentId === projectEnvironmentId) ||
      (projectPath ? projects.find((project) => project.path === projectPath) || null : null),
    [projects, projectPath, projectEnvironmentId],
  );
  const sidebarTree = useMemo(() => {
    // Build env → project → tag tree. Tags are scoped per environment+project
    // so the same branch name on different environments shows separately.
    const tagMap = new Map<string, string[]>();
    for (const entry of projectTags) {
      tagMap.set(`${entry.environmentId}\0${entry.projectPath}`, entry.tags);
    }
    const groups = new Map<string, { environment: SessionEnvironment | null; projects: Array<ProjectSummary & { tags: string[] }> }>();
    for (const project of projects) {
      const environment = environments.find((env) => env.id === project.environmentId) ?? null;
      const key = project.environmentId;
      const projectTagsList = tagMap.get(`${project.environmentId}\0${project.path}`) ?? [];
      const group = groups.get(key);
      if (group) group.projects.push({ ...project, tags: projectTagsList });
      else groups.set(key, { environment, projects: [{ ...project, tags: projectTagsList }] });
    }
    return [...groups.values()].sort(
      (a, b) =>
        (a.environment ? 0 : 1) - (b.environment ? 0 : 1) ||
        (a.environment?.label ?? "").localeCompare(b.environment?.label ?? ""),
    );
  }, [projects, environments, projectTags]);
  const selectedEnvironment = useMemo(
    () => (environmentId === "all" ? null : environments.find((environment) => environment.id === environmentId) ?? null),
    [environmentId, environments],
  );
  const activeScopeFilters = [
    selectedEnvironment
      ? {
          key: "environment",
          label: selectedEnvironment.label,
          title: environmentTarget(selectedEnvironment, language),
          onClear: clearEnvironmentScopeFilter,
        }
      : null,
    selectedProject
      ? {
          key: "project",
          label: selectedProject.label,
          title: selectedProject.path,
          onClear: clearProjectScopeFilter,
        }
      : null,
    tag
      ? {
          key: "tag",
          label: displayTagName(tag),
          prefix: isBranchTag(tag) ? <GitBranch size={12} /> : "#",
          title: displayTagName(tag),
          onClear: () => setTag(undefined),
        }
      : null,
  ].filter((filter): filter is NonNullable<typeof filter> => filter !== null);
  const searchPlaceholder = projectPath
    ? t(`Search within ${selectedProject?.label || "project"}`, `在 ${selectedProject?.label || "项目"} 中搜索`)
    : tag
      ? t(`Search within ${displayTagName(tag)}`, `在 ${displayTagName(tag)} 中搜索`)
      : t("Search titles, first questions, full text, paths, or ids", "搜索标题、首个问题、全文、路径或 ID");

  function toggleSidebarSectionById(section: SidebarSectionId): void {
    setSidebarSections((current) => toggleSidebarSection(current, section));
  }

  async function refreshAfterAction(options: { metadata?: boolean; stats?: boolean } = {}): Promise<void> {
    await Promise.all([
      load(),
      options.metadata ? loadSidebarMetadata() : Promise.resolve(),
      options.stats ? loadStats() : Promise.resolve(),
    ]);
    await refreshDetail();
  }

  function beginRename(session: SessionSearchResult): void {
    setContextMenu(null);
    setDialog({ kind: "rename", session, value: session.customTitle || session.displayTitle });
  }

  function beginAddTag(session: SessionSearchResult): void {
    setContextMenu(null);
    setDialog({ kind: "tag", session, value: "" });
  }

  async function submitDialog(valueOverride?: string): Promise<void> {
    if (!dialog) return;
    const dialogKind = dialog.kind;
    const value = (valueOverride ?? dialog.value).trim();
    if (dialog.kind === "rename") {
      await window.sessionSearch.setCustomTitle(dialog.session.sessionKey, value || null);
    } else if (value) {
      await window.sessionSearch.addTag(dialog.session.sessionKey, value);
    }
    setDialog(null);
    await refreshAfterAction({ metadata: dialogKind === "tag" && Boolean(value) });
  }

  async function removeTag(session: SessionSearchResult, tagName: string): Promise<void> {
    await window.sessionSearch.removeTag(session.sessionKey, tagName);
    await refreshAfterAction({ metadata: true });
  }

  async function toggleFavorite(session: SessionSearchResult): Promise<void> {
    await window.sessionSearch.setFavorited(session.sessionKey, !session.favorited);
    await refreshAfterAction();
  }

  async function summarizeDetail(session: SessionSearchResult): Promise<void> {
    if (summarizing) return;
    setSummarizing(true);
    setActionStatus({ kind: "running", message: t("Generating AI summary...", "正在生成 AI 摘要...") });
    try {
      const updated = await window.sessionSearch.summarizeSession(session.sessionKey);
      if (updated) applyUpdatedDetail(updated);
      await refreshAfterAction();
      const message = t("AI summary generated.", "AI 摘要已生成。");
      setActionStatus({ kind: "success", message });
      window.setTimeout(() => setActionStatus((current) => (current?.kind === "success" && current.message === message ? null : current)), 4000);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSummarizing(false);
    }
  }

  async function deleteTagGlobally(tagName: string): Promise<void> {
    await window.sessionSearch.deleteTag(tagName);
    setDeleteTagName(null);
    if (tag === tagName) setTag(undefined);
    else await load();
    await loadSidebarMetadata();
    await refreshDetail();
  }

  function requestDeleteSession(session: SessionSearchResult): void {
    setContextMenu(null);
    setDeleteSessionCandidate(session);
  }

  async function confirmDeleteSession(): Promise<void> {
    if (!deleteSessionCandidate || deletingSession) return;
    const session = deleteSessionCandidate;
    setDeletingSession(true);
    setActionStatus({ kind: "running", message: t("Deleting session...", "正在删除会话...") });
    try {
      const removed = await window.sessionSearch.deleteSession(session.sessionKey);
      setDeleteSessionCandidate(null);
      if (removed) {
        if (detail?.sessionKey === session.sessionKey) closeDetail();
        setSelectedKey((current) => (current === session.sessionKey ? null : current));
        await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
        const message = t("Session file deleted.", "会话文件已删除。");
        setActionStatus({ kind: "success", message });
        window.setTimeout(() => {
          setActionStatus((current) => (current?.kind === "success" && current.message === message ? null : current));
        }, 1800);
      } else {
        setActionStatus({ kind: "error", message: t("Session was already deleted.", "会话已经被删除。") });
        await load();
      }
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingSession(false);
    }
  }

  async function runAction<T>(label: string, action: () => Promise<T>, successMessage: string | ((result: T) => string)): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: `${label}...` });
    try {
      const result = await action();
      await refreshAfterAction();
      await refreshLiveSessions();
      window.setTimeout(() => void refreshLiveSessions(), 1200);
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      setActionStatus({ kind: "success", message });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 1800);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function runUtilityAction(label: string, action: () => Promise<void>, successMessage: string): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: `${label}...` });
    try {
      await action();
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1600);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function uploadRemoteSession(session: SessionSearchResult): Promise<void> {
    await runAction(
      t("Uploading remote session", "正在上传远程会话"),
      () => window.sessionSearch.uploadRemoteSession(session.sessionKey),
      (result) => {
        if (result.status === "skipped") return t("Remote session is already up to date.", "远程会话已是最新。");
        if (result.status === "updated") return t("Remote session updated.", "远程会话已更新。");
        return t("Remote session uploaded.", "远程会话已上传。");
      },
    );
  }

  async function exportMarkdown(sessionKey: string): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: t("Exporting markdown...", "正在导出 Markdown...") });
    try {
      const exported = await window.sessionSearch.exportMarkdown(sessionKey);
      if (!exported) {
        setActionStatus(null);
        return;
      }
      const successMessage = t("Markdown exported.", "Markdown 已导出。");
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1800);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function exportJson(sessionKey: string): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: t("Exporting JSON...", "正在导出 JSON...") });
    try {
      const result = await window.sessionSearch.exportJson(sessionKey);
      if (!result.exported) {
        setActionStatus(null);
        return;
      }
      const successMessage = result.fidelity === "exact-trace"
        ? t("Exact Codex request JSON exported.", "已导出 Codex 真实请求体 JSON。")
        : result.fidelity === "reconstructed"
          ? t("Reconstructed request JSON exported.", "已导出重建的请求体 JSON。")
          : t("Normalized request JSON exported.", "已导出标准化请求体 JSON。");
      setActionStatus({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1800);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function beginMigrate(session: SessionSearchResult): void {
    setContextMenu(null);
    setMigrationDialog({ kind: "select", session });
  }

  async function runMigration(target: SessionMigrationProgress["target"]): Promise<void> {
    if (!migrationDialog || migrationDialog.kind !== "select") return;
    const session = migrationDialog.session;
    setContextMenu(null);
    setMigrationProgress(null);
    setActionStatus({ kind: "running", message: t("Preparing migration...", "正在准备迁移...") });
    try {
      const result: SessionMigrationResult = await window.sessionSearch.migrateSession(session.sessionKey, target);
      await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
      await refreshLiveSessions();
      const strategyLabel = migrationStrategyLabel(result.strategy, language);
      const message = t(
        `Migrated to ${migrationAgentLabel(result.target)} (${strategyLabel}): ${result.targetSessionId}`,
        `已迁移到 ${migrationAgentLabel(result.target)}（${strategyLabel}）：${result.targetSessionId}`,
      );
      setActionStatus({ kind: "success", message: result.warning ? `${message}\n${result.warning}` : message });
      setMigrationDialog(result.launched ? null : { kind: "launch-failed", session, result });
      window.setTimeout(() => {
        setActionStatus((current) => (current?.kind === "success" && current.message.startsWith(message) ? null : current));
      }, 2200);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setMigrationProgress(null);
    }
  }

  async function refreshNow(): Promise<void> {
    setContextMenu(null);
    setRefreshFeedback({ kind: "running", message: t("Refreshing index...", "正在更新索引...") });
    try {
      const status = await window.sessionSearch.refreshIndex();
      setIndexStatus(status);
      await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
      if (status.error) {
        setRefreshFeedback({ kind: "error", message: status.error });
        return;
      }
      const successMessage = t(
        `Index refreshed: ${status.indexed} updated, ${status.skipped} skipped, ${status.total} total.`,
        `索引已更新：更新 ${status.indexed} 个，跳过 ${status.skipped} 个，共 ${status.total} 个。`,
      );
      setRefreshFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setRefreshFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 2200);
    } catch (error) {
      setRefreshFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function updateDefaultTerminal(defaultTerminal: AppSettings["defaultTerminal"]): Promise<void> {
    await updateSettings({ defaultTerminal });
  }

  async function updateGlobalShortcut(globalShortcut: AppSettings["globalShortcut"]): Promise<void> {
    await updateSettings({ globalShortcut });
  }

  async function checkAppUpdate(): Promise<void> {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    try {
      setAppUpdateStatus(await window.sessionSearch.getAppUpdateStatus(true));
    } catch (error) {
      setAppUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function installAppUpdate(): Promise<void> {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    try {
      await window.sessionSearch.installAppUpdate();
    } catch (error) {
      setAppUpdateError(error instanceof Error ? error.message : String(error));
      setAppUpdateBusy(false);
    }
  }

  async function skipAppUpdate(untilNextVersion: boolean): Promise<void> {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    try {
      setAppUpdateStatus(await window.sessionSearch.skipAppUpdate(untilNextVersion));
    } catch (error) {
      setAppUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function updateSettings(next: AppSettingsUpdate): Promise<void> {
    const newlyEnabledSources = OPTIONAL_SOURCE_SETTINGS.filter((item) => next[item.key] === true && !appSettings?.[item.key]);
    const quotaVisibilityChanged =
      ("hideCodexQuota" in next && next.hideCodexQuota !== appSettings?.hideCodexQuota) ||
      ("hideClaudeQuota" in next && next.hideClaudeQuota !== appSettings?.hideClaudeQuota);
    setSettingsFeedback({ kind: "running", message: t("Saving settings...", "正在保存设置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings(next);
      setAppSettings(nextSettings);
      if ("remoteSyncEnabled" in next) {
        setSessionHookStatus(await window.sessionSearch.getSessionSyncHookStatus());
      }
      if (quotaVisibilityChanged) void loadQuotas();

      if (newlyEnabledSources.length > 0) {
        // Keep the toggle responsive: scan optional sources in the background
        // and only reveal their sidebar filters once that scan finishes.
        setPendingPersonalSources((current) => {
          const pending = { ...current };
          for (const item of newlyEnabledSources) pending[item.pendingKey] = true;
          return pending;
        });
        setSettingsFeedback({ kind: "success", message: t("Loading sessions in the background...", "正在后台加载会话...") });
        void window.sessionSearch
          .refreshIndex()
          .then(async () => {
            setPendingPersonalSources((current) => {
              const pending = { ...current };
              for (const item of newlyEnabledSources) pending[item.pendingKey] = false;
              return pending;
            });
            await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
            setSettingsFeedback({ kind: "success", message: t("Sources ready.", "来源已就绪。") });
            window.setTimeout(() => {
              setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
            }, 1600);
          })
          .catch((error) => {
            setPendingPersonalSources((current) => {
              const pending = { ...current };
              for (const item of newlyEnabledSources) pending[item.pendingKey] = false;
              return pending;
            });
            setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
      setSettingsFeedback({ kind: "success", message: t("Settings saved.", "设置已保存。") });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
      }, 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function reloadEnvironmentData(): Promise<void> {
    setEnvironments(await window.sessionSearch.listEnvironments());
    await load();
  }

  async function refreshEnvironment(environment: SessionEnvironment): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t(`Refreshing ${environment.label}...`, `正在刷新 ${environment.label}...`) });
    try {
      await window.sessionSearch.refreshEnvironment(environment.id);
      await reloadEnvironmentData();
      const message = t(`${environment.label} refreshed.`, `${environment.label} 已刷新。`);
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 1800);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function diagnoseEnvironment(environment: SessionEnvironment): Promise<void> {
    if (environment.kind !== "ssh") return;
    setDiagnosingEnvironmentId(environment.id);
    setSettingsFeedback({ kind: "running", message: t(`Checking ${environment.label}...`, `正在检查 ${environment.label}...`) });
    try {
      const report = await window.sessionSearch.diagnoseEnvironment(environment.id);
      setEnvironmentHealthReports((current) => ({ ...current, [environment.id]: report }));
      setSettingsFeedback({ kind: report.ok ? "success" : "error", message: report.summary });
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiagnosingEnvironmentId((current) => (current === environment.id ? null : current));
    }
  }

  async function deleteEnvironment(environment: SessionEnvironment): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t(`Deleting ${environment.label}...`, `正在删除 ${environment.label}...`) });
    try {
      await window.sessionSearch.deleteEnvironment(environment.id);
      setEnvironmentHealthReports((current) => {
        const next = { ...current };
        delete next[environment.id];
        return next;
      });
      if (environmentId === environment.id) setEnvironmentId("all");
      if (projectEnvironmentId === environment.id) clearProjectFilter();
      await reloadEnvironmentData();
      const message = t(`${environment.label} deleted.`, `${environment.label} 已删除。`);
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 1800);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function saveSshEnvironment(input: EnvironmentUpsertInput): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t("Saving SSH environment...", "正在保存 SSH 环境...") });
    try {
      await window.sessionSearch.saveEnvironment(input);
      await reloadEnvironmentData();
      const message = t("SSH environment saved.", "SSH 环境已保存。");
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 1800);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function applyApiConfigToCodex(apiConfig: ApiConfig): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t("Applying Codex profile...", "正在应用 Codex 配置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings({ apiConfig });
      setAppSettings(nextSettings);
      const result = await window.sessionSearch.applyCodexProfile(apiConfig);
      const profileLabel = result.profile === "codex" ? "Codex Official" : apiConfig.customProviderName.trim() || "CodexZH";
      const usesLocalProxy = apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
      const successMessage = usesLocalProxy
        ? t(`Applied ${profileLabel} to ~/.codex via local proxy.`, `已通过本地 proxy 将 ${profileLabel} 应用到 ~/.codex。`)
        : t(`Applied ${profileLabel} to ~/.codex.`, `已将 ${profileLabel} 应用到 ~/.codex。`);
      setSettingsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 2200);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function applyApiConfigToClaude(claudeApiConfig: ClaudeApiConfig): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t("Applying Claude Code profile...", "正在应用 Claude Code 配置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings({ claudeApiConfig });
      setAppSettings(nextSettings);
      const result = await window.sessionSearch.applyClaudeProfile(claudeApiConfig);
      const profileLabel =
        result.profile === "claude-official" ? "Claude Official" : claudeApiConfig.customProviderName.trim() || "Claude Code";
      const successMessage = t(`Applied ${profileLabel} to ~/.claude.`, `已将 ${profileLabel} 应用到 ~/.claude。`);
      setSettingsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 2200);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Stable callbacks for SessionRow so the memoized rows don't re-render on every
  // App render (e.g. when a search commits). The latest closures are read via a
  // ref so the callbacks can stay referentially stable without going stale.
  const rowHandlersRef = useRef({ openDetail, beginRename, toggleFavorite });
  rowHandlersRef.current = { openDetail, beginRename, toggleFavorite };
  const handleRowSelect = useCallback((sessionKey: string) => setSelectedKey(sessionKey), []);
  const handleRowOpen = useCallback((session: SessionSearchResult) => void rowHandlersRef.current.openDetail(session), []);
  const handleRowOpenMatch = useCallback(
    (session: SessionSearchResult, hit: SessionMatchHit) => void rowHandlersRef.current.openDetail(session, hit),
    [],
  );
  const handleRowRename = useCallback((session: SessionSearchResult) => rowHandlersRef.current.beginRename(session), []);
  const handleRowFavorite = useCallback((session: SessionSearchResult) => void rowHandlersRef.current.toggleFavorite(session), []);
  const handleRowContextMenu = useCallback((event: ReactMouseEvent, session: SessionSearchResult) => {
    event.preventDefault();
    setSelectedKey(session.sessionKey);
    setContextMenu({ x: event.clientX, y: event.clientY, session });
  }, []);

  return (
    <main className="app" data-theme={theme} data-platform={RUNTIME_PLATFORM} onClick={() => setContextMenu(null)}>
      <div className="titlebar-drag" />
      <AppNavigation
        activePage={activePage}
        indexStatus={indexStatus}
        settingsOpen={settingsOpen}
        signalUpdate={shouldSignalAppUpdate}
        language={language}
        onNavigate={(page) => void navigateToPage(page)}
        onRefresh={() => void refreshNow()}
        onOpenSettings={() => {
          setSettingsInitialSection(shouldSignalAppUpdate ? "about" : "terminal");
          setSettingsOpen(true);
        }}
      />

      <section className="app-workspace">
        <div className="app-page-host">
          {activePage === "workbench" ? (
            <WorkbenchPage
              stats={stats}
              statsPeriod={statsPeriod}
              statsRefreshing={statsRefreshing}
              statsFeedback={statsFeedback}
              quotas={quotas}
              quotaLoading={quotaLoading}
              quotaFeedback={quotaFeedback}
              sessions={workbenchSessions}
              sessionQuery={workbenchQuery}
              liveSessionKeys={liveSessionKeys}
              liveDetectionFailed={liveDetectionFailed}
              platform={RUNTIME_PLATFORM}
              language={language}
              onStatsPeriodChange={setStatsPeriod}
              onRefreshStats={() => void refreshStats()}
              onRefreshQuotas={() => void loadQuotas("manual")}
              onOpenSettings={() => { setSettingsInitialSection("usage"); setSettingsOpen(true); }}
              onSearchSessions={setWorkbenchQuery}
              onOpenSession={(session) => void openDetail(session)}
              onResumeSession={(session) => void runAction(resumeActionLabel(session.source, language), () => window.sessionSearch.resumeSession(session.sessionKey), (result) => resumeRouteMessage(result, language))}
              onShowSessions={(submittedQuery) => {
                setQuery(submittedQuery);
                setActivePage("sessions");
                setLiveStatus("all");
              }}
              onSelectTrendDay={(day) => {
                setQuery("");
                setSource("all");
                selectEnvironment("all");
                clearProjectFilter();
                setTag(undefined);
                setVisibility("default");
                setLiveStatus("all");
                setDateRange("all");
                setCustomDateRange({ dayStart: day.dayStart, dayEndExclusive: day.dayEndExclusive });
                setActivePage("sessions");
              }}
              workflows={workbenchWorkflows}
              workflowsLoading={automation.loading}
              workflowsError={automation.error}
              onOpenWorkflow={(workflowId) => {
                void automation.api.selectWorkflow(workflowId).then((next) => {
                  automation.setSnapshot(next);
                  setActivePage("workflows");
                }).catch((error) => setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
              }}
              onNewWorkflow={() => {
                void automation.api.createWorkflowDraft().then((next) => {
                  automation.setSnapshot(next);
                  setActivePage("workflows");
                }).catch((error) => setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
              }}
              onShowWorkflows={() => void navigateToPage("workflows")}
            />
          ) : null}

          {activePage === "sessions" ? (
            <SessionsPage
              model={{
                language,
                indexStatus,
                sessionTotalCount,
                sidebarSections,
                environmentId,
                projectPath,
                projectEnvironmentId,
                tag,
                sidebarTree,
                collapsedProjectGroups,
                expandedTreeProjects: collapsedTreeProjects,
                source,
                sourceFilters: visibleSourceFilters,
                visibility,
                searchRef,
                searchPlaceholder,
                query,
                activeScopeFilters,
                liveStatus,
                customDateRange,
                dateRange,
                aiAssistantOpen,
                remoteSessionsOpen,
                selected,
                sessions: displayedResults,
                hasMoreSessions,
                pageSize: SESSION_PAGE_SIZE,
                liveSessionKeys,
                liveDetectionFailed,
              }}
              actions={{
                refresh: () => void refreshNow(),
                toggleSidebarSection: toggleSidebarSectionById,
                selectAllSessions: () => {
                  selectEnvironment("all");
                  clearProjectFilter();
                  setTag(undefined);
                },
                toggleEnvironment: toggleProjectGroup,
                selectEnvironment: (nextEnvironmentId) => {
                  selectEnvironment(nextEnvironmentId);
                  clearProjectFilter();
                  setTag(undefined);
                },
                toggleProject: toggleTreeProject,
                selectProject,
                toggleProjectTag: (project, tagName) => {
                  const isActive = tag === tagName
                    && projectPath === project.path
                    && projectEnvironmentId === project.environmentId;
                  if (isActive) {
                    setTag(undefined);
                    return;
                  }
                  selectProject(project);
                  setTag(tagName);
                },
                deleteTag: setDeleteTagName,
                setSource,
                setVisibility,
                search: setQuery,
                setLiveStatus,
                clearCustomDateRange: () => setCustomDateRange(null),
                setDateRange: (nextRange) => {
                  setCustomDateRange(null);
                  setDateRange(nextRange);
                },
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
                loadMore,
              }}
            />
          ) : null}
          <Suspense
            fallback={(
              <div className="app-page-loading" role="status">
                {t("Loading feature...", "正在加载功能...")}
              </div>
            )}
          >
            {activePage === "skills" ? (
              <SkillsPage
                snapshot={skills.snapshot}
                syncSnapshot={skills.syncSnapshot}
                loading={skills.loading}
                feedback={skills.feedback}
                language={language}
                revealLabel={FILE_MANAGER_LABEL}
                onRefresh={() => void skills.load({ refreshUsage: true })}
                onUpload={(skill, force) => skills.upload(skill, force)}
                onUploadSelected={(selectedSkills) => skills.uploadSelected(selectedSkills)}
                onInstallRemote={(remoteSkillId) => skills.installRemote(remoteSkillId)}
                onFetchVersion={(remoteSkillId) => skills.fetchVersion(remoteSkillId)}
                onRefreshRemote={() => void skills.load({ silent: true })}
                onCopySetupSql={() => void skills.copySetupSql()}
                onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("skills")}
                onCopyPath={(skillPath) =>
                  void runUtilityAction(t("Copying skill path", "正在复制 Skill 路径"), () => window.sessionSearch.copySkillPath(skillPath), t("Skill path copied.", "Skill 路径已复制。"))
                }
                onReveal={(skillPath) =>
                  void runUtilityAction(`Opening ${FILE_MANAGER_LABEL}`, () => window.sessionSearch.revealSkill(skillPath), `${FILE_MANAGER_LABEL} opened.`)
                }
                onDelete={(skill) => skills.deleteSkill(skill)}
              />
            ) : null}

            {activePage === "workflows" ? <WorkflowFeaturePage language={language} /> : null}

            {activePage === "team-chat" ? <TeamChatPage language={language} /> : null}

            {activePage === "evaluation" ? (
              <EvaluationFeaturePage language={language} onNavigationGuardChange={setPageNavigationGuard} />
            ) : null}

            {activePage === "runtimes" ? (
              <RuntimeFeaturePage language={language} onNavigationGuardChange={setPageNavigationGuard} />
            ) : null}

            {activePage === "mcp" ? <McpFeaturePage language={language} /> : null}

            {activePage === "memories" ? <AgentMemoryPage language={language} /> : null}

            {activePage === "providers" ? (
              <ProviderPage
                settings={appSettings}
                language={language}
                feedback={settingsFeedback}
                onSettingsChange={(next) => void updateSettings(next)}
                onApplyToCodex={(apiConfig) => void applyApiConfigToCodex(apiConfig)}
                onApplyToClaude={(claudeApiConfig) => void applyApiConfigToClaude(claudeApiConfig)}
              />
            ) : null}
          </Suspense>
        </div>
      </section>

      <SessionDetails
        detail={detail}
        remoteDetail={remoteDetail}
        turns={detailTurns}
        turnsLoading={turnsLoading}
        matchedTurnId={matchedTurnId}
        actionStatus={actionStatus}
        query={query}
        liveState={detail
          ? getLiveSessionState(detail, liveSessionKeys, liveDetectionFailed)
          : "closed"}
        language={language}
        revealLabel={FILE_MANAGER_LABEL}
        showItermAction={IS_MAC}
        summarizing={summarizing}
        actions={{
          loadTurn: (session, turnId) =>
            window.sessionSearch.getSessionTurn(session.sessionKey, turnId),
          closeLocal: closeDetail,
          closeRemote: closeRemoteDetail,
          rename: beginRename,
          addTag: beginAddTag,
          removeTag: (session, tagName) => void removeTag(session, tagName),
          toggleFavorite: (session) => void toggleFavorite(session),
          summarize: (session) => void summarizeDetail(session),
          resume: (session) => void runAction(
            resumeActionLabel(session.source, language),
            () => window.sessionSearch.resumeSession(session.sessionKey),
            (result) => resumeRouteMessage(result, language),
          ),
          resumeInIterm: (session) => void runAction(
            t("Opening iTerm", "正在打开 iTerm"),
            () => window.sessionSearch.resumeSessionInIterm(session.sessionKey),
            t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"),
          ),
          migrate: beginMigrate,
          uploadRemote: (session) => void uploadRemoteSession(session),
          copyResume: (session) => void runAction(
            t("Copying resume command", "正在复制 Resume 命令"),
            () => window.sessionSearch.copyResumeCommand(session.sessionKey),
            t("Resume command copied.", "Resume 命令已复制。"),
          ),
          copyMarkdown: (session) => void runAction(
            t("Copying markdown", "正在复制 Markdown"),
            () => window.sessionSearch.copyMarkdown(session.sessionKey),
            t("Markdown copied.", "Markdown 已复制。"),
          ),
          exportMarkdown: (session) => void exportMarkdown(session.sessionKey),
          exportJson: (session) => void exportJson(session.sessionKey),
          copyPlain: (session) => void runAction(
            t("Copying plain text", "正在复制纯文本"),
            () => window.sessionSearch.copyPlainText(session.sessionKey),
            t("Plain text copied.", "纯文本已复制。"),
          ),
          deleteSession: requestDeleteSession,
          reveal: (session) => void runAction(
            `Opening ${FILE_MANAGER_LABEL}`,
            () => window.sessionSearch.revealSession(session.sessionKey),
            `${FILE_MANAGER_LABEL} opened.`,
          ),
        }}
      />
      {contextMenu ? (
        <SessionContextMenu
          state={contextMenu}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          showMacActions={IS_MAC}
          canResume={supportsResumeSource(contextMenu.session.source)}
          canMigrate={!isRemoteSession(contextMenu.session) && supportsMigrationSource(contextMenu.session.source)}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onFavorite={() =>
            void runAction(
              contextMenu.session.favorited ? t("Removing favorite", "正在取消收藏") : t("Adding favorite", "正在加入收藏"),
              () => window.sessionSearch.setFavorited(contextMenu.session.sessionKey, !contextMenu.session.favorited),
              contextMenu.session.favorited ? t("Removed from favorites.", "已取消收藏。") : t("Added to favorites.", "已加入收藏。"),
            )
          }
          onPin={() =>
            void runAction(t("Updating pin", "正在更新置顶"), () => window.sessionSearch.setPinned(contextMenu.session.sessionKey, !contextMenu.session.pinned), t("Pin updated.", "置顶已更新。"))
          }
          onHide={() =>
            void runAction(
              t("Updating visibility", "正在更新可见性"),
              () => window.sessionSearch.setHidden(contextMenu.session.sessionKey, !contextMenu.session.hidden),
              t("Visibility updated.", "可见性已更新。"),
            )
          }
          onResume={() =>
            void runAction(resumeActionLabel(contextMenu.session.source, language), () => window.sessionSearch.resumeSession(contextMenu.session.sessionKey), (result) => resumeRouteMessage(result, language))
          }
          onResumeIterm={() =>
            void runAction(t("Opening iTerm", "正在打开 iTerm"), () => window.sessionSearch.resumeSessionInIterm(contextMenu.session.sessionKey), t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"))
          }
          onOpenApp={() =>
            void runAction(
              contextMenu.session.source === "codex-app" ? resumeActionLabel("codex-app", language) : t("Opening native app", "正在打开原生应用"),
              () => window.sessionSearch.openNativeApp(contextMenu.session.sessionKey),
              contextMenu.session.source === "codex-app" ? resumeRouteMessage({ route: "app" }, language) : t("Native app opened.", "原生应用已打开。"),
            )
          }
          onMigrate={() => beginMigrate(contextMenu.session)}
          onCopyResume={() =>
            void runAction(t("Copying resume command", "正在复制 Resume 命令"), () => window.sessionSearch.copyResumeCommand(contextMenu.session.sessionKey), t("Resume command copied.", "Resume 命令已复制。"))
          }
          onCopyMarkdown={() =>
            void runAction(t("Copying markdown", "正在复制 Markdown"), () => window.sessionSearch.copyMarkdown(contextMenu.session.sessionKey), t("Markdown copied.", "Markdown 已复制。"))
          }
          onExportMarkdown={() => void exportMarkdown(contextMenu.session.sessionKey)}
          onExportJson={() => void exportJson(contextMenu.session.sessionKey)}
          onDelete={() => requestDeleteSession(contextMenu.session)}
          onReveal={() =>
            void runAction(
              `Opening ${FILE_MANAGER_LABEL}`,
              () => window.sessionSearch.revealSession(contextMenu.session.sessionKey),
              `${FILE_MANAGER_LABEL} opened.`,
            )
          }
        />
      ) : null}

      {migrationDialog?.kind === "select" ? (
        <SessionMigrationDialog
          session={migrationDialog.session}
          targets={migrationTargetsForSession(migrationDialog.session, appSettings ?? DEFAULT_MIGRATION_TARGET_SETTINGS)}
          language={language}
          busy={actionStatus?.kind === "running"}
          progress={migrationProgress}
          onSelect={(target) => void runMigration(target)}
          onClose={() => setMigrationDialog(null)}
        />
      ) : null}

      {migrationDialog?.kind === "launch-failed" ? (
        <SessionMigrationLaunchFailedDialog
          session={migrationDialog.session}
          result={migrationDialog.result}
          language={language}
          onClose={() => setMigrationDialog(null)}
        />
      ) : null}

      {actionStatus
        ? <ActionToast status={actionStatus} onClose={() => setActionStatus(null)} />
        : refreshFeedback
          ? <ActionToast status={refreshFeedback} onClose={() => setRefreshFeedback(null)} />
          : null}

      {dialog ? (
        <CommandDialog
          dialog={dialog}
          tags={tags}
          language={language}
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={(value) => void submitDialog(value)}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {deleteTagName ? (
        <DeleteTagDialog
          tagName={deleteTagName}
          language={language}
          onConfirm={() => void deleteTagGlobally(deleteTagName)}
          onCancel={() => setDeleteTagName(null)}
        />
      ) : null}

      {deleteSessionCandidate ? (
        <DeleteSessionDialog
          session={deleteSessionCandidate}
          language={language}
          deleting={deletingSession}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (!deletingSession) setDeleteSessionCandidate(null);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          platform={RUNTIME_PLATFORM}
          initialSection={settingsInitialSection}
          settings={appSettings}
          appUpdateStatus={appUpdateStatus}
          appUpdateBusy={appUpdateBusy}
          appUpdateError={appUpdateError}
          environments={environments}
          environmentHealthReports={environmentHealthReports}
          diagnosingEnvironmentId={diagnosingEnvironmentId}
          theme={theme}
          language={language}
          feedback={settingsFeedback}
          onSettingsChange={(next) => void updateSettings(next)}
          onCheckAppUpdate={() => void checkAppUpdate()}
          onInstallAppUpdate={() => void installAppUpdate()}
          onSkipAppUpdate={(untilNextVersion) => void skipAppUpdate(untilNextVersion)}
          onThemeChange={setTheme}
          onLanguageChange={setLanguage}
          onDefaultTerminalChange={(terminal) => void updateDefaultTerminal(terminal)}
          onGlobalShortcutChange={(shortcut) => void updateGlobalShortcut(shortcut)}
          skillHookInstalled={skillHookInstalled}
          skillHookBusy={skillHookBusy}
          onSkillHookChange={(enabled) => void toggleSkillUsageHook(enabled)}
          sessionHookStatus={sessionHookStatus}
          sessionHookBusy={sessionHookBusy}
          onSessionHookChange={(enabled) => void toggleSessionSyncHook(enabled)}
          onRefreshEnvironment={(environment) => void refreshEnvironment(environment)}
          onDiagnoseEnvironment={(environment) => void diagnoseEnvironment(environment)}
          onDeleteEnvironment={(environment) => void deleteEnvironment(environment)}
          onAddSsh={() => setSshDialogOpen(true)}
          onOpenApiConfig={() => {
            setSettingsOpen(false);
            void navigateToPage("providers");
          }}
          onOpenRemoteSessions={() => {
            setSettingsOpen(false);
            setRemoteSessionsOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {sshDialogOpen ? (
        <SshEnvironmentDialog
          environments={environments}
          language={language}
          feedback={settingsFeedback}
          onSaveEnvironment={(input) => saveSshEnvironment(input)}
          onClose={() => setSshDialogOpen(false)}
        />
      ) : null}

      {remoteSessionsOpen ? (
        <RemoteSessionsDialog
          cache={remoteSessions.cache}
          language={language}
          onRefresh={remoteSessions.load}
          onRemoteSessionUploaded={remoteSessions.recordUpload}
          onRemoteSessionsDeleted={remoteSessions.recordDeletion}
          onRestored={(result) => {
            if (!result.launched) setActionStatus({ kind: "error", message: result.warning || result.resumeCommand });
            void Promise.all([load(), loadSidebarMetadata()]);
          }}
          onOpenDetail={openRemoteDetail}
          onClose={() => setRemoteSessionsOpen(false)}
        />
      ) : null}

      {aiAssistantOpen ? (
        <AiAssistantDialog
          language={language}
          onOpenSession={(session) => {
            setAiAssistantOpen(false);
            void openDetail(session);
          }}
          onClose={() => setAiAssistantOpen(false)}
        />
      ) : null}
    </main>
  );
}
