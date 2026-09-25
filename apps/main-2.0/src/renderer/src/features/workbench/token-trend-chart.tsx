import { useId, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { SessionDailyTokenUsage } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";

const CHART_WIDTH = 280;
const CHART_HEIGHT = 58;
const CHART_LEFT = 10;
const CHART_RIGHT = 10;
const CHART_TOP = 7;
const CHART_BOTTOM = 9;
const TREND_PERIOD_STORAGE_KEY = "agent-recall.workbench-token-trend-period.v2";

function loadTrendPeriod(): 7 | 30 | 90 {
  if (typeof window === "undefined") return 7;
  try {
    const stored = window.localStorage.getItem(TREND_PERIOD_STORAGE_KEY);
    return stored === "30" ? 30 : stored === "90" ? 90 : 7;
  } catch {
    // An unavailable browser profile must not prevent the chart from rendering.
    return 7;
  }
}

interface TokenTrendChartProps {
  points: SessionDailyTokenUsage[];
  language: LanguageMode;
  onSelectDay: (day: SessionDailyTokenUsage) => void;
}

interface ChartPoint {
  day: SessionDailyTokenUsage;
  x: number;
  y: number;
}

export function TokenTrendChart({ points: history = [], language, onSelectDay }: TokenTrendChartProps): ReactElement {
  const [period, setPeriod] = useState<7 | 30 | 90>(loadTrendPeriod);
  const points = history.slice(-period);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const dayButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const savedIndex = points.findIndex(point => point.dayStart === selectedDayStart);
  const selectedIndex = savedIndex < 0 ? points.length - 1 : savedIndex;
  const activeIndex = hoveredIndex ?? (hasFocus ? selectedIndex : null);
  const gradientId = `token-trend-${useId().replace(/:/g, "")}`;
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const shortDate = new Intl.DateTimeFormat(locale, period === 7 ? { weekday: "short" } : { month: "numeric", day: "numeric" });
  const fullDate = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" });
  const l = (en: string, zh: string) => localize(language, en, zh);
  const total = points.reduce((sum, point) => sum + Math.max(0, point.totalTokens), 0);
  const dailyAverage = points.length > 0 ? total / points.length : 0;
  const today = points[points.length - 1];
  const maxValue = Math.max(0, ...points.map((point) => point.totalTokens));
  const plotWidth = CHART_WIDTH - CHART_LEFT - CHART_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  const chartPoints: ChartPoint[] = points.map((day, index) => ({
    day,
    x: points.length <= 1 ? CHART_WIDTH / 2 : CHART_LEFT + (index / (points.length - 1)) * plotWidth,
    y: maxValue > 0
      ? CHART_TOP + (1 - Math.max(0, day.totalTokens) / maxValue) * plotHeight
      : CHART_TOP + plotHeight,
  }));
  const linePath = chartPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = chartPoints.length > 0
    ? `${linePath} L ${chartPoints[chartPoints.length - 1].x} ${CHART_HEIGHT - CHART_BOTTOM} L ${chartPoints[0].x} ${CHART_HEIGHT - CHART_BOTTOM} Z`
    : "";
  const activePoint = activeIndex == null ? null : chartPoints[activeIndex] ?? null;
  const tickCount = Math.min(points.length, period === 7 ? 7 : 5);
  const tickIndexes = Array.from({ length: tickCount }, (_, index) =>
    Math.round(index * (points.length - 1) / (tickCount - 1 || 1)));
  const tooltipAlignment = activePoint && activePoint.x < CHART_WIDTH * .35
    ? "start"
    : activePoint && activePoint.x > CHART_WIDTH * .65 ? "end" : "center";
  const tooltipStyle: CSSProperties | undefined = activePoint
    ? tooltipAlignment === "start"
      ? { left: 4 }
      : tooltipAlignment === "end"
        ? { right: 4 }
        : { left: `${(activePoint.x / CHART_WIDTH) * 100}%` }
    : undefined;
  const nearestDayIndex = (clientX: number, canvas: HTMLDivElement): number | null => {
    if (points.length === 0) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const chartX = (clientX - bounds.left) / bounds.width * CHART_WIDTH;
    return Math.max(0, Math.min(points.length - 1,
      Math.round((chartX - CHART_LEFT) / plotWidth * (points.length - 1))));
  };

  return (
    <section className="workbench-token-trend" data-period={period} aria-label={l(`Token usage over the last ${period} days`, `近 ${period} 天 Token 用量`)}>
      <header className="workbench-token-trend-head">
        <strong>Token</strong>
        <select className="workbench-period-select" aria-label={l("Trend period", "趋势周期")} value={period}
          onChange={event => {
            const value = Number(event.target.value);
            if (value !== 7 && value !== 30 && value !== 90) return;
            setPeriod(value);
            setSelectedDayStart(null);
            setHoveredIndex(null);
            try {
              window.localStorage.setItem(TREND_PERIOD_STORAGE_KEY, String(value));
            } catch {
              // A read-only browser profile still permits changes for this mount.
            }
          }}>
          {[7, 30, 90].map(days => <option key={days} value={days}>{l(`Last ${days} days`, `近 ${days} 天`)}</option>)}
        </select>
        <span><b>{formatTokenCount(total)}</b> Token</span>
      </header>

      <div className="workbench-token-trend-body">
        <div className="workbench-token-trend-canvas" role="toolbar"
          aria-label={l("Daily Token usage", "每日 Token 用量")}
          aria-orientation="horizontal"
          aria-description={l("Use Left and Right to choose a day, Home or End for the first or last day, and Enter or Space to view its sessions.",
            "使用左右方向键选择日期，Home 或 End 跳至首日或末日，Enter 或空格查看当天会话。")}
          onPointerMove={event => setHoveredIndex(nearestDayIndex(event.clientX, event.currentTarget))}
          onPointerLeave={() => setHoveredIndex(null)}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
          }}
          onClick={event => {
            const index = nearestDayIndex(event.clientX, event.currentTarget);
            if (index === null) return;
            dayButtons.current[index]?.focus({ preventScroll: true });
            onSelectDay(points[index]);
          }}>
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
              </linearGradient>
            </defs>
            <line className="workbench-token-trend-baseline" x1={CHART_LEFT} y1={CHART_HEIGHT - CHART_BOTTOM} x2={CHART_WIDTH - CHART_RIGHT} y2={CHART_HEIGHT - CHART_BOTTOM} />
            {areaPath ? <path className="workbench-token-trend-area" d={areaPath} fill={`url(#${gradientId})`} /> : null}
            {linePath ? <path className="workbench-token-trend-line" d={linePath} /> : null}
          </svg>

          {chartPoints.map((point, index) => {
            const label = l(
              `${fullDate.format(point.day.dayStart)}, ${point.day.totalTokens.toLocaleString(locale)} Token. View sessions`,
              `${fullDate.format(point.day.dayStart)}，${point.day.totalTokens.toLocaleString(locale)} Token。查看当天会话`,
            );
            return (
              <button
                key={point.day.dayStart}
                ref={element => { dayButtons.current[index] = element; }}
                type="button"
                tabIndex={index === selectedIndex ? 0 : -1}
                data-day-start={point.day.dayStart}
                className={`workbench-token-trend-point ${index === chartPoints.length - 1 ? "today" : ""} ${index === activeIndex ? "is-active" : ""}`}
                style={{ left: `${(point.x / CHART_WIDTH) * 100}%`, top: `${(point.y / CHART_HEIGHT) * 100}%` }}
                onFocus={() => {
                  setSelectedDayStart(point.day.dayStart);
                  setHoveredIndex(null);
                  setHasFocus(true);
                }}
                onKeyDown={event => {
                  const next = event.key === "ArrowLeft" ? Math.max(0, index - 1)
                    : event.key === "ArrowRight" ? Math.min(points.length - 1, index + 1)
                    : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  setHoveredIndex(null);
                  dayButtons.current[next]?.focus({ preventScroll: true });
                }}
                onClick={event => {
                  // Native button activation handles Enter/Space; do not also
                  // interpret that click as a pointer position on the canvas.
                  event.stopPropagation();
                  setSelectedDayStart(point.day.dayStart);
                  onSelectDay(point.day);
                }}
                aria-label={label}
                aria-describedby={activeIndex === index ? `${gradientId}-tooltip` : undefined}
              >
                <span aria-hidden="true" />
              </button>
            );
          })}

          {activePoint ? (
            <div
              id={`${gradientId}-tooltip`}
              className={`workbench-token-trend-tooltip ${tooltipAlignment}`}
              style={tooltipStyle}
              role="tooltip"
            >
              <div>
                <strong>{fullDate.format(activePoint.day.dayStart)}</strong>
                <b>{formatTokenCount(activePoint.day.totalTokens)}</b>
              </div>
              <dl>
                <div><dt>{l("Input", "输入")}</dt><dd>{formatTokenCount(activePoint.day.inputTokens)}</dd></div>
                <div><dt>{l("Cache read", "缓存读取")}</dt><dd>{formatTokenCount(activePoint.day.cachedInputTokens)}</dd></div>
                <div><dt>{l("Cache write", "缓存写入")}</dt><dd>{formatTokenCount(activePoint.day.cacheCreationInputTokens ?? 0)}</dd></div>
                <div><dt>{l("Output", "输出")}</dt><dd>{formatTokenCount(activePoint.day.outputTokens)}</dd></div>
                <div><dt>{l("Reasoning", "推理")}</dt><dd>{formatTokenCount(activePoint.day.reasoningOutputTokens)}</dd></div>
              </dl>
            </div>
          ) : null}

          {points.length > 0 && maxValue === 0 ? (
            <span className="workbench-token-trend-empty">{l(`No Token usage in the last ${period} days`, `近 ${period} 天暂无 Token 用量`)}</span>
          ) : null}
        </div>

        <div className="workbench-token-trend-labels" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${tickIndexes.length || 1}, minmax(0, 1fr))` }}>
          {tickIndexes.map(index => (
            <span key={points[index].dayStart} className={index === points.length - 1 ? "today" : ""}>{shortDate.format(points[index].dayStart)}</span>
          ))}
        </div>
      </div>

      <footer className="workbench-token-trend-foot">
        <span>{l("Daily avg", "日均")} <b>{formatTokenCount(dailyAverage)}</b></span>
        <span>{l("Today", "今天")} <b>{formatTokenCount(today?.totalTokens ?? 0)}</b></span>
      </footer>
    </section>
  );
}
