import { useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { SessionDailyTokenUsage } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";

const MAX_HEATMAP_DAYS = 90;

interface TokenTrendChartProps {
  points: SessionDailyTokenUsage[];
  language: LanguageMode;
  onSelectDay: (day: SessionDailyTokenUsage) => void;
}

interface HeatmapCell {
  day: SessionDailyTokenUsage;
  index: number;
  weekIndex: number;
  weekday: number;
  level: 0 | 1 | 2 | 3 | 4;
}

interface MonthLabel {
  weekIndex: number;
  label: string;
}

function computeIntensityLevels(points: readonly SessionDailyTokenUsage[]): Array<0 | 1 | 2 | 3 | 4> {
  const positive = points
    .map((point) => Math.max(0, point.totalTokens))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);

  if (positive.length === 0) return points.map(() => 0);

  const minPositive = positive[0]!;
  const maxPositive = positive[positive.length - 1]!;
  if (minPositive === maxPositive) {
    return points.map((point) => (point.totalTokens > 0 ? 3 : 0));
  }

  // Use quartiles when enough active days exist so one outlier day never washes out the grid.
  const q1 = positive[Math.floor((positive.length - 1) * 0.25)]!;
  const q2 = positive[Math.floor((positive.length - 1) * 0.5)]!;
  const q3 = positive[Math.floor((positive.length - 1) * 0.75)]!;
  const useQuartiles = positive.length >= 4 && q1 < q3;

  return points.map((point) => {
    const value = Math.max(0, point.totalTokens);
    if (value <= 0) return 0;
    if (useQuartiles) {
      if (value <= q1) return 1;
      if (value <= q2) return 2;
      if (value <= q3) return 3;
      return 4;
    }
    const ratio = Math.sqrt(value / maxPositive);
    if (ratio <= 0.35) return 1;
    if (ratio <= 0.6) return 2;
    if (ratio <= 0.82) return 3;
    return 4;
  });
}

export function TokenTrendChart({ points: history = [], language, onSelectDay }: TokenTrendChartProps): ReactElement {
  const points = useMemo(() => history.slice(-MAX_HEATMAP_DAYS), [history]);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const dayButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tooltipBaseId = `token-heatmap-${useId().replace(/:/g, "")}`;
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const l = (en: string, zh: string) => localize(language, en, zh);

  const fullDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }),
    [locale],
  );
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short" }),
    [locale],
  );

  const {
    cells,
    gridSlots,
    weekCount,
    monthLabels,
    total,
    activeDays,
  } = useMemo(() => {
    const levels = computeIntensityLevels(points);
    const totalTokens = points.reduce((sum, point) => sum + Math.max(0, point.totalTokens), 0);
    const active = points.reduce((count, point) => count + (point.totalTokens > 0 ? 1 : 0), 0);

    if (points.length === 0) {
      return {
        cells: [] as HeatmapCell[],
        gridSlots: [] as Array<HeatmapCell | null>,
        weekCount: 0,
        monthLabels: [] as MonthLabel[],
        total: 0,
        activeDays: 0,
      };
    }

    const firstWeekday = new Date(points[0]!.dayStart).getDay(); // 0 = Sun ... 6 = Sat
    const totalSlots = Math.ceil((firstWeekday + points.length) / 7) * 7;
    const weeks = totalSlots / 7;
    const slots: Array<HeatmapCell | null> = Array.from({ length: totalSlots }, () => null);
    const builtCells: HeatmapCell[] = [];

    for (let index = 0; index < points.length; index++) {
      const day = points[index]!;
      const slotIndex = firstWeekday + index;
      const weekIndex = Math.floor(slotIndex / 7);
      const weekday = slotIndex % 7;
      const cell: HeatmapCell = {
        day,
        index,
        weekIndex,
        weekday,
        level: levels[index] ?? 0,
      };
      builtCells.push(cell);
      slots[slotIndex] = cell;
    }

    // Place month labels above the first week column where each month begins,
    // suppressing a crowded column-0 label when the next month starts 1-2 weeks later.
    const rawMonths: MonthLabel[] = [];
    let lastMonthKey = "";
    for (const cell of builtCells) {
      const date = new Date(cell.day.dayStart);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      if (key !== lastMonthKey) {
        lastMonthKey = key;
        rawMonths.push({ weekIndex: cell.weekIndex, label: monthFormatter.format(date) });
      }
    }
    const filteredMonths = rawMonths.filter((entry, idx) => {
      if (idx === 0 && rawMonths.length > 1 && rawMonths[1]!.weekIndex - entry.weekIndex < 2) {
        return false;
      }
      return true;
    });

    return {
      cells: builtCells,
      gridSlots: slots,
      weekCount: weeks,
      monthLabels: filteredMonths,
      total: totalTokens,
      activeDays: active,
    };
  }, [monthFormatter, points]);

  const savedIndex = points.findIndex((point) => point.dayStart === selectedDayStart);
  const selectedIndex = savedIndex < 0 ? points.length - 1 : savedIndex;
  const activeIndex = hoveredIndex ?? (hasFocus ? selectedIndex : null);
  const activeCell = activeIndex !== null ? cells[activeIndex] ?? null : null;
  const today = points[points.length - 1] ?? null;

  const tooltipAlignment = activeCell && weekCount > 1
    ? activeCell.weekIndex / (weekCount - 1) < 0.28
      ? "start"
      : activeCell.weekIndex / (weekCount - 1) > 0.72
        ? "end"
        : "center"
    : "center";

  const tooltipStyle: CSSProperties | undefined = activeCell && weekCount > 0
    ? tooltipAlignment === "start"
      ? { left: 0 }
      : tooltipAlignment === "end"
        ? { right: 0 }
        : { left: `${((activeCell.weekIndex + 0.5) / weekCount) * 100}%` }
    : undefined;

  const weekdayLabels = language === "zh"
    ? ["", "一", "", "三", "", "五", ""]
    : ["", "Mon", "", "Wed", "", "Fri", ""];

  const rangeDays = points.length > 0 ? points.length : MAX_HEATMAP_DAYS;

  return (
    <section
      className="workbench-token-trend"
      aria-label={l(`Token activity over the last ${rangeDays} days`, `近 ${rangeDays} 天 Token 活跃度`)}
    >
      <header className="workbench-token-trend-head">
        <div className="workbench-heatmap-title">
          <strong>{l("Activity", "活跃度")}</strong>
          <span className="workbench-heatmap-period">
            {l(`${activeDays}/${rangeDays}d`, `近 ${rangeDays} 天 · 活跃 ${activeDays} 天`)}
          </span>
        </div>
        <span><b>{formatTokenCount(total)}</b> Token</span>
      </header>

      <div className="workbench-heatmap-body">
        {points.length > 0 ? (
          <div className="workbench-heatmap-stage">
            <div className="workbench-heatmap-months-row">
              <span className="workbench-heatmap-gutter-spacer" aria-hidden="true" />
              <div
                className="workbench-heatmap-months"
                style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}
                aria-hidden="true"
              >
                {monthLabels.map((entry) => (
                  <span
                    key={`${entry.weekIndex}-${entry.label}`}
                    style={{ gridColumn: `${entry.weekIndex + 1} / span 2` }}
                  >
                    {entry.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="workbench-heatmap-matrix-row">
              <div className="workbench-heatmap-weekdays" aria-hidden="true">
                {weekdayLabels.map((label, weekday) => (
                  <span key={weekday}>{label}</span>
                ))}
              </div>

              <div
                className="workbench-heatmap-grid"
                role="toolbar"
                aria-label={l("Daily Token activity heatmap", "每日 Token 活跃度热力图")}
                aria-description={l(
                  "Use arrow keys to choose a day, Home or End for the first or last day, and Enter or Space to view its sessions.",
                  "使用方向键选择日期，Home 或 End 跳至首日或末日，Enter 或空格查看当天会话。",
                )}
                style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}
                onPointerLeave={() => setHoveredIndex(null)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
                }}
              >
                {gridSlots.map((slot, slotIndex) => {
                  if (!slot) {
                    return <span key={`pad-${slotIndex}`} className="workbench-heatmap-pad" aria-hidden="true" />;
                  }
                  const isToday = slot.index === points.length - 1;
                  const isActive = slot.index === activeIndex;
                  const label = l(
                    `${fullDate.format(slot.day.dayStart)}, ${slot.day.totalTokens.toLocaleString(locale)} Token. View sessions`,
                    `${fullDate.format(slot.day.dayStart)}，${slot.day.totalTokens.toLocaleString(locale)} Token。查看当天会话`,
                  );
                  return (
                    <button
                      key={slot.day.dayStart}
                      ref={(element) => { dayButtons.current[slot.index] = element; }}
                      type="button"
                      tabIndex={slot.index === selectedIndex ? 0 : -1}
                      data-day-start={slot.day.dayStart}
                      data-level={slot.level}
                      className={`workbench-heatmap-cell${isToday ? " is-today" : ""}${isActive ? " is-active" : ""}`}
                      onPointerEnter={() => setHoveredIndex(slot.index)}
                      onFocus={() => {
                        setSelectedDayStart(slot.day.dayStart);
                        setHoveredIndex(null);
                        setHasFocus(true);
                      }}
                      onKeyDown={(event) => {
                        const next = event.key === "ArrowUp" ? Math.max(0, slot.index - 1)
                          : event.key === "ArrowDown" ? Math.min(points.length - 1, slot.index + 1)
                          : event.key === "ArrowLeft" ? Math.max(0, slot.index - 7)
                          : event.key === "ArrowRight" ? Math.min(points.length - 1, slot.index + 7)
                          : event.key === "Home" ? 0
                          : event.key === "End" ? points.length - 1
                          : null;
                        if (next === null) return;
                        event.preventDefault();
                        setHoveredIndex(null);
                        dayButtons.current[next]?.focus({ preventScroll: true });
                      }}
                      onClick={() => {
                        setSelectedDayStart(slot.day.dayStart);
                        onSelectDay(slot.day);
                      }}
                      aria-label={label}
                      aria-describedby={isActive ? `${tooltipBaseId}-tooltip` : undefined}
                    />
                  );
                })}
              </div>
            </div>

            {activeCell ? (
              <div
                id={`${tooltipBaseId}-tooltip`}
                className={`workbench-token-trend-tooltip ${tooltipAlignment}`}
                style={tooltipStyle}
                role="tooltip"
              >
                <div>
                  <strong>{fullDate.format(activeCell.day.dayStart)}</strong>
                  <b>{activeCell.day.totalTokens > 0 ? formatTokenCount(activeCell.day.totalTokens) : l("0", "无用量")}</b>
                </div>
                {activeCell.day.totalTokens > 0 ? (
                  <dl>
                    <div><dt>{l("Input", "输入")}</dt><dd>{formatTokenCount(activeCell.day.inputTokens)}</dd></div>
                    <div><dt>{l("Cache read", "缓存读取")}</dt><dd>{formatTokenCount(activeCell.day.cachedInputTokens)}</dd></div>
                    <div><dt>{l("Cache write", "缓存写入")}</dt><dd>{formatTokenCount(activeCell.day.cacheCreationInputTokens ?? 0)}</dd></div>
                    <div><dt>{l("Output", "输出")}</dt><dd>{formatTokenCount(activeCell.day.outputTokens)}</dd></div>
                    <div><dt>{l("Reasoning", "推理")}</dt><dd>{formatTokenCount(activeCell.day.reasoningOutputTokens)}</dd></div>
                  </dl>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="workbench-heatmap-empty-state">
            <span className="workbench-token-trend-empty">
              {l(`No Token activity in the last ${MAX_HEATMAP_DAYS} days`, `近 ${MAX_HEATMAP_DAYS} 天暂无 Token 用量`)}
            </span>
          </div>
        )}
      </div>

      <footer className="workbench-token-trend-foot">
        <span className="workbench-heatmap-legend" aria-label={l("Activity intensity legend", "活跃度图例")}>
          <span>{l("Less", "少")}</span>
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <i key={level} className="workbench-heatmap-swatch" data-level={level} aria-hidden="true" />
          ))}
          <span>{l("More", "多")}</span>
        </span>
        {today ? (
          <button
            type="button"
            className="workbench-token-trend-today"
            onClick={() => {
              setSelectedDayStart(today.dayStart);
              onSelectDay(today);
            }}
            aria-label={l(
              `View today's sessions (${formatTokenCount(today.totalTokens)} Token)`,
              `查看今天的会话（${formatTokenCount(today.totalTokens)} Token）`,
            )}
          >
            {l("Today", "今天")} <b>{formatTokenCount(today.totalTokens)}</b>
          </button>
        ) : (
          <span>{l("Today", "今天")} <b>{formatTokenCount(0)}</b></span>
        )}
      </footer>
    </section>
  );
}
