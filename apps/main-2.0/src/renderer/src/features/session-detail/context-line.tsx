import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { formatTokenCount } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import type { ContextChart } from "./context-chart";

const PLOT_HEIGHT = 56;
const TOP_GAP = 4;
const LABEL_HEIGHT = 14;
/** Turn numbers under the line stay at least this far apart. */
const TURN_LABEL_GAP = 64;

/**
 * The context every model call sent, squeezed to the width of the trajectory: where the Session
 * grew, where it was compacted, and which part of it the ledger below shows.
 */
export function ContextLine({ chart, visibleTurns, language, onJump }: {
  chart: ContextChart;
  /** Turn ids the ledger shows right now, in order. */
  visibleTurns: string[];
  language: LanguageMode;
  onJump(turnId: string): void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    setWidth(plot.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(plot.clientWidth));
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

  const { points, summary } = chart;
  const { xOf, yOf, line } = useMemo(() => {
    const step = points.length > 1 ? width / (points.length - 1) : 0;
    const x = (index: number) => (points.length > 1 ? index * step : width / 2);
    const y = (value: number) => TOP_GAP + (PLOT_HEIGHT - TOP_GAP) * (1 - value / Math.max(summary.peak, 1));
    return { xOf: x, yOf: y, line: points.map((point, index) => `${x(index)},${y(point.total)}`).join(" ") };
  }, [points, summary.peak, width]);

  /** First and last call of each Turn, so the ledger's visible Turns map onto the line. */
  const turnRanges = useMemo(() => {
    const ranges = new Map<string, { first: number; last: number }>();
    chart.turns.forEach((turn, position) => {
      if (turn.turnId === null) return;
      const next = chart.turns[position + 1]?.index ?? points.length;
      ranges.set(turn.turnId, { first: turn.index, last: next - 1 });
    });
    return ranges;
  }, [chart.turns, points.length]);

  const visibleWindow = useMemo(() => {
    const ranges = visibleTurns.map((turnId) => turnRanges.get(turnId)).filter((range) => range !== undefined);
    if (ranges.length === 0 || width === 0) return null;
    const left = xOf(ranges[0].first);
    return { left, width: Math.max(xOf(ranges[ranges.length - 1].last) - left, 2) };
  }, [turnRanges, visibleTurns, width, xOf]);

  const labelledTurns = useMemo(() => {
    let lastX = -Infinity;
    return chart.turns.filter((turn) => {
      const x = xOf(turn.index);
      if (turn.turnIndex === null || x - lastX < TURN_LABEL_GAP) return false;
      lastX = x;
      return true;
    });
  }, [chart.turns, xOf]);

  const indexAt = (clientX: number, rect: DOMRect): number | null => {
    if (rect.width === 0 || points.length === 0) return null;
    const at = Math.round(((clientX - rect.left) / rect.width) * (points.length - 1));
    return Math.min(Math.max(at, 0), points.length - 1);
  };

  const point = hovered === null ? null : points[hovered] ?? null;
  const tipText = point
    ? [
      point.sample.turnIndex === null ? l("Before the first Turn", "第一轮之前") : l(`Turn ${point.sample.turnIndex + 1}`, `第 ${point.sample.turnIndex + 1} 轮`),
      l(`context ${point.total.toLocaleString()}`, `上下文 ${point.total.toLocaleString()}`),
      ...(point.compacted ? [l("after a compaction", "压缩之后")] : []),
    ].join(" · ")
    : null;

  return (
    <div className="trajectory-context">
      <div className="trajectory-context-label" title={l("Largest context of a model call", "单次模型调用的最大上下文")}>
        <span>{l("Context", "上下文")}</span>
        <strong>{formatTokenCount(summary.peak)}</strong>
      </div>
      <div className="trajectory-context-plot" ref={plotRef}>
        <svg
          width={width}
          height={PLOT_HEIGHT + LABEL_HEIGHT}
          role="img"
          aria-label={l(
            `Context sent by each model call, up to ${formatTokenCount(summary.peak)} tokens, with ${summary.compactions} compactions. Click to jump to a Turn.`,
            `每次模型调用发送的上下文，最多 ${formatTokenCount(summary.peak)} Token，压缩 ${summary.compactions} 次。点击跳到对应的轮次。`,
          )}
          onMouseMove={(event) => setHovered(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()))}
          onMouseLeave={() => setHovered(null)}
          onClick={(event) => {
            const index = indexAt(event.clientX, event.currentTarget.getBoundingClientRect());
            const turnId = index === null ? null : points[index]?.sample.turnId;
            if (turnId) onJump(turnId);
          }}
        >
          {visibleWindow ? (
            <rect className="trajectory-context-window" x={visibleWindow.left} y={0} width={visibleWindow.width} height={PLOT_HEIGHT} />
          ) : null}
          <polygon className="trajectory-context-area" points={`0,${PLOT_HEIGHT} ${line} ${xOf(points.length - 1)},${PLOT_HEIGHT}`} />
          <polyline className="trajectory-context-line" points={line} />
          {points.map((item, index) => (item.compacted ? (
            <circle key={index} className="trajectory-context-compaction" cx={xOf(index)} cy={yOf(item.total)} r={2.5} />
          ) : null))}
          {labelledTurns.map((turn) => (
            <text key={turn.index} className="context-turn-label" x={xOf(turn.index)} y={PLOT_HEIGHT + LABEL_HEIGHT - 2}>
              {l(`Turn ${turn.turnIndex! + 1}`, `第 ${turn.turnIndex! + 1} 轮`)}
            </text>
          ))}
          {hovered !== null ? (
            <line className="context-cursor" x1={xOf(hovered)} x2={xOf(hovered)} y1={0} y2={PLOT_HEIGHT} />
          ) : null}
        </svg>
        {tipText && hovered !== null ? (
          <div
            className="trajectory-context-tip"
            role="status"
            data-side={xOf(hovered) > width / 2 ? "left" : "right"}
            style={{ left: xOf(hovered) }}
          >
            {tipText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
