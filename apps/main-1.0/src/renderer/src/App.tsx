import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, RefObject } from "react";
import {
  AppWindow,
  Archive,
  ArrowRightLeft,
  CalendarDays,
  Clipboard,
  Copy,
  Download,
  Eye,
  FolderOpen,
  ListChecks,
  Play,
  Search,
  Settings,
  Star,
  Tag,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { IndexStatus } from "../../core/indexer";
import type { AppUpdateProgress, AppUpdateStatus } from "../../core/app-update-types";
import { LIVE_SESSION_REFRESH_INTERVAL_MS, QUOTA_REFRESH_INTERVAL_MS } from "../../core/refresh-policy";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { MigrationTargetSettings } from "../../core/migration-targets";
import type { RemoteHealthReport } from "../../core/remote-health";
import type { RemoteSessionDetailSnapshot } from "../../core/remote-session-sync";
import type { SessionFamily } from "../../core/session-family";
import { canDeleteSessionLocally } from "../../core/session-environment";
import type { SessionSyncHookStatus } from "../../core/session-sync-queue";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS } from "../../core/session-sources";
import type { TraceEventQueryOptions } from "../../core/session-store";
import { liveSessionDeleteKey, type SessionBulkDeletePreview, type SessionBulkDeleteRequest } from "../../core/session-bulk-delete";
import type { RemoteSkill, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../core/skill-sync";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../core/skill-manager";
import type {
  EnvironmentUpsertInput,
  LiveSessionSnapshot,
  ProjectSummary,
  ProjectTagEntry,
  SearchOptions,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionMessage,
  SessionMatchHit,
  SessionSearchResult,
  SessionSortBy,
  SessionStats,
  SessionStatsPeriod,
  SessionStatsTrend,
  SessionStatsTrendBucket,
  SessionTraceEvent,
  UsageQuotaCard,
  UsageQuotaSnapshot,
} from "../../core/types";
import { formatCompactNumber, formatTokenCount } from "./format-count";
import { DATE_RANGE_OPTIONS, dateRangeLabel, dateRangeShortLabel, resolveDateRange, type DateRangeFilter } from "./date-range";
import {
  filterSessionsByLiveStatus,
  getLiveSessionState,
  type LiveSessionState,
  type LiveStatusFilter,
} from "./live-filter";
import {
  readSidebarSections,
  serializeSidebarSections,
  toggleSidebarSection,
  type SidebarSectionId,
  type SidebarSectionsState,
} from "./sidebar-sections";
import { LANGUAGE_STORAGE_KEY, localize, readInitialLanguage, type LanguageMode } from "./language";
import { coalesceIndexStatusForRender } from "./index-status";
import { reduceIndexFeedback } from "./index-status-feedback";
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";
import {
  MESSAGE_FONT_SIZE_STORAGE_KEY,
  messageFontSizeCss,
  readInitialMessageFontSize,
  type MessageFontSizeScale,
} from "./message-font-size";
import { loadSkillsPanelData } from "./skills-load";
import { createLatestTaskQueue, type LatestTaskQueue } from "./latest-task-queue";
import type {
  ActionStatus,
  ContextMenuState,
  DialogState,
  QuotaFeedback,
  RefreshFeedback,
  SettingsFeedback,
  SessionMigrationDialogState,
  SkillsFeedback,
  StatsFeedback,
} from "./app-types";
import { ApiConfigDialog } from "./features/providers/api-config-dialog";
import { DetailPanel } from "./features/session-detail/detail-panel";
import { useSessionFamily, type FamilySessionOpenResult } from "./features/session-detail/use-session-family";
import { SessionMigrationDialog, SessionMigrationLaunchFailedDialog } from "./components/session-migration-dialog";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "./components/session-dialogs";
import { SkillsDialog } from "./features/skills/skills-dialog";
import { DigitalAssetsDialog } from "./features/digital-assets/digital-assets-dialog";
import { DEFAULT_QUERY_BUILDER_STATE, countActiveFilters, toSearchOptionsPatch, type QueryBuilderState } from "./features/search/query-builder-types";
import type { GroupMode } from "./features/search/group-logic";
import { useMainSearchShortcut } from "./features/search/use-main-search-shortcut";
import type { SavedSearch } from "../../core/store/saved-searches";
import type { RulesSyncSnapshot } from "../../core/rules-sync";
import type { MemoriesSyncSnapshot } from "../../core/memories-sync";
import { AiAssistantDialog } from "./components/ai-assistant-dialog";
import { RemoteSessionsDialog } from "./features/remote-sessions/remote-sessions-dialog";
import { useRemoteSessionsCache } from "./features/remote-sessions/use-remote-sessions-cache";
import { SupabaseSetupGuide } from "./components/supabase-setup-guide";
import { useClampedContextMenuStyle } from "./context-menu-position";
import { Sidebar } from "./layout/sidebar";
import { ContentArea } from "./layout/content-area";
import { ActionToast } from "./layout/action-toast";
import { resolveSearchScope } from "./features/search/search-scope";
import {
  SettingsDialog,
  type SettingsSection,
} from "./features/settings/settings-dialog";
import { SshEnvironmentDialog } from "./features/settings/ssh-environment-dialog";
import { WslEnvironmentDialog } from "./features/settings/wsl-environment-dialog";
import {
  SOURCE_LABEL,
  environmentBadgeLabel,
  environmentBadgeTitle,
  hasTokenUsage,
  isBranchTag,
  displayTagName,
  isRemoteSession,
  projectDisplayLabel,
  remoteOpenAppTitle,
  remoteMigrationTitle,
  remoteRevealTitle,
  resumeActionLabel,
  resumeRouteMessage,
  sourceFilters,
  supportsMigrationSource,
  supportsResumeSource,
  unsupportedMigrationTitle,
  migrationAgentLabel,
  migrationTargetsForSession,
} from "./session-ui";
import type { UsageDelta } from "./session-ui";

const RUNTIME_PLATFORM: NodeJS.Platform = window.sessionSearch.platform;
const IS_MAC = RUNTIME_PLATFORM === "darwin";
const FILE_MANAGER_LABEL = IS_MAC ? "Finder" : RUNTIME_PLATFORM === "win32" ? "Explorer" : "File Manager";

const DEFAULT_MIGRATION_TARGET_SETTINGS = {
  includeTclaude: false,
  includeTcodex: false,
} satisfies MigrationTargetSettings;

type ViewMode = "default" | "favorites" | "hidden";
type PendingSourceKey = (typeof OPTIONAL_SESSION_SOURCE_DESCRIPTORS)[number]["pendingKey"];

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  pendingKey: descriptor.pendingKey,
  filter: descriptor.id,
}));
const OPTIONAL_SOURCE_REFRESH_SETTLE_MS = 120;

function emptyPendingPersonalSources(): Record<PendingSourceKey, boolean> {
  return Object.fromEntries(
    OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map(({ pendingKey }) => [pendingKey, false]),
  ) as Record<PendingSourceKey, boolean>;
}

const SESSION_PAGE_SIZE = 30;

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
const INITIAL_MESSAGE_LIMIT = 20;
const MESSAGE_PAGE_SIZE = 80;
const TRACE_EVENT_WINDOW_LIMIT = 300;

const EMPTY_STATS: SessionStats = {
  total: {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  bySource: [],
  range: {
    period: "today",
    since: null,
    until: 0,
  },
  previousTotal: null,
};

const EMPTY_STATS_TREND: SessionStatsTrend = {
  period: "today",
  granularity: null,
  buckets: [],
};

const EMPTY_QUOTAS: UsageQuotaSnapshot = {
  generatedAt: "",
  providers: [],
};

const EMPTY_LIVE_SESSIONS: LiveSessionSnapshot = {
  generatedAt: "",
  sessions: [],
};

const EMPTY_SESSION_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

const EMPTY_SKILLS: InstalledSkillsSnapshot = {
  skills: [],
  roots: [],
  scannedAt: 0,
};

const EMPTY_SKILL_SYNC: SkillSyncSnapshot = {
  status: {
    kind: "unconfigured",
    setupSql: "",
    remediation: "settings",
    message: "Configure Supabase URL and anon key in Settings to sync skills.",
  },
  remoteSkillGroups: [],
  bindings: [],
  scannedAt: 0,
};

function traceWindowForMessages(messages: SessionMessage[]): TraceEventQueryOptions {
  const times = messages
    .map((message) => new Date(message.timestamp).getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return { limit: TRACE_EVENT_WINDOW_LIMIT };
  return {
    startTimestamp: new Date(Math.min(...times)).toISOString(),
    endTimestamp: new Date(Math.max(...times)).toISOString(),
    limit: TRACE_EVENT_WINDOW_LIMIT,
  };
}

function mergeTraceEventsByIndex(current: SessionTraceEvent[], next: SessionTraceEvent[]): SessionTraceEvent[] {
  if (next.length === 0) return current;
  const byIndex = new Map(current.map((event) => [event.index, event]));
  for (const event of next) byIndex.set(event.index, event);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
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
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
  const [messageFontSize, setMessageFontSize] = useState<MessageFontSizeScale>(() => readInitialMessageFontSize());
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionsState>(() => loadInitialSidebarSections());
  const [collapsedProjectGroups, setCollapsedProjectGroups] = useState<Set<string>>(() => loadCollapsedProjectGroups());
  const [collapsedTreeProjects, setCollapsedTreeProjects] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [environmentId, setEnvironmentId] = useState<string | "all">("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [projectEnvironmentId, setProjectEnvironmentId] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<ViewMode>("default");
  const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
  const [sortBy, setSortBy] = useState<SessionSortBy>("smart");
  const [liveStatus, setLiveStatus] = useState<LiveStatusFilter>("all");
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [resultsScopeKey, setResultsScopeKey] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectTags, setProjectTags] = useState<ProjectTagEntry[]>([]);
  const [environments, setEnvironments] = useState<SessionEnvironment[]>([]);
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [statsTrend, setStatsTrend] = useState<SessionStatsTrend>(EMPTY_STATS_TREND);
  const [statsTrendLoadedFor, setStatsTrendLoadedFor] = useState<SessionStatsPeriod | null>(null);
  const [statsPeriod, setStatsPeriod] = useState<SessionStatsPeriod>("today");
  const [statsTrendLoading, setStatsTrendLoading] = useState(false);
  const [statsFeedback, setStatsFeedback] = useState<StatsFeedback>(null);
  const [quotas, setQuotas] = useState<UsageQuotaSnapshot>(EMPTY_QUOTAS);
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [quotaFeedback, setQuotaFeedback] = useState<QuotaFeedback>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSessionSnapshot>(EMPTY_LIVE_SESSIONS);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionSearchResult | null>(null);
  const [remoteDetail, setRemoteDetail] = useState<{ snapshot: RemoteSessionDetailSnapshot; query: string } | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [matchedContextMessages, setMatchedContextMessages] = useState<SessionMessage[]>([]);
  const [matchedMessageIndex, setMatchedMessageIndex] = useState<number | null>(null);
  const [messageOffset, setMessageOffset] = useState(0);
  const [traceEvents, setTraceEvents] = useState<SessionTraceEvent[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [migrationDialog, setMigrationDialog] = useState<SessionMigrationDialogState>(null);
  const migrationDialogRef = useRef<SessionMigrationDialogState>(null);
  const [migrationProgress, setMigrationProgress] = useState<SessionMigrationProgress | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<SessionSearchResult | null>(null);
  const [deleteSessionCascadeCount, setDeleteSessionCascadeCount] = useState<number | null>(null);
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
  const [summarizing, setSummarizing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("terminal");
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [appUpdateProgress, setAppUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [wslDialogOpen, setWslDialogOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const [sessionFamilyRefreshVersion, setSessionFamilyRefreshVersion] = useState(0);
  const [rulesSnapshot, setRulesSnapshot] = useState<RulesSyncSnapshot | null>(null);
  const [memoriesSnapshot, setMemoriesSnapshot] = useState<MemoriesSyncSnapshot | null>(null);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
  const remoteSessions = useRemoteSessionsCache();
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillsSnapshot>(EMPTY_SKILLS);
  const [skillSyncSnapshot, setSkillSyncSnapshot] = useState<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsFeedback, setSkillsFeedback] = useState<SkillsFeedback>(null);
  const skillSyncSnapshotRef = useRef<SkillSyncSnapshot>(EMPTY_SKILL_SYNC);
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
  const loadSeqRef = useRef(0);
  const metadataLoadSeqRef = useRef(0);
  const statsLoadSeqRef = useRef(0);
  const statsTrendLoadSeqRef = useRef(0);
  const indexStatusEventVersionRef = useRef(0);
  const indexRunningRef = useRef(false);
  const completedIndexRefreshKeyRef = useRef<string | null>(null);
  const completedIndexRefreshPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const detailLoadSeqRef = useRef(0);
  const appSettingsRef = useRef<AppSettings | null>(null);
  const settingsUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const optionalSourceRefreshGenerationRef = useRef(0);
  const optionalSourceIndexRefreshKeysRef = useRef(new Set<PendingSourceKey>());
  const [optionalSourceRefreshQueue] = useState(() =>
    createLatestTaskQueue<void>({ settleMs: OPTIONAL_SOURCE_REFRESH_SETTLE_MS }));
  const favoriteSaveQueuesRef = useRef(new Map<string, LatestTaskQueue<void>>());
  const favoriteSaveVersionsRef = useRef(new Map<string, number>());
  const searchRef = useRef<HTMLInputElement>(null);
  const environmentIdRef = useRef(environmentId);
  const projectPathRef = useRef(projectPath);
  const projectEnvironmentIdRef = useRef(projectEnvironmentId);
  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const loadSidebarMetadataRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const loadStatsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [refreshQueues] = useState(() => ({
    sessions: createLatestTaskQueue<void>(),
    metadata: createLatestTaskQueue<void>(),
    stats: createLatestTaskQueue<void>(),
  }));
  environmentIdRef.current = environmentId;
  projectPathRef.current = projectPath;
  projectEnvironmentIdRef.current = projectEnvironmentId;
  appSettingsRef.current = appSettings;
  migrationDialogRef.current = migrationDialog;
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const searchScopeKey = useMemo(
    () => JSON.stringify([query, source, environmentId, tag ?? "", projectPath ?? "", projectEnvironmentId ?? "", visibility, dateRange, sortBy, liveStatus]),
    [query, source, environmentId, tag, projectPath, projectEnvironmentId, visibility, dateRange, sortBy, liveStatus],
  );
  const previousSearchScopeKeyRef = useRef(searchScopeKey);
  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const liveDetectionFailed = Boolean(liveSessions.error);
  const liveSearchKeys = useMemo(() => [...liveSessionKeys], [liveSessionKeys]);

  const searchAllMatching = useCallback(async (ignoreDate: boolean): Promise<SessionSearchResult[]> => {
    const searchScope = resolveSearchScope(environmentId, projectPath, projectEnvironmentId);
    if (searchScope.projectEnvironmentConflict) return [];
    const { dateFrom, dateTo } = ignoreDate ? { dateFrom: undefined, dateTo: undefined } : resolveDateRange(dateRange);
    const page = await window.sessionSearch.searchSessionPage({
      query,
      source,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy,
      dateFrom,
      dateTo,
      limit: 100_000,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys: liveDetectionFailed ? [] : liveSearchKeys,
    });
    if (page.hasMore) throw new Error(t("More than 100,000 sessions match. Narrow the filters first.", "匹配会话超过 100,000 个，请先缩小筛选范围。"));
    return page.sessions;
  }, [environmentId, projectPath, projectEnvironmentId, dateRange, query, source, tag, visibility, sortBy, liveStatus, liveDetectionFailed, liveSearchKeys, t]);

  const load = useCallback((): Promise<void> => {
    const requestId = ++loadSeqRef.current;
    const requestScopeKey = searchScopeKey;
    const searchScope = resolveSearchScope(environmentId, projectPath, projectEnvironmentId);
    const { dateFrom, dateTo } = resolveDateRange(dateRange);
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy,
      dateFrom,
      dateTo,
      limit: SESSION_PAGE_SIZE,
      offset: (sessionPage - 1) * SESSION_PAGE_SIZE,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys: liveDetectionFailed ? [] : liveSearchKeys,
    };
    return refreshQueues.sessions.request(async () => {
      const page = searchScope.projectEnvironmentConflict
        ? { sessions: [], totalCount: 0, hasMore: false }
        : await window.sessionSearch.searchSessionPage(options);
      if (requestId !== loadSeqRef.current) return;
      const lastPage = Math.max(1, Math.ceil(page.totalCount / SESSION_PAGE_SIZE));
      if (sessionPage > lastPage) {
        setSessionPage(lastPage);
        return;
      }
      startTransition(() => {
        setResults(page.sessions);
        setResultsScopeKey(requestScopeKey);
        setSessionTotalCount(page.totalCount);
        setSelectedKey((current) =>
          current && !page.sessions.some((session) => session.sessionKey === current) ? null : current,
        );
      });
    });
  }, [query, source, environmentId, tag, projectPath, projectEnvironmentId, visibility, dateRange, sortBy, sessionPage, liveStatus, liveDetectionFailed, liveSearchKeys, refreshQueues.sessions, searchScopeKey]);

  useEffect(() => {
    setBulkSelectionActive(false);
    setBulkSelectedKeys(new Set());
  }, [searchScopeKey]);

  const loadSidebarMetadata = useCallback((): Promise<void> => {
    const requestId = ++metadataLoadSeqRef.current;
    return refreshQueues.metadata.request(async () => {
      const nextEnvironments = await window.sessionSearch.listEnvironments();
      if (requestId !== metadataLoadSeqRef.current) return;
      setEnvironments(nextEnvironments);
      const nextTags = await window.sessionSearch.listTags();
      if (requestId !== metadataLoadSeqRef.current) return;
      setTags(nextTags);
      const nextProjects = await window.sessionSearch.listProjects();
      if (requestId !== metadataLoadSeqRef.current) return;
      setProjects(nextProjects);
      const nextProjectTags = await window.sessionSearch.listTagsByProject();
      if (requestId !== metadataLoadSeqRef.current) return;
      setProjectTags(nextProjectTags);
    });
  }, [refreshQueues.metadata]);

  const loadStats = useCallback((): Promise<void> => {
    const requestId = ++statsLoadSeqRef.current;
    return refreshQueues.stats.request(async () => {
      const nextStats = await window.sessionSearch.getStats({ period: statsPeriod });
      if (requestId !== statsLoadSeqRef.current) return;
      setStats(nextStats);
    });
  }, [refreshQueues.stats, statsPeriod]);

  loadRef.current = load;
  loadSidebarMetadataRef.current = loadSidebarMetadata;
  loadStatsRef.current = loadStats;

  const refreshAfterCompletedIndex = useCallback((status: IndexStatus): Promise<void> => {
    const refreshKey = JSON.stringify([
      status.lastIndexedAt,
      status.indexed,
      status.skipped,
      status.total,
      status.error,
    ]);
    if (completedIndexRefreshKeyRef.current === refreshKey) return completedIndexRefreshPromiseRef.current;
    completedIndexRefreshKeyRef.current = refreshKey;
    const refreshPromise = (async () => {
      await loadRef.current();
      await loadSidebarMetadataRef.current();
      await loadStatsRef.current();
    })().catch((error) => {
      if (completedIndexRefreshKeyRef.current === refreshKey) completedIndexRefreshKeyRef.current = null;
      throw error;
    });
    completedIndexRefreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, []);

  const fetchStatsTrend = useCallback(async () => {
    if (statsPeriod === "allTime") return;
    const requestId = ++statsTrendLoadSeqRef.current;
    setStatsTrendLoading(true);
    try {
      const nextTrend = await window.sessionSearch
        .getStatsTrend({ period: statsPeriod })
        .catch(() => ({ period: statsPeriod, granularity: null, buckets: [] }) as SessionStatsTrend);
      if (requestId !== statsTrendLoadSeqRef.current) return;
      setStatsTrend(nextTrend);
      setStatsTrendLoadedFor(statsPeriod);
    } finally {
      if (requestId === statsTrendLoadSeqRef.current) setStatsTrendLoading(false);
    }
  }, [statsPeriod]);

  const ensureStatsTrend = useCallback(() => {
    if (statsPeriod === "allTime") return;
    if (statsTrendLoadedFor === statsPeriod) return;
    void fetchStatsTrend();
  }, [statsPeriod, statsTrendLoadedFor, fetchStatsTrend]);

  useEffect(() => {
    setStatsTrend(EMPTY_STATS_TREND);
    setStatsTrendLoadedFor(null);
    ++statsTrendLoadSeqRef.current;
  }, [statsPeriod]);

  const loadQuotas = useCallback(async (mode: "initial" | "manual" | "background" = "initial") => {
    const background = mode === "background";
    if (!background) setQuotaLoading(true);
    if (mode === "manual") setQuotaFeedback({ kind: "running", message: t("Refreshing usage limits...", "正在刷新额度...") });
    try {
      const nextQuotas = await window.sessionSearch.getQuotas(mode === "manual");
      setQuotas(nextQuotas);
      if (mode === "manual") {
        const successMessage = t("Usage limits refreshed.", "额度已刷新。");
        setQuotaFeedback({ kind: "success", message: successMessage });
        window.setTimeout(() => {
          setQuotaFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
        }, 1800);
      }
    } catch (error) {
      // Background polls fail silently so a transient read error does not clobber the last good value.
      if (!background) setQuotaFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!background) setQuotaLoading(false);
    }
  }, [t]);

  const loadSkills = useCallback(async (options: { refreshUsage?: boolean; silent?: boolean } = {}) => {
    const refreshUsage = options.refreshUsage ?? false;
    const silent = options.silent ?? false;
    setSkillsLoading(true);
    setSkillsFeedback(refreshUsage && !silent ? { kind: "running", message: t("Refreshing skill usage...", "正在刷新 Skill 使用统计...") } : null);
    try {
      let usageStatus = null;
      let usageError: unknown = null;
      if (refreshUsage) {
        try {
          usageStatus = await window.sessionSearch.refreshSkillUsage();
        } catch (error) {
          usageError = error;
        }
      }
      const {
        installedSkills: nextSkills,
        skillSyncSnapshot: nextSkillSync,
        syncError,
      } = await loadSkillsPanelData({
        listSkills: () => window.sessionSearch.listSkills(),
        getSkillSyncSnapshot: () => window.sessionSearch.getSkillSyncSnapshot(),
        fallbackSyncSnapshot: skillSyncSnapshotRef.current,
      });
      setInstalledSkills(nextSkills);
      setSkillSyncSnapshot(nextSkillSync);
      if (usageError) {
        if (!silent) setSkillsFeedback({ kind: "error", message: usageError instanceof Error ? usageError.message : String(usageError) });
        return;
      }
      if (syncError) {
        if (!silent) setSkillsFeedback({ kind: "error", message: syncError.message });
        return;
      }
      if (usageStatus && !silent) {
        const message = t(
          `Skill usage refreshed. ${usageStatus.refreshed} changed, ${usageStatus.skipped} skipped.`,
          `Skill 使用统计已刷新：${usageStatus.refreshed} 个文件有变化，${usageStatus.skipped} 个未变化。`,
        );
        setSkillsFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setSkillsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
        }, 2200);
      }
    } catch (error) {
      if (!refreshUsage) {
        setInstalledSkills(EMPTY_SKILLS);
        setSkillSyncSnapshot(EMPTY_SKILL_SYNC);
      }
      setSkillsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillsLoading(false);
    }
  }, [t]);

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

  useEffect(() => {
    skillSyncSnapshotRef.current = skillSyncSnapshot;
  }, [skillSyncSnapshot]);

  const deleteSkill = useCallback(async (skill: InstalledSkill) => {
    setSkillsLoading(true);
    setSkillsFeedback({ kind: "running", message: t(`Deleting ${skill.name}...`, `正在删除 ${skill.name}...`) });
    try {
      const result = await window.sessionSearch.deleteSkill(skill.path);
      const [nextSkills, nextSkillSync] = await Promise.all([
        window.sessionSearch.listSkills(),
        window.sessionSearch.getSkillSyncSnapshot(),
      ]);
      setInstalledSkills(nextSkills);
      setSkillSyncSnapshot(nextSkillSync);
      const message = t(`Deleted ${result.skillName}.`, `已删除 ${result.skillName}。`);
      setSkillsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setSkillsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSkillsFeedback({ kind: "error", message });
      throw error;
    } finally {
      setSkillsLoading(false);
    }
  }, [t]);

  const uploadSkillToSync = useCallback(
    async (skill: InstalledSkill, force = false): Promise<SkillSyncUploadOutcome | null> => {
      setSkillsLoading(true);
      setSkillsFeedback({ kind: "running", message: t(`Uploading ${skill.name}...`, `正在上传 ${skill.name}...`) });
      try {
        const result = await window.sessionSearch.uploadSkillToSync(skill.path, force);
        if (result.status === "needs-confirmation") {
          setSkillsFeedback(null);
          return result;
        }
        await loadSkills({ silent: true });
        const message =
          result.status === "skipped"
            ? t(`${skill.name} is already the latest version (v${result.version}).`, `${skill.name} 已是最新版本（v${result.version}）。`)
            : t(`Uploaded ${result.remoteSkill.name} v${result.version}.`, `已上传 ${result.remoteSkill.name} v${result.version}。`);
        setSkillsFeedback({ kind: "success", message });
        window.setTimeout(() => {
          setSkillsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
        }, 2200);
        return result;
      } catch (error) {
        setSkillsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        return null;
      } finally {
        setSkillsLoading(false);
      }
    },
    [loadSkills, t],
  );

  const uploadSelectedSkillsToSync = useCallback(
    async (skills: InstalledSkill[]): Promise<{ remainingSkillIds: string[] }> => {
      const uploadable = skills.filter((skill) => skill.source !== "codex-system");
      if (uploadable.length === 0) {
        setSkillsFeedback({ kind: "error", message: t("No selected non-system skills to upload.", "没有选中可上传的非系统 Skill。") });
        return { remainingSkillIds: [] };
      }

      setSkillsLoading(true);
      setSkillsFeedback({ kind: "running", message: t(`Uploading ${uploadable.length} selected skills...`, `正在上传 ${uploadable.length} 个选中 Skill...`) });
      let uploaded = 0;
      let skipped = 0;
      let conflicts = 0;
      let failed = 0;
      const remainingSkillIds: string[] = [];
      const failureDetails: string[] = [];
      try {
        const outcomes = new Array<{ skill: InstalledSkill; result?: SkillSyncUploadOutcome; error?: unknown }>(uploadable.length);
        let nextIndex = 0;
        let completed = 0;
        const worker = async (): Promise<void> => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const skill = uploadable[index];
            if (!skill) return;
            try {
              outcomes[index] = { skill, result: await window.sessionSearch.uploadSkillToSync(skill.path, false) };
            } catch (error) {
              outcomes[index] = { skill, error };
            }
            completed += 1;
            setSkillsFeedback({
              kind: "running",
              message: t(
                `Uploading selected skills: ${completed}/${uploadable.length}...`,
                `正在上传所选 Skills：${completed}/${uploadable.length}...`,
              ),
            });
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, uploadable.length) }, () => worker()));
        for (const outcome of outcomes) {
          const { skill, result, error } = outcome;
          if (error) {
            failed += 1;
            remainingSkillIds.push(skill.id);
            failureDetails.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          if (!result) continue;
          if (result.status === "uploaded") uploaded += 1;
          else if (result.status === "skipped") skipped += 1;
          else {
            conflicts += 1;
            remainingSkillIds.push(skill.id);
            failureDetails.push(t(`${skill.name}: confirm before replacing the existing remote source.`, `${skill.name}：需要确认是否替换现有远程来源。`));
          }
        }
        await loadSkills({ silent: true });
        const summary = t(
          `Selected skills upload finished: ${uploaded} uploaded, ${skipped} skipped, ${conflicts} need confirmation, ${failed} failed.`,
          `选中 Skills 上传完成：${uploaded} 个已上传，${skipped} 个已跳过，${conflicts} 个需要确认，${failed} 个失败。`,
        );
        const shownFailures = failureDetails.slice(0, 3).join(" · ");
        const hiddenFailureCount = Math.max(0, failureDetails.length - 3);
        const message = shownFailures
          ? `${summary} ${t("Details", "详情")}：${shownFailures}${hiddenFailureCount ? t(` · ${hiddenFailureCount} more`, ` · 另有 ${hiddenFailureCount} 个`) : ""}`
          : summary;
        setSkillsFeedback({ kind: failed > 0 || conflicts > 0 ? "error" : "success", message });
        window.setTimeout(() => {
          setSkillsFeedback((current) => (current?.message === message ? null : current));
        }, 4200);
        return { remainingSkillIds };
      } finally {
        setSkillsLoading(false);
      }
    },
    [loadSkills, t],
  );

  const installSyncedSkill = useCallback(async (remoteSkillId: string) => {
    setSkillsLoading(true);
    setSkillsFeedback({ kind: "running", message: t("Installing remote skill...", "正在安装远程 Skill...") });
    try {
      const result = await window.sessionSearch.installSyncedSkill(remoteSkillId);
      await loadSkills({ silent: true });
      const verb = result.overwritten ? t("Updated", "已更新") : t("Installed", "已安装");
      const message = `${verb} ${result.remoteSkill.name} v${result.remoteSkill.version}.`;
      setSkillsFeedback({ kind: "success", message });
      window.setTimeout(() => {
        setSkillsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current));
      }, 2200);
    } catch (error) {
      setSkillsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillsLoading(false);
    }
  }, [loadSkills, t]);

  const fetchSyncedSkillVersion = useCallback((remoteSkillId: string): Promise<RemoteSkill> => {
    return window.sessionSearch.getSyncedSkillVersion(remoteSkillId);
  }, []);

  const copySkillSyncSetupSql = useCallback(async () => {
    try {
      await window.sessionSearch.copySkillSyncSetupSql();
      setSkillsFeedback({ kind: "success", message: t("Supabase setup SQL copied.", "Supabase 初始化 SQL 已复制。") });
    } catch (error) {
      setSkillsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [t]);

  const refreshLiveSessions = useCallback(async () => {
    try {
      setLiveSessions(await window.sessionSearch.getLiveSessions());
    } catch (error) {
      setLiveSessions({
        generatedAt: new Date().toISOString(),
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    const scopeChanged = previousSearchScopeKeyRef.current !== searchScopeKey;
    previousSearchScopeKeyRef.current = searchScopeKey;
    if (scopeChanged) {
      if (sessionPage !== 1) {
        setSessionPage(1);
        return;
      }
    }
    void load();
  }, [load, searchScopeKey, sessionPage]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadQuotas(), 100);
    const timer = window.setInterval(() => void loadQuotas("background"), QUOTA_REFRESH_INTERVAL_MS);
    const unsubscribe = window.sessionSearch.onQuotaUpdated((snapshot) => setQuotas(snapshot));
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [loadQuotas]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSidebarMetadata().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSidebarMetadata]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStats().catch((error) => {
        setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [loadStats]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLiveSessions(), 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [refreshLiveSessions]);

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
    if (skillsOpen) void loadSkills({ refreshUsage: true, silent: true });
  }, [skillsOpen, loadSkills]);

  const loadDigitalAssets = useCallback(() => {
    void window.sessionSearch.getRulesSyncSnapshot().then(setRulesSnapshot).catch(() => setRulesSnapshot(null));
    void window.sessionSearch.getMemoriesSyncSnapshot().then(setMemoriesSnapshot).catch(() => setMemoriesSnapshot(null));
  }, []);

  useEffect(() => {
    if (assetsOpen) loadDigitalAssets();
  }, [assetsOpen, loadDigitalAssets]);

  const loadSavedSearches = useCallback(() => {
    void window.sessionSearch.listSavedSearches().then(setSavedSearches).catch(() => setSavedSearches([]));
  }, []);

  useEffect(() => {
    if (savedSearchesOpen) loadSavedSearches();
  }, [savedSearchesOpen, loadSavedSearches]);

  const applyQueryBuilder = useCallback((state: QueryBuilderState) => {
    setSource(state.source ?? "all");
    setTag(state.tag);
    setVisibility(state.visibility);
    setDateRange(state.dateRange);
    setQueryBuilderOpen(false);
  }, []);

  const applySavedSearch = useCallback((saved: SavedSearch) => {
    const options = saved.options;
    if (options.query !== undefined) setQuery(options.query);
    setSource(options.source ?? "all");
    setTag(options.tag);
    setVisibility(options.visibility ?? "default");
    void window.sessionSearch.touchSavedSearch(saved.id).then(loadSavedSearches).catch(() => undefined);
    setSavedSearchesOpen(false);
  }, [loadSavedSearches]);

  const deleteSavedSearchById = useCallback((id: number) => {
    void window.sessionSearch.deleteSavedSearch(id).then(loadSavedSearches).catch(() => undefined);
  }, [loadSavedSearches]);

  const saveCurrentSearch = useCallback((name: string, state: QueryBuilderState) => {
    const options: SearchOptions = { query, ...toSearchOptionsPatch(state) };
    void window.sessionSearch.createSavedSearch(name, options).then(loadSavedSearches).catch(() => undefined);
  }, [query, loadSavedSearches]);

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
      if (skillsOpen) void loadSkills({ refreshUsage: true, silent: true });
      const message = enabled ? t("Skill usage tracking on.", "已开启 Skill 使用统计。") : t("Skill usage tracking off.", "已关闭 Skill 使用统计。");
      setSettingsFeedback({ kind: "success", message });
      window.setTimeout(() => setSettingsFeedback((current) => (current?.kind === "success" && current.message === message ? null : current)), 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillHookBusy(false);
    }
  }, [skillsOpen, loadSkills, t]);

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
    const timer = window.setInterval(() => void refreshLiveSessions(), LIVE_SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshLiveSessions]);

  useEffect(() => {
    void window.sessionSearch.getSettings().then(setAppSettings);
  }, []);

  useEffect(() => {
    if (!appSettings) return;
    if (OPTIONAL_SOURCE_SETTINGS.some((item) => source === item.filter && !appSettings[item.key])) setSource("all");
  }, [source, appSettings]);

  useEffect(() => {
    if (environmentId !== "all" && environments.length > 0 && !environments.some((environment) => environment.id === environmentId)) {
      setEnvironmentId("all");
    }
    if (projectEnvironmentId && environments.length > 0 && !environments.some((environment) => environment.id === projectEnvironmentId)) {
      clearProjectFilter();
    }
  }, [environmentId, environments, projectEnvironmentId]);

  useEffect(() => {
    if (tag && tags.length > 0 && !tags.includes(tag)) {
      setTag(undefined);
    }
  }, [tag, tags]);

  useEffect(() => {
    if (
      projectPath &&
      projects.length > 0 &&
      !projects.some((project) =>
        projectEnvironmentId
          ? project.path === projectPath && project.environmentId === projectEnvironmentId
          : project.path === projectPath,
      )
    ) {
      setProjectPath(undefined);
      setProjectEnvironmentId(undefined);
      projectPathRef.current = undefined;
      projectEnvironmentIdRef.current = undefined;
    }
  }, [projectPath, projectEnvironmentId, projects]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useLayoutEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--message-font-size", messageFontSizeCss(messageFontSize));
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
      indexRunningRef.current = nextStatus.running;
      setIndexStatus((current) => coalesceIndexStatusForRender(current, nextStatus));
      setRefreshFeedback((current) => reduceIndexFeedback(current, { type: "index-status", status: nextStatus }));
    };
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      indexStatusEventVersionRef.current += 1;
      applyIndexStatus(nextStatus);
      if (!nextStatus.running) {
        setSessionFamilyRefreshVersion((current) => current + 1);
        void refreshAfterCompletedIndex(nextStatus).catch((error) => {
          setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        });
      }
    });
    void window.sessionSearch.getIndexStatus()
      .then((nextStatus) => {
        if (active && indexStatusEventVersionRef.current === snapshotEventVersion) applyIndexStatus(nextStatus);
      })
      .catch(() => undefined);
    const offFocus = window.sessionSearch.onFocusSearch(() => searchRef.current?.focus());
    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      setSkillsOpen(false);
      setApiConfigOpen(false);
      setSettingsInitialSection("terminal");
      setSettingsOpen(true);
    });
    const offAppUpdate = window.sessionSearch.onAppUpdateStatus(setAppUpdateStatus);
    const offAppUpdateProgress = window.sessionSearch.onAppUpdateProgress((progress) => {
      setAppUpdateProgress(progress);
      if (progress.phase === "error") {
        setAppUpdateError(progress.error || progress.message || "更新失败。");
        setAppUpdateBusy(false);
      } else if (progress.phase === "completed") {
        setAppUpdateBusy(false);
      }
    });
    const offOpenSession = window.sessionSearch.onOpenSession((sessionKey) => setSelectedKey(sessionKey));
    const offEnvironments = window.sessionSearch.onEnvironmentsUpdated((nextEnvironments) => {
      setSessionFamilyRefreshVersion((current) => current + 1);
      setEnvironments(nextEnvironments);
      setEnvironmentId((current) =>
        current !== "all" && !nextEnvironments.some((environment) => environment.id === current) ? "all" : current,
      );
      setProjectEnvironmentId((current) => {
        if (current && !nextEnvironments.some((environment) => environment.id === current)) {
          setProjectPath(undefined);
          return undefined;
        }
        return current;
      });
      if (!indexRunningRef.current) void loadRef.current();
    });
    return () => {
      active = false;
      offIndex();
      offFocus();
      offOpenSettings();
      offAppUpdate();
      offAppUpdateProgress();
      offOpenSession();
      offEnvironments();
    };
  }, [refreshAfterCompletedIndex]);

  useEffect(() => {
    void window.sessionSearch.getAppUpdateStatus(false).then(setAppUpdateStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.sessionSearch.onMigrationProgress((progress) => {
      setMigrationProgress(progress);
      setActionStatus({ kind: "running", message: migrationProgressMessage(progress, language) });
    });
  }, [language]);

  const resultsMatchSearchScope = resultsScopeKey === searchScopeKey;
  const displayedResults = useMemo(
    () => filterSessionsByLiveStatus(resultsMatchSearchScope ? results : [], liveSessionKeys, liveStatus, liveDetectionFailed),
    [resultsMatchSearchScope, results, liveSessionKeys, liveStatus, liveDetectionFailed],
  );
  const displayedSessionTotalCount = resultsMatchSearchScope ? sessionTotalCount : 0;
  const selected = useMemo(
    () => displayedResults.find((session) => session.sessionKey === selectedKey) || null,
    [displayedResults, selectedKey],
  );
  const focusMainSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);
  useMainSearchShortcut(
    !(detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || bulkDeleteDialog || deleteTagName || contextMenu || skillsOpen || assetsOpen || apiConfigOpen || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen),
    focusMainSearch,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setContextMenu(null);
        setSkillsOpen(false);
        setApiConfigOpen(false);
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
        else if (skillsOpen) setSkillsOpen(false);
        else if (assetsOpen) setAssetsOpen(false);
        else if (apiConfigOpen) setApiConfigOpen(false);
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
      if (detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || bulkDeleteDialog || deleteTagName || contextMenu || skillsOpen || apiConfigOpen || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen) return;

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
  }, [displayedResults, selectedKey, detail, remoteDetail, dialog, migrationDialog, deleteSessionCandidate, deletingSession, bulkDeleteDialog, bulkDeleteBusy, deleteTagName, contextMenu, skillsOpen, apiConfigOpen, aiAssistantOpen, settingsOpen, sshDialogOpen, wslDialogOpen, remoteSessionsOpen, actionStatus, t]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail || remoteDetail || bulkDeleteDialog || skillsOpen || assetsOpen || apiConfigOpen || aiAssistantOpen || settingsOpen || sshDialogOpen || wslDialogOpen || remoteSessionsOpen));
    return () => document.body.classList.remove("overlay-open");
  }, [detail, remoteDetail, bulkDeleteDialog, skillsOpen, apiConfigOpen, aiAssistantOpen, settingsOpen, sshDialogOpen, wslDialogOpen, remoteSessionsOpen]);

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
  const selectedProjectLabel = selectedProject ? projectDisplayLabel(selectedProject, language) : "";
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
  const searchPlaceholder = projectPath
    ? t(`Search within ${selectedProjectLabel || "project"}`, `在 ${selectedProjectLabel || "项目"} 中搜索`)
    : tag
      ? t(`Search within ${displayTagName(tag)}`, `在 ${displayTagName(tag)} 中搜索`)
      : t("Search titles, first questions, full text, paths, or ids", "搜索标题、首个问题、全文、路径或 ID");

  useEffect(() => {
    setSelectedKey((current) =>
      current && !displayedResults.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [displayedResults]);

  function toggleSidebarSectionById(section: SidebarSectionId): void {
    setSidebarSections((current) => toggleSidebarSection(current, section));
  }

  function clearProjectFilter(): void {
    setProjectPath(undefined);
    setProjectEnvironmentId(undefined);
    projectPathRef.current = undefined;
    projectEnvironmentIdRef.current = undefined;
  }

  function selectEnvironment(nextEnvironmentId: string | "all"): void {
    if (nextEnvironmentId === environmentId) return;
    setEnvironmentId(nextEnvironmentId);
    environmentIdRef.current = nextEnvironmentId;
  }

  function selectProject(project: ProjectSummary): void {
    if (project.path === projectPath && project.environmentId === projectEnvironmentId) return;
    setProjectPath(project.path);
    setProjectEnvironmentId(project.environmentId);
    projectPathRef.current = project.path;
    projectEnvironmentIdRef.current = project.environmentId;
  }

  async function openDetail(session: SessionSearchResult, matchHit?: SessionMatchHit): Promise<void> {
    const requestId = ++detailLoadSeqRef.current;
    setContextMenu(null);
    setRemoteDetail(null);
    setDetail(session);
    setMessages([]);
    setMatchedContextMessages([]);
    setMatchedMessageIndex(matchHit?.messageIndex ?? null);
    setMessageOffset(0);
    setTraceEvents([]);
    setMessagesLoading(true);

    const sessionKey = session.sessionKey;
    try {
      const fresh = await window.sessionSearch.getSession(sessionKey);
      if (requestId !== detailLoadSeqRef.current) return;
      if (!fresh) {
        setMessagesLoading(false);
        return;
      }

      const initialOffset = Math.max(0, fresh.messageCount - INITIAL_MESSAGE_LIMIT);
      const [loadedMessages, loadedMatchContext] = await Promise.all([
        window.sessionSearch.getMessages(sessionKey, initialOffset, INITIAL_MESSAGE_LIMIT),
        matchHit
          ? window.sessionSearch.getMessages(sessionKey, Math.max(0, matchHit.messageIndex - 1), 3)
          : Promise.resolve([]),
      ]);
      if (requestId !== detailLoadSeqRef.current) return;
      const loadedTraceEvents = await window.sessionSearch.getTraceEvents(sessionKey, traceWindowForMessages(loadedMessages));
      if (requestId !== detailLoadSeqRef.current) return;

      setDetail(fresh);
      setMessageOffset(initialOffset);
      setMessages(loadedMessages);
      setMatchedContextMessages(loadedMatchContext);
      setTraceEvents(loadedTraceEvents);
      setMessagesLoading(false);
    } catch (error) {
      if (requestId === detailLoadSeqRef.current) {
        setMessagesLoading(false);
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  function closeDetail(): void {
    detailLoadSeqRef.current++;
    setDetail(null);
    setMessages([]);
    setMatchedContextMessages([]);
    setMatchedMessageIndex(null);
    setMessageOffset(0);
    setTraceEvents([]);
    setMessagesLoading(false);
  }

  function openRemoteDetail(snapshot: RemoteSessionDetailSnapshot, detailQuery: string): void {
    detailLoadSeqRef.current++;
    setDetail(null);
    setMessages([]);
    setMessageOffset(0);
    setTraceEvents([]);
    setMessagesLoading(false);
    setRemoteDetail({ snapshot, query: detailQuery });
  }

  function closeRemoteDetail(): void {
    setRemoteDetail(null);
  }

  async function loadMoreMessages(): Promise<void> {
    if (!detail || messagesLoading || messageOffset <= 0) return;
    const requestId = detailLoadSeqRef.current;
    const sessionKey = detail.sessionKey;
    const nextOffset = Math.max(0, messageOffset - MESSAGE_PAGE_SIZE);
    const limit = messageOffset - nextOffset;
    setMessagesLoading(true);
    try {
      const nextMessages = await window.sessionSearch.getMessages(sessionKey, nextOffset, limit);
      const nextTraceEvents = await window.sessionSearch.getTraceEvents(sessionKey, traceWindowForMessages(nextMessages));
      if (requestId !== detailLoadSeqRef.current) return;
      setMessageOffset(nextOffset);
      setMessages((current) => [...nextMessages, ...current]);
      setTraceEvents((current) => mergeTraceEventsByIndex(current, nextTraceEvents));
    } catch (error) {
      if (requestId === detailLoadSeqRef.current) {
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestId === detailLoadSeqRef.current) setMessagesLoading(false);
    }
  }

  async function refreshAfterAction(options: { metadata?: boolean; stats?: boolean } = {}): Promise<void> {
    await load();
    if (options.metadata) await loadSidebarMetadata();
    if (options.stats) await loadStats();
    if (detail) {
      const fresh = await window.sessionSearch.getSession(detail.sessionKey);
      if (fresh) setDetail(fresh);
    }
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
    await refreshAfterAction({ metadata: dialogKind === "rename" || (dialogKind === "tag" && Boolean(value)) });
  }

  async function removeTag(session: SessionSearchResult, tagName: string): Promise<void> {
    await window.sessionSearch.removeTag(session.sessionKey, tagName);
    await refreshAfterAction({ metadata: true });
  }

  function applyFavoriteState(sessionKey: string, favorited: boolean): void {
    setResults((current) => current
      .map((session) => session.sessionKey === sessionKey ? { ...session, favorited } : session)
      .filter((session) => visibility !== "favorites" || session.favorited));
    setDetail((current) => current?.sessionKey === sessionKey ? { ...current, favorited } : current);
    setContextMenu((current) => current?.session.sessionKey === sessionKey
      ? { ...current, session: { ...current.session, favorited } }
      : current);
  }

  async function toggleFavorite(session: SessionSearchResult): Promise<void> {
    const nextFavorited = !session.favorited;
    const version = (favoriteSaveVersionsRef.current.get(session.sessionKey) ?? 0) + 1;
    favoriteSaveVersionsRef.current.set(session.sessionKey, version);
    applyFavoriteState(session.sessionKey, nextFavorited);
    let queue = favoriteSaveQueuesRef.current.get(session.sessionKey);
    if (!queue) {
      queue = createLatestTaskQueue<void>();
      favoriteSaveQueuesRef.current.set(session.sessionKey, queue);
    }
    try {
      await queue.request(() => window.sessionSearch.setFavorited(session.sessionKey, nextFavorited));
      if (favoriteSaveVersionsRef.current.get(session.sessionKey) === version) {
        await refreshAfterAction();
      }
    } catch (error) {
      if (favoriteSaveVersionsRef.current.get(session.sessionKey) === version) {
        const fresh = await window.sessionSearch.getSession(session.sessionKey).catch(() => null);
        if (fresh) applyFavoriteState(session.sessionKey, fresh.favorited);
        await refreshAfterAction().catch(() => undefined);
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (favoriteSaveVersionsRef.current.get(session.sessionKey) === version) {
        favoriteSaveVersionsRef.current.delete(session.sessionKey);
        favoriteSaveQueuesRef.current.delete(session.sessionKey);
      }
    }
  }

  async function summarizeDetail(session: SessionSearchResult): Promise<void> {
    if (summarizing) return;
    setSummarizing(true);
    setActionStatus({ kind: "running", message: t("Generating AI summary...", "正在生成 AI 摘要...") });
    try {
      const updated = await window.sessionSearch.summarizeSession(session.sessionKey);
      if (updated) setDetail(updated);
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
    if (detail) {
      const fresh = await window.sessionSearch.getSession(detail.sessionKey);
      if (fresh) setDetail(fresh);
    }
  }

  function requestDeleteSession(session: SessionSearchResult): void {
    setContextMenu(null);
    setDeleteSessionCandidate(session);
    setDeleteSessionCascadeCount(null);
    setDeleteSessionBlockedMessage(null);
    const previewId = ++deleteSessionPreviewId.current;
    void freshLiveKeysForBulkDelete()
      .then((liveSessionKeys) => window.sessionSearch.previewBulkDelete({
        sessionKeys: [session.sessionKey],
        liveSessionKeys,
        protectFavorites: false,
      }))
      .then((preview) => {
        if (deleteSessionPreviewId.current !== previewId) return;
        setDeleteSessionCascadeCount(preview.expandedCount);
        if (preview.skipped.some((issue) => issue.reason === "live")) {
          setDeleteSessionBlockedMessage(t(
            "A related session is currently live. Stop it before deleting this session tree.",
            "关联会话正在运行，请先停止后再删除整棵会话树。",
          ));
        }
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
    setDeletingSession(true);
    setActionStatus({ kind: "running", message: t("Deleting session...", "正在删除会话...") });
    try {
      const removed = await window.sessionSearch.deleteSession(session.sessionKey);
      setDeleteSessionCandidate(null);
      setDeleteSessionCascadeCount(null);
      setDeleteSessionBlockedMessage(null);
      if (removed) {
        if (detail?.sessionKey === session.sessionKey) closeDetail();
        setSelectedKey((current) => (current === session.sessionKey ? null : current));
        await refreshAfterAction({ metadata: true, stats: true });
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
      const message = rawMessage === "A related session is currently live. Stop it before deleting this session tree."
        ? t(rawMessage, "关联会话正在运行，请先停止后再删除整棵会话树。")
        : rawMessage;
      if (rawMessage === "A related session is currently live. Stop it before deleting this session tree.") {
        setDeleteSessionBlockedMessage(message);
      }
      setActionStatus({ kind: "error", message });
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

  async function freshLiveKeysForBulkDelete(): Promise<string[]> {
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
      return snapshot.sessions.map(liveSessionDeleteKey);
    } catch {
      setActionStatus({
        kind: "error",
        message: t(
          "Could not verify running sessions. Confirm that related sessions have stopped before deleting.",
          "无法确认正在运行的会话，请在删除前确认相关会话已经停止。",
        ),
      });
      return [];
    }
  }

  async function previewSelectedSessions(): Promise<void> {
    if (bulkSelectedKeys.size === 0 || bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    try {
      const sessions = (await searchAllMatching(false)).filter((session) => bulkSelectedKeys.has(session.sessionKey));
      const request: SessionBulkDeleteRequest = {
        sessionKeys: sessions.map((session) => session.sessionKey),
        liveSessionKeys: await freshLiveKeysForBulkDelete(),
        protectFavorites: false,
      };
      const preview = await window.sessionSearch.previewBulkDelete(request);
      setBulkDeleteDialog({
        mode: "selection",
        dateValue: "",
        request,
        preview,
        favoriteCount: sessions.filter((session) => session.favorited).length,
      });
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
      const request: SessionBulkDeleteRequest = {
        sessionKeys: [],
        liveSessionKeys: await freshLiveKeysForBulkDelete(),
        includeOrphanedSubagents: true,
        protectFavorites: false,
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
      const request: SessionBulkDeleteRequest = {
        sessionKeys: sessions.map((session) => session.sessionKey),
        liveSessionKeys: await freshLiveKeysForBulkDelete(),
        inactiveBefore,
        protectFavorites: true,
      };
      const preview = await window.sessionSearch.previewBulkDelete(request);
      setBulkDeleteDialog((current) => current ? { ...current, request, preview } : current);
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBulkDeleteBusy(false);
    }
  }

  async function confirmBulkDelete(): Promise<void> {
    if (!bulkDeleteDialog?.request || !bulkDeleteDialog.preview || bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    setActionStatus({ kind: "running", message: t("Deleting sessions...", "正在批量删除会话...") });
    try {
      const result = await window.sessionSearch.bulkDeleteSessions(bulkDeleteDialog.request);
      if (detail && result.deletedSessionKeys.includes(detail.sessionKey)) closeDetail();
      setBulkSelectedKeys((current) => {
        const next = new Set(current);
        for (const sessionKey of result.deletedSessionKeys) next.delete(sessionKey);
        return next;
      });
      setBulkDeleteDialog(null);
      await refreshAfterAction({ metadata: true, stats: true });
      setActionStatus({
        kind: result.failed.length > 0 ? "error" : "success",
        message: result.failed.length > 0
          ? t(`Deleted ${result.deletedSessionKeys.length}; ${result.failed.length} failed.`, `已删除 ${result.deletedSessionKeys.length} 个，${result.failed.length} 个失败。`)
          : t(`Deleted ${result.deletedSessionKeys.length} sessions.`, `已删除 ${result.deletedSessionKeys.length} 个会话。`),
      });
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
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

  function closeMigrationDialog(): void {
    migrationDialogRef.current = null;
    setMigrationDialog(null);
  }

  async function runMigration(target: SessionMigrationProgress["target"]): Promise<void> {
    if (!migrationDialog || migrationDialog.kind !== "select") return;
    const session = migrationDialog.session;
    setMigrationBusy(true);
    setContextMenu(null);
    setMigrationProgress(null);
    setActionStatus({ kind: "running", message: t("Preparing migration...", "正在准备迁移...") });
    try {
      const result: SessionMigrationResult = await window.sessionSearch.migrateSession(session.sessionKey, target);
      await refreshAfterAction({ metadata: true, stats: true });
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
      message: t("Refreshing index and usage...", "正在更新索引和用量..."),
    }));
    setStatsFeedback({ kind: "running", message: t("Refreshing usage...", "正在刷新用量...") });
    try {
      const status = await window.sessionSearch.refreshIndex();
      indexRunningRef.current = status.running;
      setIndexStatus(status);
      await refreshAfterCompletedIndex(status);
      if (statsPeriod !== "allTime") await fetchStatsTrend();
      const successMessage = t(
        `Index and usage refreshed: ${status.indexed} updated, ${status.skipped} skipped, ${status.total} total.`,
        `索引和用量已更新：更新 ${status.indexed} 个，跳过 ${status.skipped} 个，共 ${status.total} 个。`,
      );
      setRefreshFeedback((current) => reduceIndexFeedback(current, {
        type: "manual-result",
        status,
        successMessage,
      }));
      if (status.error) {
        setStatsFeedback({ kind: "error", message: status.error });
        return;
      }
      const statsSuccessMessage = t("Usage refreshed.", "用量已刷新。");
      setStatsFeedback({ kind: "success", message: statsSuccessMessage });
      window.setTimeout(() => {
        setRefreshFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
        setStatsFeedback((current) => (current?.kind === "success" && current.message === statsSuccessMessage ? null : current));
      }, 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRefreshFeedback((current) => reduceIndexFeedback(current, { type: "manual-error", message }));
      setStatsFeedback({ kind: "error", message });
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
        } else {
          await window.sessionSearch.settleDisabledSources();
        }
        await refreshAfterAction({ metadata: true, stats: true });
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
  const openFamilySessionAction = useCallback(async (sessionKey: string): Promise<FamilySessionOpenResult> => {
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
      await rowHandlersRef.current.openDetail(session);
      return "opened";
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return "failed";
    }
  }, [t]);
  const {
    family: sessionFamily,
    loadFailed: sessionFamilyLoadFailed,
    retry: retrySessionFamily,
    open: openFamilySession,
  } = useSessionFamily({
    sessionKey: detail?.sessionKey ?? null,
    refreshVersion: sessionFamilyRefreshVersion,
    onOpen: openFamilySessionAction,
  });
  const handleRowContextMenu = useCallback((event: ReactMouseEvent, session: SessionSearchResult) => {
    event.preventDefault();
    setSelectedKey(session.sessionKey);
    setContextMenu({ x: event.clientX, y: event.clientY, session });
  }, []);

  return (
    <main className="app" data-theme={theme} data-platform={RUNTIME_PLATFORM} onClick={() => setContextMenu(null)}>
      <div className="titlebar-drag" />
      <Sidebar
        language={language}
        sidebarSections={sidebarSections}
        onToggleSection={toggleSidebarSectionById}
        indexStatus={indexStatus}
        refreshFeedback={refreshFeedback}
        onRefreshNow={() => void refreshNow()}
        stats={stats}
        statsPeriod={statsPeriod}
        onStatsPeriodChange={setStatsPeriod}
        statsFeedback={statsFeedback}
        statsTrend={statsTrend}
        statsTrendLoading={statsTrendLoading}
        onEnsureStatsTrend={ensureStatsTrend}
        quotas={quotas}
        quotaLoading={quotaLoading}
        quotaFeedback={quotaFeedback}
        onRefreshQuotas={() => void loadQuotas("manual")}
        sidebarTree={sidebarTree}
        collapsedProjectGroups={collapsedProjectGroups}
        collapsedTreeProjects={collapsedTreeProjects}
        onToggleProjectGroup={toggleProjectGroup}
        onToggleTreeProject={toggleTreeProject}
        environmentId={environmentId}
        projectPath={projectPath}
        projectEnvironmentId={projectEnvironmentId}
        tag={tag}
        onSelectAllSessions={() => { selectEnvironment("all"); clearProjectFilter(); setTag(undefined); }}
        onSelectEnvironment={(groupId) => { selectEnvironment(groupId); clearProjectFilter(); setTag(undefined); }}
        onSelectProject={(project) => {
          setProjectPath(project.path);
          setProjectEnvironmentId(project.environmentId);
          projectPathRef.current = project.path;
          projectEnvironmentIdRef.current = project.environmentId;
          setTag(undefined);
        }}
        onSelectTag={(tagName, project) => {
          if (tag === tagName && projectPath === project.path && projectEnvironmentId === project.environmentId) {
            setTag(undefined);
          } else {
            setTag(tagName);
            setProjectPath(project.path);
            setProjectEnvironmentId(project.environmentId);
            projectPathRef.current = project.path;
            projectEnvironmentIdRef.current = project.environmentId;
          }
        }}
        onDeleteTag={setDeleteTagName}
        sourceFilters={visibleSourceFilters}
        source={source}
        onSelectSource={setSource}
        visibility={visibility}
        onSelectVisibility={setVisibility}
      />

      <ContentArea
        language={language}
        toolbar={{
          language,
          platform: RUNTIME_PLATFORM,
          searchRef,
          searchPlaceholder,
          onSearch: setQuery,
          activeFilterCount: countActiveFilters({ source: source === "all" ? undefined : source, tag, visibility, dateRange }),
          queryBuilderOpen,
          onToggleQueryBuilder: () => {
            setSavedSearchesOpen(false);
            setQueryBuilderOpen((value) => !value);
          },
          savedSearchesOpen,
          onToggleSavedSearches: () => {
            setQueryBuilderOpen(false);
            setSavedSearchesOpen((value) => !value);
          },
          groupMode,
          onCycleGroupMode: () => setGroupMode((current) => (current === "flat" ? "project" : current === "project" ? "source" : current === "source" ? "time" : "flat")),
          liveStatus,
          onSelectLiveStatus: setLiveStatus,
          dateRange,
          onSelectDateRange: setDateRange,
          sortBy,
          onSelectSortBy: setSortBy,
          aiAssistantOpen,
          onOpenAiAssistant: () => {
            setSettingsOpen(false);
            setApiConfigOpen(false);
            setSkillsOpen(false);
            setRemoteSessionsOpen(false);
            setAiAssistantOpen(true);
          },
          skillsOpen,
          onOpenSkills: () => {
            setSettingsOpen(false);
            setApiConfigOpen(false);
            setRemoteSessionsOpen(false);
            setSkillsOpen(true);
          },
          assetsOpen,
          onOpenAssets: () => {
            setSettingsOpen(false);
            setApiConfigOpen(false);
            setRemoteSessionsOpen(false);
            setSkillsOpen(false);
            setAssetsOpen(true);
          },
          remoteSessionsOpen,
          onOpenRemoteSessions: () => {
            setSettingsOpen(false);
            setApiConfigOpen(false);
            setSkillsOpen(false);
            setRemoteSessionsOpen(true);
          },
          apiConfigOpen,
          onOpenApiConfig: () => {
            setSkillsOpen(false);
            setSettingsOpen(false);
            setRemoteSessionsOpen(false);
            setApiConfigOpen(true);
          },
          shouldSignalAppUpdate,
          onOpenSettings: () => {
            setSkillsOpen(false);
            setApiConfigOpen(false);
            setRemoteSessionsOpen(false);
            setSettingsInitialSection(shouldSignalAppUpdate ? "about" : "terminal");
            setSettingsOpen(true);
          },
        }}
        queryBuilderOpen={queryBuilderOpen}
        queryBuilderInitial={{ source: source === "all" ? undefined : source, tag, visibility, dateRange }}
        sourceOptions={visibleSourceFilters}
        tagOptions={tags}
        onApplyQueryBuilder={applyQueryBuilder}
        onCloseQueryBuilder={() => setQueryBuilderOpen(false)}
        onSaveSearch={saveCurrentSearch}
        savedSearchesOpen={savedSearchesOpen}
        savedSearches={savedSearches}
        onApplySavedSearch={applySavedSearch}
        onDeleteSavedSearch={deleteSavedSearchById}
        onCloseSavedSearches={() => setSavedSearchesOpen(false)}
        resultsHeader={
          <div className="result-count">
            <div className="bulk-result-actions">
              {bulkSelectionActive ? <input
                type="checkbox"
                checked={displayedResults.length > 0 && displayedResults.every((session) => bulkSelectedKeys.has(session.sessionKey))}
                onChange={toggleLoadedSelection}
                aria-label={t("Select loaded sessions", "选择已加载会话")}
              /> : null}
              <span>{t(`${displayedSessionTotalCount} sessions`, `${displayedSessionTotalCount} 个会话`)}</span>
              {bulkSelectionActive ? <strong>{t(`${bulkSelectedKeys.size} selected`, `已选 ${bulkSelectedKeys.size} 个`)}</strong> : null}
              {bulkSelectionActive && bulkSelectedKeys.size > 0 && bulkSelectedKeys.size < displayedSessionTotalCount ? (
                <button type="button" onClick={() => void selectAllMatchingSessions()}>{t(`Select all ${displayedSessionTotalCount}`, `选择全部 ${displayedSessionTotalCount} 个`)}</button>
              ) : null}
              {bulkSelectionActive && bulkSelectedKeys.size > 0 ? (
                <button type="button" className="bulk-delete-button" onClick={() => void previewSelectedSessions()}><Trash2 size={13} />{t("Delete", "删除")}</button>
              ) : null}
              {bulkSelectionActive ? (
                <button type="button" onClick={exitBulkSelection} title={t("Exit multi-select", "退出多选")} aria-label={t("Exit multi-select", "退出多选")}><X size={13} /></button>
              ) : null}
              <button type="button" onClick={openDateCleanup}><CalendarDays size={13} />{t("Clean up", "按日期清理")}</button>
              <button type="button" onClick={() => void openOrphanCleanup()}><Trash2 size={13} />{t("Leftover Subagent Chats", "清理残留子对话")}</button>
            </div>
            {selected ? <span className="selected-path">{selected.projectPath || selected.rawId}</span> : null}
          </div>
        }
        sessions={displayedResults}
        groupMode={groupMode}
        sortBy={sortBy}
        selectedKey={selected?.sessionKey ?? null}
        liveStateFor={(session) => getLiveSessionState(session, liveSessionKeys, liveDetectionFailed)}
        onOpenMatch={handleRowOpenMatch}
        onSelect={handleRowSelect}
        onOpen={handleRowOpen}
        onRename={handleRowRename}
        onFavorite={handleRowFavorite}
        onContextMenu={handleRowContextMenu}
        bulkSelectionActive={bulkSelectionActive}
        bulkSelectedKeys={bulkSelectedKeys}
        onToggleBulk={toggleBulkSession}
        currentPage={sessionPage}
        totalPages={Math.max(1, Math.ceil(displayedSessionTotalCount / SESSION_PAGE_SIZE))}
        onPageChange={(page) => setSessionPage(page)}
      />

      {detail ? (
        <DetailPanel
          session={detail}
          messages={messages}
          matchedContextMessages={matchedContextMessages}
          matchedMessageIndex={matchedMessageIndex}
          traceEvents={traceEvents}
          loading={messagesLoading}
          actionStatus={actionStatus}
          query={query}
          liveState={getLiveSessionState(detail, liveSessionKeys, liveDetectionFailed)}
          language={language}
          messagePageSize={MESSAGE_PAGE_SIZE}
          olderMessageCount={messageOffset}
          revealLabel={FILE_MANAGER_LABEL}
          showItermAction={IS_MAC && detail.source !== "codex-app"}
          onClose={closeDetail}
          sessionFamily={sessionFamily}
          onOpenFamilySession={openFamilySession}
          sessionFamilyLoadFailed={sessionFamilyLoadFailed}
          onRetrySessionFamily={retrySessionFamily}
          onShowMore={() => void loadMoreMessages()}
          onRename={() => beginRename(detail)}
          onAddTag={() => beginAddTag(detail)}
          onRemoveTag={(tagName) => void removeTag(detail, tagName)}
          onFavorite={() => void toggleFavorite(detail)}
          onSummarize={() => void summarizeDetail(detail)}
          summarizing={summarizing}
          canResume={supportsResumeSource(detail.source)}
          canMigrate={detail.environmentKind !== "ssh" && supportsMigrationSource(detail.source)}
          migrationTitle={
            detail.environmentKind === "ssh"
              ? remoteMigrationTitle(language)
              : supportsMigrationSource(detail.source)
                ? t("Migrate session to…", "迁移会话到…")
                : unsupportedMigrationTitle(language)
          }
          onResume={() =>
            void runAction(resumeActionLabel(detail.source, language), () => window.sessionSearch.resumeSession(detail.sessionKey), (result) => resumeRouteMessage(result, language))
          }
          onResumeIterm={() =>
            void runAction(t("Opening iTerm", "正在打开 iTerm"), () => window.sessionSearch.resumeSessionInIterm(detail.sessionKey), t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"))
          }
          onMigrate={() => beginMigrate(detail)}
          onUploadRemote={() => void uploadRemoteSession(detail)}
          remoteUploadDisabled={detail.source === "zcode-cli" || detail.environmentKind === "wsl"}
          onCopyResume={() =>
            void runAction(t("Copying resume command", "正在复制 Resume 命令"), () => window.sessionSearch.copyResumeCommand(detail.sessionKey), t("Resume command copied.", "Resume 命令已复制。"))
          }
          onCopyMarkdown={() =>
            void runAction(t("Copying markdown", "正在复制 Markdown"), () => window.sessionSearch.copyMarkdown(detail.sessionKey), t("Markdown copied.", "Markdown 已复制。"))
          }
          onExportMarkdown={() => void exportMarkdown(detail.sessionKey)}
          onExportJson={() => void exportJson(detail.sessionKey)}
          onCopyPlain={() =>
            void runAction(t("Copying plain text", "正在复制纯文本"), () => window.sessionSearch.copyPlainText(detail.sessionKey), t("Plain text copied.", "纯文本已复制。"))
          }
          onDelete={() => requestDeleteSession(detail)}
          onReveal={() =>
            void runAction(
              `Opening ${FILE_MANAGER_LABEL}`,
              () => window.sessionSearch.revealSession(detail.sessionKey),
              `${FILE_MANAGER_LABEL} opened.`,
            )
          }
        />
      ) : null}

      {remoteDetail ? (
        <DetailPanel
          session={remoteDetail.snapshot.session}
          messages={remoteDetail.snapshot.messages}
          matchedContextMessages={[]}
          matchedMessageIndex={null}
          traceEvents={remoteDetail.snapshot.traceEvents}
          loading={false}
          actionStatus={null}
          query={remoteDetail.query}
          liveState="closed"
          language={language}
          messagePageSize={MESSAGE_PAGE_SIZE}
          olderMessageCount={0}
          revealLabel={FILE_MANAGER_LABEL}
          showItermAction={false}
          backdropClassName="remote-detail-backdrop"
          sessionFamily={EMPTY_SESSION_FAMILY}
          onClose={closeRemoteDetail}
          onShowMore={() => undefined}
          onRename={() => undefined}
          onAddTag={() => undefined}
          onRemoveTag={() => undefined}
          onFavorite={() => undefined}
          onSummarize={() => undefined}
          summarizing={false}
          canResume={false}
          canMigrate={false}
          migrationTitle={t("Use Restore from the remote session list.", "请从远程会话列表点击恢复。")}
          onResume={() => undefined}
          onResumeIterm={() => undefined}
          onMigrate={() => undefined}
          onCopyResume={() => undefined}
          onCopyMarkdown={() => undefined}
          onExportMarkdown={() => undefined}
          onExportJson={() => undefined}
          onCopyPlain={() => undefined}
          onDelete={() => undefined}
          onReveal={() => undefined}
          readOnly
        />
      ) : null}

      {contextMenu ? (
        <ContextMenu
          state={contextMenu}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          showMacActions={IS_MAC}
          canResume={supportsResumeSource(contextMenu.session.source)}
          canMigrate={contextMenu.session.environmentKind !== "ssh" && supportsMigrationSource(contextMenu.session.source)}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onSelectMultiple={() => beginBulkSelection(contextMenu.session.sessionKey)}
          onFavorite={() => void toggleFavorite(contextMenu.session)}
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
          busy={migrationBusy}
          progress={migrationProgress}
          onSelect={(target) => void runMigration(target)}
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

      {actionStatus ? <ActionToast status={actionStatus} onClose={() => setActionStatus(null)} /> : null}

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
          cascadeCount={deleteSessionCascadeCount}
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
          onConfirm={() => void confirmBulkDelete()}
          onCancel={() => setBulkDeleteDialog(null)}
        />
      ) : null}

      {apiConfigOpen ? (
        <ApiConfigDialog
          settings={appSettings}
          language={language}
          feedback={settingsFeedback}
          onSettingsChange={updateSettings}
          onApplyToCodex={(apiConfig) => void applyApiConfigToCodex(apiConfig)}
          onApplyToClaude={(claudeApiConfig) => void applyApiConfigToClaude(claudeApiConfig)}
          onClose={() => setApiConfigOpen(false)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          platform={RUNTIME_PLATFORM}
          initialSection={settingsInitialSection}
          settings={appSettings}
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
          onAddWsl={() => setWslDialogOpen(true)}
          onOpenApiConfig={() => {
            setSettingsOpen(false);
            setApiConfigOpen(true);
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

      {skillsOpen ? (
        <SkillsDialog
          snapshot={installedSkills}
          syncSnapshot={skillSyncSnapshot}
          loading={skillsLoading}
          feedback={skillsFeedback}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          onRefresh={() => void loadSkills({ refreshUsage: true })}
          onUpload={(skill, force) => uploadSkillToSync(skill, force)}
          onUploadSelected={(skills) => uploadSelectedSkillsToSync(skills)}
          onInstallRemote={(remoteSkillId) => installSyncedSkill(remoteSkillId)}
          onFetchVersion={(remoteSkillId) => fetchSyncedSkillVersion(remoteSkillId)}
          onRefreshRemote={() => void loadSkills({ silent: true })}
          onCopySetupSql={() => void copySkillSyncSetupSql()}
          onOpenSqlEditor={() => window.sessionSearch.openSupabaseSqlEditor("skills")}
          onCopyPath={(skillPath) =>
            void runUtilityAction(t("Copying skill path", "正在复制 Skill 路径"), () => window.sessionSearch.copySkillPath(skillPath), t("Skill path copied.", "Skill 路径已复制。"))
          }
          onReveal={(skillPath) =>
            void runUtilityAction(`Opening ${FILE_MANAGER_LABEL}`, () => window.sessionSearch.revealSkill(skillPath), `${FILE_MANAGER_LABEL} opened.`)
          }
          onDelete={(skill) => deleteSkill(skill)}
          onClose={() => setSkillsOpen(false)}
        />
      ) : null}

      {assetsOpen ? (
        <DigitalAssetsDialog
          rulesSnapshot={rulesSnapshot}
          memoriesSnapshot={memoriesSnapshot}
          language={language}
          onClose={() => setAssetsOpen(false)}
          onRulesUploadAll={() => window.sessionSearch.uploadAllRulesToSync()}
          onRulesUpload={(identity) => window.sessionSearch.uploadRuleToSync(identity)}
          onRulesDelete={(remoteId) => window.sessionSearch.deleteRemoteRule(remoteId)}
          onRulesCopySql={() => void window.sessionSearch.copyRulesSyncSetupSql()}
          onRulesRestore={() => window.sessionSearch.restoreRules()}
          onMemoriesUploadAll={() => window.sessionSearch.uploadAllMemoriesToSync()}
          onMemoriesUpload={(identity) => window.sessionSearch.uploadMemoryToSync(identity)}
          onMemoriesDelete={(remoteId) => window.sessionSearch.deleteRemoteMemory(remoteId)}
          onMemoriesCopySql={() => void window.sessionSearch.copyMemoriesSyncSetupSql()}
          onOpenSkills={() => { setAssetsOpen(false); setSkillsOpen(true); }}
          onRefresh={loadDigitalAssets}
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
            void refreshAfterAction({ metadata: true });
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

function migrationStrategyLabel(strategy: SessionMigrationResult["strategy"], language: LanguageMode): string {
  if (strategy === "complete") return localize(language, "complete", "完整迁移");
  if (strategy === "ai-compressed") return localize(language, "AI compressed", "AI 压缩");
  return localize(language, "locally truncated", "本地截断");
}

function migrationProgressMessage(progress: SessionMigrationProgress, language: LanguageMode): string {
  const target = migrationAgentLabel(progress.target);
  if (progress.stage === "reading") return localize(language, `Reading session for ${target}...`, `正在读取会话，准备迁移到 ${target}...`);
  if (progress.stage === "compressing") {
    const base = localize(language, `Compressing long session for ${target}...`, `正在压缩长会话，准备迁移到 ${target}...`);
    return progress.percent != null ? `${base} ${progress.percent}%` : base;
  }
  if (progress.stage === "writing") return localize(language, `Writing ${target} session...`, `正在写入 ${target} 会话...`);
  if (progress.stage === "indexing") return localize(language, "Refreshing index...", "正在刷新索引...");
  return localize(language, `Opening ${target}...`, `正在打开 ${target}...`);
}

function ContextMenu({
  state,
  language,
  revealLabel,
  showMacActions,
  canResume,
  canMigrate,
  onRename,
  onAddTag,
  onSelectMultiple,
  onFavorite,
  onHide,
  onResume,
  onResumeIterm,
  onOpenApp,
  onMigrate,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onExportJson,
  onDelete,
  onReveal,
}: {
  state: ContextMenuState;
  language: LanguageMode;
  revealLabel: string;
  showMacActions: boolean;
  canResume: boolean;
  canMigrate: boolean;
  onRename: () => void;
  onAddTag: () => void;
  onSelectMultiple: () => void;
  onFavorite: () => void;
  onHide: () => void;
  onResume: () => void;
  onResumeIterm: () => void;
  onOpenApp: () => void;
  onMigrate: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onExportJson: () => void;
  onDelete: () => void;
  onReveal: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const menu = useClampedContextMenuStyle(state);
  const localOnlyDisabled = isRemoteSession(state.session);
  const migrationDisabled = state.session.environmentKind === "ssh";
  const canDelete = canDeleteSessionLocally(state.session);
  const revealTitle = localOnlyDisabled ? remoteRevealTitle(language) : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);
  const openAppTitle = localOnlyDisabled ? remoteOpenAppTitle(language) : l("Open native app", "打开原生应用");
  const migrateTitle = migrationDisabled
    ? remoteMigrationTitle(language)
    : canMigrate
      ? l("Migrate session to…", "迁移会话到…")
      : unsupportedMigrationTitle(language);
  return (
    <div ref={menu.ref} className="context-menu" style={menu.style} onClick={(event) => event.stopPropagation()}>
      <button onClick={onRename}>
        <Clipboard size={14} /> {l("Rename", "重命名")}
      </button>
      <button onClick={onAddTag}>
        <Tag size={14} /> {l("Add Tag", "添加标签")}
      </button>
      <button onClick={onSelectMultiple}>
        <ListChecks size={14} /> {l("Multi-select", "多选")}
      </button>
      <button onClick={onFavorite}>
        <Star size={14} fill={state.session.favorited ? "currentColor" : "none"} />{" "}
        {state.session.favorited ? l("Unfavorite", "取消收藏") : l("Favorite", "收藏")}
      </button>
      <button onClick={onHide}>
        {state.session.hidden ? <Eye size={14} /> : <Archive size={14} />} {state.session.hidden ? l("Unhide", "取消隐藏") : l("Hide", "隐藏")}
      </button>
      <hr />
      {canResume ? (
        <button onClick={onResume}>
          <Play size={14} /> {state.session.source === "codex-app" ? l("Open in Codex", "在 Codex 中打开") : l("Resume in Terminal", "在终端恢复")}
        </button>
      ) : null}
      {canResume && showMacActions && state.session.source !== "codex-app" ? (
        <button onClick={onResumeIterm}>
          <TerminalIcon size={14} /> Resume in iTerm
        </button>
      ) : null}
      {canResume && showMacActions ? (
        <button onClick={onOpenApp} disabled={localOnlyDisabled} title={openAppTitle}>
          <AppWindow size={14} /> Open App
        </button>
      ) : null}
      <button onClick={onMigrate} disabled={!canMigrate || migrationDisabled} title={migrateTitle}>
        <ArrowRightLeft size={14} /> {l("Migrate to…", "迁移到…")}
      </button>
      {canResume ? (
        <button onClick={onCopyResume}>
          <Copy size={14} /> {l("Copy Resume Cmd", "复制 Resume 命令")}
        </button>
      ) : null}
      <button onClick={onCopyMarkdown}>{l("Copy Markdown", "复制 Markdown")}</button>
      <button onClick={onExportMarkdown}>
        <Download size={14} /> {l("Export Markdown", "导出 Markdown")}
      </button>
      <button onClick={onExportJson}>
        <Download size={14} /> {l("Export JSON", "导出 JSON")}
      </button>
      <button onClick={onReveal} disabled={localOnlyDisabled} title={revealTitle}>
        <FolderOpen size={14} /> Show in {revealLabel}
      </button>
      {canDelete ? <>
        <hr />
        <button className="danger" onClick={onDelete}>
          <Trash2 size={14} /> {state.session.sourceAvailable === false ? l("Delete Cache", "删除缓存") : l("Delete Session", "删除会话")}
        </button>
      </> : null}
    </div>
  );
}
