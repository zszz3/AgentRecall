import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEventHandler, ReactElement } from "react";
import {
  AppWindow,
  Archive,
  ChevronLeft,
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
import {
  API_PROVIDER_PRESETS,
  CLAUDE_API_PROVIDER_PRESETS,
  defaultApiConfig,
  defaultClaudeApiConfig,
  type ApiConfig,
  type ApiProviderPresetId,
  type ClaudeApiConfig,
  type ClaudeApiProviderPresetId,
} from "../../core/api-config";
import type { IndexStatus } from "../../core/indexer";
import { formatMessageTime, formatRelativeTime } from "../../core/format-session";
import type { AppSettings, AppSettingsUpdate } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import type { InstalledSkill, InstalledSkillsSnapshot, SkillSource } from "../../core/skill-manager";
import { globalShortcutOptions } from "../../core/shortcuts";
import { terminalSelectOptions } from "../../core/terminal-options";
import type {
  LiveSessionSnapshot,
  ProjectGroupingMode,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionSortBy,
  SessionSource,
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
  liveStateLabel,
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
import { buildRepoBrowser, findContainingProjectRoot, joinProjectPath, toRelativeProjectPath } from "./repo-browser";
import { filterInstalledSkills, sortInstalledSkills, skillSourceLabel, type SkillSourceFilter } from "./skill-manager";
import { filterInstalledSkills, sortInstalledSkills, skillSourceLabel, type SkillSortKey, type SkillSourceFilter } from "./skill-manager";
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";

const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "claude-internal": "Claude Extra",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
  "codex-internal": "Codex Extra",
  "codebuddy-cli": "CodeBuddy CLI",
};

const BASE_SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Claude Code", value: "claude-cli" },
  { label: "Claude App", value: "claude-app" },
  { label: "Codex CLI", value: "codex-cli" },
  { label: "Codex App", value: "codex-app" },
];

function sourceFilters(settings: AppSettings | null): Array<{ label: string; value: SearchOptions["source"] }> {
  return [
    ...BASE_SOURCE_FILTERS,
    ...(settings?.includeClaudeInternal ? [{ label: "Claude Extra", value: "claude-internal" as const }] : []),
    ...(settings?.includeCodexInternal ? [{ label: "Codex Extra", value: "codex-internal" as const }] : []),
    ...(settings?.includeCodeBuddyCli ? [{ label: "CodeBuddy CLI", value: "codebuddy-cli" as const }] : []),
  ];
}

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
const REPO_BROWSER_FETCH_LIMIT = 10_000;

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

function isBranchTag(tagName: string): boolean {
  return tagName.startsWith("branch:");
}

function sourceUiFamily(source: SessionSource): "claude" | "codex" | "codebuddy" {
  if (source.startsWith("claude")) return "claude";
  if (source.startsWith("codex")) return "codex";
  return "codebuddy";
}

function sortLabel(value: SessionSortBy, language: LanguageMode): string {
  if (value === "created") return localize(language, "Created", "创建时间");
  if (value === "updated") return localize(language, "Updated", "更新时间");
  return localize(language, "Latest activity", "最近活动");
}

function statsPeriodLabel(value: SessionStatsPeriod, language: LanguageMode): string {
  if (value === "today") return localize(language, "Today", "今天");
  if (value === "sevenDay") return localize(language, "7D", "7 天");
  if (value === "thirtyDay") return localize(language, "30D", "30 天");
  return localize(language, "All", "全部");
}

function liveStatusFilterLabel(value: LiveStatusFilter, language: LanguageMode): string {
  if (value === "open") return localize(language, "Open", "打开");
  if (value === "closed") return localize(language, "Closed", "关闭");
  return localize(language, "All", "全部");
}

function sourceFilterLabel(item: { label: string; value: SearchOptions["source"] }, language: LanguageMode): string {
  return item.value === "all" ? localize(language, "All", "全部") : item.label;
}

function localizedLiveStateLabel(state: LiveSessionState, language: LanguageMode): string {
  return localize(language, liveStateLabel(state), state === "open" ? "打开" : state === "closed" ? "关闭" : "未知");
}

function resumeRouteMessage(result: ResumeRouteResult, language: LanguageMode): string {
  return result.route === "focus"
    ? localize(language, "Terminal brought to front.", "终端已前置。")
    : localize(language, "Resume command sent to terminal.", "Resume 命令已发送到终端。");
}

type ActionStatus = {
  kind: "running" | "success" | "error";
  message: string;
};

type RefreshFeedback = ActionStatus | null;
type StatsFeedback = ActionStatus | null;
type QuotaFeedback = ActionStatus | null;
type SettingsFeedback = ActionStatus | null;
type SkillsFeedback = ActionStatus | null;

interface ContextMenuState {
  x: number;
  y: number;
  target:
    | { kind: "session"; session: SessionSearchResult }
    | { kind: "directory"; path: string; label: string }
    | { kind: "project"; project: ProjectSummary; promoted: boolean };
}

type DialogState =
  | {
      kind: "rename" | "tag";
      session: SessionSearchResult;
      value: string;
    }
  | null;

const SIDEBAR_SECTIONS_STORAGE_KEY = "agent-session-search-sidebar-sections";

function loadInitialSidebarSections(): SidebarSectionsState {
  if (typeof window === "undefined") return readSidebarSections(null);
  return readSidebarSections(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY));
}

function formatSessionProjectDisplay(
  projectPath: string,
  projects: ProjectSummary[],
  projectGrouping: ProjectGroupingMode,
  language: LanguageMode,
): string {
  if (!projectPath) return "";
  if (projectGrouping !== "repo") return projectPath;
  const repoRoot = findContainingProjectRoot(projectPath, projects);
  if (!repoRoot) return projectPath;
  const relativePath = toRelativeProjectPath(projectPath, repoRoot);
  if (relativePath === null) return projectPath;
  if (!relativePath) return localize(language, "Repository root", "仓库根目录");
  return relativePath;
}

function comparableProjectPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function findMatchingPromotedRoot(targetPath: string, promotedRoots: string[]): string | null {
  const normalizedTargetPath = targetPath.trim();
  if (!normalizedTargetPath) return null;
  const comparableTargetPath = comparableProjectPath(normalizedTargetPath);
  let bestMatch: string | null = null;
  let bestLength = -1;

  for (const root of promotedRoots) {
    const normalizedRoot = root.trim();
    if (!normalizedRoot) continue;
    const comparableRoot = comparableProjectPath(normalizedRoot);
    if (comparableTargetPath !== comparableRoot && !comparableTargetPath.startsWith(`${comparableRoot}/`)) continue;
    if (comparableRoot.length <= bestLength) continue;
    bestMatch = normalizedRoot;
    bestLength = comparableRoot.length;
  }

  return bestMatch;
}

export function App(): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [language, setLanguage] = useState<LanguageMode>(() => readInitialLanguage());
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionsState>(() => loadInitialSidebarSections());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [repoBrowserSegments, setRepoBrowserSegments] = useState<string[]>([]);
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
  const [traceEvents, setTraceEvents] = useState<SessionTraceEvent[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
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
  const projectGrouping = appSettings?.projectGrouping ?? "cwd";
  const repoBrowserEnabled = projectGrouping === "repo" && Boolean(projectPath);
  const searchScopeKey = useMemo(
    () => JSON.stringify([query, source, tag ?? "", projectPath ?? "", visibility, sortBy, projectGrouping]),
    [query, source, tag, projectPath, visibility, sortBy, projectGrouping],
  );

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const fetchAllRepoSessions = projectGrouping === "repo" && Boolean(projectPath);
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath,
      projectGrouping,
      visibility,
      sortBy,
      limit: fetchAllRepoSessions ? REPO_BROWSER_FETCH_LIMIT : sessionLimit + 1,
    };
    const [rawResults, nextTags, nextProjects, nextStats] = await Promise.all([
      window.sessionSearch.searchSessions(options),
      window.sessionSearch.listTags(projectPath && appSettings?.filterTagsByProject ? projectPath : undefined),
      window.sessionSearch.listProjects(),
      window.sessionSearch.getStats({ period: statsPeriod }),
    ]);
    if (requestId !== loadSeqRef.current) return;
    const nextResults = fetchAllRepoSessions ? rawResults : rawResults.slice(0, sessionLimit);
    setResults(nextResults);
    setHasMoreSessions(!fetchAllRepoSessions && rawResults.length > sessionLimit);
    setTags(nextTags);
    setProjects(nextProjects);
    setStats(nextStats);
    setSelectedKey((current) =>
      current && !nextResults.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [projectGrouping, query, source, tag, projectPath, visibility, sortBy, sessionLimit, statsPeriod]);

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

  const loadQuotas = useCallback(async (manual = false) => {
    setQuotaLoading(true);
    if (manual) setQuotaFeedback({ kind: "running", message: t("Refreshing usage limits...", "正在刷新额度...") });
    try {
      const nextQuotas = await window.sessionSearch.getQuotas();
      setQuotas(nextQuotas);
      if (manual) {
        const successMessage = t("Usage limits refreshed.", "额度已刷新。");
        setQuotaFeedback({ kind: "success", message: successMessage });
        window.setTimeout(() => {
          setQuotaFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
        }, 1800);
      }
    } catch (error) {
      setQuotaFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setQuotaLoading(false);
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
    setProjectPath(undefined);
    setRepoBrowserSegments([]);
  }, [projectGrouping]);

  useEffect(() => {
    setRepoBrowserSegments([]);
  }, [projectPath]);

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
  const repoBrowserState = useMemo(
    () => (repoBrowserEnabled && projectPath ? buildRepoBrowser(displayedResults, projectPath, repoBrowserSegments) : null),
    [displayedResults, projectPath, repoBrowserEnabled, repoBrowserSegments],
  );
  const visibleSessions = useMemo(
    () => (repoBrowserState ? repoBrowserState.sessions : displayedResults),
    [displayedResults, repoBrowserState],
  );
  const selected = useMemo(
    () => visibleSessions.find((session) => session.sessionKey === selectedKey) || null,
    [visibleSessions, selectedKey],
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
      if (detail || dialog || deleteTagName || contextMenu || skillsOpen || apiConfigOpen || settingsOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = visibleSessions.find((item) => item.sessionKey === selectedKey);
        if (session) {
          void runAction(t("Opening terminal", "正在打开终端"), () => window.sessionSearch.resumeSession(session.sessionKey), (result) => resumeRouteMessage(result, language));
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (visibleSessions.length === 0) return;
        event.preventDefault();
        const currentIndex = visibleSessions.findIndex((session) => session.sessionKey === selectedKey);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? RUNTIME_PLATFORM === "darwin" && delta === -1
              ? visibleSessions.length - 1
              : 0
            : Math.min(visibleSessions.length - 1, Math.max(0, currentIndex + delta));
        setSelectedKey(visibleSessions[nextIndex].sessionKey);
        return;
      }

      if (event.key === " " && selectedKey) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const session = visibleSessions.find((item) => item.sessionKey === selectedKey);
        if (session) {
          event.preventDefault();
          void openDetail(session);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleSessions, selectedKey, detail, dialog, deleteTagName, contextMenu, skillsOpen, apiConfigOpen, settingsOpen, actionStatus, t]);

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
  const promotedProjectRoots = appSettings?.promotedProjectRoots ?? [];
  const repoBrowserRootLabel = selectedProject?.label || t("Repository root", "仓库根目录");
  const repoBrowserPathLabel = repoBrowserSegments.length > 0 ? repoBrowserSegments.join("/") : repoBrowserRootLabel;
  const searchPlaceholder = projectPath
    ? t(`Search within ${selectedProject?.label || "project"}`, `在 ${selectedProject?.label || "项目"} 中搜索`)
    : tag
      ? t(`Search within #${tag}`, `在 #${tag} 中搜索`)
      : t("Search titles, first questions, full text, paths, or ids", "搜索标题、首个问题、全文、路径或 ID");

  useEffect(() => {
    setSelectedKey((current) =>
      current && !visibleSessions.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [visibleSessions]);

  function toggleSidebarSectionById(section: SidebarSectionId): void {
    setSidebarSections((current) => toggleSidebarSection(current, section));
  }

  async function openDetail(session: SessionSearchResult): Promise<void> {
    const requestId = ++detailLoadSeqRef.current;
    setContextMenu(null);
    setDetail(session);
    setMessages([]);
    setTraceEvents([]);
    setMessagesLoading(true);

    const sessionKey = session.sessionKey;
    const [fresh, loadedMessages, loadedTraceEvents] = await Promise.all([
      window.sessionSearch.getSession(sessionKey),
      window.sessionSearch.getMessages(sessionKey, 0, INITIAL_MESSAGE_LIMIT),
      window.sessionSearch.getTraceEvents(sessionKey),
    ]);
    if (requestId !== detailLoadSeqRef.current) return;
    if (!fresh) {
      setMessagesLoading(false);
      return;
    }
    setDetail(fresh);
    setMessages(loadedMessages);
    setTraceEvents(loadedTraceEvents);
    setMessagesLoading(false);
  }

  function closeDetail(): void {
    detailLoadSeqRef.current++;
    setDetail(null);
    setMessages([]);
    setTraceEvents([]);
    setMessagesLoading(false);
  }

  async function loadMoreMessages(): Promise<void> {
    if (!detail || messagesLoading) return;
    setMessagesLoading(true);
    const nextMessages = await window.sessionSearch.getMessages(detail.sessionKey, messages.length, MESSAGE_PAGE_SIZE);
    setMessages((current) => [...current, ...nextMessages]);
    setMessagesLoading(false);
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

  async function promoteToRoot(rootPath: string): Promise<void> {
    if (projectGrouping !== "repo") return;
    const normalizedPath = rootPath.trim();
    if (!normalizedPath) return;
    setContextMenu(null);
    const nextRoots = promotedProjectRoots.includes(normalizedPath) ? promotedProjectRoots : [...promotedProjectRoots, normalizedPath];
    setSettingsFeedback({ kind: "running", message: t("Promoting root...", "正在提升根目录...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings({ promotedProjectRoots: nextRoots });
      setAppSettings(nextSettings);
      setProjectPath(normalizedPath);
      setRepoBrowserSegments([]);
      await load();
      const successMessage = t("Root promoted.", "根目录已提升。");
      setSettingsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function demotePromotedRoot(rootPath: string): Promise<void> {
    if (projectGrouping !== "repo") return;
    const normalizedPath = rootPath.trim();
    if (!normalizedPath) return;
    const matchedRoot = findMatchingPromotedRoot(normalizedPath, promotedProjectRoots);
    if (!matchedRoot) return;
    setContextMenu(null);
    const nextRoots = promotedProjectRoots.filter((root) => root !== matchedRoot);
    setSettingsFeedback({ kind: "running", message: t("Reverting promoted root...", "正在回退提升根目录...") });
    try {
      const nextSettings = await window.sessionSearch.setSettings({ promotedProjectRoots: nextRoots });
      const nextProjects = await window.sessionSearch.listProjects();
      setAppSettings(nextSettings);
      setProjects(nextProjects);
      const nextProjectPath = projectPath
        ? findContainingProjectRoot(projectPath, nextProjects) ?? findContainingProjectRoot(normalizedPath, nextProjects) ?? undefined
        : undefined;
      setProjectPath(nextProjectPath);
      setRepoBrowserSegments([]);
      if (nextProjectPath === projectPath) await load();
      const successMessage = t("Promoted root reverted.", "提升根目录已回退。");
      setSettingsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
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

  const sessionContextMenu =
    contextMenu?.target.kind === "session"
      ? { x: contextMenu.x, y: contextMenu.y, session: contextMenu.target.session }
      : null;
  const directoryContextMenu =
    contextMenu?.target.kind === "directory"
      ? { x: contextMenu.x, y: contextMenu.y, path: contextMenu.target.path, label: contextMenu.target.label }
      : null;
  const projectContextMenu =
    contextMenu?.target.kind === "project"
      ? { x: contextMenu.x, y: contextMenu.y, project: contextMenu.target.project, promoted: contextMenu.target.promoted }
      : null;
  const sessionPromotedRoot = sessionContextMenu
    ? findMatchingPromotedRoot(sessionContextMenu.session.projectPath, promotedProjectRoots)
    : null;
  const directoryPromotedRoot = directoryContextMenu
    ? findMatchingPromotedRoot(directoryContextMenu.path, promotedProjectRoots)
    : null;

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
          onRefresh={() => void loadQuotas(true)}
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
                onContextMenu={(event) => {
                  if (projectGrouping !== "repo") return;
                  event.preventDefault();
                  setContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    target: {
                      kind: "project",
                      project,
                      promoted: promotedProjectRoots.includes(project.path),
                    },
                  });
                }}
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
          {repoBrowserState ? (
            <span className="selected-path" title={repoBrowserPathLabel}>
              {repoBrowserPathLabel}
            </span>
          ) : selected ? (
            <span className="selected-path" title={selected.projectPath || undefined}>
              {formatSessionProjectDisplay(selected.projectPath, projects, projectGrouping, language) || selected.rawId}
            </span>
          ) : null}
        </div>

        <div className="results">
          {repoBrowserState ? (
            <div className="repo-browser-bar">
              <button
                className="repo-browser-back"
                onClick={() => setRepoBrowserSegments((current) => current.slice(0, -1))}
                disabled={repoBrowserSegments.length === 0}
              >
                <ChevronLeft size={14} />
                {t("Back", "返回")}
              </button>
              <div className="repo-browser-breadcrumbs">
                <button className={repoBrowserSegments.length === 0 ? "active" : ""} onClick={() => setRepoBrowserSegments([])}>
                  {repoBrowserRootLabel}
                </button>
                {repoBrowserSegments.map((segment, index) => (
                  <button
                    key={`${segment}:${index}`}
                    className={index === repoBrowserSegments.length - 1 ? "active" : ""}
                    onClick={() => setRepoBrowserSegments(repoBrowserSegments.slice(0, index + 1))}
                  >
                    {segment}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {repoBrowserState
            ? repoBrowserState.directories.map((directory) => (
                <button
                  key={directory.key}
                  className="repo-directory-row"
                  onClick={() => setRepoBrowserSegments(directory.segments)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      target: { kind: "directory", path: directory.absolutePath, label: directory.relativePath || directory.name },
                    });
                  }}
                  title={directory.relativePath}
                >
                  <span className="repo-directory-main">
                    <Folder size={15} />
                    <span className="repo-directory-name">{directory.name}</span>
                  </span>
                  <span className="repo-directory-meta">
                    <span className="repo-directory-path">{directory.relativePath}</span>
                    <em>{t(`${directory.sessionCount} sessions`, `${directory.sessionCount} 个会话`)}</em>
                  </span>
                </button>
              ))
            : null}
          {visibleSessions.map((session) => (
            <SessionRow
              key={session.sessionKey}
              session={{ ...session, projectPath: formatSessionProjectDisplay(session.projectPath, projects, projectGrouping, language) }}
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
                setContextMenu({ x: event.clientX, y: event.clientY, target: { kind: "session", session } });
              }}
            />
          ))}
          {repoBrowserState && repoBrowserState.directories.length === 0 && visibleSessions.length === 0 ? (
            <div className="empty">{t(`No sessions in ${repoBrowserPathLabel}.`, `${repoBrowserPathLabel} 下没有会话。`)}</div>
          ) : null}
          {displayedResults.length === 0 && !hasMoreSessions ? <div className="empty">{t("No sessions found.", "没有找到会话。")}</div> : null}
          {!repoBrowserState && hasMoreSessions ? (
            <button className="load-more-sessions" onClick={() => setSessionLimit((current) => current + SESSION_PAGE_SIZE)}>
              <ChevronDown size={14} />
              {t(`Load ${SESSION_PAGE_SIZE} more`, `再加载 ${SESSION_PAGE_SIZE} 个`)}
            </button>
          ) : null}
        </div>
      </section>

      {detail ? (
        <DetailPanel
          session={{ ...detail, projectPath: formatSessionProjectDisplay(detail.projectPath, projects, projectGrouping, language) }}
          messages={messages}
          traceEvents={traceEvents}
          loading={messagesLoading}
          actionStatus={actionStatus}
          query={query}
          liveState={getLiveSessionState(detail, liveSessionKeys, liveDetectionFailed)}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          showItermAction={IS_MAC}
          onClose={closeDetail}
          onShowMore={() => void loadMoreMessages()}
          onRename={() => beginRename(detail)}
          onAddTag={() => beginAddTag(detail)}
          onRemoveTag={(tagName) => void removeTag(detail, tagName)}
          onRenameTitle={() => beginRename(detail)}
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
          onReveal={() =>
            void runAction(
              `Opening ${FILE_MANAGER_LABEL}`,
              () => window.sessionSearch.revealSession(detail.sessionKey),
              `${FILE_MANAGER_LABEL} opened.`,
            )
          }
        />
      ) : null}

      {sessionContextMenu ? (
        <SessionContextMenu
          state={sessionContextMenu}
          language={language}
          revealLabel={FILE_MANAGER_LABEL}
          showMacActions={IS_MAC}
          onRename={() => beginRename(sessionContextMenu.session)}
          onAddTag={() => beginAddTag(sessionContextMenu.session)}
          onFavorite={() =>
            void runAction(
              sessionContextMenu.session.favorited ? t("Removing favorite", "正在取消收藏") : t("Adding favorite", "正在加入收藏"),
              () => window.sessionSearch.setFavorited(sessionContextMenu.session.sessionKey, !sessionContextMenu.session.favorited),
              sessionContextMenu.session.favorited
                ? t("Removed from favorites.", "已取消收藏。")
                : t("Added to favorites.", "已加入收藏。"),
            )
          }
          onPin={() =>
            void runAction(
              t("Updating pin", "正在更新置顶"),
              () => window.sessionSearch.setPinned(sessionContextMenu.session.sessionKey, !sessionContextMenu.session.pinned),
              t("Pin updated.", "置顶已更新。"),
            )
          }
          onHide={() =>
            void runAction(
              t("Updating visibility", "正在更新可见性"),
              () => window.sessionSearch.setHidden(sessionContextMenu.session.sessionKey, !sessionContextMenu.session.hidden),
              t("Visibility updated.", "可见性已更新。"),
            )
          }
          onResume={() =>
            void runAction(
              t("Opening terminal", "正在打开终端"),
              () => window.sessionSearch.resumeSession(sessionContextMenu.session.sessionKey),
              (result) => resumeRouteMessage(result, language),
            )
          }
          onResumeIterm={() =>
            void runAction(
              t("Opening iTerm", "正在打开 iTerm"),
              () => window.sessionSearch.resumeSessionInIterm(sessionContextMenu.session.sessionKey),
              t("Resume command sent to iTerm.", "Resume 命令已发送到 iTerm。"),
            )
          }
          onOpenApp={() =>
            void runAction(
              t("Opening native app", "正在打开原生应用"),
              () => window.sessionSearch.openNativeApp(sessionContextMenu.session.sessionKey),
              t("Native app opened.", "原生应用已打开。"),
            )
          }
          onCopyResume={() =>
            void runAction(
              t("Copying resume command", "正在复制 Resume 命令"),
              () => window.sessionSearch.copyResumeCommand(sessionContextMenu.session.sessionKey),
              t("Resume command copied.", "Resume 命令已复制。"),
            )
          }
          onCopyMarkdown={() =>
            void runAction(
              t("Copying markdown", "正在复制 Markdown"),
              () => window.sessionSearch.copyMarkdown(sessionContextMenu.session.sessionKey),
              t("Markdown copied.", "Markdown 已复制。"),
            )
          }
          onExportMarkdown={() => void exportMarkdown(sessionContextMenu.session.sessionKey)}
          onReveal={() =>
            void runAction(
              `Opening ${FILE_MANAGER_LABEL}`,
              () => window.sessionSearch.revealSession(sessionContextMenu.session.sessionKey),
              `${FILE_MANAGER_LABEL} opened.`,
            )
          }
          onPromoteToRoot={
            projectGrouping === "repo" && !sessionPromotedRoot ? () => void promoteToRoot(sessionContextMenu.session.projectPath) : undefined
          }
        />
      ) : directoryContextMenu ? (
        <DirectoryContextMenu
          state={directoryContextMenu}
          language={language}
          onPromoteToRoot={directoryPromotedRoot ? undefined : () => void promoteToRoot(directoryContextMenu.path)}
        />
      ) : projectContextMenu ? (
        <ProjectContextMenu
          state={projectContextMenu}
          language={language}
          onDemote={() => {
            if (!projectContextMenu.promoted) {
              setContextMenu(null);
              const message = t("No higher-level directory.", "没有更高层的目录");
              setActionStatus({ kind: "error", message });
              window.setTimeout(() => {
                setActionStatus((current) => (current?.message === message ? null : current));
              }, 1600);
              return;
            }
            void demotePromotedRoot(projectContextMenu.project.path);
          }}
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

function SkillsDialog({
  snapshot,
  loading,
  feedback,
  language,
  revealLabel,
  onRefresh,
  onCopyPath,
  onReveal,
  onDelete,
  onClose,
}: {
  snapshot: InstalledSkillsSnapshot;
  loading: boolean;
  feedback: SkillsFeedback;
  language: LanguageMode;
  revealLabel: string;
  onRefresh: () => void;
  onCopyPath: (skillPath: string) => void;
  onReveal: (skillPath: string) => void;
  onDelete: (skill: InstalledSkill) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [sortKey, setSortKey] = useState<SkillSortKey>("usage");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillContextMenu, setSkillContextMenu] = useState<{ x: number; y: number; skill: InstalledSkill } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<InstalledSkill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);
  const filteredSkills = useMemo(() => {
    const filtered = filterInstalledSkills(snapshot.skills, query, sourceFilter);
    return sortInstalledSkills(filtered, sortKey);
  }, [snapshot.skills, query, sourceFilter, sortKey]);
  const selectedSkill =
    filteredSkills.find((skill) => skill.id === selectedSkillId) ??
    filteredSkills[0] ??
    null;
  const codexCount = snapshot.skills.filter((skill) => skill.agent === "codex").length;
  const claudeCount = snapshot.skills.filter((skill) => skill.agent === "claude").length;
  const activeItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!filteredSkills.length) {
      if (selectedSkillId) setSelectedSkillId(null);
      return;
    }
    if (!selectedSkillId || !filteredSkills.some((skill) => skill.id === selectedSkillId)) setSelectedSkillId(filteredSkills[0].id);
  }, [filteredSkills, selectedSkillId]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedSkill?.id]);

  const handleListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      if (deleteCandidate) setDeleteCandidate(null);
      else if (skillContextMenu) setSkillContextMenu(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!filteredSkills.length) return;
    event.preventDefault();
    const currentIndex = filteredSkills.findIndex((skill) => skill.id === selectedSkill?.id);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = Math.min(filteredSkills.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
    setSelectedSkillId(filteredSkills[nextIndex].id);
  };

  const requestDelete = (skill: InstalledSkill) => {
    setSkillContextMenu(null);
    setDeleteCandidate(skill);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    setDeletingSkill(true);
    try {
      await onDelete(deleteCandidate);
      setDeleteCandidate(null);
    } finally {
      setDeletingSkill(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="command-dialog skills-dialog"
        onMouseDown={(event) => {
          event.stopPropagation();
          setSkillContextMenu(null);
        }}
        onKeyDown={handleListKeyDown}
      >
        <div className="dialog-title">
          <span>{l("Skills", "Skills 管理")}</span>
          <span className="skills-dialog-count">
            Codex {formatCompactNumber(codexCount)} · Claude Code {formatCompactNumber(claudeCount)}
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>

        <div className="skills-toolbar">
          <label className="skills-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l("Search name, description, or path", "搜索名称、描述或路径")} autoFocus />
          </label>
          <div className="skills-filter" role="group" aria-label={l("Skill source filter", "Skill 来源筛选")}>
            {SKILL_SOURCE_FILTERS.map((filter) => (
              <button key={filter} className={sourceFilter === filter ? "active" : ""} onClick={() => setSourceFilter(filter)}>
                {skillFilterLabel(filter, language)}
              </button>
            ))}
          </div>
          <label className="skills-sort" title={l("Sort skills", "排序 Skills")}>
            <span>{l("Sort", "排序")}</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.currentTarget.value as SkillSortKey)} aria-label={l("Sort skills", "排序 Skills")}>
              <option value="usage">{l("Most used", "最多使用")}</option>
              <option value="usage-asc">{l("Least used", "最少使用")}</option>
            </select>
          </label>
          <button className="stats-refresh" onClick={onRefresh} disabled={loading} title={l("Refresh skill usage", "刷新 Skill 使用统计")} aria-label={l("Refresh skill usage", "刷新 Skill 使用统计")}>
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="skills-roots">
          {snapshot.roots.map((root) => (
            <span key={`${root.source}:${root.path}`} className={root.exists ? "" : "missing"} title={root.path}>
              <strong>{skillSourceUiLabel(root.source, language)}</strong>
              {root.exists ? l(`${root.skillCount} skills`, `${root.skillCount} 个`) : l("Missing", "未找到")}
            </span>
          ))}
        </div>

        {feedback ? <div className={`skills-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
        <div className="skills-shell">
          <div className="skills-list">
            {loading ? <div className="skills-empty">{l("Loading installed skills...", "正在加载已安装 Skills...")}</div> : null}
            {!loading && filteredSkills.length === 0 ? <div className="skills-empty">{l("No skills found.", "没有找到 Skill。")}</div> : null}
            {!loading
              ? filteredSkills.map((skill) => (
                  <button
                    key={skill.id}
                    ref={selectedSkill?.id === skill.id ? activeItemRef : undefined}
                    type="button"
                    className={`skill-item ${selectedSkill?.id === skill.id ? "active" : ""}`}
                    onClick={() => setSelectedSkillId(skill.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelectedSkillId(skill.id);
                      setSkillContextMenu({ x: event.clientX, y: event.clientY, skill });
                    }}
                  >
                    <span className="skill-item-head">
                      <strong>{skill.name}</strong>
                      {skill.usageCount ? <span className="skill-usage-count" title={l("Times used", "使用次数")}>{formatCompactNumber(skill.usageCount)}</span> : null}
                      <SkillSourceBadge source={skill.source} language={language} />
                    </span>
                    <span className="skill-item-desc">{skill.description || l("No description", "无描述")}</span>
                    <span className="skill-item-path">{skill.path}</span>
                  </button>
                ))
              : null}
          </div>

          <div className="skill-preview">
            {selectedSkill ? (
              <>
                <div className="skill-preview-head">
                  <div>
                    <div className="skill-preview-title">
                      <h3>{selectedSkill.name}</h3>
                      <SkillSourceBadge source={selectedSkill.source} language={language} />
                    </div>
                    <p>{selectedSkill.description || l("No description", "无描述")}</p>
                  </div>
                </div>
                <dl className="skill-meta">
                  <div>
                    <dt>{l("Agent", "Agent")}</dt>
                    <dd>{selectedSkill.agent === "codex" ? "Codex" : "Claude Code"}</dd>
                  </div>
                  <div>
                    <dt>{l("Used", "使用次数")}</dt>
                    <dd>
                      {selectedSkill.usageCount
                        ? l(`${selectedSkill.usageCount} times`, `${selectedSkill.usageCount} 次`) + (selectedSkill.lastUsedAt ? ` · ${new Date(selectedSkill.lastUsedAt).toLocaleString()}` : "")
                        : l("Not yet", "暂无")}
                    </dd>
                  </div>
                  <div>
                    <dt>{l("Updated", "更新时间")}</dt>
                    <dd>{new Date(selectedSkill.mtimeMs).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>{l("Path", "路径")}</dt>
                    <dd title={selectedSkill.path}>{selectedSkill.path}</dd>
                  </div>
                </dl>
                <pre className="skill-markdown-preview">{skillPreviewMarkdown(selectedSkill.markdown, language)}</pre>
              </>
            ) : (
              <div className="skills-empty">{l("Select a skill to preview it.", "选择一个 Skill 查看内容。")}</div>
            )}
          </div>
        </div>
        {skillContextMenu ? (
          <SkillContextMenu
            state={skillContextMenu}
            language={language}
            revealLabel={revealLabel}
            onCopyPath={() => {
              onCopyPath(skillContextMenu.skill.path);
              setSkillContextMenu(null);
            }}
            onReveal={() => {
              onReveal(skillContextMenu.skill.path);
              setSkillContextMenu(null);
            }}
            onDelete={() => requestDelete(skillContextMenu.skill)}
          />
        ) : null}
        {deleteCandidate ? (
          <DeleteSkillDialog
            skill={deleteCandidate}
            language={language}
            deleting={deletingSkill}
            onConfirm={() => void confirmDelete()}
            onCancel={() => {
              if (!deletingSkill) setDeleteCandidate(null);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

const SKILL_SOURCE_FILTERS: SkillSourceFilter[] = ["all", "codex", "claude", "shared", "project"];

function skillFilterLabel(filter: SkillSourceFilter, language: LanguageMode): string {
  if (filter === "codex") return "Codex";
  if (filter === "claude") return "Claude Code";
  if (filter === "shared") return localize(language, "Shared", "共享");
  if (filter === "project") return localize(language, "Project", "项目");
  return localize(language, "All", "全部");
}

function skillSourceUiLabel(source: SkillSource, language: LanguageMode): string {
  if (source === "codex-shared") return localize(language, "Shared", "共享");
  if (source === "codex-system") return localize(language, "Codex System", "Codex 系统");
  if (source === "claude-project") return localize(language, "Project", "项目");
  if (source === "claude-plugin") return localize(language, "Claude Plugin", "Claude 插件");
  return skillSourceLabel(source);
}

function SkillSourceBadge({ source, language }: { source: SkillSource; language: LanguageMode }): ReactElement {
  return <span className={`skill-source-badge ${source}`}>{skillSourceUiLabel(source, language)}</span>;
}

function SkillContextMenu({
  state,
  language,
  revealLabel,
  onCopyPath,
  onReveal,
  onDelete,
}: {
  state: { x: number; y: number; skill: InstalledSkill };
  language: LanguageMode;
  revealLabel: string;
  onCopyPath: () => void;
  onReveal: () => void;
  onDelete: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const canDelete = state.skill.source !== "codex-system";
  return (
    <div
      className="context-menu skill-context-menu"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={onCopyPath}>
        <Copy size={14} /> {l("Copy Path", "复制路径")}
      </button>
      <button type="button" onClick={onReveal}>
        <FolderOpen size={14} /> {l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)}
      </button>
      <hr />
      <button
        type="button"
        className="danger"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? l("Delete this skill", "删除这个 Skill") : l("Codex system skills cannot be deleted here.", "Codex 系统 Skill 不能在这里删除。")}
      >
        <Trash2 size={14} /> {l("Delete Skill", "删除 Skill")}
      </button>
    </div>
  );
}

function DeleteSkillDialog({
  skill,
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  skill: InstalledSkill;
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-skill-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete Skill", "删除 Skill")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={deleting} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Delete", "删除")} <strong>{skill.name}</strong>
          {l(" permanently?", "？")}
        </p>
        <p className="dialog-copy danger-copy">
          {l("This deletes the whole skill folder and cannot be undone.", "这会删除整个 Skill 文件夹，无法撤销。")}
        </p>
        <div className="delete-skill-path" title={skill.directoryPath}>
          {skill.directoryPath}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={deleting}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm} disabled={deleting}>
            {deleting ? l("Deleting...", "正在删除...") : l("Delete Permanently", "永久删除")}
          </button>
        </div>
      </div>
    </div>
  );
}

function skillPreviewMarkdown(markdown: string, language: LanguageMode): string {
  const limit = 12000;
  if (markdown.length <= limit) return markdown;
  return `${markdown.slice(0, limit)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`;
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
        <button className="quota-refresh" onClick={onRefresh} disabled={loading} title={l("Refresh usage limits", "刷新额度")} aria-label={l("Refresh usage limits", "刷新额度")}>
          <RefreshCw size={13} />
        </button>
      </div>
      {expanded ? (
        <>
          <div className="quota-list">
            {snapshot.providers.map((card) => (
              <QuotaProviderCard key={card.provider} card={card} language={language} />
            ))}
            {snapshot.providers.length === 0 ? <div className="quota-empty">{loading ? l("Checking usage limits...", "正在检查额度...") : l("Usage limits unavailable.", "额度不可用。")}</div> : null}
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

type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent };

function timestampMs(timestamp: string): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function conversationTimeline(messages: SessionMessage[], traceEvents: SessionTraceEvent[]): ConversationTimelineItem[] {
  const messageTimes = messages.map((message) => timestampMs(message.timestamp)).filter((time): time is number => time !== null);
  const maxMessageTime = messageTimes.length > 0 ? Math.max(...messageTimes) : null;
  const visibleTraceEvents =
    messages.length === 0
      ? traceEvents
      : traceEvents.filter((event) => {
          const time = timestampMs(event.timestamp);
          return time === null || maxMessageTime === null || time <= maxMessageTime;
        });

  const items: ConversationTimelineItem[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      key: `message:${message.index}`,
      timestampMs: timestampMs(message.timestamp),
      order: message.index * 2,
      message,
    })),
    ...visibleTraceEvents.map((event) => ({
      kind: "trace" as const,
      key: `trace:${event.index}`,
      timestampMs: timestampMs(event.timestamp),
      order: event.index * 2 + 1,
      event,
    })),
  ];

  return items.sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    if (a.timestampMs !== null && b.timestampMs === null) return -1;
    if (a.timestampMs === null && b.timestampMs !== null) return 1;
    return a.order - b.order;
  });
}

function DetailPanel({
  session,
  messages,
  traceEvents,
  loading,
  actionStatus,
  query,
  liveState,
  language,
  revealLabel,
  showItermAction,
  onClose,
  onShowMore,
  onRename,
  onAddTag,
  onRemoveTag,
  onRenameTitle,
  onFavorite,
  onResume,
  onResumeIterm,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onCopyPlain,
  onReveal,
}: {
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  loading: boolean;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  onClose: () => void;
  onShowMore: () => void;
  onRename: () => void;
  onAddTag: () => void;
  onRemoveTag: (tagName: string) => void;
  onRenameTitle: () => void;
  onFavorite: () => void;
  onResume: () => void;
  onResumeIterm: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onCopyPlain: () => void;
  onReveal: () => void;
}): ReactElement {
  const matchIndex = query
    ? messages.findIndex((message) => message.content.toLowerCase().includes(query.toLowerCase()))
    : -1;
  const context = matchIndex >= 0 ? messages.slice(Math.max(0, matchIndex - 1), Math.min(messages.length, matchIndex + 2)) : [];
  const actionRunning = actionStatus?.kind === "running";
  const l = (en: string, zh: string) => localize(language, en, zh);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timelineItems = useMemo(() => conversationTimeline(messages, traceEvents), [messages, traceEvents]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = bodyRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const page = el.clientHeight * 0.9;
      switch (event.key) {
        case "ArrowDown":
          el.scrollBy({ top: 64 });
          break;
        case "ArrowUp":
          el.scrollBy({ top: -64 });
          break;
        case "PageDown":
        case " ":
          el.scrollBy({ top: page });
          break;
        case "PageUp":
          el.scrollBy({ top: -page });
          break;
        case "Home":
          el.scrollTo({ top: 0 });
          break;
        case "End":
          el.scrollTo({ top: el.scrollHeight });
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="detail-backdrop" onClick={onClose}>
    <aside className="detail" onClick={(event) => event.stopPropagation()}>
      <div className="detail-header">
        <div>
          <div className="detail-badges">
            <div className={`source-badge ${sourceUiFamily(session.source)}`}>
              {SOURCE_LABEL[session.source]}
            </div>
            <span className={`live-status ${liveState}`}>
              <span className="live-status-dot" />
              {localizedLiveStateLabel(liveState, language)}
            </span>
          </div>
          <div className="detail-title-row">
            <h2>{session.displayTitle}</h2>
            <button className="title-edit-button detail-title-edit" onClick={onRenameTitle} aria-label={l("Rename session", "重命名会话")} title={l("Rename session", "重命名会话")}>
              <Edit3 size={14} />
            </button>
          </div>
          <p>
            {session.projectPath || l("No project", "无项目")} · {new Date(session.timestamp).toLocaleString()} · {l(`${messages.length} messages`, `${messages.length} 条消息`)} ·{" "}
            {l(`${formatTokenCount(session.tokenUsage.totalTokens)} tokens`, `${formatTokenCount(session.tokenUsage.totalTokens)} token`)}
            {traceEvents.length > 0 ? <> · {l(`${traceEvents.length} trace events`, `${traceEvents.length} 条轨迹`)}</> : null}
          </p>
        </div>
        <div className="detail-header-actions">
          <button
            className={`icon-button favorite-button ${session.favorited ? "active" : ""}`}
            onClick={onFavorite}
            aria-label={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
            title={session.favorited ? l("Remove from favorites", "取消收藏") : l("Add to favorites", "加入收藏")}
          >
            <Star size={17} fill={session.favorited ? "currentColor" : "none"} />
          </button>
          <button className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="detail-actions">
        <button onClick={onResume} disabled={actionRunning}>
          <Play size={15} /> Resume
        </button>
        {showItermAction ? (
          <button onClick={onResumeIterm} disabled={actionRunning}>
            <TerminalIcon size={15} /> iTerm
          </button>
        ) : null}
        <button onClick={onRename} disabled={actionRunning}>
          <Clipboard size={15} /> {l("Rename", "重命名")}
        </button>
        <button onClick={onAddTag} disabled={actionRunning}>
          <Tag size={15} /> {l("Add Tag", "添加标签")}
        </button>
        <button onClick={onCopyResume} disabled={actionRunning}>
          <Copy size={15} /> {l("Copy Cmd", "复制命令")}
        </button>
        <button onClick={onCopyMarkdown} disabled={actionRunning}>Markdown</button>
        <button onClick={onExportMarkdown} disabled={actionRunning}>
          <Download size={15} /> {l("Export MD", "导出 MD")}
        </button>
        <button onClick={onCopyPlain} disabled={actionRunning}>{l("Plain Text", "纯文本")}</button>
        <button onClick={onReveal} disabled={actionRunning}>
          <FolderOpen size={15} /> {revealLabel}
        </button>
      </div>
      <div className="detail-tags">
        {session.tags.map((tagName) => (
          <button key={tagName} className={`chip ${isBranchTag(tagName) ? "branch-tag" : ""}`} onClick={() => onRemoveTag(tagName)}>
            #{tagName} ×
          </button>
        ))}
      </div>
      <div className="detail-body" ref={bodyRef}>
        {context.length > 0 ? (
          <section className="matched">
            <h3>{l("Matched Context", "命中上下文")}</h3>
            {context.map((message) => (
              <MessageBlock key={message.index} message={message} query={query} language={language} />
            ))}
          </section>
        ) : null}
        <section className="conversation">
          <h3>{l("Full Conversation", "完整会话")}</h3>
          {loading ? <div className="loading-state">{l("Loading conversation...", "正在加载会话...")}</div> : null}
          {!loading && messages.length === 0 ? <div className="loading-state">{l("No visible messages indexed for this session.", "这个会话没有可见消息被索引。")}</div> : null}
          {timelineItems.map((item) => (
            item.kind === "message" ? (
              <MessageBlock key={item.key} message={item.message} query={query} language={language} />
            ) : (
              <TraceEventBlock key={item.key} event={item.event} language={language} />
            )
          ))}
          {!loading && messages.length < session.messageCount ? (
            <button className="show-more" onClick={onShowMore}>
              {l(`Show ${Math.min(MESSAGE_PAGE_SIZE, session.messageCount - messages.length)} more messages`, `再显示 ${Math.min(MESSAGE_PAGE_SIZE, session.messageCount - messages.length)} 条消息`)}
            </button>
          ) : null}
        </section>
      </div>
    </aside>
    </div>
  );
}

function MessageBlock({ message, query, language }: { message: SessionMessage; query: string; language: LanguageMode }): ReactElement {
  const content = useMemo(() => {
    const text =
      message.content.length > 3000
        ? `${message.content.slice(0, 3000)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`
        : message.content;
    if (!query) return text;
    return text;
  }, [message.content, query, language]);

  return (
    <div className={`message ${message.role}`}>
      <div className="message-head">
        <strong>{message.role === "user" ? localize(language, "User", "用户") : localize(language, "Assistant", "助手")}</strong>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
      <pre>{content}</pre>
    </div>
  );
}

function traceStatusSymbol(event: SessionTraceEvent): string {
  if (event.kind === "tool_call") return "→";
  if (event.status === "success") return "✓";
  if (event.status === "failure") return "✗";
  return "•";
}

function TraceEventBlock({ event, language }: { event: SessionTraceEvent; language: LanguageMode }): ReactElement {
  const detail = useMemo(() => {
    if (!event.detail) return localize(language, "No detail captured.", "没有记录详情。");
    return event.detail.length > 2400
      ? `${event.detail.slice(0, 2400)}\n\n${localize(language, "...(truncated)", "...（已截断）")}`
      : event.detail;
  }, [event.detail, language]);

  return (
    <details className={`trace-event ${event.kind} ${event.status || "unknown"}`}>
      <summary className="trace-head">
        <strong>
          <span className="trace-symbol">{traceStatusSymbol(event)}</span>
          {event.title}
        </strong>
        <span>{formatMessageTime(event.timestamp)}</span>
      </summary>
      <div className="trace-meta">
        {event.eventType ? <span>{event.eventType}</span> : null}
        {event.callId ? <span>{event.callId}</span> : null}
      </div>
      <pre>{detail}</pre>
    </details>
  );
}

function ActionToast({ status }: { status: ActionStatus }): ReactElement {
  return (
    <div className={`action-toast ${status.kind}`} role="status" aria-live="polite">
      {status.message}
    </div>
  );
}

function SessionContextMenu({
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
  onReveal,
  onPromoteToRoot,
}: {
  state: { x: number; y: number; session: SessionSearchResult };
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
  onReveal: () => void;
  onPromoteToRoot?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
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
      {onPromoteToRoot ? (
        <button onClick={onPromoteToRoot}>
          <Folder size={14} /> {l("Promote to Root", "提升为根目录")}
        </button>
      ) : null}
    </div>
  );
}

function DirectoryContextMenu({
  state,
  language,
  onPromoteToRoot,
}: {
  state: { x: number; y: number; path: string; label: string };
  language: LanguageMode;
  onPromoteToRoot?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      {onPromoteToRoot ? (
        <button onClick={onPromoteToRoot}>
          <Folder size={14} /> {l("Promote to Root", "提升为根目录")}
        </button>
      ) : null}
    </div>
  );
}

function ProjectContextMenu({
  state,
  language,
  onDemote,
}: {
  state: { x: number; y: number; project: ProjectSummary; promoted: boolean };
  language: LanguageMode;
  onDemote: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={onDemote} disabled={!state.promoted} title={state.promoted ? state.project.path : l("No higher-level directory.", "没有更高层的目录")}>
        <FolderOpen size={14} /> {state.promoted ? l("Revert to Repository Root", "回退到仓库级") : l("No higher-level directory.", "没有更高层的目录")}
      </button>
    </div>
  );
}

function ApiConfigDialog({
  settings,
  language,
  feedback,
  onSettingsChange,
  onApplyToCodex,
  onApplyToClaude,
  onClose,
}: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onApplyToCodex: (apiConfig: ApiConfig) => void;
  onApplyToClaude: (claudeApiConfig: ClaudeApiConfig) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const saving = feedback?.kind === "running";
  const [apiTarget, setApiTarget] = useState<"codex" | "claude">("codex");
  const [showCodexApiKey, setShowCodexApiKey] = useState(false);
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [draftApiConfig, setDraftApiConfig] = useState<ApiConfig>(() => settings?.apiConfig ?? { ...defaultApiConfig });
  const [draftClaudeApiConfig, setDraftClaudeApiConfig] = useState<ClaudeApiConfig>(
    () => settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig },
  );
  const apiPresetSelectionRef = useRef(0);
  const claudeApiPresetSelectionRef = useRef(0);
  const updateDraftApiConfig = (next: Partial<ApiConfig>) => setDraftApiConfig((current) => ({ ...current, ...next }));
  const updateDraftClaudeApiConfig = (next: Partial<ClaudeApiConfig>) => setDraftClaudeApiConfig((current) => ({ ...current, ...next }));
  const selectedPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === draftApiConfig.customProviderId) ?? API_PROVIDER_PRESETS[0];
  const customName = selectedPreset?.label ?? (draftApiConfig.customProviderName || "CodexZH");
  const selectedClaudePreset =
    CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === draftClaudeApiConfig.customProviderId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
  const customClaudeName = selectedClaudePreset?.label ?? (draftClaudeApiConfig.customProviderName || "Claude Code");

  const selectApiPreset = async (presetId: ApiProviderPresetId) => {
    const selectionId = ++apiPresetSelectionRef.current;
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("codex", preset.id).catch(() => "");
    if (selectionId !== apiPresetSelectionRef.current) return;
    setDraftApiConfig((current) => ({
      ...current,
      activeProvider: "custom",
      customProviderId: preset.id,
      customProviderName: preset.providerName,
      customBaseUrl: preset.baseUrl,
      customApiKey: apiKey,
      customModel: preset.model,
      customApiFormat: preset.apiFormat,
    }));
    setShowCodexApiKey(false);
  };

  const selectClaudeApiPreset = async (presetId: ClaudeApiProviderPresetId) => {
    const selectionId = ++claudeApiPresetSelectionRef.current;
    const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("claude", preset.id).catch(() => "");
    if (selectionId !== claudeApiPresetSelectionRef.current) return;
    setDraftClaudeApiConfig((current) => {
      if (preset.id === "custom") {
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: "custom",
          customProviderName: current.customProviderName || preset.providerName,
          customApiKey: apiKey,
        };
      }
      return {
        ...current,
        activeProvider: "custom",
        customProviderId: preset.id,
        customProviderName: preset.providerName,
        customBaseUrl: preset.baseUrl,
        customApiKey: apiKey,
        customModel: preset.model,
        customHaikuModel: preset.haikuModel,
        customSonnetModel: preset.sonnetModel,
        customOpusModel: preset.opusModel,
        customApiFormat: preset.apiFormat,
        customApiKeyField: preset.apiKeyField,
      };
    });
    setShowClaudeApiKey(false);
  };

  useEffect(() => {
    setDraftApiConfig(settings?.apiConfig ?? { ...defaultApiConfig });
    setDraftClaudeApiConfig(settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig });
  }, [settings?.apiConfig, settings?.claudeApiConfig]);

  const saveDraft = () => {
    if (apiTarget === "codex") onSettingsChange({ apiConfig: draftApiConfig });
    else onSettingsChange({ claudeApiConfig: draftClaudeApiConfig });
  };

  const applyDraft = () => {
    if (apiTarget === "codex") onApplyToCodex(draftApiConfig);
    else onApplyToClaude(draftClaudeApiConfig);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog api-config-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("API configuration", "API 配置")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="api-target-tabs" role="tablist" aria-label={l("API target", "API 目标")}>
          <button type="button" className={apiTarget === "codex" ? "active" : ""} onClick={() => setApiTarget("codex")}>
            Codex
          </button>
          <button type="button" className={apiTarget === "claude" ? "active" : ""} onClick={() => setApiTarget("claude")}>
            Claude Code
          </button>
        </div>
        <div className="api-config-body">
          {apiTarget === "codex" ? (
            <section className="settings-pane api-settings-form">
            <header className="settings-pane-head">
              <h3>{l("Codex providers", "Codex 供应商")}</h3>
              <p>{l("Switch Codex between the official account and common OpenAI-compatible routes.", "在 Codex 官网账号和常用 OpenAI-compatible 路径之间切换。")}</p>
            </header>
            <div
              className="api-provider-switch"
              role="group"
              aria-label={l("Codex provider", "Codex 供应商")}
              data-provider-labels="CodexZH DeepSeek GLM LongCat Kimi MiMo"
            >
              <button
                type="button"
                className={draftApiConfig.activeProvider === "official" ? "active" : ""}
                disabled={!settings || saving}
                onClick={() => {
                  apiPresetSelectionRef.current += 1;
                  updateDraftApiConfig({ activeProvider: "official" });
                }}
              >
                <strong>Codex Official</strong>
                <span>{l("Use existing official Codex auth.", "使用现有 Codex 官网认证。")}</span>
              </button>
              {API_PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={draftApiConfig.activeProvider === "custom" && draftApiConfig.customProviderId === preset.id ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => void selectApiPreset(preset.id)}
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.model}</span>
                </button>
              ))}
            </div>
            {draftApiConfig.activeProvider === "official" ? (
              <div className="api-config-note">
                {l(
                  "Apply clears Codex route fields in ~/.codex/config.toml so Codex uses its default official route, and preserves auth.json.",
                  "应用时会清理 ~/.codex/config.toml 里的 Codex 路由字段，让 Codex 使用默认官网路由，并保留现有 auth.json。",
                )}
              </div>
            ) : null}
            {draftApiConfig.activeProvider === "custom" ? (
              <>
                <div className="api-config-note">
                  {draftApiConfig.customProviderId === "codexzh"
                    ? l("Apply updates the active ~/.codex/config.toml route and preserves existing auth.json.", "应用时只更新当前 ~/.codex/config.toml 的路由配置，并保留现有 auth.json。")
                    : l(`Apply merges the ${customName} route into ~/.codex/config.toml and preserves existing auth.json.`, `应用时会把 ${customName} 路由合并到 ~/.codex/config.toml，并保留现有 auth.json。`)}
                </div>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Provider name", "供应商名称")}</span>
                    <span className="settings-field-sub">{l("Display name for this custom Codex route.", "这个自定义 Codex 路径的显示名称。")}</span>
                  </div>
                  <input
                    type="text"
                    value={draftApiConfig.customProviderName}
                    disabled={!settings || saving}
                    placeholder="CodexZH"
                    onChange={(event) => updateDraftApiConfig({ customProviderName: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Base URL</span>
                    <span className="settings-field-sub">{l("OpenAI-compatible endpoint, usually ending in /v1.", "OpenAI-compatible 接口地址，通常以 /v1 结尾。")}</span>
                  </div>
                  <input
                    type="text"
                    value={draftApiConfig.customBaseUrl}
                    disabled={!settings || saving}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => updateDraftApiConfig({ customBaseUrl: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">API Key</span>
                    <span className="settings-field-sub">{l("Stored locally. Applying it to Codex CLI will be a separate explicit action.", "保存在本地；写入 Codex CLI 会作为单独的显式动作。")}</span>
                  </div>
                  <div className="secret-input">
                    <input
                      type={showCodexApiKey ? "text" : "password"}
                      value={draftApiConfig.customApiKey}
                      disabled={!settings || saving}
                      placeholder="sk-..."
                      onChange={(event) => updateDraftApiConfig({ customApiKey: event.currentTarget.value })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCodexApiKey((current) => !current)}
                      disabled={!settings || saving}
                      aria-label={showCodexApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                      title={showCodexApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                    >
                      {showCodexApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Model", "模型")}</span>
                    <span className="settings-field-sub">{l("Model name for this Codex route.", "这个 Codex 路径使用的模型名称。")}</span>
                  </div>
                  <input
                    type="text"
                    value={draftApiConfig.customModel}
                    disabled={!settings || saving}
                    placeholder="gpt-5.5"
                    onChange={(event) => updateDraftApiConfig({ customModel: event.currentTarget.value })}
                  />
                </label>
                <label className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("API format", "API 格式")}</span>
                    <span className="settings-field-sub">{l("Matches cc-switch's OpenAI Chat / Responses split.", "对应 cc-switch 里的 OpenAI Chat / Responses 区分。")}</span>
                  </div>
                  <select
                    value={draftApiConfig.customApiFormat}
                    disabled={!settings || saving}
                    onChange={(event) => updateDraftApiConfig({ customApiFormat: event.currentTarget.value as ApiConfig["customApiFormat"] })}
                  >
                    <option value="openai_chat">OpenAI Chat Completions</option>
                    <option value="openai_responses">OpenAI Responses API</option>
                  </select>
                </label>
              </>
            ) : null}
            </section>
          ) : (
            <section className="settings-pane api-settings-form">
              <header className="settings-pane-head">
                <h3>{l("Claude Code providers", "Claude Code 供应商")}</h3>
                <p>{l("Switch Claude Code between official auth and common Anthropic-compatible routes.", "在 Claude 官方认证和常用 Anthropic-compatible 路径之间切换。")}</p>
              </header>
              <div
                className="api-provider-switch"
                role="group"
                aria-label={l("Claude Code provider", "Claude Code 供应商")}
                data-provider-labels="Custom DeepSeek GLM LongCat Kimi MiMo"
              >
                <button
                  type="button"
                  className={draftClaudeApiConfig.activeProvider === "official" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => {
                    claudeApiPresetSelectionRef.current += 1;
                    updateDraftClaudeApiConfig({ activeProvider: "official" });
                  }}
                >
                  <strong>Claude Official</strong>
                  <span>{l("Use existing Claude Code auth.", "使用现有 Claude Code 官方认证。")}</span>
                </button>
                {CLAUDE_API_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={draftClaudeApiConfig.activeProvider === "custom" && draftClaudeApiConfig.customProviderId === preset.id ? "active" : ""}
                    disabled={!settings || saving}
                    onClick={() => void selectClaudeApiPreset(preset.id)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.model || l("Manual route", "手动配置")}</span>
                  </button>
                ))}
              </div>
              {draftClaudeApiConfig.activeProvider === "official" ? (
                <div className="api-config-note">
                  {l("Apply clears third-party route env keys in ~/.claude/settings.json and keeps other Claude settings.", "应用时会清理 ~/.claude/settings.json 里的第三方路由 env，并保留其他 Claude 设置。")}
                </div>
              ) : null}
              {draftClaudeApiConfig.activeProvider === "custom" ? (
                <>
                  <div className="api-config-note">
                    {l(`Apply writes ${customClaudeName} route env into ~/.claude/settings.json.`, `应用时会把 ${customClaudeName} 路由 env 写入 ~/.claude/settings.json。`)}
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Provider name", "供应商名称")}</span>
                      <span className="settings-field-sub">{l("Display name for this Claude Code route.", "这个 Claude Code 路径的显示名称。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customProviderName}
                      disabled={!settings || saving}
                      placeholder="Custom Claude"
                      onChange={(event) => updateDraftClaudeApiConfig({ customProviderName: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">Base URL</span>
                      <span className="settings-field-sub">{l("Anthropic-compatible endpoint for Claude Code.", "Claude Code 使用的 Anthropic-compatible 接口地址。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customBaseUrl}
                      disabled={!settings || saving}
                      placeholder="https://api.example.com/anthropic"
                      onChange={(event) => updateDraftClaudeApiConfig({ customBaseUrl: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">API Key</span>
                      <span className="settings-field-sub">{l("Stored locally and written to Claude Code only when applied.", "保存在本地，只在应用时写入 Claude Code。")}</span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showClaudeApiKey ? "text" : "password"}
                        value={draftClaudeApiConfig.customApiKey}
                        disabled={!settings || saving}
                        placeholder="sk-..."
                        onChange={(event) => updateDraftClaudeApiConfig({ customApiKey: event.currentTarget.value })}
                      />
                      <button
                        type="button"
                        onClick={() => setShowClaudeApiKey((current) => !current)}
                        disabled={!settings || saving}
                        aria-label={showClaudeApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                        title={showClaudeApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                      >
                        {showClaudeApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Primary Claude Code model env.", "Claude Code 的主模型 env。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customModel}
                      disabled={!settings || saving}
                      placeholder="claude-sonnet-4.6"
                      onChange={(event) => updateDraftClaudeApiConfig({ customModel: event.currentTarget.value })}
                    />
                  </label>
                  <div className="api-model-grid">
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Haiku</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customHaikuModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "haiku model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customHaikuModel: event.currentTarget.value })}
                      />
                    </label>
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Sonnet</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customSonnetModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "sonnet model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customSonnetModel: event.currentTarget.value })}
                      />
                    </label>
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Opus</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customOpusModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "opus model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customOpusModel: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Key env", "Key 环境变量")}</span>
                      <span className="settings-field-sub">{l("Most Claude Code routes use ANTHROPIC_AUTH_TOKEN.", "大多数 Claude Code 路径使用 ANTHROPIC_AUTH_TOKEN。")}</span>
                    </div>
                    <select
                      value={draftClaudeApiConfig.customApiKeyField}
                      disabled={!settings || saving}
                      onChange={(event) =>
                        updateDraftClaudeApiConfig({ customApiKeyField: event.currentTarget.value as ClaudeApiConfig["customApiKeyField"] })
                      }
                    >
                      <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option>
                      <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
                    </select>
                  </label>
                </>
              ) : null}
            </section>
          )}
        </div>
        <div className="dialog-actions api-config-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" disabled={!settings || saving} onClick={saveDraft}>
            {l("Save", "保存")}
          </button>
          <button
            type="button"
            className="primary-action"
            disabled={!settings || saving}
            onClick={applyDraft}
          >
            {apiTarget === "codex" ? l("Apply to Codex", "应用到 Codex") : l("Apply to Claude Code", "应用到 Claude Code")}
          </button>
        </div>
        <div className={`settings-feedback ${feedback?.kind ?? ""}`} aria-live="polite">
          {feedback?.message ?? ""}
        </div>
      </section>
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
                    <span className="settings-field-title">{l("Project grouping", "项目分组")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "Choose whether the Projects sidebar groups sessions by working directory or repository root.",
                        "选择项目侧栏按工作目录还是仓库根目录聚合会话。",
                      )}
                    </span>
                  </div>
                  <select
                    value={settings?.projectGrouping ?? "cwd"}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ projectGrouping: event.target.value as AppSettings["projectGrouping"] })}
                  >
                    <option value="cwd">{l("Working directory", "工作目录")}</option>
                    <option value="repo">{l("Repository root", "仓库根目录")}</option>
                  </select>
                </div>
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
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">{l("Filter tags by project", "按项目过滤标签")}</span>
                    <span className="settings-field-sub">
                      {l(
                        "When enabled, the Tags sidebar only shows tags from sessions in the selected project.",
                        "开启后，标签侧栏只显示当前选中项目中的标签。",
                      )}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.filterTagsByProject)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ filterTagsByProject: event.currentTarget.checked })}
                  />
                </label>
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

function DeleteTagDialog({
  tagName,
  language,
  onConfirm,
  onCancel,
}: {
  tagName: string;
  language: LanguageMode;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete Tag", "删除标签")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Delete", "从所有会话中删除")} <strong>#{tagName}</strong>{l(" from all sessions?", "？")}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            {l("Delete", "删除")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandDialog({
  dialog,
  tags,
  language,
  onChange,
  onSubmit,
  onCancel,
}: {
  dialog: NonNullable<DialogState>;
  tags: string[];
  language: LanguageMode;
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
  onCancel: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const l = (en: string, zh: string) => localize(language, en, zh);
  const matchingTags = dialog.kind === "tag" ? tags.filter((tagName) => tagName.includes(dialog.value.trim())).slice(0, 6) : [];

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="command-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-title">
          <span>{dialog.kind === "rename" ? l("Rename Session", "重命名会话") : l("Add Tag", "添加标签")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={dialog.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={dialog.kind === "rename" ? l("Session title", "会话标题") : l("Tag name", "标签名")}
        />
        {matchingTags.length > 0 ? (
          <div className="tag-suggestions">
            {matchingTags.map((tagName) => (
              <button key={tagName} type="button" onClick={() => onSubmit(tagName)}>
                #{tagName}
              </button>
            ))}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {l("Cancel", "取消")}
          </button>
          <button type="submit" className="primary-action">
            {l("Save", "保存")}
          </button>
        </div>
      </form>
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
