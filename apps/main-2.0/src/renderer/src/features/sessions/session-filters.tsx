import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRightLeft, CalendarDays, ChevronDown } from "lucide-react";
import type { SessionDailyTokenUsage } from "../../../../core/types";
import { AGENT_RECALL_INVOCATION_SURFACES } from "../../../../shared/runtime-invocation";
import { customDateRangeFromInputs, NATURAL_DATE_PRESETS, naturalDateRange } from "./date-presets";
import {
  DATE_RANGE_OPTIONS,
  dateRangeLabel,
  dateRangeShortLabel,
} from "../../date-range";
import type { LiveStatusFilter } from "../../live-filter";
import { useDismiss } from "../../ui/use-dismiss";
import type { LanguageMode } from "../../language";
import { liveStatusFilterLabel } from "../../session-ui";
import type { SessionsPageActions, SessionsPageModel } from "./sessions-page";

const LIVE_STATUS_FILTERS: LiveStatusFilter[] = ["all", "open", "closed"];

export function SessionFilters({
  model,
  actions,
  l,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
  l(en: string, zh: string): string;
}): ReactElement {
  const [invocationMenuOpen, setInvocationMenuOpen] = useState(false);
  const invocationMenuRef = useRef<HTMLDivElement>(null);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const dateMenuRef = useRef<HTMLDivElement>(null);
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const closeInvocationMenu = useCallback(() => setInvocationMenuOpen(false), []);
  const closeDateMenu = useCallback(() => setDateMenuOpen(false), []);
  useDismiss(invocationMenuRef, invocationMenuOpen, closeInvocationMenu);
  useDismiss(dateMenuRef, dateMenuOpen, closeDateMenu);

  useEffect(() => {
    if (model.origin !== "agentrecall") setInvocationMenuOpen(false);
  }, [model.origin]);

  return (
    <>
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
        <span className="date-filter-menu-anchor" ref={dateMenuRef}>
          <button
            type="button"
            className={`date-filter-menu-trigger ${model.customDateRange ? "active" : ""} ${dateMenuOpen ? "is-open" : ""}`}
            aria-label={l("Custom date range", "自定义日期")}
            aria-expanded={dateMenuOpen}
            aria-haspopup="menu"
            onClick={() => setDateMenuOpen((open) => !open)}
          >
            <CalendarDays size={14} aria-hidden="true" />
          </button>
          {dateMenuOpen ? (
            <div className="date-filter-menu">
              <div role="menu" aria-label={l("Custom date range", "自定义日期")}>
                {NATURAL_DATE_PRESETS.map((preset) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={preset.value}
                    onClick={() => {
                      actions.setCustomDateRange(naturalDateRange(preset.value));
                      setDateMenuOpen(false);
                    }}
                  >
                    {model.language === "zh" ? preset.label.zh : preset.label.en}
                  </button>
                ))}
              </div>
              <div className="date-filter-menu-custom">
                <input
                  type="date"
                  aria-label={l("Start date", "开始日期")}
                  value={customStartDate}
                  onChange={(event) => setCustomStartDate(event.target.value)}
                />
                <span aria-hidden="true">–</span>
                <input
                  type="date"
                  aria-label={l("End date", "结束日期")}
                  value={customEndDate}
                  onChange={(event) => setCustomEndDate(event.target.value)}
                />
                <button
                  type="button"
                  aria-label={l("Apply date range", "应用日期范围")}
                  disabled={!customStartDate}
                  onClick={() => {
                    const range = customDateRangeFromInputs(customStartDate, customEndDate);
                    if (!range) return;
                    actions.setCustomDateRange(range);
                    setDateMenuOpen(false);
                  }}
                >
                  {l("Apply", "应用")}
                </button>
              </div>
            </div>
          ) : null}
        </span>
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
            onClick={() => {
              actions.setDateRange(option.value);
              // An exact range would keep overriding the rolling preset.
              if (model.customDateRange) actions.clearCustomDateRange();
            }}
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
      <div className="live-filter session-origin-filter" role="group" aria-label={l("Session origin", "会话来源") }>
        <button
          type="button"
          className={model.origin === "ordinary" ? "active" : ""}
          onClick={() => {
            setInvocationMenuOpen(false);
            actions.setInvocationSurface("all");
            actions.setOrigin("ordinary");
          }}
        >
          {l(`Regular (${model.originCounts.ordinary})`, `普通会话 (${model.originCounts.ordinary})`)}
        </button>
        <div className="session-origin-agentrecall" ref={invocationMenuRef}>
          <button
            type="button"
            className={`session-origin-agentrecall-trigger ${model.origin === "agentrecall" ? "active" : ""} ${invocationMenuOpen ? "is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={invocationMenuOpen}
            onClick={() => {
              if (model.origin !== "agentrecall") {
                actions.setInvocationSurface("all");
                actions.setOrigin("agentrecall");
              }
              setInvocationMenuOpen((current) => !current);
            }}
          >
            <span>{l(`AgentRecall calls (${model.originCounts.agentRecall})`, `AgentRecall 调用 (${model.originCounts.agentRecall})`)}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {invocationMenuOpen ? (
            <div className="session-origin-agentrecall-menu" role="menu" aria-label={l("AgentRecall call type", "AgentRecall 调用类型")}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={model.invocationSurface === "all"}
                className={model.invocationSurface === "all" ? "active" : ""}
                onClick={() => {
                  actions.setInvocationSurface("all");
                  setInvocationMenuOpen(false);
                }}
              >
                <span>{l("All", "全部")}</span>
                <strong>({model.invocationSurfaceCounts.all})</strong>
              </button>
              {AGENT_RECALL_INVOCATION_SURFACES.map((surface) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={model.invocationSurface === surface}
                  key={surface}
                  className={model.invocationSurface === surface ? "active" : ""}
                  onClick={() => {
                    actions.setInvocationSurface(surface);
                    setInvocationMenuOpen(false);
                  }}
                >
                  <span>{surface === "evaluation" ? "eval" : surface === "team_chat" ? "chat" : surface}</span>
                  <strong>({model.invocationSurfaceCounts[surface]})</strong>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className={model.origin === "all" ? "active" : ""}
          onClick={() => {
            setInvocationMenuOpen(false);
            actions.setInvocationSurface("all");
            actions.setOrigin("all");
          }}
        >
          {l(`All (${model.originCounts.all})`, `全部 (${model.originCounts.all})`)}
        </button>
      </div>
    </>
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
