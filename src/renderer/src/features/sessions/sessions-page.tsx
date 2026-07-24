import { useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Cloud,
  EyeOff,
  Folder,
  GitBranch,
  Laptop,
  Pin,
  RefreshCw,
  Server,
  Sparkles,
  Star,
  Tag,
  Trash2,
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
} from "../../../../core/types";
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
import { SessionRow } from "../search/session-row";
import {
  displayTagName,
  isBranchTag,
  liveStatusFilterLabel,
  projectSortTimestamp,
  sourceFilterLabel,
} from "../../session-ui";

const LIVE_STATUS_FILTERS: LiveStatusFilter[] = ["all", "open", "closed"];

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
  sidebarTree: SessionSidebarGroup[];
  collapsedProjectGroups: Set<string>;
  expandedTreeProjects: Set<string>;
  source: SearchOptions["source"];
  sourceFilters: Array<{ label: string; value: SearchOptions["source"] }>;
  visibility: "default" | "favorites" | "pinned" | "hidden";
  searchRef: RefObject<HTMLInputElement | null>;
  searchPlaceholder: string;
  query: string;
  activeScopeFilters: SessionScopeFilter[];
  liveStatus: LiveStatusFilter;
  customDateRange: Pick<SessionDailyTokenUsage, "dayStart" | "dayEndExclusive"> | null;
  dateRange: DateRangeFilter;
  aiAssistantOpen: boolean;
  remoteSessionsOpen: boolean;
  selected: SessionSearchResult | null;
  sessions: SessionSearchResult[];
  hasMoreSessions: boolean;
  pageSize: number;
  liveSessionKeys: Set<string>;
  liveDetectionFailed: boolean;
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
  setVisibility(visibility: SessionsPageModel["visibility"]): void;
  search(query: string): void;
  setLiveStatus(status: LiveStatusFilter): void;
  clearCustomDateRange(): void;
  setDateRange(range: DateRangeFilter): void;
  openAiAssistant(): void;
  openRemoteSessions(): void;
  selectSession(sessionKey: string): void;
  openSession(session: SessionSearchResult): void;
  openMatch(session: SessionSearchResult, hit: SessionMatchHit): void;
  renameSession(session: SessionSearchResult): void;
  toggleFavorite(session: SessionSearchResult): void;
  openContextMenu(event: ReactMouseEvent, session: SessionSearchResult): void;
  loadMore(): void;
}

export function SessionsPage({
  model,
  actions,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
}): ReactElement {
  const [hoveredScopeFilter, setHoveredScopeFilter] = useState<string | null>(null);
  const l = (en: string, zh: string): string => model.language === "zh" ? zh : en;

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
            ? `${l("Update index", "更新索引")} · ${formatRelativeTime(model.indexStatus.lastIndexedAt)}`
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
                  title={l("Clear exact day filter", "清除单日筛选")}
                  aria-label={l("Clear exact day filter", "清除单日筛选")}
                >
                  <span>{new Intl.DateTimeFormat(
                    model.language === "zh" ? "zh-CN" : "en-US",
                    { month: "short", day: "numeric" },
                  ).format(model.customDateRange.dayStart)}</span>
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
        </header>

        <div className="result-count">
          <span>{l(
            `${model.sessionTotalCount} sessions`,
            `${model.sessionTotalCount} 个会话`,
          )}</span>
          {model.selected
            ? <span className="selected-path">
                {model.selected.projectPath || model.selected.rawId}
              </span>
            : null}
        </div>

        <div className="results">
          {model.sessions.map((session) => (
            <SessionRow
              key={session.sessionKey}
              session={session}
              selected={model.selected?.sessionKey === session.sessionKey}
              liveState={getLiveSessionState(
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
            />
          ))}
          {model.sessions.length === 0 && !model.hasMoreSessions
            ? <div className="empty">{l("No sessions found.", "没有找到会话。")}</div>
            : null}
          {model.hasMoreSessions ? (
            <button className="load-more-sessions" onClick={actions.loadMore}>
              <ChevronDown size={14} />
              {l(
                `Load ${model.pageSize} more`,
                `再加载 ${model.pageSize} 个`,
              )}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
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
                  ? group.projects.map((project) => {
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
                              <em>{formatRelativeTime(projectSortTimestamp(project))}</em>
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
            className={model.visibility === "pinned" ? "active" : ""}
            onClick={() => actions.setVisibility("pinned")}
          >
            <Pin size={14} />
            {l("Pinned", "置顶")}
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
