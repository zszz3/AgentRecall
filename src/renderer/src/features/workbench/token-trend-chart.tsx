import { useId, useState, type CSSProperties, type ReactElement } from "react";
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

interface TokenTrendChartProps {
  points: SessionDailyTokenUsage[];
  language: LanguageMode;
  onSelectDay?: (day: SessionDailyTokenUsage) => void;
}

interface ChartPoint {
  day: SessionDailyTokenUsage;
  x: number;
  y: number;
}

export function TokenTrendChart({ points, language, onSelectDay }: TokenTrendChartProps): ReactElement {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const gradientId = `token-trend-${useId().replace(/:/g, "")}`;
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const shortDate = new Intl.DateTimeFormat(locale, { weekday: "short" });
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
  const tooltipStyle: CSSProperties | undefined = activePoint
    ? activeIndex != null && activeIndex <= 1
      ? { left: 4 }
      : activeIndex != null && activeIndex >= chartPoints.length - 2
        ? { right: 4 }
        : { left: `${(activePoint.x / CHART_WIDTH) * 100}%` }
    : undefined;
  const tooltipAlignment = activeIndex != null && activeIndex <= 1
    ? "start"
    : activeIndex != null && activeIndex >= chartPoints.length - 2
      ? "end"
      : "center";

  return (
    <section className="workbench-token-trend" aria-label={l("Token usage over the last 7 days", "近 7 天 Token 用量")}>
      <header className="workbench-token-trend-head">
        <strong>{l("Token · Last 7 days", "近 7 天 Token")}</strong>
        <span><b>{formatTokenCount(total)}</b> Token</span>
      </header>

      <div className="workbench-token-trend-body">
        <div className="workbench-token-trend-canvas">
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
            const label = `${fullDate.format(point.day.dayStart)}, ${formatTokenCount(point.day.totalTokens)} Token`;
            return (
              <button
                key={point.day.dayStart}
                type="button"
                className={`workbench-token-trend-point ${index === chartPoints.length - 1 ? "today" : ""}`}
                style={{ left: `${(point.x / CHART_WIDTH) * 100}%`, top: `${(point.y / CHART_HEIGHT) * 100}%` }}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex((current) => (current === index ? null : current))}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex((current) => (current === index ? null : current))}
                onClick={() => onSelectDay?.(point.day)}
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
                <div><dt>{l("Cached", "缓存")}</dt><dd>{formatTokenCount(activePoint.day.cachedInputTokens)}</dd></div>
                <div><dt>{l("Output", "输出")}</dt><dd>{formatTokenCount(activePoint.day.outputTokens)}</dd></div>
                <div><dt>{l("Reasoning", "推理")}</dt><dd>{formatTokenCount(activePoint.day.reasoningOutputTokens)}</dd></div>
              </dl>
            </div>
          ) : null}

          {points.length > 0 && maxValue === 0 ? (
            <span className="workbench-token-trend-empty">{l("No Token usage in the last 7 days", "近 7 天暂无 Token 用量")}</span>
          ) : null}
        </div>

        <div className="workbench-token-trend-labels" aria-hidden="true">
          {points.map((point, index) => (
            <span key={point.dayStart} className={index === points.length - 1 ? "today" : ""}>{shortDate.format(point.dayStart)}</span>
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
