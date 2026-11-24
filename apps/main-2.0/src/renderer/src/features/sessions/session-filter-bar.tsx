import { useCallback, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ArrowUpDown, Bot, Calendar, ChevronDown, CircleDot, Folder, Hash, Layers, Star, Trash2, X } from "lucide-react";
import type { SessionDailyTokenUsage } from "../../../../core/types";
import { AGENT_RECALL_INVOCATION_SURFACES } from "../../../../shared/runtime-invocation";
import { formatRelativeTime } from "../../../../core/format-session";
import { DATE_RANGE_OPTIONS, dateRangeLabel } from "../../date-range";
import type { LiveStatusFilter } from "../../live-filter";
import { MenuButton, type MenuItem } from "../../ui/menu";
import { useDismiss } from "../../ui/use-dismiss";
import type { LanguageMode } from "../../language";
import { displayTagName, liveStatusFilterLabel, projectSortTimestamp, sourceFilterLabel } from "../../session-ui";
import type { GroupMode } from "../search/group-logic";
import { customDateRangeFromInputs, NATURAL_DATE_PRESETS, naturalDateRange } from "./date-presets";
import type { SessionsPageActions, SessionsPageModel } from "./sessions-page";

const LIVE_STATUS_FILTERS: LiveStatusFilter[] = ["all", "open", "closed"];

/**
 * One row of filter chips. An unset chip names its dimension with a dashed outline; a set chip
 * shows its value. Every chip opens a list whose first entry resets it.
 */
export function SessionFilterBar({
  model,
  actions,
  groupMode,
  onGroupModeChange,
  l,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
  groupMode: GroupMode;
  onGroupModeChange(mode: GroupMode): void;
  l(en: string, zh: string): string;
}): ReactElement {
  const projectSet = model.environmentId !== "all" || Boolean(model.projectPath);
  const selectedProject = model.sidebarTree
    .flatMap((group) => group.projects)
    .find((project) => project.path === model.projectPath && (!model.projectEnvironmentId || project.environmentId === model.projectEnvironmentId));
  const selectedEnvironment = model.sidebarTree.find((group) => group.environment?.id === model.environmentId)?.environment ?? null;
  const multipleEnvironments = model.sidebarTree.length > 1;

  const projectItems: MenuItem[] = [{
    key: "all",
    label: l("All projects", "全部项目"),
    checked: !projectSet,
    onSelect: actions.selectAllSessions,
  }];
  for (const group of model.sidebarTree) {
    const section = multipleEnvironments ? group.environment?.label ?? l("Unknown", "未知") : undefined;
    if (multipleEnvironments && group.environment) {
      const environmentId = group.environment.id;
      projectItems.push({
        key: `environment:${environmentId}`,
        section,
        label: l(`All of ${group.environment.label}`, `${group.environment.label} 全部`),
        checked: model.environmentId === environmentId && !model.projectPath,
        onSelect: () => actions.selectEnvironment(environmentId),
      });
    }
    for (const project of group.projects) {
      const time = projectSortTimestamp(project);
      projectItems.push({
        key: `project:${project.environmentId}:${project.path}`,
        section,
        label: project.label,
        hint: time ? formatRelativeTime(time, model.language) : undefined,
        checked: model.projectPath === project.path && model.projectEnvironmentId === project.environmentId,
        onSelect: () => actions.selectProject(project),
      });
    }
  }

  const source = model.sourceFilters.find((item) => item.value === model.source);
  const agentItems: MenuItem[] = model.sourceFilters.map((item) => ({
    key: String(item.value),
    label: item.value === "all" ? l("All agents", "全部 Agent") : sourceFilterLabel(item, model.language),
    checked: model.source === item.value,
    onSelect: () => actions.setSource(item.value),
  }));

  const statusItems: MenuItem[] = LIVE_STATUS_FILTERS.map((status) => ({
    key: status,
    label: status === "all" ? l("Any status", "全部状态") : liveStatusFilterLabel(status, model.language),
    checked: model.liveStatus === status,
    onSelect: () => actions.setLiveStatus(status),
  }));

  const visibilityLabel = model.visibility === "favorites" ? l("Favorites", "收藏") : model.visibility === "hidden" ? l("Hidden", "已隐藏") : null;
  const visibilityItems: MenuItem[] = [
    { key: "default", label: l("Not hidden", "未隐藏的会话"), checked: model.visibility === "default", onSelect: () => actions.setVisibility("default") },
    { key: "favorites", label: l("Favorites", "收藏"), checked: model.visibility === "favorites", onSelect: () => actions.setVisibility("favorites") },
    { key: "hidden", label: l("Hidden", "已隐藏"), checked: model.visibility === "hidden", onSelect: () => actions.setVisibility("hidden") },
  ];

  const tagItems: MenuItem[] = [
    { key: "all", label: l("All tags", "全部标签"), checked: !model.tag, onSelect: () => actions.setTag(undefined) },
    ...model.tags.map((tagName) => ({
      key: `tag:${tagName}`,
      label: displayTagName(tagName),
      checked: model.tag === tagName,
      onSelect: () => actions.setTag(tagName),
    })),
    ...(model.tag ? [{
      key: "delete",
      label: l(`Delete tag "${displayTagName(model.tag)}"…`, `删除标签「${displayTagName(model.tag)}」…`),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => actions.deleteTag(model.tag!),
    }] : []),
  ];

  const selectOrigin = (origin: SessionsPageModel["origin"], surface: SessionsPageModel["invocationSurface"] = "all"): void => {
    actions.setInvocationSurface(surface);
    actions.setOrigin(origin);
  };
  const originItems: MenuItem[] = [
    { key: "ordinary", label: l(`Regular (${model.originCounts.ordinary})`, `普通会话 (${model.originCounts.ordinary})`), checked: model.origin === "ordinary", onSelect: () => selectOrigin("ordinary") },
    { key: "agentrecall", label: l(`AgentRecall calls (${model.originCounts.agentRecall})`, `AgentRecall 调用 (${model.originCounts.agentRecall})`), checked: model.origin === "agentrecall" && model.invocationSurface === "all", onSelect: () => selectOrigin("agentrecall") },
    ...AGENT_RECALL_INVOCATION_SURFACES.map((surface) => ({
      key: `surface:${surface}`,
      section: l("AgentRecall call type", "AgentRecall 调用类型"),
      label: `${surface === "evaluation" ? "eval" : surface === "team_chat" ? "chat" : surface} (${model.invocationSurfaceCounts[surface]})`,
      checked: model.origin === "agentrecall" && model.invocationSurface === surface,
      onSelect: () => selectOrigin("agentrecall", surface),
    })),
    { key: "all", label: l(`All (${model.originCounts.all})`, `全部 (${model.originCounts.all})`), checked: model.origin === "all", onSelect: () => selectOrigin("all") },
  ];
  const originLabel = model.origin === "agentrecall"
    ? model.invocationSurface === "all" ? l("AgentRecall calls", "AgentRecall 调用") : `AgentRecall · ${model.invocationSurface}`
    : model.origin === "all" ? l("All sessions", "全部会话") : null;

  const sortLabel = model.sortBy === "activity" ? l("Recent", "最新") : model.sortBy === "created" ? l("Oldest", "最早") : l("Smart", "智能");
  const groupItems: Array<[GroupMode, string]> = [
    ["time", l("By date", "按日期")],
    ["project", l("By project", "按项目")],
    ["source", l("By agent", "按 Agent")],
    ["flat", l("No groups", "不分组")],
  ];
  const sortItems: MenuItem[] = [
    { key: "smart", label: l("Smart: relevance + recency", "智能：相关性 + 时间"), checked: model.sortBy === "smart", onSelect: () => actions.setSortBy("smart") },
    { key: "activity", label: l("Most recent first", "最近活跃优先"), checked: model.sortBy === "activity", onSelect: () => actions.setSortBy("activity") },
    { key: "created", label: l("Oldest first", "最早创建优先"), checked: model.sortBy === "created", onSelect: () => actions.setSortBy("created") },
    ...groupItems.map(([mode, label]) => ({
      key: `group:${mode}`,
      section: l("Group", "分组"),
      label,
      checked: groupMode === mode,
      onSelect: () => onGroupModeChange(mode),
    })),
  ];

  const anySet = projectSet || model.source !== "all" || model.liveStatus !== "all" || model.visibility !== "default"
    || Boolean(model.tag) || model.origin !== "ordinary" || Boolean(model.customDateRange) || model.dateRange !== "all";

  return (
    <div className="session-filter-bar" role="toolbar" aria-label={l("Session filters", "会话筛选")}>
      <Chip
        label={l("Project", "项目")}
        icon={<Folder size={13} />}
        value={selectedProject?.label ?? (model.projectPath ? model.projectPath : selectedEnvironment?.label ?? null)}
        items={projectItems}
      />
      <Chip label="Agent" icon={<Bot size={13} />} value={model.source !== "all" ? source?.label ?? String(model.source) : null} items={agentItems} />
      <DateChip model={model} actions={actions} l={l} />
      <Chip
        label={l("Status", "状态")}
        icon={<CircleDot size={13} />}
        value={model.liveStatus === "all" ? null : liveStatusFilterLabel(model.liveStatus, model.language)}
        items={statusItems}
      />
      <Chip label={l("View", "视图")} icon={<Star size={13} />} value={visibilityLabel} items={visibilityItems} />
      {model.tags.length > 0 || model.tag ? (
        <Chip label={l("Tag", "标签")} icon={<Hash size={13} />} value={model.tag ? displayTagName(model.tag) : null} items={tagItems} />
      ) : null}
      <Chip label={l("Type", "类型")} icon={<Layers size={13} />} value={originLabel} items={originItems} />
      {anySet ? (
        <button
          type="button"
          className="session-filter-clear"
          onClick={() => {
            actions.selectAllSessions();
            actions.setSource("all");
            actions.setLiveStatus("all");
            actions.setVisibility("default");
            selectOrigin("ordinary");
            actions.setDateRange("all");
            if (model.customDateRange) actions.clearCustomDateRange();
          }}
        >
          <X size={12} />{l("Clear filters", "清除筛选")}
        </button>
      ) : null}
      <MenuButton
        className="session-sort"
        label={l("Sort and group", "排序与分组")}
        icon={<ArrowUpDown size={13} />}
        text={<span>{sortLabel}</span>}
        items={sortItems}
      />
    </div>
  );
}

function Chip({ label, icon, value, items }: { label: string; icon: ReactNode; value: string | null; items: MenuItem[] }): ReactElement {
  return (
    <MenuButton
      className={`session-chip ${value ? "is-set" : ""}`}
      label={label}
      icon={icon}
      text={<><span>{value ?? label}</span><ChevronDown className="session-chip-caret" size={12} aria-hidden="true" /></>}
      items={items}
    />
  );
}

function toDateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function DateChip({ model, actions, l }: { model: SessionsPageModel; actions: SessionsPageActions; l(en: string, zh: string): string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const value = model.customDateRange
    ? exactDateRangeLabel(model.customDateRange, model.language)
    : model.dateRange !== "all" ? dateRangeLabel(model.dateRange, model.language) : null;
  const toggleMenu = () => {
    setOpen((current) => {
      const next = !current;
      if (next && model.customDateRange) {
        setStart(toDateInputValue(model.customDateRange.dayStart));
        setEnd(toDateInputValue(Math.max(model.customDateRange.dayStart, model.customDateRange.dayEndExclusive - 1)));
      }
      return next;
    });
  };
  return (
    <span className="session-date-anchor" ref={anchor}>
      <button
        type="button"
        className={`session-chip ${value ? "is-set" : ""} ${open ? "active" : ""}`}
        aria-label={l("Session time range", "会话时间范围")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        <Calendar size={13} />
        <span>{value ?? l("Date", "时间")}</span>
        <ChevronDown className="session-chip-caret" size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="session-date-menu">
          <div role="menu" aria-label={l("Session time range", "会话时间范围")}>
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!model.customDateRange && model.dateRange === option.value}
                key={option.value}
                onClick={() => {
                  actions.setDateRange(option.value);
                  if (model.customDateRange) actions.clearCustomDateRange();
                  setOpen(false);
                }}
              >
                {dateRangeLabel(option.value, model.language)}
              </button>
            ))}
            {NATURAL_DATE_PRESETS.map((preset) => (
              <button
                type="button"
                role="menuitem"
                key={preset.value}
                onClick={() => {
                  actions.setCustomDateRange(naturalDateRange(preset.value));
                  setOpen(false);
                }}
              >
                {model.language === "zh" ? preset.label.zh : preset.label.en}
              </button>
            ))}
          </div>
          <div className="session-date-custom">
            <input type="date" aria-label={l("Start date", "开始日期")} value={start} onChange={(event) => setStart(event.target.value)} />
            <span aria-hidden="true">–</span>
            <input type="date" aria-label={l("End date", "结束日期")} value={end} onChange={(event) => setEnd(event.target.value)} />
            <button
              type="button"
              aria-label={l("Apply date range", "应用日期范围")}
              disabled={!start}
              onClick={() => {
                const range = customDateRangeFromInputs(start, end);
                if (!range) return;
                actions.setCustomDateRange(range);
                setOpen(false);
              }}
            >
              {l("Apply", "应用")}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
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
