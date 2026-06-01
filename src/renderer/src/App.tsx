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
  Edit3,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  GitBranch,
  Moon,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Settings,
  Star,
  Sun,
  Tag,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { IndexStatus } from "../../core/indexer";
import { formatMessageTime, formatRelativeTime } from "../../core/format-session";
import type { AppSettings } from "../../core/platform";
import type {
  LiveSessionSnapshot,
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
  SessionSortBy,
  SessionSource,
  SessionStats,
  SessionStatsPeriod,
  UsageQuotaCard,
  UsageQuotaSnapshot,
} from "../../core/types";
import { formatCompactNumber, formatTokenCount } from "./format-count";
import {
  readSidebarSections,
  serializeSidebarSections,
  toggleSidebarSection,
  type SidebarSectionId,
  type SidebarSectionsState,
} from "./sidebar-sections";
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";

const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "claude-internal": "Claude Internal",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
  "codex-internal": "Codex Internal",
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
    ...(settings?.includeClaudeInternal ? [{ label: "Claude Internal", value: "claude-internal" as const }] : []),
    ...(settings?.includeCodexInternal ? [{ label: "Codex Internal", value: "codex-internal" as const }] : []),
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

const DEFAULT_TERMINAL_OPTIONS: Array<{ label: string; value: AppSettings["defaultTerminal"] }> = [
  { label: "Terminal", value: "Terminal" },
  { label: "iTerm", value: "iTerm" },
  { label: "Ghostty", value: "Ghostty" },
  { label: "WezTerm", value: "WezTerm" },
  { label: "Warp", value: "Warp" },
];

type ViewMode = "default" | "favorites" | "pinned" | "hidden";
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

function isBranchTag(tagName: string): boolean {
  return tagName.startsWith("branch:");
}

type LiveSessionState = "open" | "closed" | "unknown";

function liveSessionKey(session: SessionSearchResult): string {
  return `${session.source.startsWith("claude") ? "claude" : "codex"}:${session.rawId}`;
}

function liveStateLabel(state: LiveSessionState): string {
  if (state === "open") return "Open";
  if (state === "closed") return "Closed";
  return "Unknown";
}

type ActionStatus = {
  kind: "running" | "success" | "error";
  message: string;
};

type RefreshFeedback = ActionStatus | null;
type StatsFeedback = ActionStatus | null;
type QuotaFeedback = ActionStatus | null;
type SettingsFeedback = ActionStatus | null;

interface ContextMenuState {
  x: number;
  y: number;
  session: SessionSearchResult;
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

export function App(): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [sidebarSections, setSidebarSections] = useState<SidebarSectionsState>(() => loadInitialSidebarSections());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [tag, setTag] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<ViewMode>("default");
  const [sortBy, setSortBy] = useState<SessionSortBy>("created");
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
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<SettingsFeedback>(null);
  const [pendingInternal, setPendingInternal] = useState<{ claude: boolean; codex: boolean }>({ claude: false, codex: false });
  const loadSeqRef = useRef(0);
  const detailLoadSeqRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const requestId = ++loadSeqRef.current;
    const options: SearchOptions = {
      query,
      source,
      tag,
      projectPath,
      visibility,
      sortBy,
      limit: 300,
    };
    const [nextResults, nextTags, nextProjects, nextStats] = await Promise.all([
      window.sessionSearch.searchSessions(options),
      window.sessionSearch.listTags(),
      window.sessionSearch.listProjects(),
      window.sessionSearch.getStats({ period: statsPeriod }),
    ]);
    if (requestId !== loadSeqRef.current) return;
    setResults(nextResults);
    setTags(nextTags);
    setProjects(nextProjects);
    setStats(nextStats);
    setSelectedKey((current) =>
      current && !nextResults.some((session) => session.sessionKey === current) ? null : current,
    );
  }, [query, source, tag, projectPath, visibility, sortBy, statsPeriod]);

  const refreshStats = useCallback(async () => {
    setStatsRefreshing(true);
    setStatsFeedback({ kind: "running", message: "Refreshing usage..." });
    try {
      setStats(await window.sessionSearch.getStats({ period: statsPeriod }));
      const successMessage = "Usage refreshed.";
      setStatsFeedback({ kind: "success", message: successMessage });
      window.setTimeout(() => {
        setStatsFeedback((current) => (current?.kind === "success" && current.message === successMessage ? null : current));
      }, 1600);
    } catch (error) {
      setStatsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatsRefreshing(false);
    }
  }, [statsPeriod]);

  const loadQuotas = useCallback(async (manual = false) => {
    setQuotaLoading(true);
    if (manual) setQuotaFeedback({ kind: "running", message: "Refreshing usage limits..." });
    try {
      const nextQuotas = await window.sessionSearch.getQuotas();
      setQuotas(nextQuotas);
      if (manual) {
        const successMessage = "Usage limits refreshed.";
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
  }, []);

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
    const timer = window.setTimeout(() => void load(), 120);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void loadQuotas();
  }, [loadQuotas]);

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
  }, [source, appSettings]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, serializeSidebarSections(sidebarSections));
  }, [sidebarSections]);

  useEffect(() => {
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      setIndexStatus(nextStatus);
      if (!nextStatus.running) void load();
    });
    const offFocus = window.sessionSearch.onFocusSearch(() => searchRef.current?.focus());
    return () => {
      offIndex();
      offFocus();
    };
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
        else if (settingsOpen) setSettingsOpen(false);
        else if (detail) closeDetail();
        else return;
        event.preventDefault();
        return;
      }

      // Leave list navigation alone while an overlay or menu is in front.
      if (detail || dialog || deleteTagName || contextMenu || settingsOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (actionStatus?.kind === "running" || !selectedKey) return;
        const session = results.find((item) => item.sessionKey === selectedKey);
        if (session) {
          void runAction("Opening terminal", () => window.sessionSearch.resumeSession(session.sessionKey), "Resume command sent to terminal.");
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (results.length === 0) return;
        event.preventDefault();
        const currentIndex = results.findIndex((session) => session.sessionKey === selectedKey);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? delta === 1
              ? 0
              : results.length - 1
            : Math.min(results.length - 1, Math.max(0, currentIndex + delta));
        setSelectedKey(results[nextIndex].sessionKey);
        return;
      }

      if (event.key === " " && selectedKey) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const session = results.find((item) => item.sessionKey === selectedKey);
        if (session) {
          event.preventDefault();
          void openDetail(session);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [results, selectedKey, detail, dialog, deleteTagName, contextMenu, settingsOpen, actionStatus]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(".session-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(detail));
    return () => document.body.classList.remove("overlay-open");
  }, [detail]);

  const selected = useMemo(
    () => results.find((session) => session.sessionKey === selectedKey) || null,
    [results, selectedKey],
  );
  const liveSessionKeys = useMemo(
    () => new Set(liveSessions.sessions.map((session) => `${session.family}:${session.rawId}`)),
    [liveSessions],
  );
  const visibleSourceFilters = useMemo(() => {
    if (!appSettings) return sourceFilters(null);
    // Reveal an internal source filter only once its background load has finished.
    return sourceFilters({
      ...appSettings,
      includeClaudeInternal: appSettings.includeClaudeInternal && !pendingInternal.claude,
      includeCodexInternal: appSettings.includeCodexInternal && !pendingInternal.codex,
    });
  }, [appSettings, pendingInternal]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.path === projectPath) || null,
    [projects, projectPath],
  );
  const searchPlaceholder = projectPath
    ? `Search within ${selectedProject?.label || "project"}`
    : tag
      ? `Search within #${tag}`
      : "Search titles, first questions, full text, paths, or ids";

  function toggleSidebarSectionById(section: SidebarSectionId): void {
    setSidebarSections((current) => toggleSidebarSection(current, section));
  }

  async function openDetail(session: SessionSearchResult): Promise<void> {
    const requestId = ++detailLoadSeqRef.current;
    setContextMenu(null);
    setDetail(session);
    setMessages([]);
    setMessagesLoading(true);

    const sessionKey = session.sessionKey;
    const [fresh, loadedMessages] = await Promise.all([
      window.sessionSearch.getSession(sessionKey),
      window.sessionSearch.getMessages(sessionKey, 0, INITIAL_MESSAGE_LIMIT),
    ]);
    if (requestId !== detailLoadSeqRef.current) return;
    if (!fresh) {
      setMessagesLoading(false);
      return;
    }
    setDetail(fresh);
    setMessages(loadedMessages);
    setMessagesLoading(false);
  }

  function closeDetail(): void {
    detailLoadSeqRef.current++;
    setDetail(null);
    setMessages([]);
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

  async function runAction(label: string, action: () => Promise<void>, successMessage: string): Promise<void> {
    setContextMenu(null);
    setActionStatus({ kind: "running", message: `${label}...` });
    try {
      await action();
      await refreshAfterAction();
      await refreshLiveSessions();
      window.setTimeout(() => void refreshLiveSessions(), 1200);
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
    setRefreshFeedback({ kind: "running", message: "Refreshing index..." });
    try {
      const status = await window.sessionSearch.refreshIndex();
      setIndexStatus(status);
      await load();
      if (status.error) {
        setRefreshFeedback({ kind: "error", message: status.error });
        return;
      }
      const successMessage = `Index refreshed: ${status.indexed}/${status.total} sessions.`;
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

  async function updateSettings(next: Partial<AppSettings>): Promise<void> {
    const enablingClaude = next.includeClaudeInternal === true && !appSettings?.includeClaudeInternal;
    const enablingCodex = next.includeCodexInternal === true && !appSettings?.includeCodexInternal;
    setSettingsFeedback({ kind: "running", message: "Saving settings..." });
    try {
      const nextSettings = await window.sessionSearch.setSettings(next);
      setAppSettings(nextSettings);

      if (enablingClaude || enablingCodex) {
        // Keep the toggle responsive: scan the internal source in the background
        // and only reveal its sidebar filter once that scan finishes.
        if (enablingClaude) setPendingInternal((current) => ({ ...current, claude: true }));
        if (enablingCodex) setPendingInternal((current) => ({ ...current, codex: true }));
        setSettingsFeedback({ kind: "success", message: "Loading sessions in the background…" });
        void window.sessionSearch
          .refreshIndex()
          .then(async () => {
            setPendingInternal((current) => ({
              claude: enablingClaude ? false : current.claude,
              codex: enablingCodex ? false : current.codex,
            }));
            await load();
            setSettingsFeedback({ kind: "success", message: "Sources ready." });
            window.setTimeout(() => {
              setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
            }, 1600);
          })
          .catch((error) => {
            if (enablingClaude) setPendingInternal((current) => ({ ...current, claude: false }));
            if (enablingCodex) setPendingInternal((current) => ({ ...current, codex: false }));
            setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      await load();
      setSettingsFeedback({ kind: "success", message: "Settings saved." });
      window.setTimeout(() => {
        setSettingsFeedback((current) => (current?.kind === "success" ? null : current));
      }, 1600);
    } catch (error) {
      setSettingsFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <main className="app" data-theme={theme} onClick={() => setContextMenu(null)}>
      <div className="titlebar-drag" />
      <section className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Search size={17} />
          </div>
          <div>
            <h1>Agent Session Search</h1>
            <p>Codex and Claude Code</p>
          </div>
        </div>

        <div className="refresh-control">
          <button className={`primary ${indexStatus?.running ? "is-running" : ""}`} onClick={() => void refreshNow()} disabled={indexStatus?.running}>
            <RefreshCw size={16} />
            {indexStatus?.running ? "Refreshing Index..." : "Refresh Index"}
          </button>
          {refreshFeedback ? <div className={`refresh-feedback ${refreshFeedback.kind}`}>{refreshFeedback.message}</div> : null}
        </div>

        <div className="stats-panel">
          <div className="stats-header">
            <span>Usage</span>
            <div className="stats-controls">
              <div className="stats-period-toggle" role="group" aria-label="Usage period">
                {STATS_PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={statsPeriod === option.value ? "active" : ""}
                    onClick={() => setStatsPeriod(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                className="stats-refresh"
                onClick={() => void refreshStats()}
                disabled={statsRefreshing}
                title="Refresh usage stats"
                aria-label="Refresh usage stats"
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>
          {statsFeedback ? <div className={`stats-feedback ${statsFeedback.kind}`}>{statsFeedback.message}</div> : null}
          <div className="stats-metrics">
            <span>
              <strong>{formatCompactNumber(stats.total.messageCount)}</strong>
              Messages
            </span>
            <span>
              <strong>{formatTokenCount(stats.total.totalTokens)}</strong>
              Tokens
            </span>
          </div>
          <div className="stats-breakdown">
            {stats.bySource.map((item) => (
              <div key={item.source}>
                <span>{SOURCE_LABEL[item.source]}</span>
                <em>
                  {formatCompactNumber(item.messageCount)} msg · {formatTokenCount(item.totalTokens)}
                </em>
              </div>
            ))}
          </div>
        </div>

        <QuotaPanel
          snapshot={quotas}
          loading={quotaLoading}
          feedback={quotaFeedback}
          onRefresh={() => void loadQuotas(true)}
        />

        <SidebarSectionHeader title="Views" expanded={sidebarSections.views} onToggle={() => toggleSidebarSectionById("views")} />
        {sidebarSections.views ? (
          <nav className="nav-group">
            <button className={visibility === "default" ? "active" : ""} onClick={() => setVisibility("default")}>
              All
            </button>
            <button className={visibility === "favorites" ? "active" : ""} onClick={() => setVisibility("favorites")}>
              <Star size={14} />
              Favorites
            </button>
            <button className={visibility === "pinned" ? "active" : ""} onClick={() => setVisibility("pinned")}>
              <Pin size={14} />
              Pinned
            </button>
            <button className={visibility === "hidden" ? "active" : ""} onClick={() => setVisibility("hidden")}>
              <EyeOff size={14} />
              Hidden
            </button>
          </nav>
        ) : null}

        <SidebarSectionHeader title="Sources" expanded={sidebarSections.sources} onToggle={() => toggleSidebarSectionById("sources")} />
        {sidebarSections.sources ? (
          <nav className="nav-group">
            {visibleSourceFilters.map((item) => (
              <button key={item.label} className={source === item.value ? "active" : ""} onClick={() => setSource(item.value)}>
                {item.label}
              </button>
            ))}
          </nav>
        ) : null}

        <SidebarSectionHeader title="Projects" expanded={sidebarSections.projects} onToggle={() => toggleSidebarSectionById("projects")} />
        {sidebarSections.projects ? (
          <nav className="project-list">
            <button className={!projectPath ? "active" : ""} onClick={() => setProjectPath(undefined)}>
              All Projects
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

        <SidebarSectionHeader title="Tags" expanded={sidebarSections.tags} onToggle={() => toggleSidebarSectionById("tags")} />
        {sidebarSections.tags ? (
          <nav className="tag-list">
            <button className={!tag ? "active" : ""} onClick={() => setTag(undefined)}>
              All Tags
            </button>
            {tags.map((tagName) => (
              <div
                key={tagName}
                className={`tag-list-row ${tag === tagName ? "active" : ""} ${isBranchTag(tagName) ? "branch-tag" : ""}`}
              >
                <button className="tag-filter" onClick={() => setTag(tagName)} title={`Filter by ${tagName}`}>
                  {isBranchTag(tagName) ? <GitBranch size={13} /> : <Tag size={13} />}
                  <span>{tagName}</span>
                </button>
                <button
                  className="tag-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTagName(tagName);
                  }}
                  title={`Delete tag ${tagName}`}
                  aria-label={`Delete tag ${tagName}`}
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
            <span className="kbd-hint">⌘K</span>
            <span className="kbd-hint" title="Resume selected session in the default terminal">
              ⌘↵
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
          <label className="sort-menu">
            <span>Sort</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SessionSortBy)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="top-actions">
            <button
              className="icon-button toolbar-icon-button"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              className="icon-button toolbar-icon-button"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={15} />
            </button>
          </div>
        </header>

        <div className="result-count">
          <span>{results.length} sessions</span>
          {selected ? <span className="selected-path">{selected.projectPath || selected.rawId}</span> : null}
        </div>

        <div className="results">
          {results.map((session) => (
            <SessionRow
              key={session.sessionKey}
              session={session}
              selected={selected?.sessionKey === session.sessionKey}
              liveState={liveSessions.error ? "unknown" : liveSessionKeys.has(liveSessionKey(session)) ? "open" : "closed"}
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
          {results.length === 0 ? <div className="empty">No sessions found.</div> : null}
        </div>
      </section>

      {detail ? (
        <DetailPanel
          session={detail}
          messages={messages}
          loading={messagesLoading}
          actionStatus={actionStatus}
          query={query}
          liveState={liveSessions.error ? "unknown" : liveSessionKeys.has(liveSessionKey(detail)) ? "open" : "closed"}
          onClose={closeDetail}
          onShowMore={() => void loadMoreMessages()}
          onRename={() => beginRename(detail)}
          onAddTag={() => beginAddTag(detail)}
          onRemoveTag={(tagName) => void removeTag(detail, tagName)}
          onRenameTitle={() => beginRename(detail)}
          onFavorite={() => void toggleFavorite(detail)}
          onResume={() =>
            void runAction("Opening terminal", () => window.sessionSearch.resumeSession(detail.sessionKey), "Resume command sent to terminal.")
          }
          onResumeIterm={() =>
            void runAction("Opening iTerm", () => window.sessionSearch.resumeSessionInIterm(detail.sessionKey), "Resume command sent to iTerm.")
          }
          onCopyResume={() =>
            void runAction("Copying resume command", () => window.sessionSearch.copyResumeCommand(detail.sessionKey), "Resume command copied.")
          }
          onCopyMarkdown={() =>
            void runAction("Copying markdown", () => window.sessionSearch.copyMarkdown(detail.sessionKey), "Markdown copied.")
          }
          onCopyPlain={() =>
            void runAction("Copying plain text", () => window.sessionSearch.copyPlainText(detail.sessionKey), "Plain text copied.")
          }
          onReveal={() => void runAction("Opening Finder", () => window.sessionSearch.revealSession(detail.sessionKey), "Finder opened.")}
        />
      ) : null}

      {contextMenu ? (
        <ContextMenu
          state={contextMenu}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onFavorite={() =>
            void runAction(
              contextMenu.session.favorited ? "Removing favorite" : "Adding favorite",
              () => window.sessionSearch.setFavorited(contextMenu.session.sessionKey, !contextMenu.session.favorited),
              contextMenu.session.favorited ? "Removed from favorites." : "Added to favorites.",
            )
          }
          onPin={() =>
            void runAction("Updating pin", () => window.sessionSearch.setPinned(contextMenu.session.sessionKey, !contextMenu.session.pinned), "Pin updated.")
          }
          onHide={() =>
            void runAction(
              "Updating visibility",
              () => window.sessionSearch.setHidden(contextMenu.session.sessionKey, !contextMenu.session.hidden),
              "Visibility updated.",
            )
          }
          onResume={() =>
            void runAction("Opening terminal", () => window.sessionSearch.resumeSession(contextMenu.session.sessionKey), "Resume command sent to terminal.")
          }
          onResumeIterm={() =>
            void runAction("Opening iTerm", () => window.sessionSearch.resumeSessionInIterm(contextMenu.session.sessionKey), "Resume command sent to iTerm.")
          }
          onOpenApp={() =>
            void runAction("Opening native app", () => window.sessionSearch.openNativeApp(contextMenu.session.sessionKey), "Native app opened.")
          }
          onCopyResume={() =>
            void runAction("Copying resume command", () => window.sessionSearch.copyResumeCommand(contextMenu.session.sessionKey), "Resume command copied.")
          }
          onCopyMarkdown={() =>
            void runAction("Copying markdown", () => window.sessionSearch.copyMarkdown(contextMenu.session.sessionKey), "Markdown copied.")
          }
          onCopyPlain={() =>
            void runAction("Copying plain text", () => window.sessionSearch.copyPlainText(contextMenu.session.sessionKey), "Plain text copied.")
          }
          onReveal={() =>
            void runAction("Opening Finder", () => window.sessionSearch.revealSession(contextMenu.session.sessionKey), "Finder opened.")
          }
        />
      ) : null}

      {actionStatus ? <ActionToast status={actionStatus} /> : null}

      {dialog ? (
        <CommandDialog
          dialog={dialog}
          tags={tags}
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={(value) => void submitDialog(value)}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {deleteTagName ? (
        <DeleteTagDialog
          tagName={deleteTagName}
          onConfirm={() => void deleteTagGlobally(deleteTagName)}
          onCancel={() => setDeleteTagName(null)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={appSettings}
          feedback={settingsFeedback}
          onSettingsChange={(next) => void updateSettings(next)}
          onDefaultTerminalChange={(terminal) => void updateDefaultTerminal(terminal)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}

function QuotaPanel({
  snapshot,
  loading,
  feedback,
  onRefresh,
}: {
  snapshot: UsageQuotaSnapshot;
  loading: boolean;
  feedback: QuotaFeedback;
  onRefresh: () => void;
}): ReactElement {
  const updatedAt = snapshot.generatedAt ? formatRelativeTime(Date.parse(snapshot.generatedAt)) : "";
  return (
    <div className="quota-panel">
      <div className="quota-header">
        <div>
          <span>Remaining</span>
          {updatedAt ? <em>{updatedAt}</em> : null}
        </div>
        <button className="quota-refresh" onClick={onRefresh} disabled={loading} title="Refresh usage limits" aria-label="Refresh usage limits">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="quota-list">
        {snapshot.providers.map((card) => (
          <QuotaProviderCard key={card.provider} card={card} />
        ))}
        {snapshot.providers.length === 0 ? <div className="quota-empty">{loading ? "Checking usage limits..." : "Usage limits unavailable."}</div> : null}
      </div>
      {feedback ? <div className={`quota-feedback ${feedback.kind}`}>{feedback.message}</div> : null}
    </div>
  );
}

function QuotaProviderCard({ card }: { card: UsageQuotaCard }): ReactElement {
  const supported = card.status === "supported" && card.quotas.length > 0;
  const meta = card.plan;
  return (
    <div className={`quota-card ${card.provider}`}>
      <div className="quota-provider-head">
        <span className="quota-provider-name">{card.displayName}</span>
        <span className={`quota-status ${card.status}`}>{quotaStatusLabel(card.status)}</span>
      </div>
      {meta ? <div className="quota-meta">{meta}</div> : null}
      {supported ? (
        <div className="quota-windows">
          {card.quotas.map((quota) => (
            <div className="quota-window" key={quota.key}>
              <div className="quota-window-top">
                <span>{quota.label}</span>
                <strong>{quota.remainingDisplay} left</strong>
              </div>
              <div className="quota-track" aria-hidden="true">
                <div className="quota-fill" style={{ width: `${quota.remainingPercent}%` } as CSSProperties} />
              </div>
              <div className="quota-reset">{quota.stale ? "stale" : formatQuotaReset(quota.resetsAt)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="quota-detail">{card.detail || "Quota data unavailable."}</p>
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
  onSelect,
  onOpen,
  onRename,
  onFavorite,
  onContextMenu,
}: {
  session: SessionSearchResult;
  selected: boolean;
  liveState: LiveSessionState;
  onSelect: () => void;
  onOpen: () => void;
  onRename: () => void;
  onFavorite: () => void;
  onContextMenu: MouseEventHandler;
}): ReactElement {
  return (
    <article
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div className="session-main">
        <div className="session-title">
          <span className={`source-dot ${session.source.startsWith("claude") ? "claude" : "codex"}`} />
          <button
            className={`favorite-button ${session.favorited ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite();
            }}
            aria-label={session.favorited ? "Remove from favorites" : "Add to favorites"}
            title={session.favorited ? "Remove from favorites" : "Add to favorites"}
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
            aria-label="Rename session"
            title="Rename session"
          >
            <Edit3 size={13} />
          </button>
        </div>
        <div className="session-meta">
          <span className={`live-status ${liveState}`}>
            <span className="live-status-dot" />
            {liveStateLabel(liveState)}
          </span>
          <span className={`source-badge ${session.source.startsWith("claude") ? "claude" : "codex"}`}>
            {session.source.startsWith("claude") ? <Code2 size={13} /> : <Terminal size={13} />}
            {SOURCE_LABEL[session.source]}
          </span>
          <span>{session.projectPath || "No project path"}</span>
          <span>{formatRelativeTime(session.timestamp)}</span>
          <span>{session.messageCount} messages</span>
          <span>{formatTokenCount(session.tokenUsage.totalTokens)} tokens</span>
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

function DetailPanel({
  session,
  messages,
  loading,
  actionStatus,
  query,
  liveState,
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
  onCopyPlain,
  onReveal,
}: {
  session: SessionSearchResult;
  messages: SessionMessage[];
  loading: boolean;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
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
  onCopyPlain: () => void;
  onReveal: () => void;
}): ReactElement {
  const matchIndex = query
    ? messages.findIndex((message) => message.content.toLowerCase().includes(query.toLowerCase()))
    : -1;
  const context = matchIndex >= 0 ? messages.slice(Math.max(0, matchIndex - 1), Math.min(messages.length, matchIndex + 2)) : [];
  const actionRunning = actionStatus?.kind === "running";
  const bodyRef = useRef<HTMLDivElement>(null);

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
            <div className={`source-badge ${session.source.startsWith("claude") ? "claude" : "codex"}`}>
              {SOURCE_LABEL[session.source]}
            </div>
            <span className={`live-status ${liveState}`}>
              <span className="live-status-dot" />
              {liveStateLabel(liveState)}
            </span>
          </div>
          <div className="detail-title-row">
            <h2>{session.displayTitle}</h2>
            <button className="title-edit-button detail-title-edit" onClick={onRenameTitle} aria-label="Rename session" title="Rename session">
              <Edit3 size={14} />
            </button>
          </div>
          <p>
            {session.projectPath || "No project"} · {new Date(session.timestamp).toLocaleString()} · {messages.length} messages ·{" "}
            {formatTokenCount(session.tokenUsage.totalTokens)} tokens
          </p>
        </div>
        <div className="detail-header-actions">
          <button
            className={`icon-button favorite-button ${session.favorited ? "active" : ""}`}
            onClick={onFavorite}
            aria-label={session.favorited ? "Remove from favorites" : "Add to favorites"}
            title={session.favorited ? "Remove from favorites" : "Add to favorites"}
          >
            <Star size={17} fill={session.favorited ? "currentColor" : "none"} />
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="detail-actions">
        <button onClick={onResume} disabled={actionRunning}>
          <Play size={15} /> Resume
        </button>
        <button onClick={onResumeIterm} disabled={actionRunning}>
          <Terminal size={15} /> iTerm
        </button>
        <button onClick={onRename} disabled={actionRunning}>
          <Clipboard size={15} /> Rename
        </button>
        <button onClick={onAddTag} disabled={actionRunning}>
          <Tag size={15} /> Add Tag
        </button>
        <button onClick={onCopyResume} disabled={actionRunning}>
          <Copy size={15} /> Copy Cmd
        </button>
        <button onClick={onCopyMarkdown} disabled={actionRunning}>Markdown</button>
        <button onClick={onCopyPlain} disabled={actionRunning}>Plain Text</button>
        <button onClick={onReveal} disabled={actionRunning}>
          <FolderOpen size={15} /> Finder
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
            <h3>Matched Context</h3>
            {context.map((message) => (
              <MessageBlock key={message.index} message={message} query={query} />
            ))}
          </section>
        ) : null}
        <section className="conversation">
          <h3>Full Conversation</h3>
          {loading ? <div className="loading-state">Loading conversation...</div> : null}
          {!loading && messages.length === 0 ? <div className="loading-state">No visible messages indexed for this session.</div> : null}
          {messages.map((message) => (
            <MessageBlock key={message.index} message={message} query={query} />
          ))}
          {!loading && messages.length < session.messageCount ? (
            <button className="show-more" onClick={onShowMore}>
              Show {Math.min(MESSAGE_PAGE_SIZE, session.messageCount - messages.length)} more messages
            </button>
          ) : null}
        </section>
      </div>
    </aside>
    </div>
  );
}

function MessageBlock({ message, query }: { message: SessionMessage; query: string }): ReactElement {
  const content = useMemo(() => {
    const text = message.content.length > 3000 ? `${message.content.slice(0, 3000)}\n\n...(truncated)` : message.content;
    if (!query) return text;
    return text;
  }, [message.content, query]);

  return (
    <div className={`message ${message.role}`}>
      <div className="message-head">
        <strong>{message.role === "user" ? "User" : "Assistant"}</strong>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
      <pre>{content}</pre>
    </div>
  );
}

function ActionToast({ status }: { status: ActionStatus }): ReactElement {
  return (
    <div className={`action-toast ${status.kind}`} role="status" aria-live="polite">
      {status.message}
    </div>
  );
}

function ContextMenu({
  state,
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
  onCopyPlain,
  onReveal,
}: {
  state: ContextMenuState;
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
  onCopyPlain: () => void;
  onReveal: () => void;
}): ReactElement {
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={onRename}>
        <Clipboard size={14} /> Rename
      </button>
      <button onClick={onAddTag}>
        <Tag size={14} /> Add Tag
      </button>
      <button onClick={onFavorite}>
        <Star size={14} fill={state.session.favorited ? "currentColor" : "none"} />{" "}
        {state.session.favorited ? "Unfavorite" : "Favorite"}
      </button>
      <button onClick={onPin}>{state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />} {state.session.pinned ? "Unpin" : "Pin"}</button>
      <button onClick={onHide}>
        {state.session.hidden ? <Eye size={14} /> : <Archive size={14} />} {state.session.hidden ? "Unhide" : "Hide"}
      </button>
      <hr />
      <button onClick={onResume}>
        <Play size={14} /> Resume in Terminal
      </button>
      <button onClick={onResumeIterm}>
        <Terminal size={14} /> Resume in iTerm
      </button>
      <button onClick={onOpenApp}>
        <AppWindow size={14} /> Open App
      </button>
      <button onClick={onCopyResume}>
        <Copy size={14} /> Copy Resume Cmd
      </button>
      <button onClick={onCopyMarkdown}>Copy Markdown</button>
      <button onClick={onCopyPlain}>Copy Plain Text</button>
      <button onClick={onReveal}>
        <FolderOpen size={14} /> Show in Finder
      </button>
    </div>
  );
}

function SettingsDialog({
  settings,
  feedback,
  onSettingsChange,
  onDefaultTerminalChange,
  onClose,
}: {
  settings: AppSettings | null;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: Partial<AppSettings>) => void;
  onDefaultTerminalChange: (terminal: AppSettings["defaultTerminal"]) => void;
  onClose: () => void;
}): ReactElement {
  const defaultTerminal = settings?.defaultTerminal ?? "Terminal";
  const saving = feedback?.kind === "running";
  const [activeSection, setActiveSection] = useState<"terminal" | "sources">("terminal");

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>Settings</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="settings-shell">
          <nav className="settings-sidebar" aria-label="Settings sections">
            <button className={activeSection === "terminal" ? "active" : ""} onClick={() => setActiveSection("terminal")}>
              <Terminal size={15} />
              <span>Default terminal</span>
            </button>
            <button className={activeSection === "sources" ? "active" : ""} onClick={() => setActiveSection("sources")}>
              <Folder size={15} />
              <span>Personal sources</span>
            </button>
          </nav>
          <div className="settings-content">
            {activeSection === "terminal" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>Default terminal</h3>
                  <p>Choose which terminal app Resume and the list shortcut use to reopen a session.</p>
                </header>
                <div className="settings-field">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Terminal app</span>
                    <span className="settings-field-sub">Applies to Resume and the keyboard shortcut.</span>
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
            {activeSection === "sources" ? (
              <section className="settings-pane">
                <header className="settings-pane-head">
                  <h3>Personal sources</h3>
                  <p>Internal sessions stay separate from the normal Claude and Codex filters.</p>
                </header>
                <label className="settings-field settings-toggle">
                  <div className="settings-field-text">
                    <span className="settings-field-title">Include ~/.claude-internal</span>
                    <span className="settings-field-sub">Adds a separate Claude Internal source filter.</span>
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
                    <span className="settings-field-sub">Adds a separate Codex Internal source filter.</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(settings?.includeCodexInternal)}
                    disabled={!settings || saving}
                    onChange={(event) => onSettingsChange({ includeCodexInternal: event.currentTarget.checked })}
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

function DeleteTagDialog({
  tagName,
  onConfirm,
  onCancel,
}: {
  tagName: string;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>Delete Tag</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          Delete <strong>#{tagName}</strong> from all sessions?
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandDialog({
  dialog,
  tags,
  onChange,
  onSubmit,
  onCancel,
}: {
  dialog: NonNullable<DialogState>;
  tags: string[];
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
  onCancel: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
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
          <span>{dialog.kind === "rename" ? "Rename Session" : "Add Tag"}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={dialog.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={dialog.kind === "rename" ? "Session title" : "Tag name"}
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
            Cancel
          </button>
          <button type="submit" className="primary-action">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function quotaStatusLabel(status: UsageQuotaCard["status"]): string {
  if (status === "supported") return "Live";
  if (status === "unsupported_api_key") return "Unsupported";
  if (status === "error") return "Error";
  return "Setup";
}

function formatQuotaReset(resetsAt?: string): string {
  if (!resetsAt) return "";
  const timestamp = Date.parse(resetsAt);
  if (!Number.isFinite(timestamp)) return "";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "reset due";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes - hours * 60;
    return remainingMinutes > 0 ? `resets in ${hours}h ${remainingMinutes}m` : `resets in ${hours}h`;
  }
  const days = Math.ceil(hours / 24);
  return `resets in ${days}d`;
}
