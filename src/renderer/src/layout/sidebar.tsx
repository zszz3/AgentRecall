import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Container, EyeOff, Folder, GitBranch, Laptop, Pin, RefreshCw, Search, Server, Star, Tag, Trash2 } from "lucide-react";
import { formatRelativeTime } from "../../../core/format-session";
import type { IndexStatus } from "../../../core/indexer";
import type {
  LiveSessionSnapshot,
  ProjectSummary,
  SearchOptions,
  SessionEnvironment,
  SessionSearchResult,
  SessionStats,
  SessionStatsPeriod,
  SessionStatsTrend,
  SessionStatsTrendBucket,
  UsageQuotaCard,
  UsageQuotaSnapshot,
} from "../../../core/types";
import { formatCompactNumber, formatTokenCount } from "../format-count";
import { localize, type LanguageMode } from "../language";
import type { QuotaFeedback, RefreshFeedback, StatsFeedback } from "../app-types";
import type { SidebarSectionsState, SidebarSectionId } from "../sidebar-sections";
import { environmentTarget } from "../features/environments/environment-display";
import {
  displayTagName,
  formatUsageDelta,
  hasTokenUsage,
  isBranchTag,
  projectDisplayLabel,
  projectSortTimestamp,
  sourceFilterLabel,
  statsPeriodLabel,
  usageDelta,
  usageStatsDisplayRows,
} from "../session-ui";
import type { UsageDelta } from "../session-ui";

/* ------------------------------------------------------------------ types */

export type SidebarTreeGroup = {
  environment: SessionEnvironment | null;
  projects: Array<ProjectSummary & { tags: string[] }>;
};

export type ViewMode = "default" | "favorites" | "pinned" | "hidden";

export type SidebarProps = {
  language: LanguageMode;
  sidebarSections: SidebarSectionsState;
  onToggleSection: (section: SidebarSectionId) => void;
  indexStatus: IndexStatus | null;
  refreshFeedback: RefreshFeedback;
  onRefreshNow: () => void;
  stats: SessionStats;
  statsPeriod: SessionStatsPeriod;
  onStatsPeriodChange: (period: SessionStatsPeriod) => void;
  statsFeedback: StatsFeedback;
  statsTrend: SessionStatsTrend;
  statsTrendLoading: boolean;
  onEnsureStatsTrend: () => void;
  quotas: UsageQuotaSnapshot;
  quotaLoading: boolean;
  quotaFeedback: QuotaFeedback;
  onRefreshQuotas: () => void;
  sidebarTree: SidebarTreeGroup[];
  collapsedProjectGroups: ReadonlySet<string>;
  collapsedTreeProjects: ReadonlySet<string>;
  onToggleProjectGroup: (groupId: string) => void;
  onToggleTreeProject: (projectKey: string) => void;
  environmentId: string | "all";
  projectPath: string | undefined;
  projectEnvironmentId: string | undefined;
  tag: string | undefined;
  onSelectAllSessions: () => void;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectProject: (project: ProjectSummary) => void;
  onSelectTag: (tagName: string, project: ProjectSummary) => void;
  onDeleteTag: (tagName: string) => void;
  sourceFilters: Array<{ label: string; value: SearchOptions["source"] }>;
  source: SearchOptions["source"];
  onSelectSource: (source: SearchOptions["source"]) => void;
  visibility: ViewMode;
  onSelectVisibility: (visibility: ViewMode) => void;
};

export const STATS_PERIOD_OPTIONS: Array<{ label: string; value: SessionStatsPeriod }> = [
  { label: "Today", value: "today" },
  { label: "7D", value: "sevenDay" },
  { label: "30D", value: "thirtyDay" },
  { label: "All", value: "allTime" },
];

/* ----------------------------------------------------------------- sidebar */

export function Sidebar(props: SidebarProps): ReactElement {
  const {
    language,
    sidebarSections,
    onToggleSection,
    indexStatus,
    refreshFeedback,
    onRefreshNow,
    stats,
    statsPeriod,
    onStatsPeriodChange,
    statsFeedback,
    statsTrend,
    statsTrendLoading,
    onEnsureStatsTrend,
    quotas,
    quotaLoading,
    quotaFeedback,
    onRefreshQuotas,
    sidebarTree,
    collapsedProjectGroups,
    collapsedTreeProjects,
    onToggleProjectGroup,
    onToggleTreeProject,
    environmentId,
    projectPath,
    projectEnvironmentId,
    tag,
    onSelectAllSessions,
    onSelectEnvironment,
    onSelectProject,
    onSelectTag,
    onDeleteTag,
    sourceFilters,
    source,
    onSelectSource,
    visibility,
    onSelectVisibility,
  } = props;
  const t = (en: string, zh: string) => localize(language, en, zh);

  return (
    <section className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Search size={17} />
        </div>
        <div>
          <h1>AgentRecall</h1>
          <p>{t("Codex and Claude Code", "Codex 和 Claude Code")}</p>
        </div>
      </div>

      <div className="refresh-control">
        <button className={`primary ${indexStatus?.running ? "is-running" : ""}`} onClick={onRefreshNow} disabled={indexStatus?.running}>
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
                  onClick={() => onStatsPeriodChange(option.value)}
                >
                  {statsPeriodLabel(option.value, language)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {statsFeedback ? <div className={`stats-feedback ${statsFeedback.kind}`}>{statsFeedback.message}</div> : null}
        <div className="stats-metrics">
          <span>
            <span className="stats-metric-value">
              <strong>{formatCompactNumber(stats.total.messageCount)}</strong>
              <UsageDeltaBadge delta={usageDelta(stats.total.messageCount, stats.previousTotal?.messageCount ?? null)} />
            </span>
            {t("Messages", "消息")}
          </span>
          {hasTokenUsage(stats.total) ? (
            <UsageTokenMetric
              totalTokens={stats.total.totalTokens}
              previousTotalTokens={stats.previousTotal?.totalTokens ?? null}
              period={statsPeriod}
              language={language}
              trend={statsTrend}
              trendLoading={statsTrendLoading}
              onEnsureTrend={onEnsureStatsTrend}
              tokensLabel={t("Tokens", "Token")}
            />
          ) : null}
        </div>
        <div className="stats-breakdown">
          {usageStatsDisplayRows(stats.bySource).map((item) => (
            <div key={item.key}>
              <span>{item.label}</span>
              <em>
                {formatCompactNumber(item.messageCount)} {t("msg", "条")}
                {hasTokenUsage(item) ? ` · ${formatTokenCount(item.totalTokens)}` : ""}
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
        onToggle={() => onToggleSection("remaining")}
        onRefresh={onRefreshQuotas}
        language={language}
      />

      <SidebarSectionHeader title={t("Environments", "环境")} expanded={sidebarSections.environments} onToggle={() => onToggleSection("environments")} />
      {sidebarSections.environments ? (
        <nav className="sidebar-tree">
          <button
            className={`tree-row tree-root ${environmentId === "all" && !projectPath && !tag ? "active" : ""}`}
            onClick={onSelectAllSessions}
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
                    onClick={() => onToggleProjectGroup(groupId)}
                    aria-expanded={!envCollapsed}
                    aria-label={envCollapsed ? t("Expand", "展开") : t("Collapse", "折叠")}
                  >
                    {envCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button
                    className={`tree-label ${envActive ? "active" : ""}`}
                    onClick={() => onSelectEnvironment(groupId)}
                    title={group.environment ? environmentTarget(group.environment, language) : t("Unknown", "未知")}
                  >
                    {group.environment?.kind === "local" ? <Laptop size={13} /> : group.environment?.kind === "wsl" ? <Container size={13} /> : <Server size={13} />}
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
                            onClick={() => onToggleTreeProject(projectKey)}
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
                          onClick={() => onSelectProject(project)}
                          title={project.path}
                        >
                          <Folder size={13} />
                          <span>{projectDisplayLabel(project, language)}</span>
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
                            onClick={() => onSelectTag(tagName, project)}
                            title={t(`Filter by ${displayTagName(tagName)}`, `按 ${displayTagName(tagName)} 过滤`)}
                          >
                            {isBranchTag(tagName) ? <GitBranch size={13} /> : <Tag size={13} />}
                            <span>{displayTagName(tagName)}</span>
                          </button>
                          <button
                            className="tag-delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteTag(tagName);
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

      <SidebarSectionHeader title={t("Sources", "来源")} expanded={sidebarSections.sources} onToggle={() => onToggleSection("sources")} />
      {sidebarSections.sources ? (
        <nav className="nav-group">
          {sourceFilters.map((item) => (
            <button key={item.label} className={source === item.value ? "active" : ""} onClick={() => onSelectSource(item.value)}>
              {sourceFilterLabel(item, language)}
            </button>
          ))}
        </nav>
      ) : null}

      <SidebarSectionHeader title={t("Views", "视图")} expanded={sidebarSections.views} onToggle={() => onToggleSection("views")} />
      {sidebarSections.views ? (
        <nav className="nav-group">
          <button className={visibility === "default" ? "active" : ""} onClick={() => onSelectVisibility("default")}>
            {t("All", "全部")}
          </button>
          <button className={visibility === "favorites" ? "active" : ""} onClick={() => onSelectVisibility("favorites")}>
            <Star size={14} />
            {t("Favorites", "收藏")}
          </button>
          <button className={visibility === "pinned" ? "active" : ""} onClick={() => onSelectVisibility("pinned")}>
            <Pin size={14} />
            {t("Pinned", "置顶")}
          </button>
          <button className={visibility === "hidden" ? "active" : ""} onClick={() => onSelectVisibility("hidden")}>
            <EyeOff size={14} />
            {t("Hidden", "隐藏")}
          </button>
        </nav>
      ) : null}
    </section>
  );
}

export function SidebarSectionHeader({
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

/* -------------------------------------------------- usage metrics + quotas */

function UsageTokenMetric({
  totalTokens,
  previousTotalTokens,
  period,
  language,
  trend,
  trendLoading,
  onEnsureTrend,
  tokensLabel,
}: {
  totalTokens: number;
  previousTotalTokens: number | null;
  period: SessionStatsPeriod;
  language: LanguageMode;
  trend: SessionStatsTrend;
  trendLoading: boolean;
  onEnsureTrend: () => void;
  tokensLabel: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; arrowLeft: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const interactive = period !== "allTime";

  const closePopover = useCallback(() => {
    setOpen(false);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(closePopover, 120);
  }, [cancelClose, closePopover]);

  const openPopover = useCallback(() => {
    if (!interactive) return;
    cancelClose();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverWidth = 280;
      const anchorCenter = rect.left + rect.width / 2;
      const desiredLeft = anchorCenter - (popoverWidth - 40);
      const left = Math.max(8, Math.min(window.innerWidth - popoverWidth - 8, desiredLeft));
      const top = rect.bottom + 8;
      const arrowLeft = Math.max(14, Math.min(popoverWidth - 14, anchorCenter - left));
      setPosition({ top, left, arrowLeft });
    }
    onEnsureTrend();
    setOpen(true);
  }, [interactive, cancelClose, onEnsureTrend]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => closePopover();
    const closeIfPointerLeaves = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closePopover();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closePopover();
    };
    window.addEventListener("pointermove", closeIfPointerLeaves, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointermove", closeIfPointerLeaves, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePopover, open]);

  return (
    <div
      ref={anchorRef}
      className={interactive ? "stats-token-metric stats-token-metric--interactive" : "stats-token-metric"}
      tabIndex={interactive ? 0 : undefined}
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
      onFocus={openPopover}
      onBlur={closePopover}
    >
      <span className="stats-metric-value">
        <strong>{formatTokenCount(totalTokens)}</strong>
        <UsageDeltaBadge delta={usageDelta(totalTokens, previousTotalTokens)} />
      </span>
      {tokensLabel}
      {interactive && open && position
        ? createPortal(
            <UsageTokenTrendPopover
              popoverRef={popoverRef}
              trend={trend}
              loading={trendLoading}
              period={period}
              language={language}
              position={position}
              onMouseEnter={cancelClose}
              onMouseLeave={closePopover}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function UsageTokenTrendPopover({
  popoverRef,
  trend,
  loading,
  period,
  language,
  position,
  onMouseEnter,
  onMouseLeave,
}: {
  popoverRef: RefObject<HTMLDivElement | null>;
  trend: SessionStatsTrend;
  loading: boolean;
  period: SessionStatsPeriod;
  language: LanguageMode;
  position: { top: number; left: number; arrowLeft: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}): ReactElement {
  const title =
    period === "today"
      ? localize(language, "Last 30 days", "近 30 天")
      : period === "sevenDay"
        ? localize(language, "Last 30 weeks", "近 30 周")
        : localize(language, "Last 30 months", "近 30 个月");
  const buckets = trend.buckets;
  const width = 280;
  const height = 118;
  const chartLeft = 34;
  const chartRight = 8;
  const chartTop = 8;
  const chartBottom = 22;
  const plotWidth = width - chartLeft - chartRight;
  const plotHeight = height - chartTop - chartBottom;
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.totalTokens), 0);
  const yMax = Math.max(maxTokens, 1);
  const yMid = chartTop + plotHeight / 2;
  const points = buckets.map((bucket, index) => {
    const x = buckets.length <= 1 ? chartLeft + plotWidth / 2 : chartLeft + (index * plotWidth) / (buckets.length - 1);
    const y = chartTop + (1 - bucket.totalTokens / yMax) * plotHeight;
    return { x, y, bucket, index };
  });
  const pathData = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const totalTokens = buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  const nonZeroBuckets = buckets.filter((bucket) => bucket.totalTokens > 0);
  const peakBucket = nonZeroBuckets.reduce<SessionStatsTrendBucket | undefined>(
    (best, bucket) => (!best || bucket.totalTokens > best.totalTokens ? bucket : best),
    undefined,
  );
  const avgTokens = nonZeroBuckets.length > 0 ? Math.round(totalTokens / nonZeroBuckets.length) : 0;
  let lastNonZeroIndex = -1;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    if (buckets[i].totalTokens > 0) {
      lastNonZeroIndex = i;
      break;
    }
  }
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const focusIndex = hoveredIndex ?? lastNonZeroIndex;
  const focusPoint = focusIndex >= 0 && focusIndex < points.length ? points[focusIndex] : null;
  const focusBucket = focusPoint?.bucket ?? null;
  const midLabelIndex = Math.floor(buckets.length / 2);
  const handleChartMove = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || points.length === 0) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const relativeX = ((event.clientX - rect.left) / rect.width) * width;
      let nearest = points[0];
      let nearestDistance = Math.abs(nearest.x - relativeX);
      for (let i = 1; i < points.length; i += 1) {
        const distance = Math.abs(points[i].x - relativeX);
        if (distance < nearestDistance) {
          nearest = points[i];
          nearestDistance = distance;
        }
      }
      setHoveredIndex(nearest.index);
    },
    [points, width],
  );
  const clearHover = useCallback(() => setHoveredIndex(null), []);

  useEffect(() => clearHover, [clearHover]);

  return (
    <div
      ref={popoverRef}
      className="stats-token-popover"
      role="tooltip"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        ["--stats-popover-arrow-left" as string]: `${position.arrowLeft}px`,
      } as CSSProperties}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="stats-token-popover-header">
        <span>{title}</span>
        <em>
          {localize(language, "Total", "合计")} {formatTokenCount(totalTokens)}
        </em>
      </div>
      {peakBucket ? (
        <div className="stats-token-popover-summary">
          <span>
            {localize(language, "Peak", "峰值")} <em>{formatTokenCount(peakBucket.totalTokens)}</em>
            <i>{peakBucket.label}</i>
          </span>
          <span>
            {localize(language, "Avg", "平均")} <em>{formatTokenCount(avgTokens)}</em>
          </span>
        </div>
      ) : null}
      {loading ? (
        <div className="stats-token-popover-empty">{localize(language, "Loading trend...", "正在加载趋势...")}</div>
      ) : buckets.length === 0 ? (
        <div className="stats-token-popover-empty">{localize(language, "No token usage yet", "暂无 Token 用量")}</div>
      ) : (
        <svg
          ref={svgRef}
          className="stats-token-chart"
          viewBox={`0 0 ${width} ${height}`}
          onMouseMove={handleChartMove}
          onMouseLeave={clearHover}
        >
          <path className="stats-token-chart-grid" d={`M${chartLeft} ${chartTop}H${width - chartRight}M${chartLeft} ${yMid}H${width - chartRight}`} />
          <path className="stats-token-chart-axis" d={`M${chartLeft} ${chartTop}V${height - chartBottom}H${width - chartRight}`} />
          <text className="stats-token-chart-y-label" x={chartLeft - 6} y={chartTop + 3} textAnchor="end">{formatCompactNumber(yMax)}</text>
          <text className="stats-token-chart-y-label" x={chartLeft - 6} y={yMid + 3} textAnchor="end">{formatCompactNumber(Math.round(yMax / 2))}</text>
          <text className="stats-token-chart-y-label" x={chartLeft - 6} y={height - chartBottom + 3} textAnchor="end">0</text>
          <text className="stats-token-chart-x-label" x={chartLeft} y={height - 5} textAnchor="start">{buckets[0]?.label}</text>
          {buckets.length > 2 ? (
            <text className="stats-token-chart-x-label" x={chartLeft + plotWidth / 2} y={height - 5} textAnchor="middle">
              {buckets[midLabelIndex]?.label}
            </text>
          ) : null}
          <text className="stats-token-chart-x-label" x={width - chartRight} y={height - 5} textAnchor="end">{buckets.at(-1)?.label}</text>
          <path className="stats-token-chart-line" d={pathData} />
          {focusPoint ? (
            <path
              className="stats-token-chart-focus-line"
              d={`M${focusPoint.x.toFixed(1)} ${chartTop}V${height - chartBottom}`}
            />
          ) : null}
          {points.map((point) => (
            <circle
              key={point.bucket.start}
              className={
                point.index === focusIndex
                  ? "stats-token-chart-point stats-token-chart-point--focus"
                  : "stats-token-chart-point"
              }
              cx={point.x}
              cy={point.y}
              r={point.index === focusIndex ? 2.8 : 1.6}
            />
          ))}
        </svg>
      )}
      {focusBucket ? (
        <div className="stats-token-popover-focus">
          <span>{focusBucket.label}</span>
          <em>{formatTokenCount(focusBucket.totalTokens)}</em>
        </div>
      ) : null}
    </div>
  );
}

function UsageDeltaBadge({ delta }: { delta: UsageDelta | null }): ReactElement | null {
  if (!delta || delta.kind === "flat") return null;
  return <span className={`stats-delta stats-delta-${delta.kind}`}>{formatUsageDelta(delta)}</span>;
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
              <div className="quota-empty">
                {loading
                  ? l("Checking usage limits...", "正在检查额度...")
                  : (snapshot.hiddenProviders?.length ?? 0) > 0
                    ? l("Usage limits are hidden. Enable them in settings.", "额度已在设置中隐藏。")
                    : l("Usage limits unavailable.", "额度不可用。")}
              </div>
            ) : null}
          </div>
          {snapshot.freshness === "stale" ? (
            <div className="quota-stale-notice">
              {l(
                `Showing data from ${formatRelativeTime(Date.parse(snapshot.lastSuccessfulAt ?? ""))}. Refresh failed.`,
                `正在显示 ${formatRelativeTime(Date.parse(snapshot.lastSuccessfulAt ?? ""))} 的数据，刷新失败。`,
              )}
            </div>
          ) : null}
          {snapshot.freshness === "auth-required" ? (
            <div className="quota-stale-notice error">
              {l("Codex login expired. Sign in again to refresh usage limits.", "Codex 登录已失效，请重新登录后刷新额度。")}
            </div>
          ) : null}
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
