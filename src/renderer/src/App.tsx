import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Bug,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Edit3,
  Folder,
  Info,
  Play,
  Search,
  Settings,
  Star,
  X,
} from "lucide-react";
import { formatRelativeTime } from "../../core/format-session";
import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import { terminalSelectOptions } from "../../core/terminal-options";
import type {
  ProjectSummary,
  SearchOptions,
  SessionMessage,
  SessionSearchResult,
} from "../../core/types";
import {
  DATE_RANGE_OPTIONS,
  dateRangeLabel,
  dateRangeShortLabel,
  resolveDateRange,
  type DateRangeFilter,
} from "./date-range";
import {
  browserCoreExperienceApi,
  type CoreExperienceApi,
} from "./core-experience-api";
import { LANGUAGE_STORAGE_KEY, localize, readInitialLanguage, type LanguageMode } from "./language";
import { SearchBox } from "./features/search/search-box";
import { CoreSessionDetailAdapter } from "./features/session-detail/core-session-detail-adapter";
import { SOURCE_LABEL, sourceUiFamily, supportsResumeSource } from "./session-ui";
import { readInitialTheme, THEME_STORAGE_KEY, type ThemeMode } from "./theme";

const INITIAL_SESSION_LIMIT = 30;
const SESSION_PAGE_SIZE = 30;
const INITIAL_MESSAGE_LIMIT = 20;
const MESSAGE_PAGE_SIZE = 80;

type CoreView = "all" | "favorites";
type CoreDialogSection = "settings" | "about" | "diagnostics";
type ActionStatus =
  | { kind: "running" | "success" | "error"; message: string }
  | null;

const CORE_SOURCE_FILTERS: Array<{ value: SearchOptions["source"]; en: string; zh: string }> = [
  { value: "all", en: "All sources", zh: "全部来源" },
  { value: "claude", en: "Claude", zh: "Claude" },
  { value: "codex", en: "Codex", zh: "Codex" },
];

const CORE_SESSION_SOURCES = new Set<SessionSearchResult["source"]>([
  "claude-cli",
  "claude-app",
  "codex-cli",
  "codex-app",
]);

export function isCoreV1Session(
  session: Pick<SessionSearchResult, "source" | "environmentId" | "environmentKind">,
): boolean {
  return CORE_SESSION_SOURCES.has(session.source)
    && session.environmentId === "local"
    && session.environmentKind === "local";
}

function sourceLabel(source: SessionSearchResult["source"]): string {
  return SOURCE_LABEL[source] ?? source;
}

function resumeSuccessMessage(
  route: ResumeRouteResult,
  language: LanguageMode,
): string {
  if (route.route === "app") {
    return localize(language, "Opened in the Codex app.", "已在 Codex App 中打开。");
  }
  if (route.route === "focus") {
    return localize(language, "Focused the running session.", "已聚焦正在运行的会话。");
  }
  return localize(language, "Session resumed.", "已恢复会话。");
}

function CoreSessionRow({
  session,
  selected,
  language,
  onOpen,
  onSelect,
  onResume,
  onRename,
  onFavorite,
}: {
  session: SessionSearchResult;
  selected: boolean;
  language: LanguageMode;
  onOpen: () => void;
  onSelect: () => void;
  onResume: () => void;
  onRename: () => void;
  onFavorite: () => void;
}): ReactElement {
  const t = (en: string, zh: string) => localize(language, en, zh);

  return (
    <article
      className={`session-row core-session-row ${selected ? "selected" : ""}`}
      onClick={() => {
        onSelect();
        onOpen();
      }}
    >
      <div className="session-main">
        <div className="session-title">
          <button
            className={`favorite-button ${session.favorited ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onFavorite();
            }}
            title={session.favorited ? t("Remove from favorites", "取消收藏") : t("Add to favorites", "加入收藏")}
            aria-label={session.favorited ? t("Remove from favorites", "取消收藏") : t("Add to favorites", "加入收藏")}
          >
            <Star size={14} fill={session.favorited ? "currentColor" : "none"} />
          </button>
          <span className="session-name">{session.displayTitle}</span>
          <button
            className="title-edit-button"
            onClick={(event) => {
              event.stopPropagation();
              onRename();
            }}
            title={t("Rename session", "重命名会话")}
            aria-label={t("Rename session", "重命名会话")}
          >
            <Edit3 size={13} />
          </button>
        </div>
        <div className="session-meta">
          <span className={`source-badge ${sourceUiFamily(session.source)}`}>{sourceLabel(session.source)}</span>
          <span title={session.projectPath}>{session.projectPath || t("No project", "无项目")}</span>
          <span>{formatRelativeTime(session.lastActivityAt || session.timestamp)}</span>
          <span>{t(`${session.messageCount} messages`, `${session.messageCount} 条消息`)}</span>
        </div>
        {session.matchSnippet ? <div className="snippet">{session.matchSnippet}</div> : null}
      </div>
      <button
        className="core-row-resume"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
          onResume();
        }}
        disabled={!supportsResumeSource(session.source)}
      >
        <Play size={13} />
        {session.source === "codex-app" ? t("Open", "打开") : t("Resume", "恢复")}
      </button>
    </article>
  );
}

function RenameDialog({
  session,
  value,
  language,
  onChange,
  onCancel,
  onSubmit,
}: {
  session: SessionSearchResult;
  value: string;
  language: LanguageMode;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): ReactElement {
  const t = (en: string, zh: string) => localize(language, en, zh);
  const inputRef = useRef<HTMLInputElement>(null);

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
          <span>{t("Rename session", "重命名会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={t("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <input ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)} placeholder={session.displayTitle} />
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{t("Cancel", "取消")}</button>
          <button type="submit" className="primary-action">{t("Save", "保存")}</button>
        </div>
      </form>
    </div>
  );
}

function CoreInfoDialog({
  initialSection,
  language,
  platform,
  theme,
  sessionCount,
  searchError,
  defaultTerminal,
  settingsLoading,
  onLanguageChange,
  onThemeChange,
  onDefaultTerminalChange,
  onClose,
}: {
  initialSection: CoreDialogSection;
  language: LanguageMode;
  platform: NodeJS.Platform;
  theme: ThemeMode;
  sessionCount: number;
  searchError: string | null;
  defaultTerminal: AppSettings["defaultTerminal"] | null;
  settingsLoading: boolean;
  onLanguageChange: (language: LanguageMode) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onDefaultTerminalChange: (terminal: AppSettings["defaultTerminal"]) => void;
  onClose: () => void;
}): ReactElement {
  const [section, setSection] = useState(initialSection);
  const t = (en: string, zh: string) => localize(language, en, zh);
  const sections: Array<{ id: CoreDialogSection; icon: ReactElement; label: string }> = [
    { id: "settings", icon: <Settings size={15} />, label: t("Settings", "设置") },
    { id: "about", icon: <Info size={15} />, label: t("About", "关于") },
    { id: "diagnostics", icon: <Bug size={15} />, label: t("Diagnostics", "诊断") },
  ];

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog settings-dialog core-settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{sections.find((item) => item.id === section)?.label}</span>
          <button className="icon-button" onClick={onClose} aria-label={t("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-shell">
          <nav className="settings-sidebar">
            {sections.map((item) => (
              <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === "settings" ? (
              <div className="settings-pane core-settings-pane">
                <h2>{t("Core settings", "核心设置")}</h2>
                <label className="core-setting-row">
                  <span>{t("Resume terminal", "恢复会话终端")}</span>
                  <select
                    value={defaultTerminal ?? ""}
                    disabled={settingsLoading || !defaultTerminal}
                    onChange={(event) => onDefaultTerminalChange(event.target.value as AppSettings["defaultTerminal"])}
                  >
                    {!defaultTerminal ? <option value="">{t("Loading…", "加载中…")}</option> : null}
                    {terminalSelectOptions(platform).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="core-setting-row">
                  <span>{t("Theme", "主题")}</span>
                  <div className="core-segmented-control">
                    <button className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}>{t("Light", "浅色")}</button>
                    <button className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}>{t("Dark", "深色")}</button>
                  </div>
                </div>
                <div className="core-setting-row">
                  <span>{t("Language", "语言")}</span>
                  <div className="core-segmented-control">
                    <button className={language === "zh" ? "active" : ""} onClick={() => onLanguageChange("zh")}>中文</button>
                    <button className={language === "en" ? "active" : ""} onClick={() => onLanguageChange("en")}>English</button>
                  </div>
                </div>
              </div>
            ) : null}
            {section === "about" ? (
              <div className="settings-pane core-info-pane">
                <CircleHelp size={32} />
                <h2>AgentRecall 1.0</h2>
                <p>{t("Find and resume your local Claude and Codex sessions.", "查找并恢复本机 Claude 与 Codex 会话。")}</p>
              </div>
            ) : null}
            {section === "diagnostics" ? (
              <div className="settings-pane core-diagnostics">
                <h2>{t("Core diagnostics", "核心诊断")}</h2>
                <dl>
                  <div><dt>{t("Platform", "平台")}</dt><dd>{platform}</dd></div>
                  <div><dt>{t("Visible core sessions", "当前核心会话")}</dt><dd>{sessionCount}</dd></div>
                  <div>
                    <dt>{t("Search", "搜索")}</dt>
                    <dd className={searchError ? "error" : "success"}>
                      {searchError || t("Ready", "正常")}
                    </dd>
                  </div>
                </dl>
                <p>{t("No background polling is active.", "当前没有后台轮询。")}</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

export interface AppProps {
  api?: CoreExperienceApi;
}

export function App({ api = browserCoreExperienceApi() }: AppProps = {}): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [language, setLanguage] = useState<LanguageMode>(readInitialLanguage);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
  const [view, setView] = useState<CoreView>("all");
  const [sessionLimit, setSessionLimit] = useState(INITIAL_SESSION_LIMIT);
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionSearchResult | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>(null);
  const [renameSession, setRenameSession] = useState<SessionSearchResult | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [infoSection, setInfoSection] = useState<CoreDialogSection | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const t = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);

  const selected = useMemo(
    () => results.find((session) => session.sessionKey === selectedKey) ?? null,
    [results, selectedKey],
  );

  const load = useCallback(async () => {
    const requestId = ++searchRequestRef.current;
    setSearchLoading(true);
    setSearchError(null);
    const options: SearchOptions = {
      query: query || undefined,
      source,
      projectPath: project?.path,
      environmentId: "local",
      visibility: view === "favorites" ? "favorites" : "default",
      sortBy: "activity",
      ...resolveDateRange(dateRange),
      limit: sessionLimit,
      excludeSubagents: true,
    };

    try {
      const page = await api.searchSessionPage(options);
      if (requestId !== searchRequestRef.current) return;
      const coreSessions = page.sessions.filter(isCoreV1Session);
      setResults(coreSessions);
      setSessionTotalCount(coreSessions.length);
      setHasMoreSessions(page.hasMore);
    } catch (error) {
      if (requestId !== searchRequestRef.current) return;
      setResults([]);
      setSessionTotalCount(0);
      setHasMoreSessions(false);
      setSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === searchRequestRef.current) setSearchLoading(false);
    }
  }, [api, dateRange, project, query, sessionLimit, source, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    void api
      .listProjects({ excludeSubagents: true, environmentId: "local" })
      .then((nextProjects) => {
        if (active) setProjects(nextProjects);
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const offFocusSearch = api.onFocusSearch(() => searchRef.current?.focus());
    const offOpenSettings = api.onOpenSettings(() => setInfoSection("settings"));
    return () => {
      offFocusSearch();
      offOpenSettings();
    };
  }, [api]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (infoSection !== "settings" || appSettings) return;
    let active = true;
    setSettingsLoading(true);
    void api
      .getSettings()
      .then((settings) => {
        if (active) setAppSettings(settings);
      })
      .catch((error) => {
        if (active) setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (active) setSettingsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, appSettings, infoSection]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setInfoSection("settings");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (renameSession) setRenameSession(null);
        else if (infoSection) setInfoSection(null);
        else if (detail) closeDetail();
        return;
      }
      if (renameSession || infoSection || detail) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA") return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = results.findIndex((session) => session.sessionKey === selectedKey);
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(results.length - 1, Math.max(0, currentIndex + 1))
          : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
        setSelectedKey(results[nextIndex]?.sessionKey ?? null);
      } else if (event.key === " " && selected) {
        event.preventDefault();
        void openDetail(selected);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && selected) {
        event.preventDefault();
        void resumeSession(selected);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function changeSource(next: SearchOptions["source"]): void {
    setSource(next);
    setSessionLimit(INITIAL_SESSION_LIMIT);
  }

  function changeProject(next: ProjectSummary | null): void {
    setProject(next);
    setSessionLimit(INITIAL_SESSION_LIMIT);
  }

  function changeDateRange(next: DateRangeFilter): void {
    setDateRange(next);
    setSessionLimit(INITIAL_SESSION_LIMIT);
  }

  function changeView(next: CoreView): void {
    setView(next);
    setSessionLimit(INITIAL_SESSION_LIMIT);
  }

  async function openDetail(session: SessionSearchResult): Promise<void> {
    const requestId = ++detailRequestRef.current;
    setDetail(session);
    setMessages([]);
    setMessageOffset(0);
    setDetailLoading(true);
    setActionStatus(null);
    try {
      const fresh = await api.getSession(session.sessionKey);
      if (requestId !== detailRequestRef.current || !fresh) return;
      const offset = Math.max(0, fresh.messageCount - INITIAL_MESSAGE_LIMIT);
      const loadedMessages = await api.getMessages(fresh.sessionKey, offset, INITIAL_MESSAGE_LIMIT);
      if (requestId !== detailRequestRef.current) return;
      setDetail(fresh);
      setMessageOffset(offset);
      setMessages(loadedMessages);
    } catch (error) {
      if (requestId === detailRequestRef.current) {
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }

  function closeDetail(): void {
    detailRequestRef.current += 1;
    setDetail(null);
    setMessages([]);
    setMessageOffset(0);
    setDetailLoading(false);
    setActionStatus(null);
  }

  async function loadOlderMessages(request: { limit: number }): Promise<void> {
    if (!detail || detailLoading || messageOffset <= 0) return;
    const requestId = detailRequestRef.current;
    const pageSize = Math.min(MESSAGE_PAGE_SIZE, Math.max(1, request.limit));
    const nextOffset = Math.max(0, messageOffset - pageSize);
    setDetailLoading(true);
    try {
      const olderMessages = await api.getMessages(
        detail.sessionKey,
        nextOffset,
        messageOffset - nextOffset,
      );
      if (requestId !== detailRequestRef.current) return;
      setMessages((current) => [...olderMessages, ...current]);
      setMessageOffset(nextOffset);
    } catch (error) {
      if (requestId === detailRequestRef.current) {
        setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }

  async function resumeSession(session: SessionSearchResult): Promise<void> {
    if (!supportsResumeSource(session.source)) return;
    setActionStatus({ kind: "running", message: t("Opening session…", "正在打开会话…") });
    try {
      const route = await api.resumeSession(session.sessionKey);
      setActionStatus({ kind: "success", message: resumeSuccessMessage(route, language) });
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function toggleFavorite(session: SessionSearchResult): Promise<void> {
    try {
      await api.setFavorited(session.sessionKey, !session.favorited);
      await load();
      if (detail?.sessionKey === session.sessionKey) {
        const fresh = await api.getSession(session.sessionKey);
        if (fresh) setDetail(fresh);
      }
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function beginRename(session: SessionSearchResult): void {
    setRenameSession(session);
    setRenameValue(session.customTitle || session.displayTitle);
  }

  async function submitRename(): Promise<void> {
    if (!renameSession) return;
    const sessionKey = renameSession.sessionKey;
    try {
      await api.setCustomTitle(sessionKey, renameValue.trim() || null);
      setRenameSession(null);
      await load();
      if (detail?.sessionKey === sessionKey) {
        const fresh = await api.getSession(sessionKey);
        if (fresh) setDetail(fresh);
      }
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function updateTheme(next: ThemeMode): void {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setTheme(next);
  }

  function updateLanguage(next: LanguageMode): void {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    setLanguage(next);
  }

  async function updateDefaultTerminal(defaultTerminal: AppSettings["defaultTerminal"]): Promise<void> {
    setSettingsLoading(true);
    try {
      setAppSettings(await api.setSettings({ defaultTerminal }));
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSettingsLoading(false);
    }
  }

  return (
    <main className="app core-shell" data-theme={theme} data-platform={api.platform}>
      <div className="titlebar-drag" />
      <aside className="sidebar core-sidebar">
        <div className="brand">
          <div className="brand-mark"><Search size={17} /></div>
          <div>
            <h1>AgentRecall</h1>
            <p>{t("Claude + Codex sessions", "Claude + Codex 会话")}</p>
          </div>
        </div>

        <div className="filter-title">{t("Views", "视图")}</div>
        <nav className="nav-group">
          <button className={view === "all" ? "active" : ""} onClick={() => changeView("all")}>
            <Search size={14} />
            {t("All sessions", "全部会话")}
          </button>
          <button className={view === "favorites" ? "active" : ""} onClick={() => changeView("favorites")}>
            <Star size={14} />
            {t("Favorites", "收藏")}
          </button>
        </nav>

        <div className="filter-title">{t("Sources", "来源")}</div>
        <nav className="nav-group">
          {CORE_SOURCE_FILTERS.map((item) => (
            <button key={item.value} className={source === item.value ? "active" : ""} onClick={() => changeSource(item.value)}>
              {localize(language, item.en, item.zh)}
            </button>
          ))}
        </nav>

        <div className="filter-title">{t("Projects", "项目")}</div>
        <nav className="nav-group core-project-list">
          <button className={!project ? "active" : ""} onClick={() => changeProject(null)}>
            <Folder size={14} />
            {t("All projects", "全部项目")}
          </button>
          {projects.map((item) => (
            <button
              key={`${item.environmentId}:${item.path}`}
              className={project?.path === item.path && project.environmentId === item.environmentId ? "active" : ""}
              onClick={() => changeProject(item)}
              title={item.path}
            >
              <Folder size={14} />
              <span>{item.label}</span>
              <em>{item.sessionCount}</em>
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        <header className="toolbar core-toolbar">
          <SearchBox
            ref={searchRef}
            platform={api.platform}
            placeholder={project
              ? t(`Search in ${project.label}`, `在 ${project.label} 中搜索`)
              : t("Search sessions", "搜索会话")}
            recentLabel={t("Recent searches", "最近搜索")}
            clearRecentLabel={t("Clear", "清空")}
            deleteRecentLabel={t("Delete recent search", "删除最近搜索")}
            onSearch={(value) => {
              setQuery(value);
              setSessionLimit(INITIAL_SESSION_LIMIT);
            }}
          />
          <div className="toolbar-filters">
            <div className="date-filter" role="group" aria-label={t("Session time range", "会话时间范围")}>
              <CalendarDays size={14} aria-hidden="true" />
              {DATE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={dateRange === option.value ? "active" : ""}
                  onClick={() => changeDateRange(option.value)}
                  title={dateRangeLabel(option.value, language)}
                  aria-label={dateRangeLabel(option.value, language)}
                >
                  {dateRangeShortLabel(option.value, language)}
                </button>
              ))}
            </div>
          </div>
          <div className="top-actions">
            <button className="icon-button toolbar-icon-button" onClick={() => setInfoSection("settings")} title={t("Settings", "设置")} aria-label={t("Settings", "设置")}>
              <Settings size={15} />
            </button>
            <button className="icon-button toolbar-icon-button" onClick={() => setInfoSection("about")} title={t("About", "关于")} aria-label={t("About", "关于")}>
              <Info size={15} />
            </button>
            <button className="icon-button toolbar-icon-button" onClick={() => setInfoSection("diagnostics")} title={t("Diagnostics", "诊断")} aria-label={t("Diagnostics", "诊断")}>
              <Bug size={15} />
            </button>
          </div>
        </header>

        <div className="result-count">
          <span>
            {searchLoading
              ? t("Searching…", "搜索中…")
              : hasMoreSessions
                ? t(`${sessionTotalCount}+ core sessions shown`, `已显示 ${sessionTotalCount}+ 个核心会话`)
                : t(`${sessionTotalCount} sessions`, `${sessionTotalCount} 个会话`)}
          </span>
          {project ? <span className="selected-path">{project.path}</span> : null}
        </div>

        <div className="results">
          {searchError ? <div className="empty core-error">{searchError}</div> : null}
          {!searchError && results.map((session) => (
            <CoreSessionRow
              key={session.sessionKey}
              session={session}
              selected={selectedKey === session.sessionKey}
              language={language}
              onSelect={() => setSelectedKey(session.sessionKey)}
              onOpen={() => void openDetail(session)}
              onResume={() => void resumeSession(session)}
              onRename={() => beginRename(session)}
              onFavorite={() => void toggleFavorite(session)}
            />
          ))}
          {!searchLoading && !searchError && results.length === 0 ? <div className="empty">{t("No sessions found.", "没有找到会话。")}</div> : null}
          {hasMoreSessions ? (
            <button className="load-more-sessions" onClick={() => setSessionLimit((current) => current + SESSION_PAGE_SIZE)}>
              <ChevronDown size={14} />
              {t(`Load ${SESSION_PAGE_SIZE} more`, `再加载 ${SESSION_PAGE_SIZE} 个`)}
            </button>
          ) : null}
        </div>
      </section>

      {detail ? (
        <CoreSessionDetailAdapter
          session={detail}
          messages={messages}
          loading={detailLoading}
          olderMessageCount={messageOffset}
          actionStatus={actionStatus}
          language={language}
          onLoadOlder={loadOlderMessages}
          onClose={closeDetail}
          onResume={() => void resumeSession(detail)}
          onFavorite={() => void toggleFavorite(detail)}
          onRename={() => beginRename(detail)}
        />
      ) : null}

      {renameSession ? (
        <RenameDialog
          session={renameSession}
          value={renameValue}
          language={language}
          onChange={setRenameValue}
          onCancel={() => setRenameSession(null)}
          onSubmit={() => void submitRename()}
        />
      ) : null}

      {infoSection ? (
        <CoreInfoDialog
          initialSection={infoSection}
          language={language}
          platform={api.platform}
          theme={theme}
          sessionCount={sessionTotalCount}
          searchError={searchError}
          defaultTerminal={appSettings?.defaultTerminal ?? null}
          settingsLoading={settingsLoading}
          onLanguageChange={updateLanguage}
          onThemeChange={updateTheme}
          onDefaultTerminalChange={(terminal) => void updateDefaultTerminal(terminal)}
          onClose={() => setInfoSection(null)}
        />
      ) : null}

      {actionStatus && !detail ? (
        <div className={`action-toast ${actionStatus.kind}`} role="status">
          <span>{actionStatus.message}</span>
          <button className="action-toast-close" onClick={() => setActionStatus(null)} aria-label={t("Close", "关闭")}>
            <X size={14} />
          </button>
        </div>
      ) : null}
    </main>
  );
}
