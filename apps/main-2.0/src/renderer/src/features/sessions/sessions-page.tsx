import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  RefObject,
} from "react";
import {
  Bookmark,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cloud,
  MoreHorizontal,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
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
import type { DateRangeFilter } from "../../date-range";
import {
  getLiveSessionState,
  type LiveStatusFilter,
} from "../../live-filter";
import { MenuButton } from "../../ui/menu";
import type { LanguageMode } from "../../language";
import { SearchBox } from "../search/search-box";
import { GroupedResults } from "../search/grouped-results";
import type { GroupMode } from "../search/group-logic";
import { QueryBuilder } from "../search/query-builder";
import {
  countActiveFilters,
  toSearchOptionsPatch,
  type QueryBuilderState,
} from "../search/query-builder-types";
import { SavedSearchesPanel } from "../search/saved-searches-panel";
import { SessionFilterBar } from "./session-filter-bar";

export interface SessionSidebarGroup {
  environment: SessionEnvironment | null;
  projects: Array<ProjectSummary & { tags: string[] }>;
}

export interface SessionsPageModel {
  language: LanguageMode;
  indexStatus: IndexStatus | null;
  sessionTotalCount: number;
  environmentId: string | "all";
  projectPath?: string;
  projectEnvironmentId?: string;
  tag?: string;
  tags: string[];
  sidebarTree: SessionSidebarGroup[];
  source: SearchOptions["source"];
  origin: NonNullable<SearchOptions["origin"]>;
  originCounts: { ordinary: number; agentRecall: number; all: number };
  invocationSurface: NonNullable<SearchOptions["invocationSurface"]>;
  invocationSurfaceCounts: Record<NonNullable<SearchOptions["invocationSurface"]>, number>;
  sourceFilters: Array<{ label: string; value: SearchOptions["source"] }>;
  visibility: "default" | "favorites" | "hidden";
  searchRef: RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  query: string;
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
  bulkSelectedKeys: ReadonlySet<string>;
}

export interface SessionsPageActions {
  refresh(): void;
  selectAllSessions(): void;
  selectEnvironment(environmentId: string): void;
  selectProject(project: ProjectSummary): void;
  deleteTag(tagName: string): void;
  setSource(source: SearchOptions["source"]): void;
  setOrigin(origin: NonNullable<SearchOptions["origin"]>): void;
  setInvocationSurface(surface: NonNullable<SearchOptions["invocationSurface"]>): void;
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
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>("time");
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
      .createSavedSearch(name, {
        query: model.query,
        origin: model.origin,
        invocationSurface: model.invocationSurface,
        ...toSearchOptionsPatch(state),
      })
      .then(loadSavedSearches)
      .catch(() => undefined);
  }

  function applySavedSearch(saved: SavedSearch): void {
    if (saved.options.query !== undefined) actions.search(saved.options.query);
    actions.setSource(saved.options.source ?? "all");
    actions.setOrigin(saved.options.origin ?? "ordinary");
    actions.setInvocationSurface(saved.options.invocationSurface ?? "all");
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

  function renderSessionResults(sessions: SessionSearchResult[]): ReactElement {
    return <GroupedResults
      sessions={sessions}
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
    />;
  }

  const headButton = (label: string, active: boolean, onClick: () => void, icon: ReactElement): ReactElement => (
    <button type="button" className={`icon-button toolbar-icon-button ${active ? "active" : ""}`}
      onClick={onClick} title={label} aria-label={label}>{icon}</button>
  );
  const indexLabel = model.indexStatus?.running
    ? l("Updating index…", "正在更新索引…")
    : model.indexStatus?.lastIndexedAt
      ? l(`Indexed ${formatRelativeTime(model.indexStatus.lastIndexedAt, model.language)}`,
        `${formatRelativeTime(model.indexStatus.lastIndexedAt, model.language)}更新索引`)
      : null;

  return (
    <div className="sessions-page" data-page="sessions">
      <header className="app-page-head sessions-page-head">
        <div className="sessions-head-title">
          <h2>Session</h2>
          <span className="sessions-head-meta">
            {l(`${model.sessionTotalCount} sessions`, `${model.sessionTotalCount} 个会话`)}
            {indexLabel ? <> · {indexLabel}</> : null}
          </span>
        </div>
        <div className="sessions-head-actions">
          {headButton(l("AI session finder", "AI 找会话"), model.aiAssistantOpen, actions.openAiAssistant, <Sparkles size={15} />)}
          {headButton(l("Remote sessions", "远程会话"), model.remoteSessionsOpen, actions.openRemoteSessions, <Cloud size={15} />)}
          <button
            type="button"
            className={`sessions-page-refresh ${model.indexStatus?.running ? "is-running" : ""}`}
            onClick={actions.refresh}
            disabled={model.indexStatus?.running}
            aria-label={model.indexStatus?.running
              ? l("Updating index", "正在更新索引")
              : l("Update index", "更新索引")}
          >
            <RefreshCw size={14} />
            <span>{model.indexStatus?.running
              ? l("Updating...", "更新中...")
              : l("Update index", "更新索引")}</span>
          </button>
        </div>
      </header>

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
              <MenuButton
                className="icon-button toolbar-icon-button"
                label={l("More actions", "更多操作")}
                icon={<MoreHorizontal size={15} />}
                items={[
                  { key: "date-cleanup", label: l("Clean up by date", "按日期清理"), icon: <CalendarDays size={14} />, onSelect: actions.openDateCleanup },
                  { key: "orphan-cleanup", label: l("Leftover Subagent Chats", "清理残留子对话"), icon: <Trash2 size={14} />, onSelect: actions.openOrphanCleanup },
                ]}
              />
            </div>
          </div>
          <SessionFilterBar model={model} actions={actions} groupMode={groupMode} onGroupModeChange={setGroupMode} l={l} />
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

        {model.bulkSelectionActive ? (
          <div className="result-count">
            <div className="bulk-result-actions">
              <input
                type="checkbox"
                checked={model.sessions.length > 0 && model.sessions.every((session) => model.bulkSelectedKeys.has(session.sessionKey))}
                onChange={actions.toggleLoadedSelection}
                aria-label={l("Select loaded sessions", "选择已加载会话")}
              />
              <strong>{l(`${model.bulkSelectedKeys.size} selected`, `已选 ${model.bulkSelectedKeys.size} 个`)}</strong>
              {model.bulkSelectedKeys.size > 0 && model.bulkSelectedKeys.size < model.sessionTotalCount ? (
                <button type="button" onClick={actions.selectAllMatching}>{l(`Select all ${model.sessionTotalCount}`, `选择全部 ${model.sessionTotalCount} 个`)}</button>
              ) : null}
              {model.bulkSelectedKeys.size > 0 ? (
                <button type="button" className="bulk-delete-button" onClick={actions.deleteSelected}><Trash2 size={13} />{l("Delete", "删除")}</button>
              ) : null}
              <button type="button" onClick={actions.exitBulkSelection} title={l("Exit multi-select", "退出多选")} aria-label={l("Exit multi-select", "退出多选")}><X size={13} /></button>
            </div>
          </div>
        ) : null}

        <div key={model.currentPage} className="results">
          {renderSessionResults(model.sessions)}
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
