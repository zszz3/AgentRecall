import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEventHandler, ReactElement } from "react";
import {
  AppWindow,
  Archive,
  ChevronDown,
  ChevronRight,
  Clipboard,
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
  KeyRound,
  Keyboard,
  Languages,
  Moon,
  PackageSearch,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Settings,
  Star,
  Sun,
  Tag,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import type { ApiConfig, ClaudeApiConfig } from "../../core/api-config";
import type { IndexStatus } from "../../core/indexer";
import { formatRelativeTime } from "../../core/format-session";
import { QUOTA_REFRESH_INTERVAL_MS } from "../../core/refresh-policy";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../core/skill-manager";
import { globalShortcutOptions } from "../../core/shortcuts";
import { terminalSelectOptions } from "../../core/terminal-options";
import type {
  LiveSessionSnapshot,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionSortBy,
  SessionStats,
  SessionStatsPeriod,
  SessionTraceEvent,
  UsageQuotaCard,
  UsageQuotaSnapshot,
} from "../../core/types";
import { formatCompactNumber, formatTokenCount } from "./format-count";
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
import type {
  ActionStatus,
  ContextMenuState,
  DialogState,
  QuotaFeedback,
  RefreshFeedback,
  SettingsFeedback,
  SkillsFeedback,
  StatsFeedback,
} from "./app-types";
import { ApiConfigDialog } from "./components/api-config-dialog";
import { DetailPanel } from "./components/detail-panel";
import { CommandDialog, DeleteSessionDialog, DeleteTagDialog } from "./components/session-dialogs";
import { SkillsDialog } from "./components/skills-dialog";
import { useClampedContextMenuStyle } from "./context-menu-position";
import {
  SOURCE_LABEL,
  isBranchTag,
  liveStatusFilterLabel,
  localizedLiveStateLabel,
  resumeRouteMessage,
  sourceFilterLabel,
  sourceFilters,
  sourceUiFamily,
  statsPeriodLabel,
} from "./session-ui";

const SORT_OPTIONS: Array<{ label: string; value: SessionSortBy }> = [
  { label: "Latest activity", value: "activity" },
  { label: "Created", value: "created" },
  { label: "Updated", value: "updated" },
];

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

type ViewMode = "default" | "favorites" | "pinned" | "hidden";
const INITIAL_SESSION_LIMIT = 30;
const SESSION_PAGE_SIZE = 30;
const INITIAL_MESSAGE_LIMIT = 20;
const MESSAGE_PAGE_SIZE = 80;

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

function sortLabel(value: SessionSortBy, language: LanguageMode): string {
  if (value === "created") return localize(language, "Created", "创建时间");
  if (value === "updated") return localize(language, "Updated", "更新时间");
  return localize(language, "Latest activity", "最近活动");
}

const SIDEBAR_SECTIONS_STORAGE_KEY = "agent-session-search-sidebar-sections";

function loadInitialSidebarSections(): SidebarSectionsState {
  if (typeof window === "undefined") return readSidebarSections(null);
  return readSidebarSections(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY));
}

export function App(): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionsState>(() => loadInitialSidebarSections());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<ViewMode>("default");
  const [sortBy, setSortBy] = useState<SessionSortBy>("created");
  const [liveStatus, setLiveStatus] = useState<LiveStatusFilter>("all");
  const [sessionLimit, setSessionLimit] = useState(INITIAL_SESSION_LIMIT);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
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
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [traceEvents, setTraceEvents] = useState<SessionTraceEvent[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<SessionSearchResult | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillsSnapshot>(EMPTY_SKILLS);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsFeedback, setSkillsFeedback] = useState<SkillsFeedback>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedback>(null);
  const [skillHookInstalled, setSkillHookInstalled] = useState<boolean | null>(null);
  const [skillHookBusy, setSkillHookBusy] = useState(false);
  const [pendingPersonalSources, setPendingPersonalSources] = useState<{ claude: boolean; codex: boolean; codebuddy: boolean }>({
    claude: false,
    codex: false,
    codebuddy: false,
  });
  const loadSeqRef = useRef(0);
  const detailLoadSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const searchScopeKey = useMemo(
    () => JSON.stringify([query, source, tag ?? "", projectPath ?? "", visibility, sortBy]),
    [query, source, tag, projectPath, visibility, sortBy],
  );

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath,
      visibility,
      sortBy,
      limit: sessionLimit + 1,
    };
    const [rawResults, nextTags, nextProjects, nextStats] = await Promise.all([
      window.sessionSearch.searchSessions(options),
      window.sessionSearch.listTags(),
      window.sessionSearch.listProjects(),
      window.sessionSearch.getStats({ period: statsPeriod }),
    ]);
    if (requestId !== loadSeqRef.current) return;
    const nextResults = rawResults.slice(0, sessionLimit);
    setResults(nextResults);
    setHasMoreSessions(rawResults.length > sessionLimit);
    setTags(nextTags);
    setProjects(nextProjects);
    setStats(nextStats);
    setSelectedKey((current) =>
      current && !nextResults.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [query, source, tag, projectPath, visibility, sortBy, sessionLimit, statsPeriod]);

  const refreshStats = useCallback(async () => {
    setStatsRefreshing(true);
    setStatsFeedback({ kind: "running", message: t("Refreshing usage...", "正在刷新用量...") });
    try {
      setStats(await window.sessionSearch.getStats({ period: statsPeriod }));
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
  }, [statsPeriod, t]);

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

  const loadSkills = useCallback(async (refreshUsage = false) => {
    setSkillsLoading(true);
    setSkillsFeedback(refreshUsage ? { kind: "running", message: t("Refreshing skill usage...", "正在刷新 Skill 使用统计...") } : null);
    try {
      const usageStatus = refreshUsage ? await window.sessionSearch.refreshSkillUsage() : null;
      setInstalledSkills(await window.sessionSearch.listSkills());
      if (usageStatus) {
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
      if (!refreshUsage) setInstalledSkills(EMPTY_SKILLS);
      setSkillsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillsLoading(false);
    }
  }, [t]);

  const deleteSkill = useCallback(async (skill: InstalledSkill) => {
    setSkillsLoading(true);
    setSkillsFeedback({ kind: "running", message: t(`Deleting ${skill.name}...`, `正在删除 ${skill.name}...`) });
    try {
      const result = await window.sessionSearch.deleteSkill(skill.path);
      setInstalledSkills(await window.sessionSearch.listSkills());
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
    const timer = window.setTimeout(() => void load(), 120);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void loadQuotas();
    const timer = window.setInterval(() => void loadQuotas("background"), QUOTA_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadQuotas]);

  useEffect(() => {
    if (skillsOpen) void loadSkills();
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
      if (skillsOpen) void loadSkills();
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
    const timer = window.setInterval(() => void refreshLiveSessions(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshLiveSessions]);

  useEffect(() => {
    void window.sessionSearch.getSettings().then(setAppSettings);
  }, []);

  useEffect(() => {
    if (source === "claude-internal" && appSettings && !appSettings.includeClaudeInternal) setSource("all");
    if (source === "codex-internal" && appSettings && !appSettings.includeCodexInternal) setSource("all");
    if (source === "codebuddy-cli" && appSettings && !appSettings.includeCodeBuddyCli) setSource("all");
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
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      setIndexStatus(nextStatus);
      if (!nextStatus.running) void load();
    });
    const offFocus = window.sessionSearch.onFocusSearch(() => searchRef.current?.focus());
    const offOpenSettings = window.sessionSearch.onOpenSettings(() => {
      setSkillsOpen(false);
      setApiConfigOpen(false);
      setSettingsOpen(true);
    });
    return () => {
      offIndex();
      offFocus();
      offOpenSettings();
    };
  }, [load]);

  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const liveDetectionFailed = Boolean(liveSessions.error);
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
        if (dialog) setDialog(null);
        else if (deleteSessionCandidate && !deletingSession) setDeleteSessionCandidate(null);
        else if (deleteTagName) setDeleteTagName(null);
        else if (contextMenu) setContextMenu(null);
        else if (skillsOpen) setSkillsOpen(false);
        else if (apiConfigOpen) setApiConfigOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (detail) closeDetail();
        else return;
        event.preventDefault();
        return;
      }

      // Leave list navigation alone while an overlay or menu is in front.
      if (detail || dialog || deleteSessionCandidate || deleteTagName || contextMenu || skillsOpen || apiConfigOpen || settingsOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = displayedResults.find((item) => item.sessionKey === selectedKey);
        if (session) {
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
  }, [displayedResults, selectedKey, detail, dialog, deleteSessionCandidate, deletingSession, deleteTagName, contextMenu, skillsOpen, apiConfigOpen, settingsOpen, actionStatus, t]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail || skillsOpen || apiConfigOpen));
    return () => document.body.classList.remove("overlay-open");
  }, [detail, skillsOpen, apiConfigOpen]);

  const visibleSourceFilters = useMemo(() => {
    if (!appSettings) return sourceFilters(null);
    // Reveal an extra source filter only once its background load has finished.
    return sourceFilters({
      ...appSettings,
      includeClaudeInternal: appSettings.includeClaudeInternal && !pendingPersonalSources.claude,
      includeCodexInternal: appSettings.includeCodexInternal && !pendingPersonalSources.codex,
      includeCodeBuddyCli: appSettings.includeCodeBuddyCli && !pendingPersonalSources.codebuddy,
    });
  }, [appSettings, pendingPersonalSources]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.path === projectPath) || null,
    [projects, projectPath],
  );
  const searchPlaceholder = projectPath
    ? t(`Search within ${selectedProject?.label || "project"}`, `在 ${selectedProject?.label || "项目"} 中搜索`)
    : tag
      ? t(`Search within #${tag}`, `在 #${tag} 中搜索`)
      : t("Search titles, first questions, full text, paths, or ids", "搜索标题、首个问题、全文、路径或 ID");

  useEffect(() => {
    setSelectedKey((current) =>
      current && !displayedResults.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [displayedResults]);

  function toggleSidebarSectionById(section: SidebarSectionId): void {
    setSidebarSections((current) => toggleSidebarSection(current, section));
  }

  async function openDetail(session: SessionSearchResult): Promise<void> {
    const requestId = ++detailLoadSeqRef.current;
    setContextMenu(null);
    setDetail(session);
    setMessages([]);
    setMessageOffset(0);
    setTraceEvents([]);
    setMessagesLoading(true);

    const sessionKey = session.sessionKey;
    try {
      const [fresh, loadedTraceEvents] = await Promise.all([
        window.sessionSearch.getSession(sessionKey),
        window.sessionSearch.getTraceEvents(sessionKey),
      ]);
      if (requestId !== detailLoadSeqRef.current) return;
      if (!fresh) {
        setMessagesLoading(false);
        return;
      }

      const initialOffset = Math.max(0, fresh.messageCount - INITIAL_MESSAGE_LIMIT);
      const loadedMessages = await window.sessionSearch.getMessages(sessionKey, initialOffset, INITIAL_MESSAGE_LIMIT);
      if (requestId !== detailLoadSeqRef.current) return;

      setDetail(fresh);
      setMessageOffset(initialOffset);
      setMessages(loadedMessages);
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
    setMessageOffset(0);
    setTraceEvents([]);
    setMessagesLoading(false);
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
      if (requestId !== detailLoadSeqRef.current) return;
      setMessageOffset(nextOffset);
      setMessages((current) => [...nextMessages, ...current]);
    } catch (error) {
      if (requestId === detailLoadSeqRef.current) {
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestId === detailLoadSeqRef.current) setMessagesLoading(false);
    }
  }

  async function refreshAfterAction(): Promise<void> {
    await load();
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
    const value = (valueOverride ?? dialog.value).trim();
    if (dialog.kind === "rename") {
      await window.sessionSearch.setCustomTitle(dialog.session.sessionKey, value || null);
    } else if (value) {
      await window.sessionSearch.addTag(dialog.session.sessionKey, value);
    }
    setDialog(null);
    await refreshAfterAction();
  }

  async function removeTag(session: SessionSearchResult, tagName: string): Promise<void> {
    await window.sessionSearch.removeTag(session.sessionKey, tagName);
    await refreshAfterAction();
  }

  async function toggleFavorite(session: SessionSearchResult): Promise<void> {
    await window.sessionSearch.setFavorited(session.sessionKey, !session.favorited);
    await refreshAfterAction();
  }

  async function deleteTagGlobally(tagName: string): Promise<void> {
    await window.sessionSearch.deleteTag(tagName);
    setDeleteTagName(null);
    if (tag === tagName) setTag(undefined);
    else await load();
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
        await load();
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

  async function refreshNow(): Promise<void> {
    setContextMenu(null);
    setRefreshFeedback({ kind: "running", message: t("Refreshing index...", "正在更新索引...") });
    try {
      const status = await window.sessionSearch.refreshIndex();
      setIndexStatus(status);
      await load();
      if (status.error) {
        setRefreshFeedback({ kind: "error", message: status.error });
        return;
      }
      const successMessage = t(`Index refreshed: ${status.indexed}/${status.total} sessions.`, `索引已更新：${status.indexed}/${status.total} 个会话。`);
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

  async function updateSettings(next: AppSettingsUpdate): Promise<void> {
    const enablingClaude = next.includeClaudeInternal === true && !appSettings?.includeClaudeInternal;
    const enablingCodex = next.includeCodexInternal === true && !appSettings?.includeCodexInternal;
    const enablingCodeBuddy = next.includeCodeBuddyCli === true && !appSettings?.includeCodeBuddyCli;
    const quotaVisibilityChanged =
      ("hideCodexQuota" in next && next.hideCodexQuota !== appSettings?.hideCodexQuota) ||
      ("hideClaudeQuota" in next && next.hideClaudeQuota !== appSettings?.hideClaudeQuota);
    setSettingsFeedback({ kind: "running", message: t("Saving settings...", "正在保存设置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings(next);
      setAppSettings(nextSettings);
      if (quotaVisibilityChanged) void loadQuotas();

      if (enablingClaude || enablingCodex || enablingCodeBuddy) {
        // Keep the toggle responsive: scan the personal source in the background
        // and only reveal its sidebar filter once that scan finishes.
        if (enablingClaude) setPendingPersonalSources((current) => ({ ...current, claude: true }));
        if (enablingCodex) setPendingPersonalSources((current) => ({ ...current, codex: true }));
        if (enablingCodeBuddy) setPendingPersonalSources((current) => ({ ...current, codebuddy: true }));
        setSettingsFeedback({ kind: "success", message: t("Loading sessions in the background...", "正在后台加载会话...") });
        void window.sessionSearch
          .refreshIndex()
          .then(async () => {
            setPendingPersonalSources((current) => ({
              claude: enablingClaude ? false : current.claude,
              codex: enablingCodex ? false : current.codex,
              codebuddy: enablingCodeBuddy ? false : current.codebuddy,
            }));
            await load();
            setSettingsFeedback({ kind: "success", message: t("Sources ready.", "来源已就绪。") });
            window.setTimeout(() => {
              setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
            }, 1600);
          })
          .catch((error) => {
            if (enablingClaude) setPendingPersonalSources((current) => ({ ...current, claude: false }));
            if (enablingCodex) setPendingPersonalSources((current) => ({ ...current, codex: false }));
            if (enablingCodeBuddy) setPendingPersonalSources((current) => ({ ...current, codebuddy: false }));
            setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      await load();
      setSettingsFeedback({ kind: "success", message: t("Settings saved.", "设置已保存。") });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
      }, 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function applyApiConfigToCodex(apiConfig: ApiConfig): Promise<void> {
    setSettingsFeedback({ kind: "running", message: t("Applying Codex profile...", "正在应用 Codex 配置...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings({ apiConfig });
      setAppSettings(nextSettings);
      const result = await window.sessionSearch.applyCodexProfile(apiConfig);
      const profileLabel = result.profile === "codex" ? "Codex Official" : apiConfig.customProviderName.trim() || "CodexZH";
      const successMessage = t(`Applied ${profileLabel} to ~/.codex.`, `已将 ${profileLabel} 应用到 ~/.codex。`);
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
            {stats.bySource.map((item) => (
              <div key={item.source}>
                <span>{SOURCE_LABEL[item.source]}</span>
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

        <SidebarSectionHeader title={t("Projects", "项目")} expanded={sidebarSections.projects} onToggle={() => toggleSidebarSectionById("projects")} />
        {sidebarSections.projects ? (
          <nav className="project-list">
            <button className={!projectPath ? "active" : ""} onClick={() => setProjectPath(undefined)}>
              {t("All Projects", "全部项目")}
            </button>
            {projects.map((project) => (
              <button
                key={project.path}
                className={`project-row ${projectPath === project.path ? "active" : ""}`}
                onClick={() => setProjectPath(project.path)}
                title={project.path}
              >
                <Folder size={13} />
                <span>{project.label}</span>
                <em>{project.sessionCount}</em>
              </button>
            ))}
          </nav>
        ) : null}

        <SidebarSectionHeader title={t("Tags", "标签")} expanded={sidebarSections.tags} onToggle={() => toggleSidebarSectionById("tags")} />
        {sidebarSections.tags ? (
          <nav className="tag-list">
            <button className={!tag ? "active" : ""} onClick={() => setTag(undefined)}>
              {t("All Tags", "全部标签")}
            </button>
            {tags.map((tagName) => (
              <div
                key={tagName}
                className={`tag-list-row ${tag === tagName ? "active" : ""} ${isBranchTag(tagName) ? "branch-tag" : ""}`}
              >
                <button className="tag-filter" onClick={() => setTag(tagName)} title={t(`Filter by ${tagName}`, `按 ${tagName} 过滤`)}>
                  {isBranchTag(tagName) ? <GitBranch size={13} /> : <Tag size={13} />}
                  <span>{tagName}</span>
                </button>
                <button
                  className="tag-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTagName(tagName);
                  }}
                  title={t(`Delete tag ${tagName}`, `删除标签 ${tagName}`)}
                  aria-label={t(`Delete tag ${tagName}`, `删除标签 ${tagName}`)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </nav>
        ) : null}
      </section>

      <section className="content">
        <header className="toolbar">
          <div className="searchbox">
            <Search size={18} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (!event.metaKey && !event.ctrlKey && event.key === "Enter" && selected) void openDetail(selected);
              }}
              placeholder={searchPlaceholder}
              autoFocus
            />
            <span className="kbd-hint">{RUNTIME_PLATFORM === "darwin" ? "⌘K" : "Ctrl+K"}</span>
            <span className="kbd-hint" title="Resume selected session in the default terminal">
              {RUNTIME_PLATFORM === "darwin" ? "⌘↵" : "Ctrl+Enter"}
            </span>
          </div>
          {selectedProject ? (
            <button className="chip clear" onClick={() => setProjectPath(undefined)} title={selectedProject.path}>
              {selectedProject.label} ×
            </button>
          ) : null}
          {tag ? (
            <button className="chip clear" onClick={() => setTag(undefined)}>
              #{tag} ×
            </button>
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
          <label className="sort-menu">
            <span>{t("Sort", "排序")}</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SessionSortBy)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {sortLabel(option.value, language)}
                </option>
              ))}
            </select>
          </label>
          <div className="top-actions">
            <button
              className={`icon-button toolbar-icon-button ${skillsOpen ? "active" : ""}`}
              onClick={() => {
                setSettingsOpen(false);
                setApiConfigOpen(false);
                setSkillsOpen(true);
              }}
              title={t("Skills", "Skills 管理")}
              aria-label={t("Skills", "Skills 管理")}
            >
              <PackageSearch size={15} />
            </button>
            <button
              className={`icon-button toolbar-icon-button ${apiConfigOpen ? "active" : ""}`}
              onClick={() => {
                setSkillsOpen(false);
                setSettingsOpen(false);
                setApiConfigOpen(true);
              }}
              title={t("API configuration", "API 配置")}
              aria-label={t("API configuration", "API 配置")}
            >
              <KeyRound size={15} />
            </button>
            <button
              className="icon-button toolbar-icon-button"
              onClick={() => {
                setSkillsOpen(false);
                setApiConfigOpen(false);
                setSettingsOpen(true);
              }}
              title={t("Settings", "设置")}
              aria-label={t("Settings", "设置")}
            >
              <Settings size={15} />
            </button>
          </div>
        </header>

        <div className="result-count">
          <span>
            {hasMoreSessions
              ? displayedResults.length === results.length
                ? t(`${results.length}+ sessions`, `${results.length}+ 个会话`)
                : t(`${displayedResults.length} of ${results.length}+ sessions`, `${displayedResults.length} / ${results.length}+ 个会话`)
              : displayedResults.length === results.length
              ? t(`${results.length} sessions`, `${results.length} 个会话`)
              : t(`${displayedResults.length} of ${results.length} sessions`, `${displayedResults.length} / ${results.length} 个会话`)}
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
              onSelect={() => setSelectedKey(session.sessionKey)}
              onOpen={() => void openDetail(session)}
              onRename={() => beginRename(session)}
              onFavorite={() => void toggleFavorite(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedKey(session.sessionKey);
                setContextMenu({ x: event.clientX, y: event.clientY, session });
              }}
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
          onResume={() =>
            void runAction(t("Opening terminal", "正在打开终端"), () => window.sessionSearch.resumeSession(detail.sessionKey), (result) => resumeRouteMessage(result, language))
          }
          onResumeIterm={() =>
            void runAction(t("Opening iTerm", "正在打开 iTerm"), () => window.sessionSearch.resumeSessionInIterm(detail.sessionKey), t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"))
          }
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

      {contextMenu ? (
        <ContextMenu
          state={contextMenu}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          showMacActions={IS_MAC}
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

      {actionStatus ? <ActionToast status={actionStatus} /> : null}

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
          settings={appSettings}
          theme={theme}
          language={language}
          feedback={settingsFeedback}
          onSettingsChange={(next) => void updateSettings(next)}
          onThemeChange={setTheme}
          onLanguageChange={setLanguage}
          onDefaultTerminalChange={(terminal) => void updateDefaultTerminal(terminal)}
          onGlobalShortcutChange={(shortcut) => void updateGlobalShortcut(shortcut)}
          skillHookInstalled={skillHookInstalled}
          skillHookBusy={skillHookBusy}
          onSkillHookChange={(enabled) => void toggleSkillUsageHook(enabled)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {skillsOpen ? (
        <SkillsDialog
          snapshot={installedSkills}
          loading={skillsLoading}
          feedback={skillsFeedback}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          onRefresh={() => void loadSkills(true)}
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

function SessionRow({
  session,
  selected,
  liveState,
  language,
  onSelect,
  onOpen,
  onRename,
  onFavorite,
  onContextMenu,
}: {
  session: SessionSearchResult;
  selected: boolean;
  liveState: LiveSessionState;
  language: LanguageMode;
  onSelect: () => void;
  onOpen: () => void;
  onRename: () => void;
  onFavorite: () => void;
  onContextMenu: MouseEventHandler;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <article
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div className="session-main">
        <div className="session-title">
          <button
            className={`favorite-button ${session.favorited ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite();
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
              onRename();
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
          <span>{session.projectPath || l("No project path", "无项目路径")}</span>
          <span>{formatRelativeTime(session.timestamp)}</span>
          <span>{l(`${session.messageCount} messages`, `${session.messageCount} 条消息`)}</span>
          <span>{l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)}</span>
        </div>
        {session.matchSnippet ? <div className="snippet">{session.matchSnippet}</div> : null}
      </div>
      <div className="row-tags">
        {session.tags.slice(0, 3).map((tagName) => (
          <span key={tagName} className={isBranchTag(tagName) ? "branch-tag" : undefined}>
            #{tagName}
          </span>
        ))}
      </div>
    </article>
  );
}

function ActionToast({ status }: { status: ActionStatus }): ReactElement {
  return (
    <div className={`action-toast ${status.kind}`} role="status" aria-live="polite">
      {status.message}
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

function ContextMenu({
  state,
  language,
  revealLabel,
  showMacActions,
  onRename,
  onAddTag,
  onFavorite,
  onPin,
  onHide,
  onResume,
  onResumeIterm,
  onOpenApp,
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
  onRename: () => void;
  onAddTag: () => void;
  onFavorite: () => void;
  onPin: () => void;
  onHide: () => void;
  onResume: () => void;
  onResumeIterm: () => void;
  onOpenApp: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onDelete: () => void;
  onReveal: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const menu = useClampedContextMenuStyle(state);
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
      <button onClick={onResume}>
        <Play size={14} /> {l("Resume in Terminal", "在终端恢复")}
      </button>
      {showMacActions ? (
        <button onClick={onResumeIterm}>
          <TerminalIcon size={14} /> Resume in iTerm
        </button>
      ) : null}
      {showMacActions ? (
        <button onClick={onOpenApp}>
          <AppWindow size={14} /> Open App
        </button>
      ) : null}
      <button onClick={onCopyResume}>
        <Copy size={14} /> {l("Copy Resume Cmd", "复制 Resume 命令")}
      </button>
      <button onClick={onCopyMarkdown}>{l("Copy Markdown", "复制 Markdown")}</button>
      <button onClick={onExportMarkdown}>
        <Download size={14} /> {l("Export Markdown", "导出 Markdown")}
      </button>
      <button onClick={onReveal}>
        <FolderOpen size={14} /> Show in {revealLabel}
      </button>
      <hr />
      <button className="danger" onClick={onDelete}>
        <Trash2 size={14} /> {l("Delete Session", "删除会话")}
      </button>
    </div>
  );
}

function SettingsDialog({
  settings,
  theme,
  language,
  feedback,
  onSettingsChange,
  onThemeChange,
  onLanguageChange,
  onDefaultTerminalChange,
  onGlobalShortcutChange,
  skillHookInstalled,
  skillHookBusy,
  onSkillHookChange,
  onClose,
}: {
  settings: AppSettings | null;
  theme: ThemeMode;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLanguageChange: (language: LanguageMode) => void;
  onDefaultTerminalChange: (terminal: AppSettings["defaultTerminal"]) => void;
  onGlobalShortcutChange: (shortcut: AppSettings["globalShortcut"]) => void;
  skillHookInstalled: boolean | null;
  skillHookBusy: boolean;
  onSkillHookChange: (enabled: boolean) => void;
  onClose: () => void;
}): ReactElement {
  const defaultTerminal = settings?.defaultTerminal ?? (RUNTIME_PLATFORM === "win32" ? "WindowsTerminal" : "Terminal");
  const globalShortcut = settings?.globalShortcut ?? (RUNTIME_PLATFORM === "win32" ? "Ctrl+Alt+Space" : "Alt+Space");
  const saving = feedback?.kind === "running";
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [activeSection, setActiveSection] = useState<"terminal" | "shortcut" | "sources" | "usage" | "skills" | "appearance">("terminal");

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
            <button className={activeSection === "sources" ? "active" : ""} onClick={() => setActiveSection("sources")}>
              <Folder size={15} />
              <span>{l("Personal sources", "个人来源")}</span>
            </button>
            <button className={activeSection === "usage" ? "active" : ""} onClick={() => setActiveSection("usage")}>
              <Gauge size={15} />
              <span>{l("Usage limits", "剩余额度")}</span>
            </button>
            <button className={activeSection === "skills" ? "active" : ""} onClick={() => setActiveSection("skills")}>
              <PackageSearch size={15} />
              <span>{l("Skill usage", "Skill 统计")}</span>
            </button>
            <button className={activeSection === "appearance" ? "active" : ""} onClick={() => setActiveSection("appearance")}>
              <Sun size={15} />
              <span>{l("Appearance", "外观")}</span>
            </button>
          </nav>
          <div className="settings-content">
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
            {activeSection === "sources" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>{l("Personal sources", "个人来源")}</h3>
                  <p>{l("Personal sources stay separate from the normal Claude and Codex filters.", "个人来源会和普通 Claude/Codex 过滤项分开显示。")}</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.claude-internal</span>
                    <span className="settings-field-sub">{l("Adds a separate Claude Extra source filter.", "添加独立的 Claude Extra 来源过滤项。")}</span>
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
                    <span className="settings-field-sub">{l("Adds a separate Codex Extra source filter.", "添加独立的 Codex Extra 来源过滤项。")}</span>
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
          </div>
        </div>
        <div className={`settings-feedback ${feedback?.kind ?? ""}`} aria-live="polite">
          {feedback?.message ?? ""}
        </div>
      </section>
    </div>
  );
}
