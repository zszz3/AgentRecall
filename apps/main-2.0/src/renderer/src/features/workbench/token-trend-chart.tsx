import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { SessionDailyTokenUsage } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";

const DEFAULT_CELL_SIZE = 13;
const MIN_CELL_SIZE = 12;
const MAX_CELL_SIZE = 14;
const CELL_GAP = 3;
const GUTTER_WIDTH = 24;
const GUTTER_GAP = 6;
const GUTTER_TOTAL = GUTTER_WIDTH + GUTTER_GAP;
const MIN_WEEKS = 13;
const MAX_WEEKS = 53;
const DEFAULT_WEEKS = 24;

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

  // Use quartiles when enough active days exist so one spike day never flattens the rest of the graph.
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

function computeCurrentStreak(history: readonly SessionDailyTokenUsage[]): number {
  if (history.length === 0) return 0;
  let index = history.length - 1;
  // If today has no usage yet, still count an unbroken streak through yesterday.
  if ((history[index]?.totalTokens ?? 0) <= 0) index--;
  let streak = 0;
  while (index >= 0 && (history[index]?.totalTokens ?? 0) > 0) {
    streak++;
    index--;
  }
  return streak;
}

export function TokenTrendChart({ points: history = [], language, onSelectDay }: TokenTrendChartProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({ cellSize: DEFAULT_CELL_SIZE, visibleWeeks: DEFAULT_WEEKS });
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const dayButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tooltipBaseId = `token-heatmap-${useId().replace(/:/g, "")}`;
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const l = (en: string, zh: string) => localize(language, en, zh);

  // Measure available body box and pick crisp 12-14px square tiles + exact full-week count
  // so the GitHub heatmap fills the card cleanly edge-to-edge without empty side voids.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width <= 0) return;
      const matrixHeight = height > 0 ? Math.max(96, height - 22) : 112;
      const cellSize = Math.max(
        MIN_CELL_SIZE,
        Math.min(MAX_CELL_SIZE, Math.floor((matrixHeight - 6 * CELL_GAP) / 7)),
      );
      const step = cellSize + CELL_GAP;
      const fit = Math.floor((width - GUTTER_TOTAL + CELL_GAP) / step);
      const visibleWeeks = Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, fit));
      setLayout((previous) => (
        previous.cellSize === cellSize && previous.visibleWeeks === visibleWeeks
          ? previous
          : { cellSize, visibleWeeks }
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { cellSize, visibleWeeks } = layout;
  const cellStep = cellSize + CELL_GAP;

  const fullDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", weekday: "short" }),
    [locale],
  );
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short" }),
    [locale],
  );

  // Slice history to align cleanly on Sunday for the leftmost column whenever enough days exist.
  const points = useMemo(() => {
    if (history.length === 0) return [];
    const lastDay = history[history.length - 1]!;
    const lastWeekday = new Date(lastDay.dayStart).getDay();
    const targetDays = (visibleWeeks - 1) * 7 + (lastWeekday + 1);
    return history.slice(-targetDays);
  }, [history, visibleWeeks]);

  const {
    cells,
    gridSlots,
    weekCount,
    monthLabels,
    total,
    activeDays,
    streak,
  } = useMemo(() => {
    const levels = computeIntensityLevels(points);
    const totalTokens = points.reduce((sum, point) => sum + Math.max(0, point.totalTokens), 0);
    const active = points.reduce((count, point) => count + (point.totalTokens > 0 ? 1 : 0), 0);
    const currentStreak = computeCurrentStreak(history);

    if (points.length === 0) {
      return {
        cells: [] as HeatmapCell[],
        gridSlots: [] as Array<HeatmapCell | null>,
        weekCount: 0,
        monthLabels: [] as MonthLabel[],
        total: 0,
        activeDays: 0,
        streak: 0,
      };
    }

    const firstWeekday = new Date(points[0]!.dayStart).getDay();
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

    // Position month labels at exact pixel offsets while enforcing minimum separation so labels
    // never collide or clip into ellipses at the right edge.
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
    const spacedMonths: MonthLabel[] = [];
    for (let idx = 0; idx < rawMonths.length; idx++) {
      const entry = rawMonths[idx]!;
      const next = rawMonths[idx + 1];
      if (idx === 0 && next && (next.weekIndex - entry.weekIndex) * cellStep < 34) continue;
      if ((weeks - entry.weekIndex) * cellStep < 24) continue;
      const prev = spacedMonths[spacedMonths.length - 1];
      if (prev && (entry.weekIndex - prev.weekIndex) * cellStep < 34) continue;
      spacedMonths.push(entry);
    }

    return {
      cells: builtCells,
      gridSlots: slots,
      weekCount: weeks,
      monthLabels: spacedMonths,
      total: totalTokens,
      activeDays: active,
      streak: currentStreak,
    };
  }, [cellStep, history, monthFormatter, points]);

  const savedIndex = points.findIndex((point) => point.dayStart === selectedDayStart);
  const selectedIndex = savedIndex < 0 ? points.length - 1 : savedIndex;
  const activeIndex = hoveredIndex ?? (hasFocus ? selectedIndex : null);
  const activeCell = activeIndex !== null ? cells[activeIndex] ?? null : null;
  const today = points[points.length - 1] ?? null;

  const matrixWidth = weekCount > 0 ? weekCount * cellSize + (weekCount - 1) * CELL_GAP : 0;

  const tooltipAlignment = activeCell && weekCount > 1
    ? activeCell.weekIndex / (weekCount - 1) < 0.25
      ? "start"
      : activeCell.weekIndex / (weekCount - 1) > 0.75
        ? "end"
        : "center"
    : "center";

  const tooltipStyle: CSSProperties | undefined = activeCell && matrixWidth > 0
    ? tooltipAlignment === "start"
      ? { left: GUTTER_TOTAL }
      : tooltipAlignment === "end"
        ? { right: 0 }
        : { left: GUTTER_TOTAL + activeCell.weekIndex * cellStep + cellSize / 2 }
    : undefined;

  const weekdayLabels = language === "zh"
    ? ["", "一", "", "三", "", "五", ""]
    : ["", "Mon", "", "Wed", "", "Fri", ""];

  const rangeDays = points.length > 0 ? points.length : 90;

  return (
    <section
      className="workbench-token-trend"
      aria-label={l(`Token activity over the last ${rangeDays} days`, `近 ${rangeDays} 天 Token 活跃度`)}
    >
      <header className="workbench-token-trend-head">
        <div className="workbench-heatmap-title">
          <strong>{l("Activity", "活跃度")}</strong>
          <span className={`workbench-heatmap-period${activeCell ? " is-active" : ""}`}>
            {activeCell
              ? fullDate.format(activeCell.day.dayStart)
              : streak > 1
                ? l(`${activeDays}d active · ${streak}d streak`, `活跃 ${activeDays} 天 · 连续 ${streak} 天`)
                : l(`${activeDays}/${rangeDays}d active`, `近 ${rangeDays} 天 · 活跃 ${activeDays} 天`)}
          </span>
        </div>
        <span><b>{formatTokenCount(activeCell ? activeCell.day.totalTokens : total)}</b> Token</span>
      </header>

      <div ref={bodyRef} className="workbench-heatmap-body">
        {points.length > 0 ? (
          <div
            className="workbench-heatmap-stage"
            style={{ width: `${GUTTER_TOTAL + matrixWidth}px`, "--heatmap-cell": `${cellSize}px` } as CSSProperties}
          >
            <div className="workbench-heatmap-months" style={{ width: `${matrixWidth}px`, marginLeft: `${GUTTER_TOTAL}px` }} aria-hidden="true">
              {monthLabels.map((entry) => (
                <span
                  key={`${entry.weekIndex}-${entry.label}`}
                  style={{ left: `${entry.weekIndex * cellStep}px` }}
                >
                  {entry.label}
                </span>
              ))}
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
                style={{ gridTemplateColumns: `repeat(${weekCount}, ${cellSize}px)` }}
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
              {l("No Token activity yet", "暂无 Token 活跃记录")}
            </span>
          </div>
        )}
      </div>

      <footer className="workbench-token-trend-foot">
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
        <span className="workbench-heatmap-legend" aria-label={l("Activity intensity legend", "活跃度图例")}>
          <span>{l("Less", "少")}</span>
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <i key={level} className="workbench-heatmap-swatch" data-level={level} aria-hidden="true" />
          ))}
          <span>{l("More", "多")}</span>
        </span>
      </footer>
    </section>
  );
}
