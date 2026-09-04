import {
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
import type { AppUpdateProgress, AppUpdateStatus } from "../../core/app-update-types";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { MigrationTargetSettings } from "../../core/migration-targets";
import type { McpServerDefinition } from "../../automation/contracts";
import type { InstalledSkill } from "../../core/skill-manager";
import type { OpenVikingMemorySnapshot } from "../../core/openviking-memory";
import type { RemoteHealthReport } from "../../core/remote-health";
import { isLocalSessionEnvironment } from "../../core/session-environment";
import type { SessionSyncHookStatus } from "../../core/session-sync-queue";
import type { V1ImportResult } from "../../core/v1-import";
import type { WorkflowWorkbenchSnapshot } from "../../shared/ipc/automation";
import {
  isSessionDeleteConfirmationRequiredMessage,
  isSessionDeleteLiveCheckConfirmationRequiredMessage,
  liveSessionDeleteKey,
  type SessionBulkDeletePreview,
  type SessionBulkDeleteRequest,
} from "../../core/session-bulk-delete";
import type { TeamChatRoomSummary } from "../../shared/team-chat";
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
  SessionTurnSummary,
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
import {
  MESSAGE_FONT_SIZE_STORAGE_KEY,
  applyMessageFontSize,
  readInitialMessageFontSize,
  type MessageFontSizeScale,
} from "./message-font-size";
import { coalesceIndexStatusForRender } from "./index-status";
import { reduceIndexFeedback } from "./index-status-feedback";
import { createLatestTaskQueue } from "./latest-task-queue";
import type {
  ActionStatus,
  ContextMenuState,
  DialogState,
  RefreshFeedback,
  SettingsFeedback,
  SessionMigrationDialogState,
} from "./app-types";
import { SessionMigrationDialog, SessionMigrationLaunchFailedDialog } from "./components/session-migration-dialog";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "./components/session-dialogs";
import { AppNavigation, type AppPage } from "./components/app-navigation";
import { ActionToast } from "./components/action-toast";
import { useSkillsController } from "./features/skills/use-skills-controller";
import { AiAssistantDialog } from "./components/ai-assistant-dialog";
import { RemoteSessionsDialog } from "./features/remote-sessions/remote-sessions-dialog";
import { useRemoteSessionsCache } from "./features/remote-sessions/use-remote-sessions-cache";
import { environmentTarget } from "./features/environments/environment-display";
import { SessionsPage } from "./features/sessions/sessions-page";
import { SessionContextMenu } from "./features/sessions/session-context-menu";
import { SessionDetails } from "./features/sessions/session-details";
import {
  migrationProgressMessage,
  migrationStrategyLabel,
} from "./features/sessions/session-migration-copy";
import { useSessionCatalog } from "./features/sessions/use-session-catalog";
import { useSessionDetail } from "./features/sessions/use-session-detail";
import { useMainSearchShortcut } from "./features/search/use-main-search-shortcut";
import { SettingsDialog, type SettingsSection } from "./features/settings/settings-dialog";
import { SshEnvironmentDialog } from "./features/settings/ssh-environment-dialog";
import { WslEnvironmentDialog } from "./features/settings/wsl-environment-dialog";
import { WorkbenchPage } from "./features/workbench/workbench-page";
import { useWorkbenchOverview } from "./features/workbench/use-workbench-overview";
import { useAutomation } from "./features/automation/automation-provider";
import type { WorkflowInitialRequest } from "./features/automation/workflow-feature-page";
import {
  canMigrateSession,
  isSidebarProjectVisible,
  isBranchTag,
  displayTagName,
  resumeActionLabel,
  resumeRouteMessage,
  sourceFilters,
  supportsOpenAppSource,
  supportsResumeSource,
  migrationAgentLabel,
  migrationTargetsForSession,
} from "./session-ui";

const RUNTIME_PLATFORM: NodeJS.Platform = window.sessionSearch.platform;
const IS_MAC = RUNTIME_PLATFORM === "darwin";
const FILE_MANAGER_LABEL = IS_MAC ? "Finder" : RUNTIME_PLATFORM === "win32" ? "Explorer" : "File Manager";

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const SkillsPage = lazy(() =>
  import("./features/skills/skills-page").then((module) => ({ default: module.SkillsPage })));
const WorkflowFeaturePage = lazy(() =>
  import("./features/automation/workflow-feature-page").then((module) => ({ default: module.WorkflowFeaturePage })));
const TeamChatPage = lazy(() =>
  import("./features/team-chat/team-chat-page").then((module) => ({ default: module.TeamChatPage })));
const EvaluationFeaturePage = lazy(() =>
  import("./features/eval/eval-page").then((module) => ({ default: module.EvalPage })));
const RuntimeFeaturePage = lazy(() =>
  import("./features/automation/runtime-feature-page").then((module) => ({ default: module.RuntimeFeaturePage })));
const McpFeaturePage = lazy(() =>
  import("./features/automation/mcp-feature-page").then((module) => ({ default: module.McpFeaturePage })));
const OpenVikingMemoryPage = lazy(() =>
  import("./features/openviking-memory/openviking-memory-page").then((module) => ({
    default: module.OpenVikingMemoryPage,
  })));
const ProviderPage = lazy(() =>
  import("./features/providers/provider-page").then((module) => ({ default: module.ProviderPage })));

const DEFAULT_MIGRATION_TARGET_SETTINGS = {
  includeTclaude: false,
  includeTcodex: false,
} satisfies MigrationTargetSettings;

type PendingSourceKey = (typeof OPTIONAL_SESSION_SOURCE_DESCRIPTORS)[number]["pendingKey"];

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  pendingKey: descriptor.pendingKey,
  filter: descriptor.optionalSetting === "includeStepcode" ? "stepcode" : descriptor.id,
}));
const OPTIONAL_SOURCE_REFRESH_SETTLE_MS = 120;

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
  const [messageFontSize, setMessageFontSize] = useState<MessageFontSizeScale>(() => readInitialMessageFontSize());
  const skills = useSkillsController(language);
  const remoteSessions = useRemoteSessionsCache();
  const [activePage, setActivePage] = useState<AppPage>("workbench");
  const pageNavigationVersionRef = useRef(0);
  useLayoutEffect(() => {
    pageNavigationVersionRef.current += 1;
  }, [activePage]);
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
  const [workbenchWorkflowSnapshot, setWorkbenchWorkflowSnapshot] = useState<WorkflowWorkbenchSnapshot | null>(null);
  const [workbenchWorkflowError, setWorkbenchWorkflowError] = useState<string | null>(null);
  const [workflowInitialRequest, setWorkflowInitialRequest] = useState<WorkflowInitialRequest>();
  const [workbenchMcpServers, setWorkbenchMcpServers] = useState<McpServerDefinition[] | null>(null);
  const [workbenchChatRooms, setWorkbenchChatRooms] = useState<TeamChatRoomSummary[] | null>(null);
  const [workbenchMemorySnapshot, setWorkbenchMemorySnapshot] = useState<OpenVikingMemorySnapshot | null>(null);
  const [workbenchMemoryLoading, setWorkbenchMemoryLoading] = useState(true);
  const [workbenchSkills, setWorkbenchSkills] = useState<InstalledSkill[] | null>(null);
  const [preferredTeamChatRoomId, setPreferredTeamChatRoomId] = useState<string>();
  const [preferredTeamChatMessageId, setPreferredTeamChatMessageId] = useState<string>();
  const [preferredTeamChatAgentId, setPreferredTeamChatAgentId] = useState<string>();
  const [preferredEvaluationRunId, setPreferredEvaluationRunId] = useState<string>();
  const [preferredEvaluationCaseId, setPreferredEvaluationCaseId] = useState<string>();
  const [preferredEvaluationEvaluatorId, setPreferredEvaluationEvaluatorId] = useState<string>();
  const [preferredRuntimeChannelId, setPreferredRuntimeChannelId] = useState<string>();
  const [preferredRuntimeAgentId, setPreferredRuntimeAgentId] = useState<string>();
  const [openSkillDiscoveryFromSession, setOpenSkillDiscoveryFromSession] = useState(false);
  useEffect(() => {
    if (activePage !== "workbench") return;
    let active = true;
    const timers: number[] = [];
    setWorkbenchMcpServers(null);
    setWorkbenchChatRooms(null);
    setWorkbenchMemorySnapshot(null);
    setWorkbenchMemoryLoading(true);
    setWorkbenchSkills(null);
    setWorkbenchWorkflowSnapshot(null);
    setWorkbenchWorkflowError(null);
    const tasks: Array<() => Promise<void>> = [
      async () => {
        try {
          const snapshot = await automation.api.getWorkflowWorkbench();
          if (active) setWorkbenchWorkflowSnapshot(snapshot);
        } catch (error) {
          if (active) {
            setWorkbenchWorkflowSnapshot({ workflows: [], totalCount: 0, activeCount: 0 });
            setWorkbenchWorkflowError(error instanceof Error ? error.message : String(error));
          }
        }
      },
      async () => {
        try {
          const servers = await automation.api.listMcpServers();
          if (active) setWorkbenchMcpServers(servers);
        } catch {
          if (active) setWorkbenchMcpServers([]);
        }
      },
      async () => {
        try {
          const rooms = await window.sessionSearch.teamChat.listRooms();
          if (active) setWorkbenchChatRooms(rooms);
        } catch {
          if (active) setWorkbenchChatRooms([]);
        }
      },
      async () => {
        try {
          const snapshot = await window.sessionSearch.getOpenVikingMemorySnapshot();
          if (active) setWorkbenchMemorySnapshot(snapshot);
        } catch {
          if (active) setWorkbenchMemorySnapshot(null);
        } finally {
          if (active) setWorkbenchMemoryLoading(false);
        }
      },
      async () => {
        try {
          const snapshot = await window.sessionSearch.listSkills();
          if (active) setWorkbenchSkills(snapshot.skills);
        } catch {
          if (active) setWorkbenchSkills([]);
        }
      },
    ];
    const frameId = window.requestAnimationFrame(() => {
      tasks.forEach((task, index) => {
        timers.push(window.setTimeout(() => {
          if (active) void task();
        }, index * 50));
      });
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(frameId);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [activePage, automation.api]);
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
    statsOrigin,
    setStatsOrigin,
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
    origin,
    setOrigin,
    originCounts,
    invocationSurface,
    setInvocationSurface,
    invocationSurfaceCounts,
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
    sortBy,
    setSortBy,
    liveStatus,
    setLiveStatus,
    sessionTotalCount,
    displayedResults,
    selectedKey,
    setSelectedKey,
    selected,
    searchRef,
    liveSessionKeys,
    liveDetectionFailed,
    load,
    currentPage,
    totalPages,
    goToPage,
    searchAllMatching,
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
  const migrationDialogRef = useRef<SessionMigrationDialogState>(null);
  const [migrationProgress, setMigrationProgress] = useState<SessionMigrationProgress | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<SessionSearchResult | null>(null);
  const [deleteSessionCascadeCount, setDeleteSessionCascadeCount] = useState<number | null>(null);
  const [deleteSessionHasLiveSession, setDeleteSessionHasLiveSession] = useState(false);
  const [deleteSessionLiveCheckFailed, setDeleteSessionLiveCheckFailed] = useState(false);
  const [deleteSessionConfirmationFingerprint, setDeleteSessionConfirmationFingerprint] = useState<string>();
  const [deleteSessionConfirmationVersion, setDeleteSessionConfirmationVersion] = useState(0);
  const [deleteSessionBlockedMessage, setDeleteSessionBlockedMessage] = useState<string | null>(null);
  const deleteSessionPreviewId = useRef(0);
  const [deletingSession, setDeletingSession] = useState(false);
  const [bulkSelectedKeys, setBulkSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkSelectionActive, setBulkSelectionActive] = useState(false);
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState<{
    mode: "selection" | "cleanup" | "orphans";
    dateValue: string;
    request: SessionBulkDeleteRequest | null;
    preview: SessionBulkDeletePreview | null;
    favoriteCount: number;
  } | null>(null);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const openWorkflows = useCallback(async (initialRequest?: WorkflowInitialRequest): Promise<void> => {
    const navigationVersion = pageNavigationVersionRef.current;
    setWorkflowInitialRequest(undefined);
    try {
      await automation.ensureDetailsLoaded();
      if (pageNavigationVersionRef.current !== navigationVersion) return;
      setWorkflowInitialRequest(initialRequest);
      if (!(await navigateToPage("workflows"))) setWorkflowInitialRequest(undefined);
    } catch (error) {
      if (pageNavigationVersionRef.current !== navigationVersion) return;
      setActionStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [automation.ensureDetailsLoaded, navigateToPage]);
  const [summarizing, setSummarizing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("terminal");
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [appUpdateProgress, setAppUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const indexStatusEventVersionRef = useRef(0);
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [wslDialogOpen, setWslDialogOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [evalPreselectedSkill, setEvalPreselectedSkill] = useState<string | null>(null);
  const [evalFindingCounts, setEvalFindingCounts] = useState<{ skill: string; low: number; medium: number }[]>([]);

  useEffect(() => {
    if (!appSettings?.evalEnabled) {
      setEvalFindingCounts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const counts = await window.sessionSearch.getSkillEvalFindingCounts();
        if (!cancelled) setEvalFindingCounts(counts);
      } catch {
        // Eval is opt-in; failures here are non-fatal.
      }
    })();
    return () => { cancelled = true; };
  }, [appSettings?.evalEnabled, skills.snapshot]);
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedback>(null);
  const [sessionFamilyRefreshVersion, setSessionFamilyRefreshVersion] = useState(0);
  const [environmentHealthReports, setEnvironmentHealthReports] = useState<Record<string, RemoteHealthReport>>({});
  const [diagnosingEnvironmentId, setDiagnosingEnvironmentId] = useState<string | null>(null);
  const [sessionHookStatus, setSessionHookStatus] = useState<SessionSyncHookStatus | null>(null);
  const [sessionHookBusy, setSessionHookBusy] = useState(false);
  const [pendingPersonalSources, setPendingPersonalSources] = useState<Record<PendingSourceKey, boolean>>(
    emptyPendingPersonalSources,
  );
  const metadataLoadSeqRef = useRef(0);
  const appSettingsRef = useRef<AppSettings | null>(null);
  const settingsUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const optionalSourceRefreshGenerationRef = useRef(0);
  const optionalSourceIndexRefreshKeysRef = useRef(new Set<PendingSourceKey>());
  const [optionalSourceRefreshQueue] = useState(() =>
    createLatestTaskQueue<void>({ settleMs: OPTIONAL_SOURCE_REFRESH_SETTLE_MS }));
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  appSettingsRef.current = appSettings;
  migrationDialogRef.current = migrationDialog;
  const continueRemoteSessionsInBackground = useCallback((): void => {
    const message = t(
      "Remote sessions are continuing to load in the background.",
      "已转到后台，远程会话会继续加载。",
    );
    void remoteSessions.ensureLoaded();
    setRemoteSessionsOpen(false);
    setActionStatus({ kind: "success", message });
    window.setTimeout(() => {
      setActionStatus((current) =>
        current?.kind === "success" && current.message === message ? null : current);
    }, 2400);
  }, [remoteSessions.ensureLoaded, t]);
  const reportSessionDetailError = useCallback((error: unknown): void => {
    setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }, []);
  const {
    detail,
    remoteDetail,
    turns: detailTurns,
    turnsLoading,
    matchedTurnId,
    matchedMessageIndex,
    openLocal: openDetail,
    closeLocal: closeDetail,
    openRemote: openRemoteDetail,
    closeRemote: closeRemoteDetail,
    refreshLocal: refreshDetail,
    applyUpdatedLocal: applyUpdatedDetail,
  } = useSessionDetail(reportSessionDetailError);
  useEffect(() => {
    void window.sessionSearch.setOpenSession(detail?.sessionKey);
  }, [detail?.sessionKey]);

  const loadSidebarMetadata = useCallback(async () => {
    const requestId = ++metadataLoadSeqRef.current;
    const [nextTags, nextProjects, nextEnvironments, nextProjectTags] = await Promise.all([
      window.sessionSearch.listTags(),
      window.sessionSearch.listProjects({ origin }),
      window.sessionSearch.listEnvironments(),
      window.sessionSearch.listTagsByProject(),
    ]);
    if (requestId !== metadataLoadSeqRef.current) return;
    setTags(nextTags);
    setProjects(nextProjects);
    setEnvironments(nextEnvironments);
    setProjectTags(nextProjectTags);
  }, [origin]);

  useEffect(() => {
    void loadSidebarMetadata();
  }, [loadSidebarMetadata]);

  useEffect(() => {
    setBulkSelectionActive(false);
    setBulkSelectedKeys(new Set());
  }, [
    query,
    source,
    environmentId,
    tag,
    projectPath,
    projectEnvironmentId,
    visibility,
    dateRange,
    customDateRange,
    sortBy,
    liveStatus,
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
    void window.sessionSearch.getSessionSyncHookStatus().then(setSessionHookStatus).catch(() => setSessionHookStatus(null));
  }, [automation.ensureDetailsLoaded, settingsOpen]);

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

  useLayoutEffect(() => {
    applyMessageFontSize(messageFontSize, (factor) => {
      void window.sessionSearch.setInterfaceZoomFactor(factor);
    });
    window.localStorage.setItem(MESSAGE_FONT_SIZE_STORAGE_KEY, messageFontSize);
  }, [messageFontSize]);

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
    let active = true;
    const snapshotEventVersion = indexStatusEventVersionRef.current;
    const applyIndexStatus = (nextStatus: IndexStatus): void => {
      setIndexStatus((current) => coalesceIndexStatusForRender(current, nextStatus));
      setRefreshFeedback((current) => reduceIndexFeedback(current, { type: "index-status", status: nextStatus }));
    };
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      indexStatusEventVersionRef.current += 1;
      applyIndexStatus(nextStatus);
      if (!nextStatus.running) {
        setSessionFamilyRefreshVersion((current) => current + 1);
        if (activePage === "sessions") void load();
        void loadSidebarMetadata();
        void loadStats();
        void loadWorkbenchSessions();
      }
    });
    void window.sessionSearch.getIndexStatus()
      .then((nextStatus) => {
        if (active && indexStatusEventVersionRef.current === snapshotEventVersion) applyIndexStatus(nextStatus);
      })
      .catch(() => undefined);
    const offFocus = window.sessionSearch.onFocusSearch(() => {
      void navigateToPage("sessions").then((navigated) => {
        if (navigated) window.requestAnimationFrame(() => searchRef.current?.focus());
      });
    });
    const offOpenSession = window.sessionSearch.onOpenSession((sessionKey) => {
      void (async () => {
        if (!(await navigateToPage("sessions"))) return;
        setSelectedKey(sessionKey);
        const session = await window.sessionSearch.getSession(sessionKey);
        if (session) await openDetail(session);
      })().catch(reportSessionDetailError);
    });
    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      setSettingsInitialSection("terminal");
      setSettingsOpen(true);
    });
    const offAppUpdate = window.sessionSearch.onAppUpdateStatus(setAppUpdateStatus);
    const offAppUpdateProgress = window.sessionSearch.onAppUpdateProgress(setAppUpdateProgress);
    const offEnvironments = window.sessionSearch.onEnvironmentsUpdated((nextEnvironments) => {
      setSessionFamilyRefreshVersion((current) => current + 1);
      setEnvironments(nextEnvironments);
      if (activePage === "sessions") void load();
    });
    return () => {
      active = false;
      offIndex();
      offFocus();
      offOpenSession();
      offOpenSettings();
      offAppUpdate();
      offAppUpdateProgress();
      offEnvironments();
    };
  }, [activePage, load, loadSidebarMetadata, loadStats, loadWorkbenchSessions, navigateToPage, openDetail, reportSessionDetailError, setSelectedKey]);

  useEffect(() => {
    void window.sessionSearch.getAppUpdateStatus(false).then(setAppUpdateStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.sessionSearch.onMigrationProgress((progress) => {
      setMigrationProgress(progress);
      setActionStatus({ kind: "running", message: migrationProgressMessage(progress, language) });
    });
  }, [language]);

  const focusMainSearch = useCallback(() => {
    void navigateToPage("sessions").then((navigated) => {
      if (!navigated) return;
      window.requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    });
  }, [navigateToPage, searchRef]);
  useMainSearchShortcut(
    !(detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || bulkDeleteDialog || deleteTagName || contextMenu || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen),
    focusMainSearch,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setContextMenu(null);
        setSettingsInitialSection("terminal");
        setSettingsOpen(true);
        return;
      }

      // Esc backs out of the frontmost layer, one at a time.
      if (event.key === "Escape") {
        if (sshDialogOpen) setSshDialogOpen(false);
        else if (wslDialogOpen) setWslDialogOpen(false);
        else if (migrationDialog) closeMigrationDialog();
        else if (dialog) setDialog(null);
        else if (bulkDeleteDialog) setBulkDeleteDialog(null);
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
      if (detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || bulkDeleteDialog || deleteTagName || contextMenu || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen) return;

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
  }, [displayedResults, selectedKey, detail, remoteDetail, dialog, migrationDialog, deleteSessionCandidate, deletingSession, bulkDeleteDialog, bulkDeleteBusy, deleteTagName, contextMenu, aiAssistantOpen, settingsOpen, sshDialogOpen, wslDialogOpen, remoteSessionsOpen, actionStatus, t]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail || remoteDetail || bulkDeleteDialog || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen));
    return () => document.body.classList.remove("overlay-open");
  }, [detail, remoteDetail, bulkDeleteDialog, aiAssistantOpen, settingsOpen, sshDialogOpen, wslDialogOpen, remoteSessionsOpen]);

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
    const groups = new Map<string, {
      environment: SessionEnvironment | null;
      projects: Array<ProjectSummary & { tags: string[] }>;
      emptyProjects: Array<ProjectSummary & { tags: string[] }>;
    }>();
    for (const project of projects) {
      const environment = environments.find((env) => env.id === project.environmentId) ?? null;
      const key = project.environmentId;
      const projectTagsList = tagMap.get(`${project.environmentId}\0${project.path}`) ?? [];
      const group = groups.get(key);
      const target = isSidebarProjectVisible(project, projectPath, projectEnvironmentId) ? "projects" : "emptyProjects";
      if (group) group[target].push({ ...project, tags: projectTagsList });
      else groups.set(key, {
        environment,
        projects: target === "projects" ? [{ ...project, tags: projectTagsList }] : [],
        emptyProjects: target === "emptyProjects" ? [{ ...project, tags: projectTagsList }] : [],
      });
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
    setDialog({ kind: "rename", session, value: session.customTitle || session.displayTitle, useDefaultTitle: false });
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
      await window.sessionSearch.setCustomTitle(dialog.session.sessionKey, dialog.useDefaultTitle ? null : value || null);
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

  function requestDeleteSession(
    session: SessionSearchResult,
    forceUnverifiedLiveSessionConfirmation = false,
  ): void {
    setContextMenu(null);
    setDeleteSessionCandidate(session);
    setDeleteSessionCascadeCount(null);
    setDeleteSessionHasLiveSession(false);
    setDeleteSessionLiveCheckFailed(forceUnverifiedLiveSessionConfirmation);
    setDeleteSessionConfirmationFingerprint(undefined);
    setDeleteSessionBlockedMessage(null);
    const previewId = ++deleteSessionPreviewId.current;
    setDeleteSessionConfirmationVersion(previewId);
    void freshLiveKeysForBulkDelete()
      .then((liveCheck) => window.sessionSearch.previewBulkDelete({
        sessionKeys: [session.sessionKey],
        ...liveCheck,
        liveSessionCheckFailed:
          forceUnverifiedLiveSessionConfirmation || liveCheck.liveSessionCheckFailed,
        protectFavorites: false,
        openSessionKey: detail?.sessionKey,
      }))
      .then((preview) => {
        if (deleteSessionPreviewId.current !== previewId) return;
        setDeleteSessionCascadeCount(preview.expandedCount);
        setDeleteSessionHasLiveSession(preview.skipped.some((issue) => issue.reason === "live"));
        setDeleteSessionLiveCheckFailed(preview.liveSessionCheckFailed);
        setDeleteSessionConfirmationFingerprint(preview.confirmationFingerprint);
      })
      .catch((error) => {
        if (deleteSessionPreviewId.current === previewId) {
          setDeleteSessionBlockedMessage(error instanceof Error ? error.message : String(error));
        }
      });
  }

  async function confirmDeleteSession(): Promise<void> {
    if (!deleteSessionCandidate || deletingSession || deleteSessionCascadeCount === null || deleteSessionBlockedMessage) return;
    const session = deleteSessionCandidate;
    const isOpen = detail?.sessionKey === session.sessionKey;
    const confirmed = deleteSessionCascadeCount > 1
      || deleteSessionHasLiveSession
      || deleteSessionLiveCheckFailed
      || isOpen;
    setDeletingSession(true);
    setActionStatus({ kind: "running", message: t("Deleting session...", "正在删除会话...") });
    try {
      const removed = await window.sessionSearch.deleteSession(session.sessionKey, confirmed ? {
        confirmed: true,
        allowLiveSessions: deleteSessionHasLiveSession || deleteSessionLiveCheckFailed,
        allowUnverifiedLiveSessions: deleteSessionLiveCheckFailed,
        confirmationFingerprint: deleteSessionConfirmationFingerprint,
      } : undefined);
      setDeleteSessionCandidate(null);
      setDeleteSessionCascadeCount(null);
      setDeleteSessionHasLiveSession(false);
      setDeleteSessionLiveCheckFailed(false);
      setDeleteSessionConfirmationFingerprint(undefined);
      setDeleteSessionBlockedMessage(null);
      if (removed) {
        if (detail?.sessionKey === session.sessionKey) closeDetail();
        setSelectedKey((current) => (current === session.sessionKey ? null : current));
        await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
        const message = session.sourceAvailable === false
          ? t("Cached session deleted.", "会话缓存已删除。")
          : session.source === "zcode-cli"
          ? t("ZCode session deleted from the local database.", "ZCode 会话已从本地数据库删除。")
          : t("Session file deleted.", "会话文件已删除。");
        setActionStatus({ kind: "success", message });
        window.setTimeout(() => {
          setActionStatus((current) => (current?.kind === "success" && current.message === message ? null : current));
        }, 1800);
      } else {
        setActionStatus({ kind: "error", message: t("Session was already deleted.", "会话已经被删除。") });
        await load();
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const liveCheckFailed = isSessionDeleteLiveCheckConfirmationRequiredMessage(rawMessage);
      if (liveCheckFailed || isSessionDeleteConfirmationRequiredMessage(rawMessage)) {
        const message = liveCheckFailed
          ? t(
              "Running sessions could not be verified. Review the updated deletion warning and confirm again.",
              "无法确认会话是否仍在运行，请检查更新后的删除警告并重新确认。",
            )
          : t(
              "The session tree changed. Review the updated deletion warning and confirm again.",
              "会话树状态已变化，请检查更新后的删除警告并重新确认。",
            );
        setActionStatus({ kind: "error", message });
        requestDeleteSession(session, liveCheckFailed);
      } else {
        setActionStatus({ kind: "error", message: rawMessage });
      }
    } finally {
      setDeletingSession(false);
    }
  }

  function toggleBulkSession(sessionKey: string): void {
    setBulkSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }

  function beginBulkSelection(sessionKey: string): void {
    setBulkSelectionActive(true);
    setBulkSelectedKeys((current) => new Set(current).add(sessionKey));
    setContextMenu(null);
  }

  function exitBulkSelection(): void {
    setBulkSelectionActive(false);
    setBulkSelectedKeys(new Set());
  }

  function toggleLoadedSelection(): void {
    setBulkSelectedKeys((current) => {
      const next = new Set(current);
      const allSelected = displayedResults.length > 0 && displayedResults.every((session) => next.has(session.sessionKey));
      for (const session of displayedResults) {
        if (allSelected) next.delete(session.sessionKey);
        else next.add(session.sessionKey);
      }
      return next;
    });
  }

  async function selectAllMatchingSessions(): Promise<void> {
    try {
      const sessions = await searchAllMatching(false);
      setBulkSelectedKeys(new Set(sessions.map((session) => session.sessionKey)));
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function freshLiveKeysForBulkDelete(): Promise<{
    liveSessionKeys: string[];
    liveSessionCheckFailed: boolean;
  }> {
    try {
      const snapshot = await window.sessionSearch.getLiveSessions(true);
      if (snapshot.error) {
        setActionStatus({
          kind: "error",
          message: t(
            "Could not verify running sessions. Confirm that related sessions have stopped before deleting.",
            "无法确认正在运行的会话，请在删除前确认相关会话已经停止。",
          ),
        });
      }
      return {
        liveSessionKeys: snapshot.sessions.map(liveSessionDeleteKey),
        liveSessionCheckFailed: Boolean(snapshot.error),
      };
    } catch {
      setActionStatus({
        kind: "error",
        message: t(
          "Could not verify running sessions. Confirm that related sessions have stopped before deleting.",
          "无法确认正在运行的会话，请在删除前确认相关会话已经停止。",
        ),
      });
      return {
        liveSessionKeys: [],
        liveSessionCheckFailed: true,
      };
    }
  }

  async function previewSelectedSessions(): Promise<void> {
    if (bulkSelectedKeys.size === 0 || bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    try {
      const sessions = (await searchAllMatching(false)).filter((session) => bulkSelectedKeys.has(session.sessionKey));
      const liveCheck = await freshLiveKeysForBulkDelete();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: sessions.map((session) => session.sessionKey),
        ...liveCheck,
        protectFavorites: false,
        openSessionKey: detail?.sessionKey,
      };
      const preview = await window.sessionSearch.previewBulkDelete(request);
      setBulkDeleteDialog({ mode: "selection", dateValue: "", request, preview, favoriteCount: sessions.filter((session) => session.favorited).length });
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBulkDeleteBusy(false);
    }
  }

  function openDateCleanup(): void {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    setBulkDeleteDialog({ mode: "cleanup", dateValue: formatDateInput(date), request: null, preview: null, favoriteCount: 0 });
  }

  async function openOrphanCleanup(): Promise<void> {
    if (bulkDeleteBusy) return;
    setBulkDeleteDialog({ mode: "orphans", dateValue: "", request: null, preview: null, favoriteCount: 0 });
    setBulkDeleteBusy(true);
    try {
      const liveCheck = await freshLiveKeysForBulkDelete();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: [],
        ...liveCheck,
        includeOrphanedSubagents: true,
        protectFavorites: false,
        openSessionKey: detail?.sessionKey,
      };
      const preview = await window.sessionSearch.previewBulkDelete(request);
      setBulkDeleteDialog((current) => current?.mode === "orphans" ? { ...current, request, preview } : current);
    } catch (error) {
      setBulkDeleteDialog(null);
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBulkDeleteBusy(false);
    }
  }

  async function previewDateCleanup(): Promise<void> {
    if (!bulkDeleteDialog?.dateValue || bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    try {
      const sessions = await searchAllMatching(true);
      const inactiveBefore = new Date(`${bulkDeleteDialog.dateValue}T00:00:00`).getTime();
      if (!Number.isFinite(inactiveBefore)) throw new Error(t("Choose a valid date.", "请选择有效日期。"));
      const liveCheck = await freshLiveKeysForBulkDelete();
      const request: SessionBulkDeleteRequest = {
        sessionKeys: sessions.map((session) => session.sessionKey),
        ...liveCheck,
        inactiveBefore,
        protectFavorites: true,
        openSessionKey: detail?.sessionKey,
      };
      const preview = await window.sessionSearch.previewBulkDelete(request);
      setBulkDeleteDialog((current) => current ? { ...current, request, preview } : current);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBulkDeleteBusy(false);
    }
  }

  async function confirmBulkDelete(confirmed: boolean): Promise<void> {
    if (!bulkDeleteDialog?.request || !bulkDeleteDialog.preview || bulkDeleteBusy) return;
    const requestAtConfirmation = bulkDeleteDialog.request;
    setBulkDeleteBusy(true);
    setActionStatus({ kind: "running", message: t("Deleting sessions...", "正在批量删除会话...") });
    try {
      const result = await window.sessionSearch.bulkDeleteSessions({
        ...requestAtConfirmation,
        confirmed,
        allowUnverifiedLiveSessions:
          confirmed && bulkDeleteDialog.preview.liveSessionCheckFailed,
        confirmationFingerprint: confirmed
          ? bulkDeleteDialog.preview.confirmationFingerprint
          : undefined,
        openSessionKey: detail?.sessionKey,
      });
      if (detail && result.deletedSessionKeys.includes(detail.sessionKey)) closeDetail();
      setBulkSelectedKeys((current) => {
        const next = new Set(current);
        for (const sessionKey of result.deletedSessionKeys) next.delete(sessionKey);
        return next;
      });
      setBulkDeleteDialog(null);
      await Promise.all([load(), loadSidebarMetadata(), loadStats(), loadWorkbenchSessions()]);
      setActionStatus({
        kind: result.failed.length > 0 ? "error" : "success",
        message: result.failed.length > 0
          ? t(`Deleted ${result.deletedSessionKeys.length}; ${result.failed.length} failed.`, `已删除 ${result.deletedSessionKeys.length} 个，${result.failed.length} 个失败。`)
          : t(`Deleted ${result.deletedSessionKeys.length} sessions.`, `已删除 ${result.deletedSessionKeys.length} 个会话。`),
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const liveCheckFailed = isSessionDeleteLiveCheckConfirmationRequiredMessage(rawMessage);
      if (liveCheckFailed || isSessionDeleteConfirmationRequiredMessage(rawMessage)) {
        try {
          const {
            confirmed: _confirmed,
            allowUnverifiedLiveSessions: _allowUnverifiedLiveSessions,
            ...requestWithoutConfirmation
          } = requestAtConfirmation;
          const liveCheck = await freshLiveKeysForBulkDelete();
          const request: SessionBulkDeleteRequest = {
            ...requestWithoutConfirmation,
            ...liveCheck,
            liveSessionCheckFailed: liveCheckFailed || liveCheck.liveSessionCheckFailed,
            openSessionKey: detail?.sessionKey,
          };
          const preview = await window.sessionSearch.previewBulkDelete(request);
          setBulkDeleteDialog((current) =>
            current?.request === requestAtConfirmation
              ? { ...current, request, preview }
              : current);
          setActionStatus({
            kind: "error",
            message: liveCheckFailed
              ? t(
                  "Running sessions could not be verified. Review the updated preview and confirm again.",
                  "无法确认会话是否仍在运行，请检查更新后的预览并重新确认。",
                )
              : t(
                  "The deletion risk changed. Review the updated preview and confirm again.",
                  "删除风险已发生变化，请检查更新后的预览并重新确认。",
                ),
          });
        } catch (refreshError) {
          setActionStatus({
            kind: "error",
            message: refreshError instanceof Error ? refreshError.message : String(refreshError),
          });
        }
      } else {
        setActionStatus({ kind: "error", message: rawMessage });
      }
    } finally {
      setBulkDeleteBusy(false);
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

  function uploadRemoteSession(session: SessionSearchResult): void {
    remoteSessions.queueUploads([{
      itemId: session.sessionKey,
      sessionKey: session.sessionKey,
      title: session.displayTitle,
    }]);
    const message = t("Session upload started in the background.", "会话已开始在后台上传。");
    setActionStatus({ kind: "success", message });
    window.setTimeout(() => {
      setActionStatus((current) => current?.kind === "success" && current.message === message ? null : current);
    }, 1800);
  }

  async function exportMarkdown(sessionKey: string, includeToolTrace: boolean): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: t("Exporting markdown...", "正在导出 Markdown...") });
    try {
      const exported = await window.sessionSearch.exportMarkdown(sessionKey, { includeToolTrace });
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

  function beginMigrate(session: SessionSearchResult, turn?: SessionTurnSummary): void {
    setContextMenu(null);
    setMigrationDialog({
      kind: "select",
      session,
      ...(turn
        ? {
            throughTurnId: turn.id,
            throughTurnIndex: turn.turnIndex,
          }
        : {}),
    });
  }

  function closeMigrationDialog(): void {
    migrationDialogRef.current = null;
    setMigrationDialog(null);
  }

  async function runMigration(
    target: SessionMigrationProgress["target"],
    withoutProjectPath: boolean,
  ): Promise<void> {
    if (!migrationDialog || migrationDialog.kind !== "select") return;
    const session = migrationDialog.session;
    let targetProjectPath: string | undefined;
    if (withoutProjectPath) {
      targetProjectPath = "";
    } else if (isLocalSessionEnvironment(session) && !session.projectPath.trim()) {
      try {
        targetProjectPath = (await window.sessionSearch.chooseLocalProjectDirectory()) ?? undefined;
      } catch (error) {
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!targetProjectPath) return;
    }
    setMigrationBusy(true);
    setContextMenu(null);
    setMigrationProgress(null);
    setActionStatus({ kind: "running", message: t("Preparing migration...", "正在准备迁移...") });
    try {
      const result: SessionMigrationResult = await window.sessionSearch.migrateSession({
        sessionKey: session.sessionKey,
        target,
        ...(targetProjectPath !== undefined ? { targetProjectPath } : {}),
        ...(migrationDialog.throughTurnId
          ? { throughTurnId: migrationDialog.throughTurnId }
          : {}),
      });
      await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
      await refreshLiveSessions();
      const strategyLabel = migrationStrategyLabel(result.strategy, language);
      const message = t(
        `Migrated to ${migrationAgentLabel(result.target)} (${strategyLabel}): ${result.targetSessionId}`,
        `已迁移到 ${migrationAgentLabel(result.target)}（${strategyLabel}）：${result.targetSessionId}`,
      );
      const dialogStillOpen = migrationDialogRef.current?.kind === "select";
      const backgroundLaunchFailure = !result.launched && !dialogStillOpen;
      const detail = result.warning || (!result.launched ? result.resumeCommand : "");
      setActionStatus({ kind: backgroundLaunchFailure ? "error" : "success", message: detail ? `${message}\n${detail}` : message });
      if (dialogStillOpen) setMigrationDialog(result.launched ? null : { kind: "launch-failed", session, result });
      if (!backgroundLaunchFailure) {
        window.setTimeout(() => {
          setActionStatus((current) => (current?.kind === "success" && current.message.startsWith(message) ? null : current));
        }, 2200);
      }
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setMigrationBusy(false);
      setMigrationProgress(null);
    }
  }

  async function refreshNow(): Promise<void> {
    setContextMenu(null);
    setRefreshFeedback((current) => reduceIndexFeedback(current, {
      type: "start",
      message: t("Refreshing index...", "正在更新索引..."),
    }));
    try {
      const status = await window.sessionSearch.refreshIndex();
      setIndexStatus(status);
      await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
      const successMessage = t(
        `Index refreshed: ${status.indexed} updated, ${status.skipped} skipped, ${status.total} total.`,
        `索引已更新：更新 ${status.indexed} 个，跳过 ${status.skipped} 个，共 ${status.total} 个。`,
      );
      setRefreshFeedback((current) => reduceIndexFeedback(current, {
        type: "manual-result",
        status,
        successMessage,
      }));
      if (status.error) return;
      window.setTimeout(() => {
        setRefreshFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 2200);
    } catch (error) {
      setRefreshFeedback((current) => reduceIndexFeedback(current, {
        type: "manual-error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function checkAppUpdate(): Promise<void> {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    setAppUpdateProgress(null);
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
    setAppUpdateProgress(null);
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

  function scheduleOptionalSourceRefresh(): void {
    optionalSourceRefreshGenerationRef.current += 1;
    setSettingsFeedback({ kind: "success", message: t("Loading sessions in the background...", "正在后台加载会话...") });
    void optionalSourceRefreshQueue.request(async () => {
      const generation = optionalSourceRefreshGenerationRef.current;
      const shouldRefreshIndex = optionalSourceIndexRefreshKeysRef.current.size > 0;
      optionalSourceIndexRefreshKeysRef.current.clear();
      try {
        if (shouldRefreshIndex) {
          const status = await window.sessionSearch.refreshIndex();
          if (status.error) throw new Error(status.error);
        }
        await Promise.all([load(), loadSidebarMetadata(), loadStats()]);
        if (optionalSourceRefreshGenerationRef.current !== generation) return;
        setPendingPersonalSources(emptyPendingPersonalSources());
        const message = t("Sources ready.", "来源已就绪。");
        setSettingsFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setSettingsFeedback((current) =>
            current?.kind === "success" && current.message === message ? null : current);
        }, 1600);
      } catch (error) {
        if (optionalSourceRefreshGenerationRef.current !== generation) return;
        setPendingPersonalSources(emptyPendingPersonalSources());
        setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }).catch(() => undefined);
  }

  function updateSettings(next: AppSettingsUpdate): Promise<void> {
    const request = settingsUpdateQueueRef.current.then(() => performSettingsUpdate(next));
    settingsUpdateQueueRef.current = request.catch(() => undefined);
    return request;
  }

  async function performSettingsUpdate(next: AppSettingsUpdate): Promise<void> {
    const currentSettings = appSettingsRef.current;
    const changedSources = OPTIONAL_SOURCE_SETTINGS.filter((item) => item.key in next && next[item.key] !== currentSettings?.[item.key]);
    const quotaVisibilityChanged =
      ("hideCodexQuota" in next && next.hideCodexQuota !== currentSettings?.hideCodexQuota) ||
      ("hideClaudeQuota" in next && next.hideClaudeQuota !== currentSettings?.hideClaudeQuota);
    const remoteSyncConfigurationChanged =
      ("remoteSyncEnabled" in next && next.remoteSyncEnabled !== currentSettings?.remoteSyncEnabled) ||
      ("remoteSyncSupabaseUrl" in next && next.remoteSyncSupabaseUrl !== currentSettings?.remoteSyncSupabaseUrl) ||
      ("remoteSyncSupabaseAnonKey" in next && next.remoteSyncSupabaseAnonKey !== currentSettings?.remoteSyncSupabaseAnonKey);
    setSettingsFeedback({ kind: "running", message: t("Saving settings...", "正在保存设置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings(next);
      appSettingsRef.current = nextSettings;
      setAppSettings(nextSettings);
      if (remoteSyncConfigurationChanged) remoteSessions.invalidate();
      if ("remoteSyncEnabled" in next) {
        void window.sessionSearch.getSessionSyncHookStatus().then(setSessionHookStatus).catch(() => setSessionHookStatus(null));
      }
      if (quotaVisibilityChanged) void loadQuotas();

      if (changedSources.length > 0) {
        setPendingPersonalSources((current) => {
          const pending = { ...current };
          for (const item of changedSources) pending[item.pendingKey] = nextSettings[item.key];
          return pending;
        });
        for (const item of changedSources) {
          if (nextSettings[item.key]) optionalSourceIndexRefreshKeysRef.current.add(item.pendingKey);
          else optionalSourceIndexRefreshKeysRef.current.delete(item.pendingKey);
        }
        scheduleOptionalSourceRefresh();
        return;
      }
      setSettingsFeedback({ kind: "success", message: t("Settings saved.", "设置已保存。") });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
      }, 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function importV1Data(): Promise<V1ImportResult> {
    const result = await window.sessionSearch.importV1Data();
    const [nextSettings, nextEnvironments] = await Promise.all([
      window.sessionSearch.getSettings(),
      window.sessionSearch.listEnvironments(),
      load(),
      loadSidebarMetadata(),
      loadStats(),
    ]);
    appSettingsRef.current = nextSettings;
    setAppSettings(nextSettings);
    setEnvironments(nextEnvironments);
    remoteSessions.invalidate();
    void window.sessionSearch.getSessionSyncHookStatus().then(setSessionHookStatus).catch(() => setSessionHookStatus(null));
    return result;
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
    if (environment.kind !== "ssh" && environment.kind !== "wsl") return;
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

  async function saveWslEnvironment(input: EnvironmentUpsertInput): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t("Saving WSL environment...", "正在保存 WSL 环境...") });
    try {
      await window.sessionSearch.saveEnvironment(input);
      await reloadEnvironmentData();
      const message = t("WSL environment saved.", "WSL 环境已保存。");
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
      const result = await window.sessionSearch.applyCodexProfile(apiConfig);
      const nextSettings = await window.sessionSearch.setSettings({ apiConfig });
      setAppSettings(nextSettings);
      const profileLabel = result.profile === "codex" ? "Codex Official" : apiConfig.customProviderName.trim() || "CodexZH";
      const usesLocalProxy = apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
      const successMessage = usesLocalProxy
        ? t(
            `Applied and verified ${profileLabel} at ${result.configTarget} via local proxy.`,
            `已通过本地 proxy 将 ${profileLabel} 写入并验证：${result.configTarget}`,
          )
        : t(
            `Applied and verified ${profileLabel} at ${result.configTarget}.`,
            `已将 ${profileLabel} 写入并验证：${result.configTarget}`,
          );
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
      const result = await window.sessionSearch.applyClaudeProfile(claudeApiConfig);
      const nextSettings = await window.sessionSearch.setSettings({ claudeApiConfig });
      setAppSettings(nextSettings);
      const profileLabel =
        result.profile === "claude-official" ? "Claude Official" : claudeApiConfig.customProviderName.trim() || "Claude Code";
      const successMessage = t(
        `Applied and verified ${profileLabel} at ${result.settingsPath}.`,
        `已将 ${profileLabel} 写入并验证：${result.settingsPath}`,
      );
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
        settingsOpen={settingsOpen}
        signalUpdate={shouldSignalAppUpdate}
        language={language}
        onNavigate={(page) => void navigateToPage(page)}
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
              statsOrigin={statsOrigin}
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
              onStatsOriginChange={setStatsOrigin}
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
              workflows={workbenchWorkflowSnapshot?.workflows ?? []}
              workflowTotalCount={workbenchWorkflowSnapshot?.totalCount ?? 0}
              activeWorkflowCount={workbenchWorkflowSnapshot?.activeCount ?? 0}
              workflowsLoading={workbenchWorkflowSnapshot === null}
              workflowsError={workbenchWorkflowError}
              onOpenWorkflow={(workflowId) => {
                void openWorkflows({ workflowId });
              }}
              onNewWorkflow={() => {
                void openWorkflows({ createNew: true });
              }}
              onShowWorkflows={() => {
                void openWorkflows();
              }}
              runtimes={automation.detailsLoaded ? automation.snapshot.runtimes : []}
              runtimeChannels={automation.detailsLoaded ? automation.snapshot.channels : []}
              runtimeOverviewAvailable={automation.detailsLoaded}
              mcpServers={workbenchMcpServers}
              chatRooms={workbenchChatRooms}
              memoryEnabled={Boolean(appSettings?.openVikingMemoryEnabled)}
              memorySnapshot={workbenchMemorySnapshot}
              memoryLoading={workbenchMemoryLoading}
              skills={workbenchSkills ?? []}
              skillsLoading={workbenchSkills === null}
              onShowRuntimes={() => void navigateToPage("runtimes")}
              onShowMcp={() => void navigateToPage("mcp")}
              onShowChat={(roomId) => {
                setPreferredTeamChatRoomId(roomId);
                setPreferredTeamChatMessageId(undefined);
                void navigateToPage("team-chat");
              }}
              onShowMemories={() => void navigateToPage("memories")}
              onShowSkills={() => void navigateToPage("skills")}
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
                tags,
                sidebarTree,
                collapsedProjectGroups,
                expandedTreeProjects: collapsedTreeProjects,
                source,
                origin,
                originCounts,
                invocationSurface,
                invocationSurfaceCounts,
                sourceFilters: visibleSourceFilters,
                visibility,
                searchRef,
                searchPlaceholder,
                query,
                activeScopeFilters,
                liveStatus,
                customDateRange,
                dateRange,
                sortBy,
                aiAssistantOpen,
                remoteSessionsOpen,
                selected,
                sessions: displayedResults,
                currentPage,
                totalPages,
                liveSessionKeys,
                liveDetectionFailed,
                bulkSelectionActive,
                bulkSelectedKeys,
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
                setOrigin,
                setInvocationSurface,
                setTag,
                setVisibility,
                search: setQuery,
                setLiveStatus,
                clearCustomDateRange: () => setCustomDateRange(null),
                setCustomDateRange: (nextRange) => {
                  setDateRange("all");
                  setCustomDateRange(nextRange);
                },
                setDateRange: (nextRange) => {
                  setCustomDateRange(null);
                  setDateRange(nextRange);
                },
                setSortBy,
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
                goToPage,
                toggleBulkSession,
                toggleLoadedSelection,
                exitBulkSelection,
                selectAllMatching: () => void selectAllMatchingSessions(),
                deleteSelected: () => void previewSelectedSessions(),
                openDateCleanup,
                openOrphanCleanup: () => void openOrphanCleanup(),
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
                localSnapshot={skills.localSnapshot}
                localLoading={skills.localLoading}
                localError={skills.localError}
                language={language}
                revealLabel={FILE_MANAGER_LABEL}
                onRefresh={() => void skills.load({ refreshUsage: true })}
                onEnsureLocalLoaded={skills.ensureLocalLoaded}
                onRefreshLoadedLocal={skills.refreshLoadedLocal}
                onRefreshLocal={() => void skills.refreshLocal()}
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
                evalBadgeCounts={Boolean(appSettings?.evalEnabled) ? evalFindingCounts : undefined}
                onNavigateToEval={(skillName) => {
                  setEvalPreselectedSkill(skillName);
                  void navigateToPage("evaluation");
                }}
                initialDiscoveryOpen={openSkillDiscoveryFromSession}
                onInitialDiscoveryConsumed={() => setOpenSkillDiscoveryFromSession(false)}
              />
            ) : null}

            {activePage === "workflows" ? <WorkflowFeaturePage
              language={language}
              globalReviewEnabled={Boolean(appSettings?.workflowGlobalReviewEnabled)}
              runtimeReviewEnabled={Boolean(appSettings?.workflowRuntimeReviewEnabled)}
              initialRequest={workflowInitialRequest}
              onInitialRequestConsumed={() => setWorkflowInitialRequest(undefined)}
              onOpenSession={(sessionKey) => {
                void (async () => {
                  const session = await window.sessionSearch.getSession(sessionKey);
                  if (session) await openDetail(session);
                })().catch(reportSessionDetailError);
              }}
            /> : null}

            {activePage === "team-chat" ? (
              <TeamChatPage
                language={language}
                preferredRoomId={preferredTeamChatRoomId}
                preferredMessageId={preferredTeamChatMessageId}
                preferredAgentId={preferredTeamChatAgentId}
                onPreferredConsumed={() => {
                  setPreferredTeamChatRoomId(undefined);
                  setPreferredTeamChatMessageId(undefined);
                  setPreferredTeamChatAgentId(undefined);
                }}
                onOpenSession={(sessionKey) => {
                  void (async () => {
                    const session = await window.sessionSearch.getSession(sessionKey);
                    if (session) await openDetail(session);
                  })().catch(reportSessionDetailError);
                }}
              />
            ) : null}

            {activePage === "evaluation" ? (
              <EvaluationFeaturePage
                language={language}
                enabled={Boolean(appSettings?.evalEnabled)}
                preselectedSkill={evalPreselectedSkill}
                onPreselectedConsumed={() => setEvalPreselectedSkill(null)}
                initialRunId={preferredEvaluationRunId}
                initialCaseId={preferredEvaluationCaseId}
                initialEvaluatorId={preferredEvaluationEvaluatorId}
                onInitialRunConsumed={() => {
                  setPreferredEvaluationRunId(undefined);
                  setPreferredEvaluationCaseId(undefined);
                  setPreferredEvaluationEvaluatorId(undefined);
                }}
                onOpenSettings={() => {
                  setSettingsInitialSection("eval");
                  setSettingsOpen(true);
                }}
                onOpenSession={(sessionKey) => {
                  void (async () => {
                    const session = await window.sessionSearch.getSession(sessionKey);
                    if (session) await openDetail(session);
                  })();
                }}
                onNavigationGuardChange={setPageNavigationGuard}
              />
            ) : null}

            {activePage === "runtimes" ? (
              <RuntimeFeaturePage
                language={language}
                initialChannelId={preferredRuntimeChannelId}
                onInitialChannelConsumed={() => {
                  setPreferredRuntimeChannelId(undefined);
                  setPreferredRuntimeAgentId(undefined);
                }}
                initialAgentId={preferredRuntimeAgentId}
                onInitialAgentConsumed={() => {
                  setPreferredRuntimeAgentId(undefined);
                  setPreferredRuntimeChannelId(undefined);
                }}
                onNavigationGuardChange={setPageNavigationGuard}
              />
            ) : null}

            {activePage === "mcp" ? <McpFeaturePage language={language} /> : null}

            {activePage === "memories" ? (
              <OpenVikingMemoryPage
                language={language}
                enabled={Boolean(appSettings?.openVikingMemoryEnabled)}
                onOpenSettings={() => {
                  setSettingsInitialSection("memory");
                  setSettingsOpen(true);
                }}
                onViewSession={async (rawId) => {
                  const session = await window.sessionSearch.findSessionByRawId(rawId);
                  if (session) {
                    setActivePage("sessions");
                    window.requestAnimationFrame(() => openDetail(session));
                  } else {
                    setActivePage("sessions");
                  }
                }}
              />
            ) : null}

            {activePage === "providers" ? (
              <ProviderPage
                settings={appSettings}
                language={language}
                feedback={settingsFeedback}
          onSettingsChange={updateSettings}
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
        matchedMessageIndex={matchedMessageIndex}
        actionStatus={actionStatus}
        query={query}
        liveState={detail
          ? getLiveSessionState(detail, liveSessionKeys, liveDetectionFailed)
          : "closed"}
        language={language}
        revealLabel={FILE_MANAGER_LABEL}
        showItermAction={IS_MAC}
        summarizing={summarizing}
        familyRefreshVersion={sessionFamilyRefreshVersion}
        actions={{
          loadTurn: (session, turnId) =>
            window.sessionSearch.getSessionTurn(session.sessionKey, turnId),
          openFamilySession: async (sessionKey) => {
            try {
              const session = await window.sessionSearch.getSession(sessionKey);
              if (!session) {
                setActionStatus({
                  kind: "error",
                  message: t(
                    "This related session is no longer available. The subagent list has been refreshed.",
                    "关联会话已不存在，Subagent 列表已刷新。",
                  ),
                });
                return "missing";
              }
              await openDetail(session);
              return "opened";
            } catch (error) {
              reportSessionDetailError(error);
              return "failed";
            }
          },
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
          exportMarkdown: (session, includeToolTrace) => void exportMarkdown(session.sessionKey, includeToolTrace),
          exportJson: (session) => void exportJson(session.sessionKey),
          copyPlain: (session) => void runAction(
            t("Copying plain text", "正在复制纯文本"),
            () => window.sessionSearch.copyPlainText(session.sessionKey),
            t("Plain text copied.", "纯文本已复制。"),
          ),
          deleteSession: requestDeleteSession,
          openInvocationOwner: (invocation) => {
            closeDetail();
            if (invocation.surface === "workflow") {
              const workflowId = invocation.ownerReference.workflowId;
              void openWorkflows(workflowId ? {
                workflowId,
                ...(invocation.ownerReference.runId ? { runId: invocation.ownerReference.runId } : {}),
                ...(invocation.ownerReference.nodeId ? { nodeId: invocation.ownerReference.nodeId } : {}),
              } : undefined);
              return;
            }
            if (invocation.surface === "team_chat") {
              const roomId = invocation.ownerReference.roomId;
              setPreferredTeamChatRoomId(roomId);
              setPreferredTeamChatMessageId(roomId ? invocation.ownerReference.messageId : undefined);
              setPreferredTeamChatAgentId(roomId ? invocation.ownerReference.agentId : undefined);
              void navigateToPage("team-chat");
              return;
            }
            if (invocation.surface === "evaluation") {
              setPreferredEvaluationRunId(invocation.ownerReference.runId);
              setPreferredEvaluationCaseId(invocation.ownerReference.caseId);
              setPreferredEvaluationEvaluatorId(invocation.ownerReference.evaluatorId);
              void navigateToPage("evaluation");
              return;
            }
            if (invocation.surface === "system") {
              setPreferredRuntimeChannelId(invocation.ownerReference.channelId);
              setPreferredRuntimeAgentId(undefined);
              void navigateToPage("runtimes");
              return;
            }
            if (invocation.surface === "agent") {
              const agentId = invocation.ownerReference.agentId;
              if (agentId) {
                setPreferredRuntimeAgentId(agentId);
                setPreferredRuntimeChannelId(undefined);
                void navigateToPage("runtimes");
              } else {
                void navigateToPage("workbench");
              }
              return;
            }
            if (invocation.surface === "skill") {
              setOpenSkillDiscoveryFromSession(true);
              void navigateToPage("skills");
              return;
            }
            void navigateToPage("workbench");
          },
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
          canOpenApp={supportsOpenAppSource(contextMenu.session.source)}
          canStepcodeResume={Boolean(
            appSettings?.includeStepcode
            && contextMenu.session.environmentKind === "local"
            && (
              contextMenu.session.source === "claude-cli"
              || contextMenu.session.source === "claude-app"
              || contextMenu.session.source === "stepcode-claude"
              || contextMenu.session.source === "codex-cli"
              || contextMenu.session.source === "codex-app"
              || contextMenu.session.source === "stepcode-codex"
            )
          )}
          canMigrate={canMigrateSession(contextMenu.session, appSettings ?? DEFAULT_MIGRATION_TARGET_SETTINGS)}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onSelectMultiple={() => beginBulkSelection(contextMenu.session.sessionKey)}
          onFavorite={() =>
            void runAction(
              contextMenu.session.favorited ? t("Removing favorite", "正在取消收藏") : t("Adding favorite", "正在加入收藏"),
              () => window.sessionSearch.setFavorited(contextMenu.session.sessionKey, !contextMenu.session.favorited),
              contextMenu.session.favorited ? t("Removed from favorites.", "已取消收藏。") : t("Added to favorites.", "已加入收藏。"),
            )
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
          onStepcodeResume={() =>
            void runAction(
              t("Opening StepCode", "正在通过 StepCode 恢复"),
              () => window.sessionSearch.resumeSessionWithStepcode(contextMenu.session.sessionKey),
              t("StepCode resume command sent to terminal.", "StepCode 恢复命令已发送到终端。"),
            )
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
          onExportMarkdown={(includeToolTrace) => void exportMarkdown(contextMenu.session.sessionKey, includeToolTrace)}
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
          busy={migrationBusy}
          progress={migrationProgress}
          throughTurnIndex={migrationDialog.throughTurnIndex}
          onSelect={(target, withoutProjectPath) => void runMigration(target, withoutProjectPath)}
          onClose={closeMigrationDialog}
        />
      ) : null}

      {migrationDialog?.kind === "launch-failed" ? (
        <SessionMigrationLaunchFailedDialog
          session={migrationDialog.session}
          result={migrationDialog.result}
          language={language}
          onClose={closeMigrationDialog}
        />
      ) : null}

      {actionStatus
        ? <ActionToast status={actionStatus} onClose={() => setActionStatus(null)} />
        : refreshFeedback
          ? <ActionToast
              status={refreshFeedback}
              onClose={() => setRefreshFeedback((current) => reduceIndexFeedback(current, { type: "dismiss" }))}
            />
          : null}

      {dialog ? (
        <CommandDialog
          dialog={dialog}
          tags={tags}
          language={language}
          onChange={(value) => setDialog(dialog.kind === "rename"
            ? { ...dialog, value, useDefaultTitle: false }
            : { ...dialog, value })}
          onRestoreDefault={() => {
            if (dialog.kind !== "rename") return;
            setDialog({
              ...dialog,
              value: dialog.session.originalTitle || dialog.session.firstQuestion || "",
              useDefaultTitle: true,
            });
          }}
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
          cascadeCount={deleteSessionCascadeCount}
          hasLiveSession={deleteSessionHasLiveSession}
          liveSessionCheckFailed={deleteSessionLiveCheckFailed}
          confirmationVersion={deleteSessionConfirmationVersion}
          isOpen={detail?.sessionKey === deleteSessionCandidate.sessionKey}
          blockedMessage={deleteSessionBlockedMessage}
          language={language}
          deleting={deletingSession}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (!deletingSession) {
              deleteSessionPreviewId.current += 1;
              setDeleteSessionCandidate(null);
              closeDetail();
              setDeleteSessionCascadeCount(null);
              setDeleteSessionHasLiveSession(false);
              setDeleteSessionLiveCheckFailed(false);
              setDeleteSessionBlockedMessage(null);
            }
          }}
        />
      ) : null}

      {bulkDeleteDialog ? (
        <BulkDeleteDialog
          mode={bulkDeleteDialog.mode}
          preview={bulkDeleteDialog.preview}
          dateValue={bulkDeleteDialog.dateValue}
          favoriteCount={bulkDeleteDialog.favoriteCount}
          busy={bulkDeleteBusy}
          language={language}
          onDateChange={(dateValue) => setBulkDeleteDialog((current) => current ? { ...current, dateValue, request: null, preview: null } : current)}
          onPreview={() => void previewDateCleanup()}
          onConfirm={(confirmed) => void confirmBulkDelete(confirmed)}
          onCancel={() => setBulkDeleteDialog(null)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          platform={RUNTIME_PLATFORM}
          initialSection={settingsInitialSection}
          settings={appSettings}
          runtimeChannels={automation.detailsLoaded ? automation.snapshot.channels : []}
          appUpdateStatus={appUpdateStatus}
          appUpdateProgress={appUpdateProgress}
          appUpdateBusy={appUpdateBusy}
          appUpdateError={appUpdateError}
          environments={environments}
          environmentHealthReports={environmentHealthReports}
          diagnosingEnvironmentId={diagnosingEnvironmentId}
          theme={theme}
          language={language}
          messageFontSize={messageFontSize}
          feedback={settingsFeedback}
          onSettingsChange={updateSettings}
          onCheckAppUpdate={() => void checkAppUpdate()}
          onInstallAppUpdate={() => void installAppUpdate()}
          onSkipAppUpdate={(untilNextVersion) => void skipAppUpdate(untilNextVersion)}
          onThemeChange={setTheme}
          onLanguageChange={setLanguage}
          onMessageFontSizeChange={setMessageFontSize}
          sessionHookStatus={sessionHookStatus}
          sessionHookBusy={sessionHookBusy}
          onSessionHookChange={(enabled) => void toggleSessionSyncHook(enabled)}
          onRefreshEnvironment={(environment) => void refreshEnvironment(environment)}
          onDiagnoseEnvironment={(environment) => void diagnoseEnvironment(environment)}
          onDeleteEnvironment={(environment) => void deleteEnvironment(environment)}
          onAddSsh={() => setSshDialogOpen(true)}
          onAddWsl={() => setWslDialogOpen(true)}
          onImportV1={importV1Data}
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

      {wslDialogOpen ? (
        <WslEnvironmentDialog
          environments={environments}
          language={language}
          feedback={settingsFeedback}
          onSaveEnvironment={(input) => saveWslEnvironment(input)}
          onClose={() => setWslDialogOpen(false)}
        />
      ) : null}

      {remoteSessionsOpen ? (
        <RemoteSessionsDialog
          cache={remoteSessions.cache}
          language={language}
          onRefresh={remoteSessions.refresh}
          onQueueUploads={remoteSessions.queueUploads}
          onQueueDeletions={remoteSessions.queueDeletions}
          onContinueInBackground={continueRemoteSessionsInBackground}
          onRestored={(result) => {
            const message = result.launched
              ? t(
                  `Restored and opened in ${migrationAgentLabel(result.target)}.`,
                  `已恢复并在 ${migrationAgentLabel(result.target)} 中打开。`,
                )
              : result.warning || result.resumeCommand;
            // Migration progress is delivered over a separate IPC channel and
            // its final "launching" event can arrive just after the restore
            // invoke resolves. Finish on the next task so that stale progress
            // cannot overwrite the terminal status.
            window.setTimeout(() => {
              setMigrationProgress(null);
              setActionStatus({ kind: result.launched ? "success" : "error", message });
              if (result.launched) {
                window.setTimeout(() => {
                  setActionStatus((current) =>
                    current?.kind === "success" && current.message === message ? null : current);
                }, 1800);
              }
            }, 0);
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
