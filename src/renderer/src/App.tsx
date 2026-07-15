import { forwardRef, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from "react";
import {
  AppWindow,
  Archive,
  ArrowRightLeft,
  Activity,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Cloud,
  Code2,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  History,
  Info,
  KeyRound,
  Keyboard,
  Languages,
  Laptop,
  Moon,
  PackageSearch,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Star,
  Sun,
  Tag,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { IndexStatus } from "../../core/indexer";
import type { AppUpdateStatus } from "../../core/app-update-types";
import { formatRelativeTime } from "../../core/format-session";
import { LIVE_SESSION_REFRESH_INTERVAL_MS, QUOTA_REFRESH_INTERVAL_MS } from "../../core/refresh-policy";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { MigrationTargetSettings } from "../../core/migration-targets";
import type { RemoteHealthReport } from "../../core/remote-health";
import type { RemoteSessionDetailSnapshot } from "../../core/remote-session-sync";
import type { TraceEventQueryOptions } from "../../core/session-store";
import type { RemoteSkill, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../core/skill-sync";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../core/skill-manager";
import { globalShortcutOptions } from "../../core/shortcuts";
import { terminalSelectOptions } from "../../core/terminal-options";
import type { SshConfigHost } from "../../core/ssh-config";
import type {
  EnvironmentSyncState,
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
  SessionStats,
  SessionStatsPeriod,
  SessionTraceEvent,
  SshAuthMode,
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
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";
import { loadSkillsPanelData } from "./skills-load";
import { clearSearchHistory, deleteSearch, readSearchHistory, recordSearch } from "./search-history";
import { HighlightedSearchText } from "./search-highlight";
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
import { ApiConfigDialog } from "./components/api-config-dialog";
import { DetailPanel } from "./components/detail-panel";
import { SessionMigrationDialog, SessionMigrationLaunchFailedDialog } from "./components/session-migration-dialog";
import { CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "./components/session-dialogs";
import { SkillsDialog } from "./components/skills-dialog";
import { AiAssistantDialog } from "./components/ai-assistant-dialog";
import { RemoteSessionsDialog } from "./components/remote-sessions-dialog";
import { useClampedContextMenuStyle } from "./context-menu-position";
import {
  SOURCE_LABEL,
  environmentBadgeLabel,
  environmentBadgeTitle,
  isBranchTag,
  displayTagName,
  isRemoteSession,
  liveStatusFilterLabel,
  localizedLiveStateLabel,
  projectSortTimestamp,
  remoteOpenAppTitle,
  remoteMigrationTitle,
  remoteRevealTitle,
  resumeRouteMessage,
  sessionSortTimestamp,
  sourceFilterLabel,
  sourceFilters,
  sourceUiFamily,
  supportsMigrationSource,
  statsPeriodLabel,
  supportsResumeSource,
  unsupportedMigrationTitle,
  usageStatsDisplayRows,
  migrationAgentLabel,
  migrationTargetsForSession,
} from "./session-ui";

const STATS_PERIOD_OPTIONS: Array<{ label: string; value: SessionStatsPeriod }> = [
  { label: "Today", value: "today" },
  { label: "7D", value: "sevenDay" },
  { label: "30D", value: "thirtyDay" },
  { label: "All", value: "allTime" },
];

const RUNTIME_PLATFORM: NodeJS.Platform = window.sessionSearch.platform;
const IS_MAC = RUNTIME_PLATFORM === "darwin";
const FILE_MANAGER_LABEL = IS_MAC ? "Finder" : RUNTIME_PLATFORM === "win32" ? "Explorer" : "File Manager";

const DEFAULT_TERMINAL_OPTIONS = terminalSelectOptions(RUNTIME_PLATFORM);

const LIVE_STATUS_FILTERS: Array<{ label: string; value: LiveStatusFilter }> = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Closed", value: "closed" },
];

const DEFAULT_MIGRATION_TARGET_SETTINGS = {
  includeTclaude: false,
  includeTcodex: false,
  includeClaudeInternal: false,
  includeCodexInternal: false,
} satisfies MigrationTargetSettings;

type ViewMode = "default" | "favorites" | "pinned" | "hidden";
type SettingsSection = "terminal" | "shortcut" | "connections" | "sources" | "usage" | "ai" | "remote" | "skills" | "appearance" | "about";
type PendingSourceKey = "claude" | "codex" | "tclaude" | "tcodex" | "codebuddy" | "codewiz" | "openclaw" | "hermes" | "opencode" | "cursor" | "trae";
type OptionalSourceSettingKey = keyof Pick<
  AppSettings,
  | "includeClaudeInternal"
  | "includeCodexInternal"
  | "includeTclaude"
  | "includeTcodex"
  | "includeCodeBuddyCli"
  | "includeCodeWizCli"
  | "includeOpenClaw"
  | "includeHermes"
  | "includeOpenCode"
  | "includeCursorAgent"
  | "includeTrae"
>;

const OPTIONAL_SOURCE_SETTINGS: Array<{ key: OptionalSourceSettingKey; pendingKey: PendingSourceKey; filter: SearchOptions["source"] }> = [
  { key: "includeClaudeInternal", pendingKey: "claude", filter: "claude-internal" },
  { key: "includeCodexInternal", pendingKey: "codex", filter: "codex-internal" },
  { key: "includeTclaude", pendingKey: "tclaude", filter: "tclaude-cli" },
  { key: "includeTcodex", pendingKey: "tcodex", filter: "tcodex-cli" },
  { key: "includeCodeBuddyCli", pendingKey: "codebuddy", filter: "codebuddy-cli" },
  { key: "includeCodeWizCli", pendingKey: "codewiz", filter: "codewiz-cli" },
  { key: "includeOpenClaw", pendingKey: "openclaw", filter: "openclaw" },
  { key: "includeHermes", pendingKey: "hermes", filter: "hermes" },
  { key: "includeOpenCode", pendingKey: "opencode", filter: "opencode-cli" },
  { key: "includeCursorAgent", pendingKey: "cursor", filter: "cursor-agent" },
  { key: "includeTrae", pendingKey: "trae", filter: "trae" },
];

const INITIAL_SESSION_LIMIT = 30;
const SESSION_PAGE_SIZE = 30;
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
};

const EMPTY_QUOTAS: UsageQuotaSnapshot = {
  generatedAt: "",
  providers: [],
};

const EMPTY_LIVE_SESSIONS: LiveSessionSnapshot = {
  generatedAt: "",
  sessions: [],
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

function environmentStatus(environment: SessionEnvironment): EnvironmentSyncState | "local" {
  if (environment.kind === "local") return "local";
  if (!environment.enabled) return "disconnected";
  return environment.syncState;
}

function environmentStatusLabel(environment: SessionEnvironment, language: LanguageMode): string {
  const status = environmentStatus(environment);
  if (status === "local") return localize(language, "local", "本地");
  if (status === "syncing") return localize(language, "syncing", "同步中");
  if (status === "watching") return localize(language, "watching", "监听中");
  if (status === "error") return localize(language, "error", "错误");
  if (status === "disconnected") return localize(language, "disconnected", "未连接");
  return localize(language, "idle", "空闲");
}

function environmentTarget(environment: SessionEnvironment, language: LanguageMode): string {
  if (environment.kind === "local") return localize(language, "This computer", "这台电脑");
  const destination = environment.hostAlias || environment.host || environment.label;
  const userPrefix = environment.user && !environment.hostAlias ? `${environment.user}@` : "";
  const portSuffix = environment.port ? `:${environment.port}` : "";
  return `${userPrefix}${destination}${portSuffix}`;
}

const SIDEBAR_SECTIONS_STORAGE_KEY = "agent-session-search-sidebar-sections";
const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "agent-session-search-collapsed-project-groups";

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

export interface ResolvedSearchScope {
  environmentId: string | "all" | undefined;
  projectPath: string | undefined;
  projectEnvironmentConflict: boolean;
}

export function resolveSearchScope(
  environmentId: string | "all",
  projectPath: string | undefined,
  projectEnvironmentId: string | undefined,
): ResolvedSearchScope {
  const selectedProjectEnvironmentId = projectPath ? projectEnvironmentId : undefined;
  const explicitEnvironmentId = environmentId !== "all" ? environmentId : undefined;
  return {
    environmentId: explicitEnvironmentId ?? selectedProjectEnvironmentId,
    projectPath,
    projectEnvironmentConflict: Boolean(
      projectPath && explicitEnvironmentId && selectedProjectEnvironmentId && explicitEnvironmentId !== selectedProjectEnvironmentId,
    ),
  };
}

export function existingSshHostAliases(environments: Array<Pick<SessionEnvironment, "kind" | "label" | "hostAlias">>): Set<string> {
  const aliases = new Set<string>();
  for (const environment of environments) {
    if (environment.kind !== "ssh") continue;
    if (environment.hostAlias) aliases.add(environment.hostAlias);
  }
  return aliases;
}

function loadInitialSidebarSections(): SidebarSectionsState {
  if (typeof window === "undefined") return readSidebarSections(null);
  return readSidebarSections(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY));
}

// The search input keeps its typed value in local state so each keystroke only
// re-renders this tiny component instead of the whole App tree (sidebar, stats,
// and the full result list). The query is pushed to the parent only when the
// user presses Enter, so typing never triggers background search work.
const SearchBox = forwardRef<
  HTMLInputElement,
  {
    placeholder: string;
    recentLabel: string;
    clearRecentLabel: string;
    deleteRecentLabel: string;
    onSearch: (value: string) => void;
  }
>(function SearchBox({ placeholder, recentLabel, clearRecentLabel, deleteRecentLabel, onSearch }, ref) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : readSearchHistory(window.localStorage),
  );
  const [focused, setFocused] = useState(false);

  function handleChange(next: string): void {
    if (value.length > 0 && next.length === 0) onSearch("");
    setValue(next);
    setFocused(next.length > 0);
  }

  function selectRecentSearch(query: string): void {
    setValue(query);
    onSearch(query);
    setHistory((current) => recordSearch(window.localStorage, current, query));
    setFocused(false);
  }

  function runSearch(): void {
    onSearch(value);
    setHistory((current) => recordSearch(window.localStorage, current, value));
    setFocused(false);
  }

  const showHistory = focused && value.length === 0 && history.length > 0;

  return (
    <div className="searchbox">
      <Search size={18} />
      <input
        ref={ref}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => {
          setHistory(readSearchHistory(window.localStorage));
          setFocused(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setFocused(false);
            event.currentTarget.blur();
          } else if (!event.metaKey && !event.ctrlKey && event.key === "Enter") {
            runSearch();
          }
        }}
        placeholder={placeholder}
      />
      <span className="kbd-hint" title={placeholder}>Enter</span>
      <span className="kbd-hint" title="Resume selected session in the default terminal">
        {RUNTIME_PLATFORM === "darwin" ? "⌘↵" : "Ctrl+Enter"}
      </span>
      {showHistory ? (
        <div className="recent-search-dropdown" onMouseDown={(event) => event.preventDefault()}>
          <div className="recent-search-header">
            <span>{recentLabel}</span>
            <button
              type="button"
              onClick={() => setHistory(clearSearchHistory(window.localStorage))}
            >
              {clearRecentLabel}
            </button>
          </div>
          <div className="recent-search-list">
            {history.map((query) => (
              <div className="recent-search-item" key={query}>
                <button type="button" className="recent-search-select" onClick={() => selectRecentSearch(query)} title={query}>
                  <History size={14} />
                  <span>{query}</span>
                </button>
                <button
                  type="button"
                  className="recent-search-delete"
                  aria-label={`${deleteRecentLabel}: ${query}`}
                  title={deleteRecentLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    setHistory((current) => deleteSearch(window.localStorage, current, query));
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export function App(): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
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
  const [liveStatus, setLiveStatus] = useState<LiveStatusFilter>("all");
  const [hoveredScopeFilter, setHoveredScopeFilter] = useState<string | null>(null);
  const [sessionLimit, setSessionLimit] = useState(INITIAL_SESSION_LIMIT);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectTags, setProjectTags] = useState<ProjectTagEntry[]>([]);
  const [environments, setEnvironments] = useState<SessionEnvironment[]>([]);
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [statsPeriod, setStatsPeriod] = useState<SessionStatsPeriod>("today");
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [statsFeedback, setStatsFeedback] = useState<StatsFeedback>(null);
  const [quotas, setQuotas] = useState<UsageQuotaSnapshot>(EMPTY_QUOTAS);
  const [quotaLoading, setQuotaLoading] = useState(false);
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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
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
  const [pendingPersonalSources, setPendingPersonalSources] = useState<Record<PendingSourceKey, boolean>>({
    claude: false,
    codex: false,
    tclaude: false,
    tcodex: false,
    codebuddy: false,
    codewiz: false,
    openclaw: false,
    hermes: false,
    opencode: false,
    cursor: false,
    trae: false,
  });
  const loadSeqRef = useRef(0);
  const metadataLoadSeqRef = useRef(0);
  const statsLoadSeqRef = useRef(0);
  const detailLoadSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const environmentIdRef = useRef(environmentId);
  const projectPathRef = useRef(projectPath);
  const projectEnvironmentIdRef = useRef(projectEnvironmentId);
  environmentIdRef.current = environmentId;
  projectPathRef.current = projectPath;
  projectEnvironmentIdRef.current = projectEnvironmentId;
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const searchScopeKey = useMemo(
    () => JSON.stringify([query, source, environmentId, tag ?? "", projectPath ?? "", projectEnvironmentId ?? "", visibility, dateRange, liveStatus]),
    [query, source, environmentId, tag, projectPath, projectEnvironmentId, visibility, dateRange, liveStatus],
  );
  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const liveDetectionFailed = Boolean(liveSessions.error);
  const liveSearchKeys = useMemo(() => [...liveSessionKeys], [liveSessionKeys]);

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const searchScope = resolveSearchScope(environmentId, projectPath, projectEnvironmentId);
    const { dateFrom, dateTo } = resolveDateRange(dateRange);
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath: searchScope.projectPath,
      environmentId: searchScope.environmentId,
      visibility,
      sortBy: "activity",
      dateFrom,
      dateTo,
      limit: sessionLimit,
      liveStatus: liveStatus === "all" ? undefined : liveStatus,
      liveSessionKeys: liveStatus === "all" || liveDetectionFailed ? [] : liveSearchKeys,
    };
    const page = searchScope.projectEnvironmentConflict
      ? { sessions: [], totalCount: 0, hasMore: false }
      : await window.sessionSearch.searchSessionPage(options);
    if (requestId !== loadSeqRef.current) return;
    // Applying results re-renders the (unvirtualized) list, so mark it as a
    // transition to keep it interruptible and avoid blocking active typing.
    startTransition(() => {
      setResults(page.sessions);
      setSessionTotalCount(page.totalCount);
      setHasMoreSessions(page.hasMore);
      setSelectedKey((current) =>
        current && !page.sessions.some((session) => session.sessionKey === current) ? null : current,
      );
    });
  }, [query, source, environmentId, tag, projectPath, projectEnvironmentId, visibility, dateRange, sessionLimit, liveStatus, liveDetectionFailed, liveSearchKeys]);

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

  const loadStats = useCallback(async () => {
    const requestId = ++statsLoadSeqRef.current;
    const nextStats = await window.sessionSearch.getStats({ period: statsPeriod });
    if (requestId !== statsLoadSeqRef.current) return;
    setStats(nextStats);
  }, [statsPeriod]);

  const refreshStats = useCallback(async () => {
    setStatsRefreshing(true);
    setStatsFeedback({ kind: "running", message: t("Refreshing usage...", "正在刷新用量...") });
    try {
      await loadStats();
      const successMessage = t("Usage refreshed.", "用量已刷新。");
      setStatsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setStatsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1600);
    } catch (error) {
      setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatsRefreshing(false);
    }
  }, [loadStats, t]);

  const loadQuotas = useCallback(async (mode: "initial" | "manual" | "background" = "initial") => {
    const background = mode === "background";
    if (!background) setQuotaLoading(true);
    if (mode === "manual") setQuotaFeedback({ kind: "running", message: t("Refreshing usage limits...", "正在刷新额度...") });
    try {
      const nextQuotas = await window.sessionSearch.getQuotas();
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
        for (const skill of uploadable) {
          try {
            const result = await window.sessionSearch.uploadSkillToSync(skill.path, false);
            if (result.status === "uploaded") uploaded += 1;
            else if (result.status === "skipped") skipped += 1;
            else {
              conflicts += 1;
              remainingSkillIds.push(skill.id);
              failureDetails.push(t(`${skill.name}: confirm before replacing the existing remote source.`, `${skill.name}：需要确认是否替换现有远程来源。`));
            }
          } catch (error) {
            failed += 1;
            remainingSkillIds.push(skill.id);
            failureDetails.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
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
    setSessionLimit(INITIAL_SESSION_LIMIT);
    setHasMoreSessions(false);
  }, [searchScopeKey]);

  useEffect(() => {
    // Typing is debounced inside SearchBox, so the search can run immediately
    // here; filter and sort changes then respond without an extra delay.
    void load();
  }, [load]);

  useEffect(() => {
    void loadSidebarMetadata();
  }, [loadSidebarMetadata]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    void loadQuotas();
    const timer = window.setInterval(() => void loadQuotas("background"), QUOTA_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadQuotas]);

  useEffect(() => {
    if (skillsOpen) void loadSkills({ refreshUsage: true, silent: true });
  }, [skillsOpen, loadSkills]);

  useEffect(() => {
    if (!settingsOpen) return;
    void window.sessionSearch.getSkillUsageHookStatus().then(setSkillHookInstalled).catch(() => setSkillHookInstalled(false));
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

  useEffect(() => {
    void refreshLiveSessions();
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
      if (!nextStatus.running) {
        void load();
        void loadSidebarMetadata();
        void loadStats();
      }
    });
    const offFocus = window.sessionSearch.onFocusSearch(() => searchRef.current?.focus());
    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      setSkillsOpen(false);
      setApiConfigOpen(false);
      setSettingsInitialSection("terminal");
      setSettingsOpen(true);
    });
    const offAppUpdate = window.sessionSearch.onAppUpdateStatus(setAppUpdateStatus);
    const offEnvironments = window.sessionSearch.onEnvironmentsUpdated((nextEnvironments) => {
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
      void load();
    });
    return () => {
      offIndex();
      offFocus();
      offOpenSettings();
      offAppUpdate();
      offEnvironments();
    };
  }, [load, loadSidebarMetadata, loadStats]);

  useEffect(() => {
    void window.sessionSearch.getAppUpdateStatus(false).then(setAppUpdateStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    return window.sessionSearch.onMigrationProgress((progress) => {
      setMigrationProgress(progress);
      setActionStatus({ kind: "running", message: migrationProgressMessage(progress, language) });
    });
  }, [language]);

  const displayedResults = useMemo(
    () => filterSessionsByLiveStatus(results, liveSessionKeys, liveStatus, liveDetectionFailed),
    [results, liveSessionKeys, liveStatus, liveDetectionFailed],
  );
  const selected = useMemo(
    () => displayedResults.find((session) => session.sessionKey === selectedKey) || null,
    [displayedResults, selectedKey],
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

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
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
        else if (skillsOpen) setSkillsOpen(false);
        else if (apiConfigOpen) setApiConfigOpen(false);
        else if (aiAssistantOpen) setAiAssistantOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (remoteSessionsOpen) setRemoteSessionsOpen(false);
        else if (detail) closeDetail();
        else if (remoteDetail) setRemoteDetail(null);
        else return;
        event.preventDefault();
        return;
      }

      // Leave list navigation alone while an overlay or menu is in front.
      if (detail || remoteDetail || dialog || migrationDialog || deleteSessionCandidate || deleteTagName || contextMenu || skillsOpen || apiConfigOpen || aiAssistantOpen || settingsOpen || sshDialogOpen || remoteSessionsOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session && supportsResumeSource(session.source)) {
          void runAction(t("Opening terminal", "正在打开终端"), () => window.sessionSearch.resumeSession(session.sessionKey), (result) => resumeRouteMessage(result, language));
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
  }, [displayedResults, selectedKey, detail, remoteDetail, dialog, migrationDialog, deleteSessionCandidate, deletingSession, deleteTagName, contextMenu, skillsOpen, apiConfigOpen, aiAssistantOpen, settingsOpen, sshDialogOpen, remoteSessionsOpen, actionStatus, t]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail || remoteDetail || skillsOpen || apiConfigOpen || aiAssistantOpen || settingsOpen || sshDialogOpen || remoteSessionsOpen));
    return () => document.body.classList.remove("overlay-open");
  }, [detail, remoteDetail, skillsOpen, apiConfigOpen, aiAssistantOpen, settingsOpen, sshDialogOpen, remoteSessionsOpen]);

  const visibleSourceFilters = useMemo(() => {
    if (!appSettings) return sourceFilters(null);
    // Reveal an extra source filter only once its background load has finished.
    return sourceFilters({
      ...appSettings,
      includeClaudeInternal: appSettings.includeClaudeInternal && !pendingPersonalSources.claude,
      includeCodexInternal: appSettings.includeCodexInternal && !pendingPersonalSources.codex,
      includeTclaude: appSettings.includeTclaude && !pendingPersonalSources.tclaude,
      includeTcodex: appSettings.includeTcodex && !pendingPersonalSources.tcodex,
      includeCodeBuddyCli: appSettings.includeCodeBuddyCli && !pendingPersonalSources.codebuddy,
      includeCodeWizCli: appSettings.includeCodeWizCli && !pendingPersonalSources.codewiz,
      includeOpenClaw: appSettings.includeOpenClaw && !pendingPersonalSources.openclaw,
      includeHermes: appSettings.includeHermes && !pendingPersonalSources.hermes,
      includeOpenCode: appSettings.includeOpenCode && !pendingPersonalSources.opencode,
      includeCursorAgent: appSettings.includeCursorAgent && !pendingPersonalSources.cursor,
      includeTrae: appSettings.includeTrae && !pendingPersonalSources.trae,
    });
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

  function clearProjectScopeFilter(): void {
    clearProjectFilter();
    setTag(undefined);
  }

  function clearEnvironmentScopeFilter(): void {
    selectEnvironment("all");
    clearProjectFilter();
    setTag(undefined);
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
    setRemoteSessionsOpen(false);
    setRemoteDetail({ snapshot, query: detailQuery });
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
    await Promise.all([
      load(),
      options.metadata ? loadSidebarMetadata() : Promise.resolve(),
      options.stats ? loadStats() : Promise.resolve(),
    ]);
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

  async function uploadVisibleRemoteSessions(): Promise<void> {
    const uploadable = displayedResults.filter((session) => supportsMigrationSource(session.source));
    if (uploadable.length === 0) {
      setActionStatus({ kind: "error", message: t("No visible sessions can be saved to remote.", "当前没有可保存到远程的可见会话。") });
      return;
    }

    setActionStatus({ kind: "running", message: t(`Saving ${uploadable.length} visible sessions to remote...`, `正在保存 ${uploadable.length} 个当前可见会话到远程...`) });
    let uploaded = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const session of uploadable) {
      try {
        const result = await window.sessionSearch.uploadRemoteSession(session.sessionKey);
        if (result.status === "uploaded") uploaded += 1;
        else if (result.status === "updated") updated += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }

    const message = t(
      `Remote save finished: ${uploaded} uploaded, ${updated} updated, ${skipped} skipped, ${failed} failed.`,
      `远程保存完成：${uploaded} 个已上传，${updated} 个已更新，${skipped} 个已跳过，${failed} 个失败。`,
    );
    setActionStatus({ kind: failed > 0 ? "error" : "success", message });
    window.setTimeout(() => {
      setActionStatus((current) => (current?.message === message ? null : current));
    }, 4200);
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
      <section className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Search size={17} />
          </div>
          <div>
            <h1>Agent Session Search</h1>
            <p>{t("Codex and Claude Code", "Codex 和 Claude Code")}</p>
          </div>
        </div>

        <div className="refresh-control">
          <button className={`primary ${indexStatus?.running ? "is-running" : ""}`} onClick={() => void refreshNow()} disabled={indexStatus?.running}>
            <RefreshCw size={16} />
            {indexStatus?.running ? t("Refreshing Index...", "正在更新索引...") : t("Refresh Index", "更新索引")}
          </button>
          {refreshFeedback ? <div className={`refresh-feedback ${refreshFeedback.kind}`}>{refreshFeedback.message}</div> : null}
        </div>

        <div className="stats-panel">
          <div className="stats-header">
            <span>{t("Usage", "用量")}</span>
            <div className="stats-controls">
              <div className="stats-period-toggle" role="group" aria-label={t("Usage period", "用量周期")}>
                {STATS_PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={statsPeriod === option.value ? "active" : ""}
                    onClick={() => setStatsPeriod(option.value)}
                  >
                    {statsPeriodLabel(option.value, language)}
                  </button>
                ))}
              </div>
              <button
                className="stats-refresh"
                onClick={() => void refreshStats()}
                disabled={statsRefreshing}
                title={t("Refresh usage stats", "刷新用量统计")}
                aria-label={t("Refresh usage stats", "刷新用量统计")}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>
          {statsFeedback ? <div className={`stats-feedback ${statsFeedback.kind}`}>{statsFeedback.message}</div> : null}
          <div className="stats-metrics">
            <span>
              <strong>{formatCompactNumber(stats.total.messageCount)}</strong>
              {t("Messages", "消息")}
            </span>
            <span>
              <strong>{formatTokenCount(stats.total.totalTokens)}</strong>
              {t("Tokens", "Token")}
            </span>
          </div>
          <div className="stats-breakdown">
            {usageStatsDisplayRows(stats.bySource).map((item) => (
              <div key={item.key}>
                <span>{item.label}</span>
                <em>
                  {formatCompactNumber(item.messageCount)} {t("msg", "条")} · {formatTokenCount(item.totalTokens)}
                </em>
              </div>
            ))}
          </div>
        </div>

        <QuotaPanel
          snapshot={quotas}
          loading={quotaLoading}
          feedback={quotaFeedback}
          expanded={sidebarSections.remaining}
          onToggle={() => toggleSidebarSectionById("remaining")}
          onRefresh={() => void loadQuotas("manual")}
          language={language}
        />

        <SidebarSectionHeader title={t("Environments", "环境")} expanded={sidebarSections.environments} onToggle={() => toggleSidebarSectionById("environments")} />
        {sidebarSections.environments ? (
          <nav className="sidebar-tree">
            <button
              className={`tree-row tree-root ${environmentId === "all" && !projectPath && !tag ? "active" : ""}`}
              onClick={() => { selectEnvironment("all"); clearProjectFilter(); setTag(undefined); }}
            >
              <span>{t("All Sessions", "全部会话")}</span>
            </button>
            {sidebarTree.map((group) => {
              const groupId = group.projects[0]?.environmentId ?? "unknown";
              const envCollapsed = collapsedProjectGroups.has(groupId);
              const envActive = environmentId === groupId && !projectPath && !tag;
              return (
                <div key={groupId} className="tree-group">
                  <div className="tree-row tree-env-row">
                    <button
                      className="tree-chevron"
                      onClick={() => toggleProjectGroup(groupId)}
                      aria-expanded={!envCollapsed}
                      aria-label={envCollapsed ? t("Expand", "展开") : t("Collapse", "折叠")}
                    >
                      {envCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <button
                      className={`tree-label ${envActive ? "active" : ""}`}
                      onClick={() => { selectEnvironment(groupId); clearProjectFilter(); setTag(undefined); }}
                      title={group.environment ? environmentTarget(group.environment, language) : t("Unknown", "未知")}
                    >
                      {group.environment?.kind === "local" ? <Laptop size={13} /> : <Server size={13} />}
                      <span>{group.environment?.label ?? t("Unknown", "未知")}</span>
                      <em className="tree-count">{group.projects.length}</em>
                    </button>
                  </div>
                  {!envCollapsed && group.projects.map((project) => {
                    const projectKey = `${project.environmentId}:${project.path}`;
                    const projExpanded = collapsedTreeProjects.has(projectKey);
                    const projCollapsed = !projExpanded;
                    const projActive = projectPath === project.path && projectEnvironmentId === project.environmentId && !tag;
                    return (
                      <div key={projectKey} className="tree-group">
                        <div className="tree-row tree-proj-row">
                          {project.tags.length > 0 ? (
                            <button
                              className="tree-chevron"
                              onClick={() => toggleTreeProject(projectKey)}
                              aria-expanded={projExpanded}
                              aria-label={projCollapsed ? t("Expand", "展开") : t("Collapse", "折叠")}
                            >
                              {projCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                            </button>
                          ) : (
                            <span className="tree-chevron-spacer" />
                          )}
                          <button
                            className={`tree-label ${projActive ? "active" : ""}`}
                            onClick={() => {
                              setProjectPath(project.path);
                              setProjectEnvironmentId(project.environmentId);
                              projectPathRef.current = project.path;
                              projectEnvironmentIdRef.current = project.environmentId;
                              setTag(undefined);
                            }}
                            title={project.path}
                          >
                            <Folder size={13} />
                            <span>{project.label}</span>
                            <em>{formatRelativeTime(projectSortTimestamp(project))}</em>
                          </button>
                        </div>
                        {!projCollapsed && project.tags.map((tagName) => (
                          <div
                            key={tagName}
                            className={`tree-row tree-tag-row ${tag === tagName && projectPath === project.path && projectEnvironmentId === project.environmentId ? "active" : ""} ${isBranchTag(tagName) ? "branch-tag" : ""}`}
                          >
                            <button
                              className="tree-label"
                              onClick={() => {
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
                              title={t(`Filter by ${displayTagName(tagName)}`, `按 ${displayTagName(tagName)} 过滤`)}
                            >
                              {isBranchTag(tagName) ? <GitBranch size={13} /> : <Tag size={13} />}
                              <span>{displayTagName(tagName)}</span>
                            </button>
                            <button
                              className="tag-delete"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteTagName(tagName);
                              }}
                              title={t(`Delete tag ${displayTagName(tagName)}`, `删除标签 ${displayTagName(tagName)}`)}
                              aria-label={t(`Delete tag ${displayTagName(tagName)}`, `删除标签 ${displayTagName(tagName)}`)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        ) : null}

        <SidebarSectionHeader title={t("Sources", "来源")} expanded={sidebarSections.sources} onToggle={() => toggleSidebarSectionById("sources")} />
        {sidebarSections.sources ? (
          <nav className="nav-group">
            {visibleSourceFilters.map((item) => (
              <button key={item.label} className={source === item.value ? "active" : ""} onClick={() => setSource(item.value)}>
                {sourceFilterLabel(item, language)}
              </button>
            ))}
          </nav>
        ) : null}

        <SidebarSectionHeader title={t("Views", "视图")} expanded={sidebarSections.views} onToggle={() => toggleSidebarSectionById("views")} />
        {sidebarSections.views ? (
          <nav className="nav-group">
            <button className={visibility === "default" ? "active" : ""} onClick={() => setVisibility("default")}>
              {t("All", "全部")}
            </button>
            <button className={visibility === "favorites" ? "active" : ""} onClick={() => setVisibility("favorites")}>
              <Star size={14} />
              {t("Favorites", "收藏")}
            </button>
            <button className={visibility === "pinned" ? "active" : ""} onClick={() => setVisibility("pinned")}>
              <Pin size={14} />
              {t("Pinned", "置顶")}
            </button>
            <button className={visibility === "hidden" ? "active" : ""} onClick={() => setVisibility("hidden")}>
              <EyeOff size={14} />
              {t("Hidden", "隐藏")}
            </button>
          </nav>
        ) : null}
      </section>

      <section className="content">
        <header className="toolbar">
          <SearchBox
            ref={searchRef}
            placeholder={searchPlaceholder}
            recentLabel={t("Recent searches", "最近搜索")}
            clearRecentLabel={t("Clear", "清空")}
            deleteRecentLabel={t("Delete recent search", "删除最近搜索")}
            onSearch={setQuery}
          />
          <div className="toolbar-filters">
            {activeScopeFilters.length ? (
              <div className="scope-filter" data-count={activeScopeFilters.length} aria-label={t("Active search scope", "当前搜索范围")}>
                {activeScopeFilters.map((filter) => (
                  <button
                    key={filter.key}
                    className="scope-filter-chip"
                    onClick={filter.onClear}
                    onMouseEnter={() => setHoveredScopeFilter(filter.key)}
                    onMouseLeave={() => setHoveredScopeFilter((current) => (current === filter.key ? null : current))}
                    onFocus={() => setHoveredScopeFilter(filter.key)}
                    onBlur={() => setHoveredScopeFilter((current) => (current === filter.key ? null : current))}
                    aria-describedby={hoveredScopeFilter === filter.key ? "scope-filter-tooltip" : undefined}
                  >
                    <span className="scope-filter-label">
                      {filter.prefix ? <span className="scope-filter-prefix">{filter.prefix}</span> : null}
                      <span>{filter.label}</span>
                    </span>
                    <span className="scope-filter-clear" aria-hidden="true">×</span>
                  </button>
                ))}
                {hoveredScopeFilter ? (
                  <div id="scope-filter-tooltip" className="scope-filter-tooltip" role="tooltip">
                    {activeScopeFilters.find((filter) => filter.key === hoveredScopeFilter)?.title}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="live-filter" role="group" aria-label="Live session status">
              {LIVE_STATUS_FILTERS.map((option) => (
                <button
                  key={option.value}
                  className={liveStatus === option.value ? "active" : ""}
                  onClick={() => setLiveStatus(option.value)}
                >
                  {liveStatusFilterLabel(option.value, language)}
                </button>
              ))}
            </div>
            <div className="date-filter" role="group" aria-label={t("Session time range", "会话时间范围")}>
              <CalendarDays size={14} aria-hidden="true" />
              {DATE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={dateRange === option.value ? "active" : ""}
                  onClick={() => setDateRange(option.value)}
                  title={dateRangeLabel(option.value, language)}
                  aria-label={dateRangeLabel(option.value, language)}
                >
                  {dateRangeShortLabel(option.value, language)}
                </button>
              ))}
            </div>
          </div>
          <div className="top-actions">
            <button
              className={`icon-button toolbar-icon-button ${aiAssistantOpen ? "active" : ""}`}
              onClick={() => {
                setSettingsOpen(false);
                setApiConfigOpen(false);
                setSkillsOpen(false);
                setRemoteSessionsOpen(false);
                setAiAssistantOpen(true);
              }}
              title={t("AI session finder", "AI 找会话")}
              aria-label={t("AI session finder", "AI 找会话")}
            >
              <Sparkles size={15} />
            </button>
            <button
              className={`icon-button toolbar-icon-button ${skillsOpen ? "active" : ""}`}
              onClick={() => {
                setSettingsOpen(false);
                setApiConfigOpen(false);
                setRemoteSessionsOpen(false);
                setSkillsOpen(true);
              }}
              title={t("Skills", "Skills 管理")}
              aria-label={t("Skills", "Skills 管理")}
            >
              <PackageSearch size={15} />
            </button>
            <button
              className={`icon-button toolbar-icon-button ${remoteSessionsOpen ? "active" : ""}`}
              onClick={() => {
                setSettingsOpen(false);
                setApiConfigOpen(false);
                setSkillsOpen(false);
                setRemoteSessionsOpen(true);
              }}
              title={t("Remote sessions", "远程会话")}
              aria-label={t("Remote sessions", "远程会话")}
            >
              <Cloud size={15} />
            </button>
            <button
              className={`icon-button toolbar-icon-button ${apiConfigOpen ? "active" : ""}`}
              onClick={() => {
                setSkillsOpen(false);
                setSettingsOpen(false);
                setRemoteSessionsOpen(false);
                setApiConfigOpen(true);
              }}
              title={t("API configuration", "API 配置")}
              aria-label={t("API configuration", "API 配置")}
            >
              <KeyRound size={15} />
            </button>
            <button
              className={`icon-button toolbar-icon-button ${shouldSignalAppUpdate ? "update-available" : ""}`}
              onClick={() => {
                setSkillsOpen(false);
                setApiConfigOpen(false);
                setRemoteSessionsOpen(false);
                setSettingsInitialSection(shouldSignalAppUpdate ? "about" : "terminal");
                setSettingsOpen(true);
              }}
              title={shouldSignalAppUpdate ? t("Update available", "有新版本可用") : t("Settings", "设置")}
              aria-label={shouldSignalAppUpdate ? t("Update available", "有新版本可用") : t("Settings", "设置")}
            >
              <Settings size={15} />
              {shouldSignalAppUpdate ? <span className="update-indicator" aria-hidden="true" /> : null}
            </button>
          </div>
        </header>

        <div className="result-count">
          <span>
            {t(`${sessionTotalCount} sessions`, `${sessionTotalCount} 个会话`)}
          </span>
          {selected ? <span className="selected-path">{selected.projectPath || selected.rawId}</span> : null}
        </div>

        <div className="results">
          {displayedResults.map((session) => (
            <SessionRow
              key={session.sessionKey}
              session={session}
              selected={selected?.sessionKey === session.sessionKey}
              liveState={getLiveSessionState(session, liveSessionKeys, liveDetectionFailed)}
              language={language}
              onOpenMatch={handleRowOpenMatch}
              onSelect={handleRowSelect}
              onOpen={handleRowOpen}
              onRename={handleRowRename}
              onFavorite={handleRowFavorite}
              onContextMenu={handleRowContextMenu}
            />
          ))}
          {displayedResults.length === 0 && !hasMoreSessions ? <div className="empty">{t("No sessions found.", "没有找到会话。")}</div> : null}
          {hasMoreSessions ? (
            <button className="load-more-sessions" onClick={() => setSessionLimit((current) => current + SESSION_PAGE_SIZE)}>
              <ChevronDown size={14} />
              {t(`Load ${SESSION_PAGE_SIZE} more`, `再加载 ${SESSION_PAGE_SIZE} 个`)}
            </button>
          ) : null}
        </div>
      </section>

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
          showItermAction={IS_MAC}
          onClose={closeDetail}
          onShowMore={() => void loadMoreMessages()}
          onRename={() => beginRename(detail)}
          onAddTag={() => beginAddTag(detail)}
          onRemoveTag={(tagName) => void removeTag(detail, tagName)}
          onFavorite={() => void toggleFavorite(detail)}
          onSummarize={() => void summarizeDetail(detail)}
          summarizing={summarizing}
          canResume={supportsResumeSource(detail.source)}
          canMigrate={!isRemoteSession(detail) && supportsMigrationSource(detail.source)}
          migrationTitle={
            isRemoteSession(detail)
              ? remoteMigrationTitle(language)
              : supportsMigrationSource(detail.source)
                ? t("Migrate session to…", "迁移会话到…")
                : unsupportedMigrationTitle(language)
          }
          onResume={() =>
            void runAction(t("Opening terminal", "正在打开终端"), () => window.sessionSearch.resumeSession(detail.sessionKey), (result) => resumeRouteMessage(result, language))
          }
          onResumeIterm={() =>
            void runAction(t("Opening iTerm", "正在打开 iTerm"), () => window.sessionSearch.resumeSessionInIterm(detail.sessionKey), t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"))
          }
          onMigrate={() => beginMigrate(detail)}
          onUploadRemote={() => void uploadRemoteSession(detail)}
          onCopyResume={() =>
            void runAction(t("Copying resume command", "正在复制 Resume 命令"), () => window.sessionSearch.copyResumeCommand(detail.sessionKey), t("Resume command copied.", "Resume 命令已复制。"))
          }
          onCopyMarkdown={() =>
            void runAction(t("Copying markdown", "正在复制 Markdown"), () => window.sessionSearch.copyMarkdown(detail.sessionKey), t("Markdown copied.", "Markdown 已复制。"))
          }
          onExportMarkdown={() => void exportMarkdown(detail.sessionKey)}
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
          onClose={() => setRemoteDetail(null)}
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
            void runAction(t("Opening terminal", "正在打开终端"), () => window.sessionSearch.resumeSession(contextMenu.session.sessionKey), (result) => resumeRouteMessage(result, language))
          }
          onResumeIterm={() =>
            void runAction(t("Opening iTerm", "正在打开 iTerm"), () => window.sessionSearch.resumeSessionInIterm(contextMenu.session.sessionKey), t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"))
          }
          onOpenApp={() =>
            void runAction(t("Opening native app", "正在打开原生应用"), () => window.sessionSearch.openNativeApp(contextMenu.session.sessionKey), t("Native app opened.", "原生应用已打开。"))
          }
          onMigrate={() => beginMigrate(contextMenu.session)}
          onCopyResume={() =>
            void runAction(t("Copying resume command", "正在复制 Resume 命令"), () => window.sessionSearch.copyResumeCommand(contextMenu.session.sessionKey), t("Resume command copied.", "Resume 命令已复制。"))
          }
          onCopyMarkdown={() =>
            void runAction(t("Copying markdown", "正在复制 Markdown"), () => window.sessionSearch.copyMarkdown(contextMenu.session.sessionKey), t("Markdown copied.", "Markdown 已复制。"))
          }
          onExportMarkdown={() => void exportMarkdown(contextMenu.session.sessionKey)}
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
          language={language}
          deleting={deletingSession}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            if (!deletingSession) setDeleteSessionCandidate(null);
          }}
        />
      ) : null}

      {apiConfigOpen ? (
        <ApiConfigDialog
          settings={appSettings}
          language={language}
          feedback={settingsFeedback}
          onSettingsChange={(next) => void updateSettings(next)}
          onApplyToCodex={(apiConfig) => void applyApiConfigToCodex(apiConfig)}
          onApplyToClaude={(claudeApiConfig) => void applyApiConfigToClaude(claudeApiConfig)}
          onClose={() => setApiConfigOpen(false)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
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
          onRefreshEnvironment={(environment) => void refreshEnvironment(environment)}
          onDiagnoseEnvironment={(environment) => void diagnoseEnvironment(environment)}
          onDeleteEnvironment={(environment) => void deleteEnvironment(environment)}
          onAddSsh={() => setSshDialogOpen(true)}
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

      {remoteSessionsOpen ? (
        <RemoteSessionsDialog
          language={language}
          onRestored={(result) => {
            if (!result.launched) setActionStatus({ kind: "error", message: result.warning || result.resumeCommand });
            void Promise.all([load(), loadSidebarMetadata()]);
          }}
          onOpenDetail={openRemoteDetail}
          onUploadVisible={uploadVisibleRemoteSessions}
          visibleUploadCount={displayedResults.filter((session) => supportsMigrationSource(session.source)).length}
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

function QuotaPanel({
  snapshot,
  loading,
  feedback,
  expanded,
  onToggle,
  onRefresh,
  language,
}: {
  snapshot: UsageQuotaSnapshot;
  loading: boolean;
  feedback: QuotaFeedback;
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  language: LanguageMode;
}): ReactElement {
  const updatedAt = snapshot.generatedAt ? formatRelativeTime(Date.parse(snapshot.generatedAt)) : "";
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="quota-panel">
      <div className="quota-header">
        <button className="quota-section-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span>{l("Remaining", "剩余额度")}</span>
          {updatedAt ? <em>{updatedAt}</em> : null}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          className="quota-refresh"
          onClick={onRefresh}
          disabled={loading}
          title={l("Refresh usage limits", "刷新额度")}
          aria-label={l("Refresh usage limits", "刷新额度")}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {expanded ? (
        <>
          <div className="quota-list">
            {snapshot.providers.map((card) => (
              <QuotaProviderCard key={card.provider} card={card} language={language} />
            ))}
            {snapshot.providers.length === 0 ? (
              <div className="quota-empty">{loading ? l("Checking usage limits...", "正在检查额度...") : l("Usage limits unavailable.", "额度不可用。")}</div>
            ) : null}
          </div>
          {feedback ? <div className={`quota-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
        </>
      ) : null}
    </div>
  );
}

function QuotaProviderCard({ card, language }: { card: UsageQuotaCard; language: LanguageMode }): ReactElement {
  const supported = card.status === "supported" && card.quotas.length > 0;
  const meta = card.plan;
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className={`quota-card ${card.provider}`}>
      <div className="quota-provider-head">
        <span className="quota-provider-name">{card.displayName}</span>
        <span className={`quota-status ${card.status}`}>{quotaStatusLabel(card.status, language)}</span>
      </div>
      {meta ? <div className="quota-meta">{meta}</div> : null}
      {supported ? (
        <div className="quota-windows">
          {card.quotas.map((quota) => (
            <div className="quota-window" key={quota.key}>
              <div className="quota-window-top">
                <span>{quota.label}</span>
                <strong>{l(`${quota.remainingDisplay} left`, `剩余 ${quota.remainingDisplay}`)}</strong>
              </div>
              <div className="quota-track" aria-hidden="true">
                <div className="quota-fill" style={{ width: `${quota.remainingPercent}%` } as CSSProperties} />
              </div>
              <div className="quota-reset">{quota.stale ? l("stale", "已过期") : formatQuotaReset(quota.resetsAt, language)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="quota-detail">{card.detail || l("Quota data unavailable.", "额度数据不可用。")}</p>
      )}
    </div>
  );
}

function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button className="section-header" onClick={onToggle} aria-expanded={expanded}>
      <span>{title}</span>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  selected,
  liveState,
  language,
  onSelect,
  onOpen,
  onOpenMatch,
  onRename,
  onFavorite,
  onContextMenu,
}: {
  session: SessionSearchResult;
  selected: boolean;
  liveState: LiveSessionState;
  language: LanguageMode;
  onSelect: (sessionKey: string) => void;
  onOpen: (session: SessionSearchResult) => void;
  onOpenMatch: (session: SessionSearchResult, hit: SessionMatchHit) => void;
  onRename: (session: SessionSearchResult) => void;
  onFavorite: (session: SessionSearchResult) => void;
  onContextMenu: (event: ReactMouseEvent, session: SessionSearchResult) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const matchHits = session.matchHits ?? [];
  const metadataMatchLabel =
    session.metadataMatch === "title"
      ? l("Matched session title", "命中会话标题")
      : session.metadataMatch === "project"
        ? l("Matched project path", "命中项目路径")
        : session.metadataMatch === "summary"
          ? l("Matched session summary", "命中会话摘要")
          : null;
  return (
    <article
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={() => onSelect(session.sessionKey)}
      onDoubleClick={() => onOpen(session)}
      onContextMenu={(event) => onContextMenu(event, session)}
    >
      <div className="session-main">
        <div className="session-title">
          <button
            className={`favorite-button ${session.favorited ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite(session);
            }}
            aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
            title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
          >
            <Star size={14} fill={session.favorited ? "currentColor" : "none"} />
          </button>
          {session.pinned ? <Pin size={14} /> : null}
          {session.hidden ? <EyeOff size={14} /> : null}
          <span className="session-name">{session.displayTitle}</span>
          <button
            className="title-edit-button"
            onClick={(event) => {
              event.stopPropagation();
              onRename(session);
            }}
            aria-label={l("Rename session", "重命名会话")}
            title={l("Rename session", "重命名会话")}
          >
            <Edit3 size={13} />
          </button>
        </div>
        <div className="session-meta">
          <span className={`live-status ${liveState}`}>
            <span className="live-status-dot" />
            {localizedLiveStateLabel(liveState, language)}
          </span>
          <span className={`source-badge ${sourceUiFamily(session.source)}`}>
            {sourceUiFamily(session.source) === "claude" ? <Code2 size={13} /> : <TerminalIcon size={13} />}
            {SOURCE_LABEL[session.source]}
          </span>
          <span className={`environment-badge ${session.environmentKind}`} title={environmentBadgeTitle(session, language)}>
            {isRemoteSession(session) ? <Server size={13} /> : <Laptop size={13} />}
            {environmentBadgeLabel(session, language)}
          </span>
          <span>{session.projectPath || l("No project path", "无项目路径")}</span>
          <span>{formatRelativeTime(sessionSortTimestamp(session))}</span>
          <span>{l(`${session.messageCount} messages`, `${session.messageCount} 条消息`)}</span>
          <span>{l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)}</span>
        </div>
        {matchHits.length > 0 ? (
          <div className="search-match-list">
            <div className="search-match-count">
              {l(`${session.messageMatchCount ?? matchHits.length} message matches`, `${session.messageMatchCount ?? matchHits.length} 条消息命中`)}
            </div>
            {matchHits.map((hit) => {
              const timestamp = Date.parse(hit.timestamp);
              return (
                <button
                  type="button"
                  className="search-match-hit"
                  key={hit.messageIndex}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenMatch(session, hit);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <span className="search-match-meta">
                    <strong>{hit.role === "user" ? l("User", "用户") : l("Assistant", "助手")}</strong>
                    {Number.isFinite(timestamp) ? <time>{formatRelativeTime(timestamp)}</time> : null}
                  </span>
                  <span className="search-match-snippet">
                    <HighlightedSearchText text={hit.snippet} terms={hit.matchedTerms} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : metadataMatchLabel ? (
          <div className="search-metadata-match">
            <span>{metadataMatchLabel}</span>
            {session.matchSnippet ? <span className="snippet">{session.matchSnippet}</span> : null}
          </div>
        ) : session.matchSnippet ? <div className="snippet">{session.matchSnippet}</div> : null}
      </div>
      <div className="row-tags">
        {session.tags.slice(0, 3).map((tagName) => (
         <span key={tagName} className={isBranchTag(tagName) ? "branch-tag" : undefined}>
            {isBranchTag(tagName) ? "" : "#"}{displayTagName(tagName)}
         </span>
        ))}
      </div>
    </article>
  );
});

function ActionToast({ status, onClose }: { status: ActionStatus; onClose: () => void }): ReactElement {
  return (
    <div className={`action-toast ${status.kind}`} role="status" aria-live="polite">
      <span>{status.message}</span>
      {status.kind === "error" ? (
        <button type="button" className="action-toast-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

function quotaStatusLabel(status: UsageQuotaCard["status"], language: LanguageMode): string {
  if (status === "supported") return localize(language, "Live", "可用");
  if (status === "unsupported_api_key") return localize(language, "Unsupported", "不支持");
  if (status === "error") return localize(language, "Error", "错误");
  return localize(language, "Setup", "设置");
}

function formatQuotaReset(resetsAt: string | undefined, language: LanguageMode): string {
  if (!resetsAt) return "";
  const timestamp = Date.parse(resetsAt);
  if (!Number.isFinite(timestamp)) return "";
  const diff = timestamp - Date.now();
  if (diff <= 0) return localize(language, "reset due", "应重置");
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return localize(language, `resets in ${minutes}m`, `${minutes} 分钟后重置`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes - hours * 60;
    return remainingMinutes > 0
      ? localize(language, `resets in ${hours}h ${remainingMinutes}m`, `${hours} 小时 ${remainingMinutes} 分钟后重置`)
      : localize(language, `resets in ${hours}h`, `${hours} 小时后重置`);
  }
  const days = Math.ceil(hours / 24);
  return localize(language, `resets in ${days}d`, `${days} 天后重置`);
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
  onFavorite,
  onPin,
  onHide,
  onResume,
  onResumeIterm,
  onOpenApp,
  onMigrate,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
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
  onFavorite: () => void;
  onPin: () => void;
  onHide: () => void;
  onResume: () => void;
  onResumeIterm: () => void;
  onOpenApp: () => void;
  onMigrate: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onDelete: () => void;
  onReveal: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const menu = useClampedContextMenuStyle(state);
  const localOnlyDisabled = isRemoteSession(state.session);
  const revealTitle = localOnlyDisabled ? remoteRevealTitle(language) : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);
  const openAppTitle = localOnlyDisabled ? remoteOpenAppTitle(language) : l("Open native app", "打开原生应用");
  const migrateTitle = localOnlyDisabled
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
      <button onClick={onFavorite}>
        <Star size={14} fill={state.session.favorited ? "currentColor" : "none"} />{" "}
        {state.session.favorited ? l("Unfavorite", "取消收藏") : l("Favorite", "收藏")}
      </button>
      <button onClick={onPin}>{state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />} {state.session.pinned ? l("Unpin", "取消置顶") : l("Pin", "置顶")}</button>
      <button onClick={onHide}>
        {state.session.hidden ? <Eye size={14} /> : <Archive size={14} />} {state.session.hidden ? l("Unhide", "取消隐藏") : l("Hide", "隐藏")}
      </button>
      <hr />
      {canResume ? (
        <button onClick={onResume}>
          <Play size={14} /> {l("Resume in Terminal", "在终端恢复")}
        </button>
      ) : null}
      {canResume && showMacActions ? (
        <button onClick={onResumeIterm}>
          <TerminalIcon size={14} /> Resume in iTerm
        </button>
      ) : null}
      {canResume && showMacActions ? (
        <button onClick={onOpenApp} disabled={localOnlyDisabled} title={openAppTitle}>
          <AppWindow size={14} /> Open App
        </button>
      ) : null}
      <button onClick={onMigrate} disabled={!canMigrate || localOnlyDisabled} title={migrateTitle}>
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
      <button onClick={onReveal} disabled={localOnlyDisabled} title={revealTitle}>
        <FolderOpen size={14} /> Show in {revealLabel}
      </button>
      <hr />
      <button className="danger" onClick={onDelete}>
        <Trash2 size={14} /> {l("Delete Session", "删除会话")}
      </button>
    </div>
  );
}

function UpdateBrandMark(): ReactElement {
  return (
    <svg className="update-brand-mark" viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="update-brand-gradient" x1="14" y1="8" x2="82" y2="88" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1687ff" />
          <stop offset="0.55" stopColor="#3d63ed" />
          <stop offset="1" stopColor="#7047d7" />
        </linearGradient>
        <radialGradient id="update-brand-glow" cx="0" cy="0" r="1" gradientTransform="translate(25 20) rotate(46) scale(69)">
          <stop stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="0.62" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="3" y="3" width="90" height="90" rx="27" fill="url(#update-brand-gradient)" />
      <rect x="3" y="3" width="90" height="90" rx="27" fill="url(#update-brand-glow)" />
      <circle cx="43" cy="41" r="21" fill="none" stroke="#ffffff" strokeWidth="6" />
      <path d="M58.5 56.5 73 71" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" />
      <path d="m35.5 33.5 7.5 7.5-7.5 7.5M47.5 49h8.5" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UpdateReleaseSection({
  kind,
  title,
  items,
}: {
  kind: "features" | "fixes";
  title: string;
  items: string[];
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section className={`update-release-section ${kind}`}>
      <div className="update-release-section-title">
        <span className="update-release-section-icon" aria-hidden="true">
          {kind === "features" ? <Sparkles size={15} /> : <Wrench size={15} />}
        </span>
        <strong>{title}</strong>
      </div>
      <ul>{items.map((item) => <li key={`${kind}:${item}`}>{item}</li>)}</ul>
    </section>
  );
}

function SettingsDialog({
  initialSection,
  settings,
  appUpdateStatus,
  appUpdateBusy,
  appUpdateError,
  environments,
  environmentHealthReports,
  diagnosingEnvironmentId,
  theme,
  language,
  feedback,
  onSettingsChange,
  onCheckAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
  onThemeChange,
  onLanguageChange,
  onDefaultTerminalChange,
  onGlobalShortcutChange,
  skillHookInstalled,
  skillHookBusy,
  onSkillHookChange,
  onRefreshEnvironment,
  onDiagnoseEnvironment,
  onDeleteEnvironment,
  onAddSsh,
  onOpenApiConfig,
  onOpenRemoteSessions,
  onClose,
}: {
  initialSection: SettingsSection;
  settings: AppSettings | null;
  appUpdateStatus: AppUpdateStatus | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  environments: SessionEnvironment[];
  environmentHealthReports: Record<string, RemoteHealthReport>;
  diagnosingEnvironmentId: string | null;
  theme: ThemeMode;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onCheckAppUpdate: () => void;
  onInstallAppUpdate: () => void;
  onSkipAppUpdate: (untilNextVersion: boolean) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLanguageChange: (language: LanguageMode) => void;
  onDefaultTerminalChange: (terminal: AppSettings["defaultTerminal"]) => void;
  onGlobalShortcutChange: (shortcut: AppSettings["globalShortcut"]) => void;
  skillHookInstalled: boolean | null;
  skillHookBusy: boolean;
  onSkillHookChange: (enabled: boolean) => void;
  onRefreshEnvironment: (environment: SessionEnvironment) => void;
  onDiagnoseEnvironment: (environment: SessionEnvironment) => void;
  onDeleteEnvironment: (environment: SessionEnvironment) => void;
  onAddSsh: () => void;
  onOpenApiConfig: () => void;
  onOpenRemoteSessions: () => void;
  onClose: () => void;
}): ReactElement {
  const defaultTerminal = settings?.defaultTerminal ?? (RUNTIME_PLATFORM === "win32" ? "WindowsTerminal" : "Terminal");
  const globalShortcut = settings?.globalShortcut ?? (RUNTIME_PLATFORM === "win32" ? "Ctrl+Alt+Space" : "Alt+Space");
  const saving = feedback?.kind === "running";
  const [summaryBatch, setSummaryBatch] = useState<{ running: boolean; message: string | null }>({ running: false, message: null });
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    void window.sessionSearch
      .getMcpStatus()
      .then(setMcpEnabled)
      .catch(() => setMcpEnabled(false));
  }, []);

  async function toggleMcp(next: boolean): Promise<void> {
    setMcpBusy(true);
    try {
      setMcpEnabled(await window.sessionSearch.setMcpEnabled(next));
    } catch {
      // Leave the previous state; the toggle simply won't flip.
    } finally {
      setMcpBusy(false);
    }
  }

  useEffect(() => {
    const off = window.sessionSearch.onSummaryProgress((progress) => {
      setSummaryBatch((current) =>
        current.running
          ? {
              running: true,
              message: localize(
                language,
                `Summarizing ${progress.processed + progress.failed}/${progress.total}...`,
                `摘要中 ${progress.processed + progress.failed}/${progress.total}...`,
              ),
            }
          : current,
      );
    });
    return off;
  }, [language]);

  async function runSummaryBatch(): Promise<void> {
    setSummaryBatch({ running: true, message: localize(language, "Starting...", "开始...") });
    try {
      const result = await window.sessionSearch.summarizeMissingSessions();
      const base = localize(language, `Summarized ${result.processed}/${result.total} sessions.`, `已摘要 ${result.processed}/${result.total} 个会话。`);
      const failedNote = result.failed > 0 ? localize(language, ` ${result.failed} failed.`, ` ${result.failed} 个失败。`) : "";
      setSummaryBatch({ running: false, message: base + failedNote });
    } catch (error) {
      setSummaryBatch({ running: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const l = (en: string, zh: string) => localize(language, en, zh);
  const shouldSignalAppUpdate = Boolean(appUpdateStatus?.updateAvailable && !appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed);
  const appUpdateSuppressed = Boolean(appUpdateStatus?.updateAvailable && !shouldSignalAppUpdate);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const settingsContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = settingsContentRef.current;
    if (!content) return;
    content.scrollTop = 0;
    const frame = window.requestAnimationFrame(() => {
      content.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, appUpdateStatus?.manifest?.version, appUpdateStatus?.updateAvailable]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Settings", "设置")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-shell">
          <nav className="settings-sidebar" aria-label={l("Settings sections", "设置分区")}>
            <button className={activeSection === "terminal" ? "active" : ""} onClick={() => setActiveSection("terminal")}>
              <TerminalIcon size={15} />
              <span>{l("Default terminal", "默认终端")}</span>
            </button>
            <button className={activeSection === "shortcut" ? "active" : ""} onClick={() => setActiveSection("shortcut")}>
              <Keyboard size={15} />
              <span>{l("Global shortcut", "全局快捷键")}</span>
            </button>
            <button className={activeSection === "connections" ? "active" : ""} onClick={() => setActiveSection("connections")}>
              <Server size={15} />
              <span>{l("Connections", "连接")}</span>
            </button>
            <button className={activeSection === "sources" ? "active" : ""} onClick={() => setActiveSection("sources")}>
              <Folder size={15} />
              <span>{l("Optional sources", "可选来源")}</span>
            </button>
            <button className={activeSection === "usage" ? "active" : ""} onClick={() => setActiveSection("usage")}>
              <Gauge size={15} />
              <span>{l("Usage limits", "剩余额度")}</span>
            </button>
            <button className={activeSection === "ai" ? "active" : ""} onClick={() => setActiveSection("ai")}>
              <Sparkles size={15} />
              <span>{l("AI", "AI")}</span>
            </button>
            <button className={activeSection === "remote" ? "active" : ""} onClick={() => setActiveSection("remote")}>
              <Cloud size={15} />
              <span>{l("Remote sync", "远程同步")}</span>
            </button>
            <button className={activeSection === "skills" ? "active" : ""} onClick={() => setActiveSection("skills")}>
              <PackageSearch size={15} />
              <span>{l("Skills", "Skills")}</span>
            </button>
            <button className={activeSection === "appearance" ? "active" : ""} onClick={() => setActiveSection("appearance")}>
              <Sun size={15} />
              <span>{l("Appearance", "外观")}</span>
            </button>
            <button className={activeSection === "about" ? "active" : ""} onClick={() => setActiveSection("about")}>
              <Info size={15} />
              <span>{l("About", "关于")}</span>
              {shouldSignalAppUpdate ? <span className="settings-update-dot" aria-hidden="true" /> : null}
            </button>
          </nav>
          <div ref={settingsContentRef} className="settings-content">
            {activeSection === "terminal" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Default terminal", "默认终端")}</h3>
                  <p>{l("Choose which terminal app Resume and the selected-session shortcut use to reopen a session.", "选择 Resume 和选中会话快捷键用于恢复会话的终端应用。")}</p>
                </header>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Terminal app", "终端应用")}</span>
                    <span className="settings-field-sub">{l("Applies to Resume and the selected-session shortcut.", "应用于 Resume 和选中会话快捷键。")}</span>
                  </div>
                  <select
                    id="default-terminal"
                    value={defaultTerminal}
                    disabled={!settings || saving}
                    onChange={(event) => onDefaultTerminalChange(event.target.value as AppSettings["defaultTerminal"])}
                  >
                    {DEFAULT_TERMINAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            ) : null}
            {activeSection === "shortcut" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Global shortcut", "全局快捷键")}</h3>
                  <p>{l("Choose the system-wide shortcut used to open or hide the search window.", "选择用于打开或隐藏搜索窗口的系统级快捷键。")}</p>
                </header>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Open search window", "打开搜索窗口")}</span>
                    <span className="settings-field-sub">{l("If another app owns the shortcut, this setting will fail to save.", "如果快捷键被其他应用占用，保存会失败。")}</span>
                  </div>
                  <select
                    id="global-shortcut"
                    value={globalShortcut}
                    disabled={!settings || saving}
                    onChange={(event) => onGlobalShortcutChange(event.target.value as AppSettings["globalShortcut"])}
                  >
                    {globalShortcutOptions(RUNTIME_PLATFORM).map((option) => (
                      <option key={option.label} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            ) : null}
            {activeSection === "connections" ? (
              <section className="settings-pane connections-pane">
                <header className="settings-pane-head settings-pane-head-row">
                  <div>
                    <h3>{l("Connections", "连接")}</h3>
                    <p>{l("Local and SSH environments indexed by session search.", "会话搜索索引的本地和 SSH 环境。")}</p>
                  </div>
                  <button className="settings-action-button" onClick={onAddSsh}>
                    <Plus size={14} />
                    <span>{l("Add SSH", "添加 SSH")}</span>
                  </button>
                </header>
                <div className="connection-list">
                  {environments.map((environment) => {
                    const report = environmentHealthReports[environment.id];
                    const diagnosing = diagnosingEnvironmentId === environment.id;
                    return (
                      <div key={environment.id} className={`connection-row ${environmentStatus(environment)} ${report ? "with-diagnostics" : ""}`}>
                        <div className="connection-icon">{environment.kind === "local" ? <Laptop size={15} /> : <Server size={15} />}</div>
                        <div className="connection-main">
                          <span className="connection-title">{environment.label}</span>
                          <span className="connection-target">{environmentTarget(environment, language)}</span>
                          {environment.lastError ? <span className="connection-error">{environment.lastError}</span> : null}
                        </div>
                        <span className="connection-status">{environmentStatusLabel(environment, language)}</span>
                        {environment.kind === "ssh" ? (
                          <div className="connection-actions">
                            <button
                              className="icon-button"
                              disabled={diagnosing}
                              onClick={() => onDiagnoseEnvironment(environment)}
                              title={l("Diagnose", "诊断")}
                              aria-label={l(`Diagnose ${environment.label}`, `诊断 ${environment.label}`)}
                            >
                              <Activity size={14} />
                            </button>
                            <button
                              className="icon-button"
                              onClick={() => onRefreshEnvironment(environment)}
                              title={l("Refresh", "刷新")}
                              aria-label={l(`Refresh ${environment.label}`, `刷新 ${environment.label}`)}
                            >
                              <RefreshCw size={14} />
                            </button>
                            <button
                              className="icon-button danger"
                              onClick={() => onDeleteEnvironment(environment)}
                              title={l("Delete", "删除")}
                              aria-label={l(`Delete ${environment.label}`, `删除 ${environment.label}`)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ) : null}
                        {report ? (
                          <div className="connection-diagnostics">
                            <div className="connection-diagnostics-head">
                              <span>{report.summary}</span>
                              <time>{formatRelativeTime(report.checkedAt)}</time>
                            </div>
                            <div className="connection-diagnostic-list">
                              {report.checks.map((check) => (
                                <div key={check.id} className={`connection-diagnostic-check ${check.status}`}>
                                  <span className="connection-diagnostic-dot" />
                                  <span className="connection-diagnostic-label">{check.label}</span>
                                  <span className="connection-diagnostic-message" title={check.detail ?? check.message}>
                                    {check.message}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {activeSection === "sources" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Optional sources", "可选来源")}</h3>
                  <p>{l("Choose which local agent data sources are monitored and indexed.", "选择要监测和索引的本地 agent 数据源。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Hide subagent sessions", "隐藏 Subagent 会话")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Exclude subagents from session lists, project counts, and statistics.",
                        "从会话列表、项目数量和统计中排除 Subagent。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.hideSubagentSessions)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ hideSubagentSessions: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include CodeWiz</span>
                    <span className="settings-field-sub">{l("Indexes CodeWiz sessions from ~/.local/share/codewiz.", "索引 ~/.local/share/codewiz 中的 CodeWiz 会话。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCodeWizCli)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodeWizCli: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.claude-internal</span>
                    <span className="settings-field-sub">{l("Indexes Claude Code Internal sessions and allows migration to that CLI.", "索引 Claude Code Internal 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeClaudeInternal)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeClaudeInternal: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.codex-internal</span>
                    <span className="settings-field-sub">{l("Indexes Codex Internal sessions and allows migration to that CLI.", "索引 Codex Internal 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCodexInternal)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodexInternal: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.tclaude</span>
                    <span className="settings-field-sub">{l("Indexes TClaude CLI sessions and allows migration to that CLI.", "索引 TClaude CLI 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeTclaude)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeTclaude: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.tcodex</span>
                    <span className="settings-field-sub">{l("Indexes TCodex CLI sessions and allows migration to that CLI.", "索引 TCodex CLI 会话，并允许迁移到该 CLI。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeTcodex)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeTcodex: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.codebuddy</span>
                    <span className="settings-field-sub">{l("Adds a separate CodeBuddy CLI source filter.", "添加独立的 CodeBuddy CLI 来源过滤项。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCodeBuddyCli)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodeBuddyCli: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include OpenClaw</span>
                    <span className="settings-field-sub">{l("Indexes local OpenClaw session files.", "索引本地 OpenClaw 会话文件。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeOpenClaw)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeOpenClaw: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include Hermes</span>
                    <span className="settings-field-sub">{l("Indexes local Hermes session database.", "索引本地 Hermes 会话数据库。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeHermes)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeHermes: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include OpenCode</span>
                    <span className="settings-field-sub">{l("Indexes local OpenCode sessions.", "索引本地 OpenCode 会话。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeOpenCode)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeOpenCode: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include Cursor Agent</span>
                    <span className="settings-field-sub">{l("Indexes local Cursor agent transcripts.", "索引本地 Cursor agent 记录。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCursorAgent)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCursorAgent: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include Trae</span>
                    <span className="settings-field-sub">{l("Indexes local Trae session memory and enables open-state checks.", "索引本地 Trae 会话记忆，并支持打开状态检测。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeTrae)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeTrae: event.currentTarget.checked })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "usage" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Usage limits", "剩余额度")}</h3>
                  <p>{l("Hide a provider in the Remaining panel if you do not have that subscription.", "如果没有某个订阅,可在剩余额度面板中隐藏对应来源。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Hide Codex usage", "隐藏 Codex 额度")}</span>
                    <span className="settings-field-sub">{l("Skip loading and hide the Codex card.", "不加载并隐藏 Codex 额度卡片。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.hideCodexQuota)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ hideCodexQuota: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Hide Claude Code usage", "隐藏 Claude Code 额度")}</span>
                    <span className="settings-field-sub">{l("Skip loading and hide the Claude Code card.", "不加载并隐藏 Claude Code 额度卡片。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.hideClaudeQuota)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ hideClaudeQuota: event.currentTarget.checked })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "ai" ? (
              <section className="settings-pane">
                <header className="settings-pane-head settings-pane-head-row">
                  <div>
                    <h3>{l("AI summaries", "AI 摘要")}</h3>
                    <p>
                      {l(
                        "Generate a one-line searchable summary per session. Configure the provider and API key under the AI Summary tab of the API dialog (falls back to the Codex provider). Session content is sent to that provider.",
                        "为每个会话生成一句可搜索的摘要。在 API 弹窗的「AI 摘要」标签里配置 provider 和 API key(未配则回落 Codex provider)。会话内容会发送给该 provider。",
                      )}
                    </p>
                  </div>
                  <button type="button" className="settings-action-button" onClick={onOpenApiConfig}>
                    {l("Configure provider", "配置 provider")}
                  </button>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Auto-summarize new sessions", "自动摘要新会话")}</span>
                    <span className="settings-field-sub">{l("After each index, summarize recent sessions that are missing or outdated.", "每次索引后，为缺失或已过期的近期会话生成摘要。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.summaryAutoBackfill)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ summaryAutoBackfill: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Only summarize sessions newer than (days)", "只摘要近 N 天内的会话")}</span>
                    <span className="settings-field-sub">{l("Older inactive sessions are skipped by auto/batch summary.", "更久未更新的会话不会被自动/批量摘要。")}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    className="settings-number"
                    value={settings?.summaryMaxAgeDays ?? 30}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ summaryMaxAgeDays: Number(event.currentTarget.value) })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Migration compression concurrency", "迁移压缩并发度")}</span>
                    <span className="settings-field-sub">{l("Max chunk summaries run in parallel when compressing a long session for migration. Lower it if you hit provider rate limits.", "迁移压缩长会话时分片摘要的最大并行数。遇到 provider 限流就调低。")}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    className="settings-number"
                    value={settings?.compressionConcurrency ?? 8}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ compressionConcurrency: Number(event.currentTarget.value) })}
                  />
                </label>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Backfill missing summaries now", "立即补全缺失摘要")}</span>
                    <span className="settings-field-sub">{summaryBatch.message ?? l("Summarize recent sessions that have no summary yet.", "为还没有摘要的近期会话批量生成。")}</span>
                  </div>
                  <button className="settings-action-button" disabled={!settings || summaryBatch.running} onClick={() => void runSummaryBatch()}>
                    {summaryBatch.running ? l("Summarizing...", "摘要中...") : l("Run", "运行")}
                  </button>
                </div>
                <header className="settings-pane-head" style={{ marginTop: 18 }}>
                  <h3>{l("MCP server", "MCP 服务")}</h3>
                  <p>
                    {l(
                      "Let Claude Code / Codex search your past sessions over MCP (search_sessions, get_session). Registers the server in their configs; restart them to apply.",
                      "让 Claude Code / Codex 通过 MCP 检索你的历史会话(search_sessions、get_session)。会注册到它们的配置中，重启后生效。",
                    )}
                  </p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable session search MCP", "启用会话检索 MCP")}</span>
                    <span className="settings-field-sub">
                      {mcpEnabled === null
                        ? l("Checking...", "检查中...")
                        : l("Registers in Claude Code, Codex, and CodeBuddy configs.", "注册到 Claude Code、Codex、CodeBuddy 的配置中。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(mcpEnabled)}
                    disabled={mcpEnabled === null || mcpBusy}
                    onChange={(event) => void toggleMcp(event.currentTarget.checked)}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "remote" ? (
              <section className="settings-pane">
                <header className="settings-pane-head settings-pane-head-row">
                  <div>
                    <h3>{l("Supabase remote sessions", "Supabase 远程会话")}</h3>
                    <p>
                      {l(
                        "Use your own single-user Supabase project to upload sessions, search them on another device, view details, and restore them to Claude Code / Codex / CodeBuddy.",
                        "使用你自己的单人 Supabase 项目上传会话，在另一台设备搜索、查看详情，并恢复到 Claude Code / Codex / CodeBuddy。",
                      )}
                    </p>
                  </div>
                  <button type="button" className="settings-action-button" onClick={onOpenRemoteSessions}>
                    {l("Remote Sessions", "远程会话")}
                  </button>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable remote session sync", "启用远程会话同步")}</span>
                    <span className="settings-field-sub">
                      {l("Manual upload and restore in this version. Automatic background sync comes later.", "当前版本为手动上传和恢复；后台自动同步后续再做。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.remoteSyncEnabled)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ remoteSyncEnabled: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field remote-sync-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Supabase URL</span>
                    <span className="settings-field-sub">https://your-project.supabase.co</span>
                  </div>
                  <input
                    type="text"
                    value={settings?.remoteSyncSupabaseUrl ?? ""}
                    disabled={!settings || saving}
                    placeholder="https://your-project.supabase.co"
                    onChange={(event) => onSettingsChange({ remoteSyncSupabaseUrl: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field remote-sync-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">anon key</span>
                    <span className="settings-field-sub">
                      {l("Stored locally. Do not commit this value to the repository.", "保存在本地，请不要提交到仓库。")}
                    </span>
                  </div>
                  <input
                    type="password"
                    value={settings?.remoteSyncSupabaseAnonKey ?? ""}
                    disabled={!settings || saving}
                    placeholder="eyJhbGciOi..."
                    onChange={(event) => onSettingsChange({ remoteSyncSupabaseAnonKey: event.currentTarget.value })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "skills" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Skill usage", "Skill 统计")}</h3>
                  <p>{l("Count how often each skill is used so the Skills panel can sort by most used.", "统计每个 skill 的使用次数，让 Skills 面板可以按使用最多排序。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Track skill usage", "统计 Skill 使用次数")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Installs a PostToolUse hook in ~/.claude/settings.json for Claude Code. Codex usage is inferred automatically from local ~/.codex/sessions logs.",
                        "在 ~/.claude/settings.json 安装 Claude Code 的 PostToolUse hook。Codex 使用次数会自动从本地 ~/.codex/sessions 日志推断。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(skillHookInstalled)}
                    disabled={skillHookInstalled === null || skillHookBusy}
                    onChange={(event) => onSkillHookChange(event.currentTarget.checked)}
                  />
                </label>
                <header className="settings-pane-head" style={{ marginTop: 18 }}>
                  <h3>{l("Supabase skill sync", "Supabase Skill 同步")}</h3>
                  <p>
                    {l(
                      "Use your own Supabase project to upload local skills and install them on another machine. Get the Project URL and anon key from supabase.com/dashboard.",
                      "使用你自己的 Supabase 项目上传本地 Skills，并在另一台机器安装。可在 supabase.com/dashboard 获取 Project URL 和 anon key。",
                    )}
                  </p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Enable Supabase sync", "启用 Supabase 同步")}</span>
                    <span className="settings-field-sub">
                      {l("Advanced automatic table creation is not used; the app will show SQL when the table is missing.", "不使用高级自动建表；缺表时应用会展示可复制的初始化 SQL。")}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.skillSyncEnabled)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ skillSyncEnabled: event.currentTarget.checked })}
                  />
                </label>
                <label className="settings-field skills-sync-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Supabase URL</span>
                    <span className="settings-field-sub">https://your-project.supabase.co</span>
                  </div>
                  <input
                    type="text"
                    value={settings?.skillSyncSupabaseUrl ?? ""}
                    disabled={!settings || saving}
                    placeholder="https://your-project.supabase.co"
                    onChange={(event) => onSettingsChange({ skillSyncSupabaseUrl: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field skills-sync-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">anon key</span>
                    <span className="settings-field-sub">{l("Stored locally and used only for the skills sync table.", "保存在本地，仅用于 Skills 同步表。")}</span>
                  </div>
                  <input
                    type="password"
                    value={settings?.skillSyncSupabaseAnonKey ?? ""}
                    disabled={!settings || saving}
                    placeholder="eyJhbGciOi..."
                    onChange={(event) => onSettingsChange({ skillSyncSupabaseAnonKey: event.currentTarget.value })}
                  />
                </label>
              </section>
            ) : null}
            {activeSection === "appearance" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Appearance", "外观")}</h3>
                  <p>{l("Choose the color theme and language used by the session search window.", "选择会话搜索窗口使用的颜色主题和语言。")}</p>
                </header>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Theme", "主题")}</span>
                    <span className="settings-field-sub">{l("Saved on this device.", "保存在当前设备。")}</span>
                  </div>
                  <div className="theme-setting-toggle" role="group" aria-label={l("Theme", "主题")}>
                    <button className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}>
                      <Sun size={14} />
                      <span>{l("Light", "浅色")}</span>
                    </button>
                    <button className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}>
                      <Moon size={14} />
                      <span>{l("Dark", "深色")}</span>
                    </button>
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Language", "语言")}</span>
                    <span className="settings-field-sub">{l("Controls app chrome and settings text.", "控制应用界面和设置文案。")}</span>
                  </div>
                  <div className="language-setting-toggle" role="group" aria-label={l("Language", "语言")}>
                    <button className={language === "en" ? "active" : ""} onClick={() => onLanguageChange("en")}>
                      <Languages size={14} />
                      <span>English</span>
                    </button>
                    <button className={language === "zh" ? "active" : ""} onClick={() => onLanguageChange("zh")}>
                      <Languages size={14} />
                      <span>中文</span>
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
            {activeSection === "about" ? (
              <section className="settings-pane update-about-pane">
                <div className="update-app-identity">
                  <UpdateBrandMark />
                  <h3>Agent-Session-Search</h3>
                  <p>v{appUpdateStatus?.currentVersion ?? "0.0.0"}</p>
                </div>

                {shouldSignalAppUpdate && appUpdateStatus?.manifest ? (
                  <div className="update-available-card">
                    <div className="update-available-head">
                      <div className="update-available-copy">
                        <span>{l("Update available", "发现新版本")}</span>
                        <div className="update-version-route" aria-label={l(`Version ${appUpdateStatus.currentVersion} to ${appUpdateStatus.manifest.version}`, `版本 ${appUpdateStatus.currentVersion} 更新至 ${appUpdateStatus.manifest.version}`)}>
                          <span>v{appUpdateStatus.currentVersion}</span>
                          <ChevronRight size={18} aria-hidden="true" />
                          <strong>v{appUpdateStatus.manifest.version}</strong>
                          <span className="update-new-badge">{l("NEW", "可更新")}</span>
                        </div>
                      </div>
                      <span className="update-available-icon" aria-hidden="true">
                        <Sparkles size={22} />
                      </span>
                    </div>
                    <div className="update-release-card">
                      <UpdateReleaseSection kind="features" title={l("New features", "新增功能")} items={appUpdateStatus.manifest.notes.features} />
                      <UpdateReleaseSection kind="fixes" title={l("Fixes", "问题修复")} items={appUpdateStatus.manifest.notes.fixes} />
                    </div>
                    <div className="update-card-footer">
                      <span>{l("The App will reopen automatically after updating.", "更新完成后会自动重新打开应用。")}</span>
                      <div className="update-card-actions">
                        <button
                          type="button"
                          className="update-refresh-button"
                          disabled={appUpdateBusy}
                          onClick={onCheckAppUpdate}
                          aria-label={l("Check again", "重新检查更新")}
                          title={l("Check again", "重新检查更新")}
                        >
                          <RefreshCw size={15} className={appUpdateBusy ? "spin" : ""} />
                        </button>
                        <button type="button" className="update-secondary-button" disabled={appUpdateBusy} onClick={() => onSkipAppUpdate(false)}>
                          {l("Skip", "跳过")}
                        </button>
                        <button type="button" className="update-secondary-button" disabled={appUpdateBusy} onClick={() => onSkipAppUpdate(true)}>
                          {l("Skip until next", "跳过至下版")}
                        </button>
                        <button type="button" className="update-primary-button" disabled={appUpdateBusy} onClick={onInstallAppUpdate}>
                          <Download size={15} aria-hidden="true" />
                          {appUpdateBusy ? l("Preparing...", "准备中...") : l("Update now", "立即更新")}
                        </button>
                      </div>
                    </div>
                    {appUpdateError || appUpdateStatus.error ? <div className="update-card-error">{appUpdateError || appUpdateStatus.error}</div> : null}
                  </div>
                ) : (
                  <div
                    className={`update-current-state ${
                      appUpdateError || appUpdateStatus?.error ? "error" : appUpdateBusy ? "checking" : "latest"
                    }`}
                  >
                    <span className="update-state-icon" aria-hidden="true">
                      {appUpdateBusy ? <RefreshCw size={19} className="spin" /> : appUpdateError || appUpdateStatus?.error ? <Info size={19} /> : <CheckCircle2 size={20} />}
                    </span>
                    <span className="update-state-copy">
                      <strong>
                        {appUpdateBusy
                          ? l("Checking for updates...", "正在检查更新...")
                          : appUpdateError || appUpdateStatus?.error || (appUpdateSuppressed ? l("Update prompt skipped", "已跳过此次更新提示") : l("You're up to date", "当前已是最新版本"))}
                      </strong>
                      {!appUpdateBusy && !appUpdateError && !appUpdateStatus?.error ? (
                        <span>
                          {appUpdateSuppressed
                            ? l("Use Check for updates to show the skipped release again.", "点击检查更新可重新显示已跳过的版本。")
                            : l("Automatic checks will keep you on the newest release.", "自动检查会让你及时获取后续新版本。")}
                        </span>
                      ) : null}
                    </span>
                  </div>
                )}

                {!shouldSignalAppUpdate ? (
                  <div className="update-about-actions">
                    <button type="button" className="settings-action-button" disabled={appUpdateBusy} onClick={onCheckAppUpdate}>
                      <RefreshCw size={14} className={appUpdateBusy ? "spin" : ""} />
                      {l("Check for updates", "检查更新")}
                    </button>
                  </div>
                ) : null}
                <label className="settings-field settings-toggle update-auto-check">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Automatically check for updates", "自动检查更新")}</span>
                    <span className="settings-field-sub">{l("The terminal and App check for a new version once a day.", "终端与 App 每天自动检查一次新版本。")}</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.autoCheckUpdates)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ autoCheckUpdates: event.currentTarget.checked })}
                  />
                </label>
              </section>
            ) : null}
          </div>
        </div>
        <div className={`settings-feedback ${feedback?.kind ?? ""}`} aria-live="polite">
          {feedback?.message ?? ""}
        </div>
      </section>
    </div>
  );
}

function SshEnvironmentDialog({
  environments,
  language,
  feedback,
  onSaveEnvironment,
  onClose,
}: {
  environments: SessionEnvironment[];
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSaveEnvironment: (input: EnvironmentUpsertInput) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [mode, setMode] = useState<"config" | "manual">("config");
  const [hosts, setHosts] = useState<SshConfigHost[]>([]);
  const [selectedAliases, setSelectedAliases] = useState<Set<string>>(() => new Set());
  const [loadingHosts, setLoadingHosts] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [manualLabel, setManualLabel] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("");
  const [manualAuthMode, setManualAuthMode] = useState<SshAuthMode>("none");
  const [manualIdentityFile, setManualIdentityFile] = useState("");
  const saving = feedback?.kind === "running";
  const existingAliases = useMemo(() => existingSshHostAliases(environments), [environments]);
  const selectableAliasCount = [...selectedAliases].filter((alias) => !existingAliases.has(alias)).length;

  useEffect(() => {
    let cancelled = false;
    setLoadingHosts(true);
    window.sessionSearch
      .listSshConfigHosts()
      .then((nextHosts) => {
        if (cancelled) return;
        setHosts(nextHosts);
        setSelectedAliases(new Set());
        setLocalError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setHosts([]);
        setLocalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingHosts(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleAlias(alias: string): void {
    if (existingAliases.has(alias)) return;
    setSelectedAliases((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  async function addSelectedHosts(): Promise<void> {
    const selectedHosts = hosts.filter((host) => selectedAliases.has(host.alias) && !existingAliases.has(host.alias));
    if (selectedHosts.length === 0) {
      setLocalError(l("Select at least one SSH config host.", "至少选择一个 SSH 配置主机。"));
      return;
    }
    try {
      setLocalError(null);
      for (const host of selectedHosts) {
        await onSaveEnvironment({
          kind: "ssh",
          label: host.alias,
          hostAlias: host.alias,
          host: host.hostName,
          user: host.user,
          port: host.port,
          authMode: host.identityFile ? "identityFile" : "none",
          identityFile: host.identityFile,
          enabled: true,
        });
      }
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  async function addManualHost(): Promise<void> {
    try {
      const normalized = normalizeManualSshDraft({
        label: manualLabel,
        host: manualHost,
        port: manualPort,
        authMode: manualAuthMode,
        identityFile: manualIdentityFile,
      });
      setLocalError(null);
      await onSaveEnvironment({
        kind: "ssh",
        label: normalized.label,
        hostAlias: null,
        host: normalized.host,
        user: normalized.user,
        port: normalized.port,
        authMode: normalized.authMode,
        identityFile: normalized.identityFile,
        enabled: true,
      });
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog ssh-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Add SSH", "添加 SSH")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="ssh-dialog-body">
          {mode === "config" ? (
            <div className="ssh-config-panel">
              <div className="ssh-config-list">
                {loadingHosts ? <div className="ssh-empty">{l("Loading SSH config hosts...", "正在加载 SSH 配置主机...")}</div> : null}
                {!loadingHosts && hosts.length === 0 ? <div className="ssh-empty">{l("No SSH config hosts found.", "未找到 SSH 配置主机。")}</div> : null}
                {hosts.map((host) => {
                  const existing = existingAliases.has(host.alias);
                  const checked = existing || selectedAliases.has(host.alias);
                  return (
                    <label
                      key={host.alias}
                      className={`ssh-config-row ${checked ? "active" : ""} ${existing ? "disabled" : ""}`}
                      title={sshConfigHostDetail(host)}
                    >
                      <span className="ssh-host-main">
                        <strong>{host.alias}</strong>
                        <em>{sshConfigHostDetail(host)}</em>
                      </span>
                      <input
                        type="checkbox"
                        className="ssh-check"
                        checked={checked}
                        disabled={existing}
                        onChange={() => toggleAlias(host.alias)}
                        aria-label={
                          existing
                            ? l(`${host.alias} is already connected`, `${host.alias} 已连接`)
                            : l(`Select ${host.alias}`, `选择 ${host.alias}`)
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <form
              className="ssh-manual-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addManualHost();
              }}
            >
              <label className="ssh-form-field">
                <span>{l("Display name", "显示名称")}</span>
                <input value={manualLabel} onChange={(event) => setManualLabel(event.target.value)} placeholder="devbox" />
              </label>
              <label className="ssh-form-field">
                <span>{l("Host", "主机")}</span>
                <input value={manualHost} onChange={(event) => setManualHost(event.target.value)} placeholder="user@host.com" autoFocus />
              </label>
              <label className="ssh-form-field">
                <span>{l("SSH port", "SSH 端口")}</span>
                <input value={manualPort} onChange={(event) => setManualPort(event.target.value)} placeholder="22" inputMode="numeric" />
              </label>
              <div className="ssh-form-field">
                <span>{l("Authentication", "认证")}</span>
                <div className="ssh-auth-toggle" role="group" aria-label={l("Authentication", "认证")}>
                  <button type="button" className={manualAuthMode === "none" ? "active" : ""} onClick={() => setManualAuthMode("none")}>
                    {l("No auth", "无认证")}
                  </button>
                  <button
                    type="button"
                    className={manualAuthMode === "identityFile" ? "active" : ""}
                    onClick={() => setManualAuthMode("identityFile")}
                  >
                    {l("Identity file", "身份文件")}
                  </button>
                </div>
              </div>
              {manualAuthMode === "identityFile" ? (
                <label className="ssh-form-field">
                  <span>{l("Identity file", "身份文件")}</span>
                  <input
                    value={manualIdentityFile}
                    onChange={(event) => setManualIdentityFile(event.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                </label>
              ) : null}
            </form>
          )}
        </div>
        <div className="ssh-dialog-footer">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setLocalError(null);
              setMode(mode === "config" ? "manual" : "config");
            }}
          >
            {mode === "config" ? l("Manual add", "手动添加") : l("SSH config", "SSH 配置")}
          </button>
          <div className={`settings-feedback inline ${localError ? "error" : feedback?.kind ?? ""}`} aria-live="polite">
            {localError ?? feedback?.message ?? ""}
          </div>
          <button
            type="button"
            className="primary"
            disabled={saving || (mode === "config" && selectableAliasCount === 0)}
            onClick={() => void (mode === "config" ? addSelectedHosts() : addManualHost())}
          >
            <Plus size={14} />
            <span>{l("Add", "添加")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

interface ManualSshDraft {
  label: string;
  host: string;
  port: string;
  authMode: SshAuthMode;
  identityFile: string;
}

function normalizeManualSshDraft(input: ManualSshDraft): {
  label: string;
  host: string;
  user: string | null;
  port: number | null;
  authMode: SshAuthMode;
  identityFile: string | null;
} {
  const rawHost = input.host.trim();
  if (!rawHost) throw new Error("SSH host is required.");
  const at = rawHost.lastIndexOf("@");
  const user = at >= 0 ? rawHost.slice(0, at).trim() || null : null;
  const host = at >= 0 ? rawHost.slice(at + 1).trim() : rawHost;
  if (!host) throw new Error("SSH host is required.");
  const port = parseManualSshPort(input.port.trim());
  return {
    label: input.label.trim() || host,
    host,
    user,
    port,
    authMode: input.authMode,
    identityFile: input.authMode === "identityFile" ? input.identityFile.trim() || null : null,
  };
}

function parseManualSshPort(value: string): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new Error("SSH port must be a number from 1 to 65535.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("SSH port must be a number from 1 to 65535.");
  }
  return parsed;
}

function sshConfigHostDetail(host: SshConfigHost): string {
  const parts = [
    host.hostName ? `HostName ${host.hostName}` : null,
    host.user ? `User ${host.user}` : null,
    host.port ? `Port ${host.port}` : null,
    host.identityFile ? `IdentityFile ${host.identityFile}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || host.alias;
}
