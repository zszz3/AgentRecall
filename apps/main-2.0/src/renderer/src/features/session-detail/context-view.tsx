import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import type { ReactElement } from "react";
import { formatMessageTime } from "../../../../core/format-session";
import type { SessionContextSample } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { ipcErrorText } from "../status/status-messages";
import { Button, IconButton, Notice } from "../../ui/primitives";
import { contextCallWidth, contextChart, type ContextPoint } from "./context-chart";

const ZOOM_STEP = 1.5;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const CHART_HEIGHT = 300;
const TOP_GAP = 12;
const TURN_LABEL_GAP = 72;

function niceStep(peak: number): number {
  const rough = peak / 4;
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= rough) ?? rough;
}

function areaPath(values: number[], scale: (value: number) => number, base: number[], callWidth: number): string {
  if (values.length === 0) return "";
  const top = values.map((value, index) => `${index * callWidth + callWidth / 2},${scale(value)}`);
  const bottom = base.map((value, index) => `${index * callWidth + callWidth / 2},${scale(value)}`).reverse();
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}

export function ContextView({
  sessionKey,
  version,
  language,
  matchedTurnId,
  onOpenTurn,
  loadContext,
}: {
  sessionKey: string;
  /** Changes when the Session's records change; the chart reloads in place. */
  version: string;
  language: LanguageMode;
  matchedTurnId: string | null;
  onOpenTurn(turnId: string): void;
  loadContext?: (sessionKey: string) => Promise<SessionContextSample[]>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [samples, setSamples] = useState<SessionContextSample[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  /** Show the tip left of the cursor when it would run past the visible part of the chart. */
  const [tipOnLeft, setTipOnLeft] = useState(false);
  const [viewport, setViewport] = useState(0);
  /** Multiplies the width that shows about a hundred Turns at once. */
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);
  /** Where in the chart, and where on screen, to keep the same call after a zoom. */
  const anchorRef = useRef<{ fraction: number; offset: number } | null>(null);

  useEffect(() => {
    setSamples(null);
    setHovered(null);
    setZoom(1);
    positionedRef.current = false;
  }, [sessionKey]);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    const load = loadContext ?? window.sessionSearch.getSessionContext;
    load(sessionKey).then(
      (loaded) => { if (active) setSamples(loaded); },
      (error: unknown) => { if (active) setLoadError(ipcErrorText(error)); },
    );
    return () => { active = false; };
  }, [loadContext, sessionKey, version]);

  const chart = useMemo(() => contextChart(samples ?? []), [samples]);
  const hasPoints = chart.points.length > 0;
  const callWidth = contextCallWidth({ calls: chart.points.length, turns: chart.turns.length, viewport, zoom });
  const width = chart.points.length * callWidth;
  const widthRef = useRef(width);
  widthRef.current = width;
  const step = niceStep(chart.summary.peak);
  const top = Math.max(step * Math.ceil(chart.summary.peak / step), 1);
  const scale = (value: number) => TOP_GAP + (CHART_HEIGHT - TOP_GAP) * (1 - value / top);
  const gridLines = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setViewport(scroller.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(scroller.clientWidth));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [hasPoints]);

  /** Zooms around a point of the visible chart, the centre unless the pointer gives one. */
  const zoomBy = useCallback((factor: number, offset?: number) => {
    const scroller = scrollRef.current;
    if (scroller && widthRef.current > 0) {
      const at = offset ?? scroller.clientWidth / 2;
      anchorRef.current = { fraction: (scroller.scrollLeft + at) / widthRef.current, offset: at };
    }
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor)));
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor) return;
    anchorRef.current = null;
    scroller.scrollLeft = anchor.fraction * width - anchor.offset;
  }, [width]);

  // A plain mouse wheel only scrolls vertically, so it moves along the calls; with Ctrl or ⌘ (and a
  // trackpad pinch, which arrives the same way) it zooms around the pointer.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomBy(Math.exp(-event.deltaY / 200), event.clientX - scroller.getBoundingClientRect().left);
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [hasPoints, zoomBy]);

  // Open at the Turn the reader came for, otherwise at the newest calls.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (positionedRef.current || !scroller || chart.points.length === 0 || viewport === 0) return;
    positionedRef.current = true;
    const turn = matchedTurnId === null ? undefined : chart.turns.find((item) => item.turnId === matchedTurnId);
    scroller.scrollLeft = turn ? Math.max(0, turn.index * callWidth - 40) : scroller.scrollWidth;
  }, [callWidth, chart, matchedTurnId, viewport]);

  const layers = useMemo(() => {
    const zero = chart.points.map(() => 0);
    const cached = chart.points.map((point) => point.sample.cachedInputTokens);
    const created = chart.points.map((point, index) => cached[index] + point.sample.cacheCreationInputTokens);
    const total = chart.points.map((point) => point.total);
    return { zero, cached, created, total };
  }, [chart]);

  const labelledTurns = useMemo(() => {
    let lastX = -Infinity;
    return chart.turns.filter((turn) => {
      const x = turn.index * callWidth;
      if (x - lastX < TURN_LABEL_GAP) return false;
      lastX = x;
      return true;
    });
  }, [callWidth, chart]);

  const point: ContextPoint | null = hovered === null ? null : chart.points[hovered] ?? null;
  const { summary } = chart;

  if (loadError) return <Notice kind="error">{l(`Could not load the context: ${loadError}`, `没能读取上下文记录：${loadError}`)}</Notice>;
  if (samples === null) return <div className="context-empty">{l("Loading the context…", "正在读取上下文记录…")}</div>;
  if (chart.points.length === 0) {
    return (
      <div className="context-empty">
        {l(
          "This Session has no usage recorded per model call. DeepSeek Harness and ZCode record it.",
          "这个会话没有逐次模型调用的用量记录。目前 DeepSeek Harness 和 ZCode 会记录这些数据。",
        )}
      </div>
    );
  }

  return (
    <section className="context-view" aria-label={l("Context per model call", "每次模型调用的上下文")}>
      <dl className="context-stats">
        <div><dt>{l("Model calls", "模型调用")}</dt><dd>{summary.calls.toLocaleString()}</dd></div>
        <div><dt>{l("Largest context", "最大上下文")}</dt><dd>{formatTokenCount(summary.peak)}</dd></div>
        <div><dt>{l("Latest context", "最新上下文")}</dt><dd>{formatTokenCount(summary.last)}</dd></div>
        <div><dt>{l("Read from cache", "缓存读取占比")}</dt><dd>{`${Math.round(summary.cacheShare * 100)}%`}</dd></div>
        <div><dt>{l("Compactions", "压缩")}</dt><dd>{summary.compactions.toLocaleString()}</dd></div>
        <div><dt>{l("Output", "输出")}</dt><dd>{formatTokenCount(summary.output)}</dd></div>
      </dl>
      <div className="context-toolbar">
        <div className="context-legend" aria-hidden="true">
          <span data-layer="cached">{l("Read from cache", "缓存读取")}</span>
          <span data-layer="created">{l("Written to cache", "本次新写入缓存")}</span>
          <span data-layer="input">{l("Not cached", "未缓存")}</span>
          <span data-layer="compaction">{l("Compaction", "压缩")}</span>
        </div>
        <div className="context-zoom" role="group" aria-label={l("Zoom", "缩放")}>
          <IconButton size="sm" label={l("Show more Turns", "显示更多轮次")} icon={<ZoomOut size={14} />} disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / ZOOM_STEP)} />
          <Button size="sm" variant="ghost" disabled={zoom === 1} onClick={() => zoomBy(1 / zoom)}>{l("About 100 Turns", "约 100 轮")}</Button>
          <IconButton size="sm" label={l("Show fewer Turns", "显示更少轮次")} icon={<ZoomIn size={14} />} disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_STEP)} />
        </div>
      </div>
      <div className="context-chart">
        <div className="context-axis" aria-hidden="true">
          {gridLines.map((value) => (
            <span key={value} style={{ top: scale(value) }}>{formatTokenCount(value)}</span>
          ))}
        </div>
        <div className="context-scroll" ref={scrollRef}>
          <svg
            width={width}
            height={CHART_HEIGHT + 22}
            role="img"
            aria-label={l(
              `Context sent by each of ${summary.calls} model calls, up to ${formatTokenCount(summary.peak)} tokens. Click a call to open its Turn in the trajectory.`,
              `${summary.calls} 次模型调用各自发送的上下文，最多 ${formatTokenCount(summary.peak)} Token。点击某次调用，在轨迹中打开它所在的轮次。`,
            )}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const index = Math.floor((event.clientX - rect.left) / callWidth);
              setHovered(index >= 0 && index < chart.points.length ? index : null);
              const visible = scrollRef.current?.getBoundingClientRect();
              setTipOnLeft(visible !== undefined && event.clientX > visible.left + visible.width / 2);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={() => {
              const turnId = point?.sample.turnId;
              if (turnId) onOpenTurn(turnId);
            }}
          >
            {gridLines.map((value) => (
              <line key={value} className="context-grid" x1={0} x2={width} y1={scale(value)} y2={scale(value)} />
            ))}
            {chart.turns.map((turn) => (
              <line key={`turn-${turn.index}`} className="context-turn" x1={turn.index * callWidth} x2={turn.index * callWidth} y1={TOP_GAP} y2={CHART_HEIGHT} />
            ))}
            <path className="context-area" data-layer="cached" d={areaPath(layers.cached, scale, layers.zero, callWidth)} />
            <path className="context-area" data-layer="created" d={areaPath(layers.created, scale, layers.cached, callWidth)} />
            <path className="context-area" data-layer="input" d={areaPath(layers.total, scale, layers.created, callWidth)} />
            <polyline
              className="context-line"
              points={layers.total.map((value, index) => `${index * callWidth + callWidth / 2},${scale(value)}`).join(" ")}
            />
            {chart.points.map((item, index) => (item.compacted ? (
              <line key={`compaction-${index}`} className="context-compaction" x1={index * callWidth} x2={index * callWidth} y1={TOP_GAP} y2={CHART_HEIGHT} />
            ) : null))}
            {labelledTurns.map((turn) => (
              <text key={`label-${turn.index}`} className="context-turn-label" x={turn.index * callWidth + 2} y={CHART_HEIGHT + 15}>
                {turn.turnIndex === null ? "" : l(`Turn ${turn.turnIndex + 1}`, `第 ${turn.turnIndex + 1} 轮`)}
              </text>
            ))}
            {hovered !== null ? (
              <line className="context-cursor" x1={hovered * callWidth + callWidth / 2} x2={hovered * callWidth + callWidth / 2} y1={TOP_GAP} y2={CHART_HEIGHT} />
            ) : null}
          </svg>
          {point && hovered !== null ? (
            <div
              className="context-tip"
              role="status"
              data-side={tipOnLeft ? "left" : "right"}
              style={{ left: tipOnLeft ? hovered * callWidth - 8 : hovered * callWidth + callWidth + 8 }}
            >
              <strong>
                {point.sample.turnIndex === null ? l("Before the first Turn", "第一轮之前") : l(`Turn ${point.sample.turnIndex + 1}`, `第 ${point.sample.turnIndex + 1} 轮`)}
                {" · "}
                {formatMessageTime(point.sample.occurredAt, language)}
              </strong>
              <span>{l(`Context ${point.total.toLocaleString()}`, `上下文 ${point.total.toLocaleString()}`)}{point.compacted ? l(" · after a compaction", " · 压缩之后") : ""}</span>
              <span>
                {l(
                  `Cache ${formatTokenCount(point.sample.cachedInputTokens)} · written ${formatTokenCount(point.sample.cacheCreationInputTokens)} · uncached ${formatTokenCount(point.sample.inputTokens)}`,
                  `缓存 ${formatTokenCount(point.sample.cachedInputTokens)} · 新写入 ${formatTokenCount(point.sample.cacheCreationInputTokens)} · 未缓存 ${formatTokenCount(point.sample.inputTokens)}`,
                )}
              </span>
              <span>{l(`Output ${formatTokenCount(point.sample.outputTokens)}`, `输出 ${formatTokenCount(point.sample.outputTokens)}`)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
