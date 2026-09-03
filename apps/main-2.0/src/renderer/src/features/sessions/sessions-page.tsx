import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import {
  ArrowRightLeft,
  Bookmark,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cloud,
  EyeOff,
  Folder,
  GitBranch,
  Laptop,
  Layers,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { IndexStatus } from "../../../../core/indexer";
import { formatRelativeTime } from "../../../../core/format-session";
import type {
  ProjectSummary,
  SearchOptions,
  SessionDailyTokenUsage,
  SessionEnvironment,
  SessionMatchHit,
  SessionSearchResult,
  SessionSortBy,
} from "../../../../core/types";
import type { SavedSearch } from "../../../../core/store/saved-searches";
import {
  DATE_RANGE_OPTIONS,
  dateRangeLabel,
  dateRangeShortLabel,
  type DateRangeFilter,
} from "../../date-range";
import {
  getLiveSessionState,
  type LiveStatusFilter,
} from "../../live-filter";
import type { SidebarSectionId, SidebarSectionsState } from "../../sidebar-sections";
import type { LanguageMode } from "../../language";
import { environmentTarget } from "../environments/environment-display";
import { SearchBox } from "../search/search-box";
import { GroupedResults } from "../search/grouped-results";
import { GROUP_MODES, type GroupMode } from "../search/group-logic";
import { QueryBuilder } from "../search/query-builder";
import {
  countActiveFilters,
  toSearchOptionsPatch,
  type QueryBuilderState,
} from "../search/query-builder-types";
import { SavedSearchesPanel } from "../search/saved-searches-panel";
import {
  displayTagName,
  isBranchTag,
  liveStatusFilterLabel,
  projectSortTimestamp,
  sourceFilterLabel,
} from "../../session-ui";

const LIVE_STATUS_FILTERS: LiveStatusFilter[] = ["all", "open", "closed"];
const SIDEBAR_PROJECT_PAGE_SIZE = 30;

export interface SessionSidebarGroup {
  environment: SessionEnvironment | null;
  projects: Array<ProjectSummary & { tags: string[] }>;
}

export interface SessionScopeFilter {
  key: string;
  label: string;
  title: string;
  prefix?: ReactNode;
  onClear(): void;
}

export interface SessionsPageModel {
  language: LanguageMode;
  indexStatus: IndexStatus | null;
  sessionTotalCount: number;
  sidebarSections: SidebarSectionsState;
  environmentId: string | "all";
  projectPath?: string;
  projectEnvironmentId?: string;
  tag?: string;
  tags: string[];
  sidebarTree: SessionSidebarGroup[];
  collapsedProjectGroups: Set<string>;
  expandedTreeProjects: Set<string>;
  source: SearchOptions["source"];
  origin: NonNullable<SearchOptions["origin"]>;
  originCounts: { ordinary: number; agentRecall: number; all: number };
  sourceFilters: Array<{ label: string; value: SearchOptions["source"] }>;
  visibility: "default" | "favorites" | "hidden";
  searchRef: RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  query: string;
  activeScopeFilters: SessionScopeFilter[];
  liveStatus: LiveStatusFilter;
  customDateRange: Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive"> | null;
  dateRange: DateRangeFilter;
  sortBy: SessionSortBy;
  aiAssistantOpen: boolean;
  remoteSessionsOpen: boolean;
  selected: SessionSearchResult | null;
  sessions: SessionSearchResult[];
  currentPage: number;
  totalPages: number;
  liveSessionKeys: Set<string>;
  liveDetectionFailed: boolean;
  bulkSelectionActive: boolean;
  bulkSelectedKeys: Set<string>;
}

export interface SessionsPageActions {
  refresh(): void;
  toggleSidebarSection(section: SidebarSectionId): void;
  selectAllSessions(): void;
  toggleEnvironment(environmentId: string): void;
  selectEnvironment(environmentId: string): void;
  toggleProject(projectKey: string): void;
  selectProject(project: ProjectSummary): void;
  toggleProjectTag(project: ProjectSummary, tagName: string): void;
  deleteTag(tagName: string): void;
  setSource(source: SearchOptions["source"]): void;
  setOrigin(origin: NonNullable<SearchOptions["origin"]>): void;
  setTag(tag: string | undefined): void;
  setVisibility(visibility: SessionsPageModel["visibility"]): void;
  search(query: string): void;
  setLiveStatus(status: LiveStatusFilter): void;
  clearCustomDateRange(): void;
  setCustomDateRange(range: Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">): void;
  setDateRange(range: DateRangeFilter): void;
  setSortBy(sortBy: SessionSortBy): void;
  openAiAssistant(): void;
  openRemoteSessions(): void;
  selectSession(sessionKey: string): void;
  openSession(session: SessionSearchResult): void;
  openMatch(session: SessionSearchResult, hit: SessionMatchHit): void;
  renameSession(session: SessionSearchResult): void;
  toggleFavorite(session: SessionSearchResult): void;
  openContextMenu(event: ReactMouseEvent, session: SessionSearchResult): void;
  goToPage(page: number): void;
  toggleBulkSession(sessionKey: string): void;
  toggleLoadedSelection(): void;
  exitBulkSelection(): void;
  selectAllMatching(): void;
  deleteSelected(): void;
  openDateCleanup(): void;
  openOrphanCleanup(): void;
}

export function SessionsPage({
  model,
  actions,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
}): ReactElement {
  const [hoveredScopeFilter, setHoveredScopeFilter] = useState<string | null>(null);
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const l = (en: string, zh: string): string => model.language === "zh" ? zh : en;
  const queryBuilderState = useMemo<QueryBuilderState>(() => ({
    source: model.source === "all" ? undefined : model.source,
    tag: model.tag,
    visibility: model.visibility,
    dateRange: model.customDateRange ? "all" : model.dateRange,
  }), [model.customDateRange, model.dateRange, model.source, model.tag, model.visibility]);
  const activeFilterCount = countActiveFilters(queryBuilderState);

  const loadSavedSearches = useCallback(async (): Promise<void> => {
    try {
      setSavedSearches(await window.sessionSearch.listSavedSearches());
    } catch {
      setSavedSearches([]);
    }
  }, []);

  useEffect(() => {
    if (savedSearchesOpen) void loadSavedSearches();
  }, [loadSavedSearches, savedSearchesOpen]);

  function applyQueryBuilder(state: QueryBuilderState): void {
    actions.setSource(state.source ?? "all");
    actions.setTag(state.tag);
    actions.setVisibility(state.visibility);
    actions.setDateRange(state.dateRange);
    setQueryBuilderOpen(false);
  }

  function saveCurrentSearch(name: string, state: QueryBuilderState): void {
    void window.sessionSearch
      .createSavedSearch(name, { query: model.query, ...toSearchOptionsPatch(state) })
      .then(loadSavedSearches)
      .catch(() => undefined);
  }

  function applySavedSearch(saved: SavedSearch): void {
    if (saved.options.query !== undefined) actions.search(saved.options.query);
    actions.setSource(saved.options.source ?? "all");
    actions.setTag(saved.options.tag);
    actions.setVisibility(saved.options.visibility ?? "default");
    if (Number.isFinite(saved.options.dateFrom) && Number.isFinite(saved.options.dateTo)) {
      actions.setCustomDateRange({
        dayStart: saved.options.dateFrom as number,
        dayEndExclusive: (saved.options.dateTo as number) + 1,
      });
    } else {
      actions.setDateRange("all");
    }
    void window.sessionSearch.touchSavedSearch(saved.id).catch(() => undefined);
    setSavedSearchesOpen(false);
  }

  function deleteSavedSearch(id: number): void {
    void window.sessionSearch.deleteSavedSearch(id).then(loadSavedSearches).catch(() => undefined);
  }

  function cycleGroupMode(): void {
    setGroupMode((current) => {
      const currentIndex = GROUP_MODES.indexOf(current);
      return GROUP_MODES[(currentIndex + 1) % GROUP_MODES.length];
    });
  }

  return (
    <div className="sessions-page" data-page="sessions">
      <header className="app-page-head sessions-page-head">
        <div>
          <h2>Session</h2>
          <p>{l(
            "Search, filter, and continue local or remote Agent sessions.",
            "搜索、筛选并继续本地或远程 Agent 会话。",
          )}</p>
        </div>
        <button
          type="button"
          className={`sessions-page-refresh ${model.indexStatus?.running ? "is-running" : ""}`}
          onClick={actions.refresh}
          disabled={model.indexStatus?.running}
          title={model.indexStatus?.lastIndexedAt
            ? `${l("Update index", "更新索引")} · ${formatRelativeTime(model.indexStatus.lastIndexedAt, model.language)}`
            : l("Update index", "更新索引")}
          aria-label={model.indexStatus?.running
            ? l("Updating index", "正在更新索引")
            : l("Update index", "更新索引")}
        >
          <RefreshCw size={14} />
          <span>{model.indexStatus?.running
            ? l("Updating...", "更新中...")
            : l("Update index", "更新索引")}</span>
        </button>
      </header>

      <SessionSidebar model={model} actions={actions} l={l} />

      <section className="content">
        <header className="toolbar">
          <div className="toolbar-primary">
            <SearchBox
              platform={window.sessionSearch.platform}
              ref={model.searchRef}
              placeholder={model.searchPlaceholder}
              recentLabel={l("Recent searches", "最近搜索")}
              clearRecentLabel={l("Clear", "清空")}
              deleteRecentLabel={l("Delete recent search", "删除最近搜索")}
              submittedValue={model.query}
              onSearch={actions.search}
            />
            <div className="toolbar-discovery" role="group" aria-label={l("Search tools", "搜索工具")}>
              <button
                className={`icon-button toolbar-icon-button ${queryBuilderOpen ? "active" : ""}`}
                onClick={() => {
                  setSavedSearchesOpen(false);
                  setQueryBuilderOpen((value) => !value);
                }}
                title={l("Advanced search", "高级搜索")}
                aria-label={l("Advanced search", "高级搜索")}
              >
                <SlidersHorizontal size={15} />
                {activeFilterCount > 0
                  ? <span className="toolbar-badge">{activeFilterCount}</span>
                  : null}
              </button>
              <button
                className={`icon-button toolbar-icon-button ${savedSearchesOpen ? "active" : ""}`}
                onClick={() => {
                  setQueryBuilderOpen(false);
                  setSavedSearchesOpen((value) => !value);
                }}
                title={l("Saved searches", "保存的搜索")}
                aria-label={l("Saved searches", "保存的搜索")}
              >
                <Bookmark size={15} />
              </button>
              <button
                className={`icon-button toolbar-icon-button ${groupMode !== "flat" ? "active" : ""}`}
                onClick={cycleGroupMode}
                title={l("Group results", "分组展示")}
                aria-label={l("Group results", "分组展示")}
              >
                <Layers size={15} />
              </button>
            </div>
          </div>
          <div className="toolbar-secondary">
            <div className="toolbar-filters">
            {model.activeScopeFilters.length ? (
              <div
                className="scope-filter"
                data-count={model.activeScopeFilters.length}
                aria-label={l("Active search scope", "当前搜索范围")}
              >
                {model.activeScopeFilters.map((filter) => (
                  <button
                    key={filter.key}
                    className="scope-filter-chip"
                    onClick={filter.onClear}
                    title={filter.title}
                    onMouseEnter={() => setHoveredScopeFilter(filter.key)}
                    onMouseLeave={() => setHoveredScopeFilter((current) =>
                      current === filter.key ? null : current)}
                    aria-describedby={hoveredScopeFilter === filter.key
                      ? "scope-filter-tooltip"
                      : undefined}
                  >
                    <span className="scope-filter-label">
                      {filter.prefix
                        ? <span className="scope-filter-prefix">{filter.prefix}</span>
                        : null}
                      <span>{filter.label}</span>
                    </span>
                    <span className="scope-filter-clear" aria-hidden="true">×</span>
                    {hoveredScopeFilter === filter.key ? (
                      <span
                        id="scope-filter-tooltip"
                        className="scope-filter-tooltip"
                        role="tooltip"
                      >
                        {filter.title}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="live-filter" role="group" aria-label="Live session status">
              {LIVE_STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  className={model.liveStatus === status ? "active" : ""}
                  onClick={() => actions.setLiveStatus(status)}
                >
                  {liveStatusFilterLabel(status, model.language)}
                </button>
              ))}
            </div>
            <div
              className="date-filter"
              role="group"
              aria-label={l("Session time range", "会话时间范围")}
            >
              <CalendarDays size={14} aria-hidden="true" />
              {model.customDateRange ? (
                <button
                  className="date-filter-custom active"
                  onClick={actions.clearCustomDateRange}
                  title={l("Clear exact date filter", "清除精确日期筛选")}
                  aria-label={l("Clear exact date filter", "清除精确日期筛选")}
                >
                  <span>{exactDateRangeLabel(model.customDateRange, model.language)}</span>
                  <b aria-hidden="true">×</b>
                </button>
              ) : null}
              {DATE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={!model.customDateRange && model.dateRange === option.value
                    ? "active"
                    : ""}
                  onClick={() => actions.setDateRange(option.value)}
                  title={dateRangeLabel(option.value, model.language)}
                  aria-label={dateRangeLabel(option.value, model.language)}
                >
                  {dateRangeShortLabel(option.value, model.language)}
                </button>
              ))}
            </div>
            <div className="sort-filter" role="group" aria-label={l("Sort order", "排序方式")}>
              <ArrowRightLeft size={14} aria-hidden="true" />
              <button
                className={model.sortBy === "smart" ? "active" : ""}
                onClick={() => actions.setSortBy("smart")}
                title={l("Smart: relevance + recency", "智能：相关性 + 时间")}
              >
                {l("Smart", "智能")}
              </button>
              <button
                className={model.sortBy === "activity" ? "active" : ""}
                onClick={() => actions.setSortBy("activity")}
                title={l("Most recent first", "最近活跃优先")}
              >
                {l("Recent", "最新")}
              </button>
              <button
                className={model.sortBy === "created" ? "active" : ""}
                onClick={() => actions.setSortBy("created")}
                title={l("Oldest first", "最早创建优先")}
              >
                {l("Oldest", "最早")}
              </button>
            </div>
            </div>
            <div className="top-actions">
              <button
                className={`icon-button toolbar-icon-button ${model.aiAssistantOpen ? "active" : ""}`}
                onClick={actions.openAiAssistant}
                title={l("AI session finder", "AI 找会话")}
                aria-label={l("AI session finder", "AI 找会话")}
              >
                <Sparkles size={15} />
              </button>
              <button
                className={`icon-button toolbar-icon-button ${model.remoteSessionsOpen ? "active" : ""}`}
                onClick={actions.openRemoteSessions}
                title={l("Remote sessions", "远程会话")}
                aria-label={l("Remote sessions", "远程会话")}
              >
                <Cloud size={15} />
              </button>
            </div>
          </div>
        </header>

        {queryBuilderOpen ? (
          <QueryBuilder
            initial={queryBuilderState}
            sourceOptions={model.sourceFilters.filter((option) => option.value !== "all")}
            tagOptions={model.tags}
            language={model.language}
            onApply={applyQueryBuilder}
            onClose={() => setQueryBuilderOpen(false)}
            onSaveSearch={saveCurrentSearch}
          />
        ) : null}

        {savedSearchesOpen ? (
          <SavedSearchesPanel
            savedSearches={savedSearches}
            language={model.language}
            onApply={applySavedSearch}
            onDelete={deleteSavedSearch}
            onClose={() => setSavedSearchesOpen(false)}
          />
        ) : null}

        <div className="result-count">
          <div className="bulk-result-actions">
            <div className="live-filter session-origin-filter" role="group" aria-label={l("Session origin", "会话来源") }>
              <button
                type="button"
                className={model.origin === "ordinary" ? "active" : ""}
                onClick={() => actions.setOrigin("ordinary")}
              >
                {l(`Regular (${model.originCounts.ordinary})`, `普通会话 (${model.originCounts.ordinary})`)}
              </button>
              <button
                type="button"
                className={model.origin === "agentrecall" ? "active" : ""}
                aria-expanded={model.origin === "agentrecall"}
                onClick={() => actions.setOrigin(model.origin === "agentrecall" ? "ordinary" : "agentrecall")}
              >
                {l(`AgentRecall calls (${model.originCounts.agentRecall})`, `AgentRecall 调用 (${model.originCounts.agentRecall})`)}
              </button>
              <button
                type="button"
                className={model.origin === "all" ? "active" : ""}
                onClick={() => actions.setOrigin("all")}
              >
                {l(`All (${model.originCounts.all})`, `全部 (${model.originCounts.all})`)}
              </button>
            </div>
            {model.bulkSelectionActive ? <input
              type="checkbox"
              checked={model.sessions.length > 0 && model.sessions.every((session) => model.bulkSelectedKeys.has(session.sessionKey))}
              onChange={actions.toggleLoadedSelection}
              aria-label={l("Select loaded sessions", "选择已加载会话")}
            /> : null}
            <span>{l(
            `${model.sessionTotalCount} sessions`,
            `${model.sessionTotalCount} 个会话`,
            )}</span>
            {model.bulkSelectionActive ? <strong>{l(`${model.bulkSelectedKeys.size} selected`, `已选 ${model.bulkSelectedKeys.size} 个`)}</strong> : null}
            {model.bulkSelectionActive && model.bulkSelectedKeys.size > 0 && model.bulkSelectedKeys.size < model.sessionTotalCount ? (
              <button type="button" onClick={actions.selectAllMatching}>{l(`Select all ${model.sessionTotalCount}`, `选择全部 ${model.sessionTotalCount} 个`)}</button>
            ) : null}
            {model.bulkSelectionActive && model.bulkSelectedKeys.size > 0 ? (
              <button type="button" className="bulk-delete-button" onClick={actions.deleteSelected}><Trash2 size={13} />{l("Delete", "删除")}</button>
            ) : null}
            {model.bulkSelectionActive ? (
              <button type="button" onClick={actions.exitBulkSelection} title={l("Exit multi-select", "退出多选")} aria-label={l("Exit multi-select", "退出多选")}><X size={13} /></button>
            ) : null}
            <button type="button" onClick={actions.openDateCleanup}><CalendarDays size={13} />{l("Clean up", "按日期清理")}</button>
            <button type="button" onClick={actions.openOrphanCleanup}><Trash2 size={13} />{l("Leftover Subagent Chats", "清理残留子对话")}</button>
          </div>
          {model.selected
            ? <span className="selected-path">
                {model.selected.projectPath || model.selected.rawId}
              </span>
            : null}
        </div>

        <div key={model.currentPage} className="results">
          <GroupedResults
            sessions={model.sessions}
            groupMode={groupMode}
            sortBy={model.sortBy}
            selectedKey={model.selected?.sessionKey ?? null}
            liveStateFor={(session) => getLiveSessionState(
              session,
              model.liveSessionKeys,
              model.liveDetectionFailed,
            )}
            language={model.language}
            onOpenMatch={actions.openMatch}
            onSelect={actions.selectSession}
            onOpen={actions.openSession}
            onRename={actions.renameSession}
            onFavorite={actions.toggleFavorite}
            onContextMenu={actions.openContextMenu}
            bulkSelectionActive={model.bulkSelectionActive}
            bulkSelectedKeys={model.bulkSelectedKeys}
            onToggleBulk={actions.toggleBulkSession}
          />
          {model.sessions.length === 0
            ? <div className="empty">{l("No sessions found.", "没有找到会话。")}</div>
            : null}
        </div>
        {model.totalPages > 1 ? (
          <nav className="session-pagination" aria-label={l("Session pages", "会话分页")}>
            <button type="button" className="pagination-button" onClick={() => actions.goToPage(1)} disabled={model.currentPage === 1} title={l("First page", "第一页")} aria-label={l("First page", "第一页")}><ChevronsLeft size={14} /></button>
            <button type="button" className="pagination-button" onClick={() => actions.goToPage(model.currentPage - 1)} disabled={model.currentPage === 1} title={l("Previous page", "上一页")} aria-label={l("Previous page", "上一页")}><ChevronLeft size={14} /></button>
            <div className="pagination-pages">
              {paginationItems(model.currentPage, model.totalPages).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`pagination-button ${item === model.currentPage ? "active" : ""}`}
                  data-page={item}
                  aria-current={item === model.currentPage ? "page" : undefined}
                  aria-label={l(`Page ${item}`, `第 ${item} 页`)}
                  onClick={() => actions.goToPage(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <button type="button" className="pagination-button" onClick={() => actions.goToPage(model.currentPage + 1)} disabled={model.currentPage === model.totalPages} title={l("Next page", "下一页")} aria-label={l("Next page", "下一页")}><ChevronRight size={14} /></button>
            <button type="button" className="pagination-button" onClick={() => actions.goToPage(model.totalPages)} disabled={model.currentPage === model.totalPages} title={l("Last page", "最后一页")} aria-label={l("Last page", "最后一页")}><ChevronsRight size={14} /></button>
            <form className="pagination-jump" onSubmit={(event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("page")); if (Number.isInteger(value)) actions.goToPage(Math.min(model.totalPages, Math.max(1, value))); }}>
              <input key={`${model.currentPage}-${model.totalPages}`} name="page" type="number" min={1} max={model.totalPages} defaultValue={model.currentPage} aria-label={l("Page number", "页码")} />
              <span>/ {model.totalPages}</span>
              <button type="submit">{l("Go", "跳转")}</button>
            </form>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

function paginationItems(currentPage: number, totalPages: number): number[] {
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);
  return Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
}

function exactDateRangeLabel(
  range: Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive">,
  language: LanguageMode,
): string {
  const start = new Date(range.dayStart);
  const end = new Date(Math.max(range.dayStart, range.dayEndExclusive - 1));
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const sameDay = start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate();
  const formatter = new Intl.DateTimeFormat(locale, {
    ...(start.getFullYear() === end.getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  });
  return sameDay ? formatter.format(start) : `${formatter.format(start)} – ${formatter.format(end)}`;
}

function SessionSidebar({
  model,
  actions,
  l,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
  l(en: string, zh: string): string;
}): ReactElement {
  const [visibleProjectCounts, setVisibleProjectCounts] = useState<Record<string, number>>({});

  return (
    <section className="sidebar">
      <div className="session-sidebar-title">
        <strong>{l("Session scope", "会话范围")}</strong>
        <span>{model.sessionTotalCount}</span>
      </div>
      <SidebarSectionHeader
        title={l("Environments", "环境")}
        expanded={model.sidebarSections.environments}
        onToggle={() => actions.toggleSidebarSection("environments")}
      />
      {model.sidebarSections.environments ? (
        <nav className="sidebar-tree">
          <button
            className={`tree-row tree-root ${
              model.environmentId === "all" && !model.projectPath && !model.tag ? "active" : ""
            }`}
            onClick={actions.selectAllSessions}
          >
            <span>{l("All Sessions", "全部会话")}</span>
          </button>
          {model.sidebarTree.map((group) => {
            const groupId = group.projects[0]?.environmentId ?? "unknown";
            const environmentCollapsed = model.collapsedProjectGroups.has(groupId);
            const environmentActive =
              model.environmentId === groupId && !model.projectPath && !model.tag;
            const visibleProjectCount = visibleProjectCounts[groupId] ?? SIDEBAR_PROJECT_PAGE_SIZE;
            const visibleProjects = group.projects.slice(0, visibleProjectCount);
            const selectedProject = group.projects.find((project) =>
              project.path === model.projectPath
              && project.environmentId === model.projectEnvironmentId);
            if (selectedProject && !visibleProjects.includes(selectedProject)) visibleProjects.push(selectedProject);
            // Subtract the projects actually rendered (which includes a selected project pulled
            // in from beyond the page), not just the page size, so "Show more" never overcounts.
            const hiddenProjectCount = Math.max(0, group.projects.length - visibleProjects.length);
            const nextProjectCount = Math.min(SIDEBAR_PROJECT_PAGE_SIZE, hiddenProjectCount);
            return (
              <div key={groupId} className="tree-group">
                <div className="tree-row tree-env-row">
                  <button
                    className="tree-chevron"
                    onClick={() => actions.toggleEnvironment(groupId)}
                    aria-expanded={!environmentCollapsed}
                    aria-label={environmentCollapsed ? l("Expand", "展开") : l("Collapse", "折叠")}
                  >
                    {environmentCollapsed
                      ? <ChevronRight size={13} />
                      : <ChevronDown size={13} />}
                  </button>
                  <button
                    className={`tree-label ${environmentActive ? "active" : ""}`}
                    onClick={() => actions.selectEnvironment(groupId)}
                    title={group.environment
                      ? environmentTarget(group.environment, model.language)
                      : l("Unknown", "未知")}
                  >
                    {group.environment?.kind === "local"
                      ? <Laptop size={13} />
                      : <Server size={13} />}
                    <span>{group.environment?.label ?? l("Unknown", "未知")}</span>
                    <em className="tree-count">{group.projects.length}</em>
                  </button>
                </div>
                {!environmentCollapsed
                  ? visibleProjects.map((project) => {
                      const projectKey = `${project.environmentId}:${project.path}`;
                      const expanded = model.expandedTreeProjects.has(projectKey);
                      const active =
                        model.projectPath === project.path
                        && model.projectEnvironmentId === project.environmentId
                        && !model.tag;
                      return (
                        <div key={projectKey} className="tree-group">
                          <div className="tree-row tree-proj-row">
                            {project.tags.length > 0 ? (
                              <button
                                className="tree-chevron"
                                onClick={() => actions.toggleProject(projectKey)}
                                aria-expanded={expanded}
                                aria-label={expanded ? l("Collapse", "折叠") : l("Expand", "展开")}
                              >
                                {expanded
                                  ? <ChevronDown size={13} />
                                  : <ChevronRight size={13} />}
                              </button>
                            ) : <span className="tree-chevron-spacer" />}
                            <button
                              className={`tree-label ${active ? "active" : ""}`}
                              onClick={() => actions.selectProject(project)}
                              title={project.path}
                            >
                              <Folder size={13} />
                              <span>{project.label}</span>
                              <em>{formatRelativeTime(projectSortTimestamp(project), model.language)}</em>
                            </button>
                          </div>
                          {expanded
                            ? project.tags.map((tagName) => (
                                <div
                                  key={tagName}
                                  className={`tree-row tree-tag-row ${
                                    model.tag === tagName
                                    && model.projectPath === project.path
                                    && model.projectEnvironmentId === project.environmentId
                                      ? "active"
                                      : ""
                                  } ${isBranchTag(tagName) ? "branch-tag" : ""}`}
                                >
                                  <button
                                    className="tree-label"
                                    onClick={() => actions.toggleProjectTag(project, tagName)}
                                    title={l(
                                      `Filter by ${displayTagName(tagName)}`,
                                      `按 ${displayTagName(tagName)} 过滤`,
                                    )}
                                  >
                                    {isBranchTag(tagName)
                                      ? <GitBranch size={13} />
                                      : <Tag size={13} />}
                                    <span>{displayTagName(tagName)}</span>
                                  </button>
                                  <button
                                    className="tag-delete"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      actions.deleteTag(tagName);
                                    }}
                                    title={l(
                                      `Delete tag ${displayTagName(tagName)}`,
                                      `删除标签 ${displayTagName(tagName)}`,
                                    )}
                                    aria-label={l(
                                      `Delete tag ${displayTagName(tagName)}`,
                                      `删除标签 ${displayTagName(tagName)}`,
                                    )}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              ))
                            : null}
                        </div>
                      );
                    })
                  : null}
                {!environmentCollapsed && hiddenProjectCount > 0 ? (
                  <button
                    type="button"
                    className="tree-project-more"
                    onClick={() => setVisibleProjectCounts((current) => ({
                      ...current,
                      [groupId]: visibleProjectCount + nextProjectCount,
                    }))}
                  >
                    <ChevronDown size={13} />
                    <span>{l(`Show ${nextProjectCount} more projects`, `再显示 ${nextProjectCount} 个项目`)}</span>
                  </button>
                ) : null}
              </div>
            );
          })}
        </nav>
      ) : null}

      <SidebarSectionHeader
        title={l("Sources", "来源")}
        expanded={model.sidebarSections.sources}
        onToggle={() => actions.toggleSidebarSection("sources")}
      />
      {model.sidebarSections.sources ? (
        <nav className="nav-group">
          {model.sourceFilters.map((item) => (
            <button
              key={item.label}
              className={model.source === item.value ? "active" : ""}
              onClick={() => actions.setSource(item.value)}
            >
              {sourceFilterLabel(item, model.language)}
            </button>
          ))}
        </nav>
      ) : null}

      <SidebarSectionHeader
        title={l("Views", "视图")}
        expanded={model.sidebarSections.views}
        onToggle={() => actions.toggleSidebarSection("views")}
      />
      {model.sidebarSections.views ? (
        <nav className="nav-group">
          <button
            className={model.visibility === "default" ? "active" : ""}
            onClick={() => actions.setVisibility("default")}
          >
            {l("All", "全部")}
          </button>
          <button
            className={model.visibility === "favorites" ? "active" : ""}
            onClick={() => actions.setVisibility("favorites")}
          >
            <Star size={14} />
            {l("Favorites", "收藏")}
          </button>
          <button
            className={model.visibility === "hidden" ? "active" : ""}
            onClick={() => actions.setVisibility("hidden")}
          >
            <EyeOff size={14} />
            {l("Hidden", "隐藏")}
          </button>
        </nav>
      ) : null}
    </section>
  );
}

function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle(): void;
}): ReactElement {
  return (
    <button className="section-header" onClick={onToggle} aria-expanded={expanded}>
      <span>{title}</span>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}
