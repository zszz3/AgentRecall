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
import type { ResumeRouteResult } from "../../core/resume-router";
import { terminalSelectOptions } from "../../core/terminal-options";
import type { SessionMessage } from "../../core/types";
import type { NativeUpdateState } from "../../distribution/native-update-types";
import type { PrivacyDiagnosticReport } from "../../privacy/diagnostics";
import type {
  CoreLegacyCleanupPreview,
  CoreProjectSummary,
  CoreSearchOptions,
  CoreSessionSearchResult,
  CoreSettings,
} from "../../shared/core-api";
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

const CORE_SOURCE_FILTERS: Array<{ value: CoreSearchOptions["source"]; en: string; zh: string }> = [
  { value: "all", en: "All sources", zh: "全部来源" },
  { value: "claude", en: "Claude", zh: "Claude" },
  { value: "codex", en: "Codex", zh: "Codex" },
];

function sourceLabel(source: CoreSessionSearchResult["source"]): string {
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
  session: CoreSessionSearchResult;
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
  session: CoreSessionSearchResult;
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
  defaultTerminal,
  autoCheckUpdates,
  settingsLoading,
  nativeUpdateState,
  updateBusy,
  diagnostics,
  diagnosticsLoading,
  cleanupPreview,
  onLanguageChange,
  onThemeChange,
  onDefaultTerminalChange,
  onAutoCheckUpdatesChange,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onRetryUpdate,
  onCopyUpdateDiagnostics,
  onOpenUpdateHelp,
  onOpenReleases,
  onRefreshDiagnostics,
  onPreviewCleanup,
  onApplyCleanup,
  onSectionChange,
  onClose,
}: {
  initialSection: CoreDialogSection;
  language: LanguageMode;
  platform: NodeJS.Platform;
  theme: ThemeMode;
  defaultTerminal: CoreSettings["defaultTerminal"] | null;
  autoCheckUpdates: boolean | null;
  settingsLoading: boolean;
  nativeUpdateState: NativeUpdateState | null;
  updateBusy: boolean;
  diagnostics: PrivacyDiagnosticReport | null;
  diagnosticsLoading: boolean;
  cleanupPreview: CoreLegacyCleanupPreview | null;
  onLanguageChange: (language: LanguageMode) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onDefaultTerminalChange: (terminal: CoreSettings["defaultTerminal"]) => void;
  onAutoCheckUpdatesChange: (enabled: boolean) => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onRetryUpdate: () => void;
  onCopyUpdateDiagnostics: () => void;
  onOpenUpdateHelp: () => void;
  onOpenReleases: () => void;
  onRefreshDiagnostics: () => void;
  onPreviewCleanup: () => void;
  onApplyCleanup: () => void;
  onSectionChange: (section: CoreDialogSection) => void;
  onClose: () => void;
}): ReactElement {
  const section = initialSection;
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
              <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => onSectionChange(item.id)}>
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
                    onChange={(event) => onDefaultTerminalChange(event.target.value as CoreSettings["defaultTerminal"])}
                  >
                    {!defaultTerminal ? <option value="">{t("Loading…", "加载中…")}</option> : null}
                    {terminalSelectOptions(platform).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="core-setting-row">
                  <span>{t("Automatic update checks", "自动检查更新")}</span>
                  <input
                    type="checkbox"
                    checked={autoCheckUpdates ?? false}
                    disabled={settingsLoading}
                    onChange={(event) => onAutoCheckUpdatesChange(event.target.checked)}
                    data-setting="auto-check-updates"
                  />
                </label>
                <div className="core-update-panel">
                  <h3>{t("Native updates", "原生更新")}</h3>
                  <p>
                    {t("Status", "状态")}: {nativeUpdateState?.phase ?? t("Loading…", "加载中…")}
                    {nativeUpdateState?.targetVersion ? ` · ${nativeUpdateState.targetVersion}` : ""}
                  </p>
                  {nativeUpdateState?.progressPercent != null ? (
                    <p>{Math.round(nativeUpdateState.progressPercent)}%</p>
                  ) : null}
                  {nativeUpdateState?.failure ? (
                    <p className="error">{nativeUpdateState.failure.message}</p>
                  ) : null}
                  <div className="dialog-actions">
                    <button type="button" onClick={onCheckUpdate} disabled={updateBusy}>
                      {t("Check", "检查")}
                    </button>
                    {nativeUpdateState?.phase === "available" ? (
                      <button type="button" onClick={onDownloadUpdate} disabled={updateBusy}>
                        {t("Download", "下载")}
                      </button>
                    ) : null}
                    {nativeUpdateState?.phase === "downloaded" ? (
                      <button type="button" onClick={onInstallUpdate} disabled={updateBusy}>
                        {t("Install", "安装")}
                      </button>
                    ) : null}
                    {nativeUpdateState?.failure?.retryable ? (
                      <button type="button" onClick={onRetryUpdate} disabled={updateBusy}>
                        {t("Retry", "重试")}
                      </button>
                    ) : null}
                    {nativeUpdateState?.failure ? (
                      <>
                        <button type="button" onClick={onCopyUpdateDiagnostics}>
                          {t("Copy diagnostics", "复制诊断")}
                        </button>
                        <button type="button" onClick={onOpenUpdateHelp}>
                          {t("Report update failure", "报告更新失败")}
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={onOpenReleases}>
                      {t("Releases", "发布页面")}
                    </button>
                  </div>
                </div>
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
                {diagnosticsLoading && !diagnostics ? <p>{t("Collecting local diagnostics…", "正在收集本地诊断…")}</p> : null}
                {diagnostics ? (
                  <>
                    <dl>
                      <div><dt>{t("Platform", "平台")}</dt><dd>{diagnostics.system.platform} / {diagnostics.system.arch}</dd></div>
                      <div><dt>{t("Core sessions", "核心会话")}</dt><dd>{diagnostics.sessions.total}</dd></div>
                      <div><dt>{t("Database", "数据库")}</dt><dd>{diagnostics.storage.database.status}</dd></div>
                      <div><dt>{t("Updates", "更新")}</dt><dd>{diagnostics.update.status}</dd></div>
                      <div><dt>{t("Legacy integrations", "遗留集成")}</dt><dd>{diagnostics.legacyIntegrations.findingCount}</dd></div>
                    </dl>
                    <div className="dialog-actions">
                      <button type="button" onClick={onRefreshDiagnostics} disabled={diagnosticsLoading}>
                        {t("Refresh diagnostics", "刷新诊断")}
                      </button>
                      <button type="button" onClick={onPreviewCleanup} disabled={diagnosticsLoading}>
                        {t("Preview legacy cleanup", "预览遗留清理")}
                      </button>
                    </div>
                    {cleanupPreview ? (
                      <div className="core-cleanup-preview">
                        <h3>{t("Review before cleanup", "清理前请核对")}</h3>
                        <p>{t("Backup", "备份")}: {cleanupPreview.backupLocation}</p>
                        {cleanupPreview.actions.length === 0 ? (
                          <p>{t("No AgentRecall-owned legacy entries were found.", "未发现 AgentRecall 自有遗留项。")}</p>
                        ) : (
                          <ul>
                            {cleanupPreview.actions.map((action) => (
                              <li key={action.filePath}>{action.filePath}: {action.description}</li>
                            ))}
                          </ul>
                        )}
                        {cleanupPreview.actions.length > 0 ? (
                          <button type="button" className="danger" onClick={onApplyCleanup}>
                            {t("Confirm cleanup…", "确认清理…")}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <button type="button" onClick={onRefreshDiagnostics} disabled={diagnosticsLoading}>
                    {t("Collect diagnostics", "收集诊断")}
                  </button>
                )}
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
  const [source, setSource] = useState<CoreSearchOptions["source"]>("all");
  const [project, setProject] = useState<CoreProjectSummary | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
  const [view, setView] = useState<CoreView>("all");
  const [sessionLimit, setSessionLimit] = useState(INITIAL_SESSION_LIMIT);
  const [results, setResults] = useState<CoreSessionSearchResult[]>([]);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [projects, setProjects] = useState<CoreProjectSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CoreSessionSearchResult | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>(null);
  const [renameSession, setRenameSession] = useState<CoreSessionSearchResult | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [infoSection, setInfoSection] = useState<CoreDialogSection | null>(null);
  const [appSettings, setAppSettings] = useState<CoreSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [nativeUpdateState, setNativeUpdateState] = useState<NativeUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PrivacyDiagnosticReport | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<CoreLegacyCleanupPreview | null>(null);
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
    const options: CoreSearchOptions = {
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
      setResults(page.sessions);
      setSessionTotalCount(page.totalCount);
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
    const offNativeUpdate = api.onNativeUpdateState(setNativeUpdateState);
    return () => {
      offFocusSearch();
      offOpenSettings();
      offNativeUpdate();
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
    if (infoSection !== "settings") return;
    let active = true;
    void api
      .getNativeUpdateState()
      .then((state) => {
        if (active) setNativeUpdateState(state);
      })
      .catch((error) => {
        if (active) setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [api, infoSection]);

  useEffect(() => {
    if (infoSection === "diagnostics" && !diagnostics) {
      void refreshDiagnostics();
    }
  }, [diagnostics, infoSection]);

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

  function changeSource(next: CoreSearchOptions["source"]): void {
    setSource(next);
    setSessionLimit(INITIAL_SESSION_LIMIT);
  }

  function changeProject(next: CoreProjectSummary | null): void {
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

  async function openDetail(session: CoreSessionSearchResult): Promise<void> {
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

  async function resumeSession(session: CoreSessionSearchResult): Promise<void> {
    if (!supportsResumeSource(session.source)) return;
    setActionStatus({ kind: "running", message: t("Opening session…", "正在打开会话…") });
    try {
      const route = await api.resumeSession(session.sessionKey);
      setActionStatus({ kind: "success", message: resumeSuccessMessage(route, language) });
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function toggleFavorite(session: CoreSessionSearchResult): Promise<void> {
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

  function beginRename(session: CoreSessionSearchResult): void {
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

  async function updateDefaultTerminal(defaultTerminal: CoreSettings["defaultTerminal"]): Promise<void> {
    setSettingsLoading(true);
    try {
      setAppSettings(await api.setSettings({ defaultTerminal }));
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSettingsLoading(false);
    }
  }

  async function updateAutoCheckUpdates(autoCheckUpdates: boolean): Promise<void> {
    setSettingsLoading(true);
    try {
      setAppSettings(await api.setSettings({ autoCheckUpdates }));
      setNativeUpdateState(await api.getNativeUpdateState());
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSettingsLoading(false);
    }
  }

  async function runNativeUpdateAction(
    action: () => Promise<NativeUpdateState>,
  ): Promise<void> {
    setUpdateBusy(true);
    try {
      setNativeUpdateState(await action());
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setUpdateBusy(false);
    }
  }

  async function refreshDiagnostics(): Promise<void> {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await api.getPrivacyDiagnostics());
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function previewLegacyCleanup(): Promise<void> {
    setDiagnosticsLoading(true);
    try {
      setCleanupPreview(await api.previewLegacyCleanup());
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function applyConfirmedLegacyCleanup(): Promise<void> {
    if (!cleanupPreview) return;
    const confirmed = window.confirm(t(
      "Backups will be created before removing only the listed AgentRecall entries. Continue?",
      "将先创建备份，再仅移除上方列出的 AgentRecall 项。是否继续？",
    ));
    if (!confirmed) return;
    setDiagnosticsLoading(true);
    try {
      const result = await api.applyLegacyCleanup(cleanupPreview.planId, true);
      setCleanupPreview(null);
      setActionStatus({
        kind: "success",
        message: t(
          `Cleaned ${result.changedFiles.length} legacy configuration files.`,
          `已清理 ${result.changedFiles.length} 个遗留配置文件。`,
        ),
      });
      setDiagnostics(await api.getPrivacyDiagnostics());
    } catch (error) {
      setActionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiagnosticsLoading(false);
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
                ? t(
                    `${results.length} of ${sessionTotalCount} sessions`,
                    `${results.length} / ${sessionTotalCount} 个会话`,
                  )
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
          defaultTerminal={appSettings?.defaultTerminal ?? null}
          autoCheckUpdates={appSettings?.autoCheckUpdates ?? null}
          settingsLoading={settingsLoading}
          nativeUpdateState={nativeUpdateState}
          updateBusy={updateBusy}
          diagnostics={diagnostics}
          diagnosticsLoading={diagnosticsLoading}
          cleanupPreview={cleanupPreview}
          onLanguageChange={updateLanguage}
          onThemeChange={updateTheme}
          onDefaultTerminalChange={(terminal) => void updateDefaultTerminal(terminal)}
          onAutoCheckUpdatesChange={(enabled) => void updateAutoCheckUpdates(enabled)}
          onCheckUpdate={() => void runNativeUpdateAction(api.checkNativeUpdate)}
          onDownloadUpdate={() => void runNativeUpdateAction(api.downloadNativeUpdate)}
          onInstallUpdate={() => void runNativeUpdateAction(api.installNativeUpdate)}
          onRetryUpdate={() => void runNativeUpdateAction(api.retryNativeUpdate)}
          onCopyUpdateDiagnostics={() => void runNativeUpdateAction(api.copyNativeUpdateDiagnostics)}
          onOpenUpdateHelp={() => void runNativeUpdateAction(api.openNativeUpdateHelp)}
          onOpenReleases={() => void runNativeUpdateAction(api.openNativeUpdateReleases)}
          onRefreshDiagnostics={() => void refreshDiagnostics()}
          onPreviewCleanup={() => void previewLegacyCleanup()}
          onApplyCleanup={() => void applyConfirmedLegacyCleanup()}
          onSectionChange={setInfoSection}
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
