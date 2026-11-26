import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock3, CornerDownRight, Rows3, Search, Wrench, X } from "lucide-react";
import { formatMessageTime } from "../../../../core/format-session";
import type { SessionContextSample, SessionTraceSpan, SessionTurnDetail, SessionTurnMessage } from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import { ipcErrorText } from "../status/status-messages";
import { IconButton, Notice } from "../../ui/primitives";
import { contextChart } from "./context-chart";
import { ContextLine } from "./context-line";
import { trajectoryRows, type TrajectoryOptions, type TrajectoryRow } from "./trajectory-rows";
import { durationLabel, durationMs, payloadText, spanDisplayName, spanStatusLabel, turnStatusLabel } from "./turn-timeline";

type Selection =
  | { key: string; turnId: string; kind: "message"; messageIndex: number }
  | { key: string; turnId: string; kind: "span"; spanId: string };

const TURN_ROW_HEIGHT = 32;
const ROW_HEIGHT = 28;
const INSPECTOR_TEXT_LIMIT = 60_000;

function roleLabel(role: SessionTurnMessage["role"], language: LanguageMode): string {
  if (role === "user") return localize(language, "User", "用户");
  if (role === "assistant") return localize(language, "Assistant", "助手");
  return role;
}

function spanBadge(row: Extract<TrajectoryRow, { kind: "span" }>, language: LanguageMode): string {
  if (!row.tool) return localize(language, "Event", "事件");
  return row.depth === 1 ? localize(language, "Subcall", "子调用") : localize(language, "Tool", "工具");
}

function rowTurnId(row: TrajectoryRow): string {
  return row.kind === "turn" ? row.turn.id : row.turnId;
}

function selectionOf(row: TrajectoryRow): Selection | null {
  if (row.kind === "message") return { key: row.key, turnId: row.turnId, kind: "message", messageIndex: row.message.messageIndex };
  if (row.kind === "span" || row.kind === "step") return { key: row.key, turnId: row.turnId, kind: "span", spanId: row.span.id };
  return null;
}

/**
 * The Session as a run trajectory: a strip of every Turn on one time axis above a ledger with one
 * line per message and call. Lines show previews; selecting one loads its Turn and shows the full
 * record beside the ledger.
 */
export function TrajectoryView({
  sessionKey,
  version,
  language,
  matchedTurnId,
  findRequest,
  onLoadTurn,
  loadTrajectory,
  loadContext,
}: {
  sessionKey: string;
  /** Changes when the Session's records change; the ledger reloads in place. */
  version: string;
  language: LanguageMode;
  matchedTurnId: string | null;
  /** Changes each time the reader asks to search the panel. */
  findRequest: number;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  loadTrajectory?: (sessionKey: string) => Promise<SessionTurnDetail[]>;
  loadContext?: (sessionKey: string) => Promise<SessionContextSample[]>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [trajectory, setTrajectory] = useState<SessionTurnDetail[] | null>(null);
  const [context, setContext] = useState<SessionContextSample[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<TrajectoryOptions>({ turns: true, calls: true, subcalls: true, query: "" });
  const [showDuration, setShowDuration] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  useEffect(() => {
    setTrajectory(null);
    setContext([]);
    setSelection(null);
    positionedRef.current = false;
  }, [sessionKey]);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    const load = loadTrajectory ?? window.sessionSearch.getSessionTrajectory;
    load(sessionKey).then(
      (loaded) => { if (active) setTrajectory(loaded); },
      (error: unknown) => { if (active) setLoadError(ipcErrorText(error)); },
    );
    return () => { active = false; };
  }, [loadTrajectory, sessionKey, version]);

  // The line above the ledger is an extra; without it the trajectory still reads in full.
  useEffect(() => {
    let active = true;
    const load = loadContext ?? window.sessionSearch.getSessionContext;
    load(sessionKey).then(
      (loaded) => { if (active) setContext(loaded); },
      (error: unknown) => {
        console.warn("Could not load the context of the Session's model calls", error);
        if (active) setContext([]);
      },
    );
    return () => { active = false; };
  }, [loadContext, sessionKey, version]);

  useEffect(() => {
    if (findRequest === 0) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [findRequest]);

  const rows = useMemo(() => (trajectory ? trajectoryRows(trajectory, options) : []), [options, trajectory]);
  const chart = useMemo(() => (context.length > 0 ? contextChart(context) : null), [context]);
  const callCount = useMemo(
    () => trajectory?.reduce((total, turn) => total + turn.spans.filter((span) => span.kind === "tool").length, 0) ?? 0,
    [trajectory],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ledgerRef.current,
    estimateSize: (index) => (rows[index]?.kind === "turn" ? TURN_ROW_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 20,
  });

  // Open at the Turn the reader came for, otherwise at the newest records, like a log.
  useLayoutEffect(() => {
    if (positionedRef.current || rows.length === 0) return;
    positionedRef.current = true;
    const target = matchedTurnId === null ? -1 : rows.findIndex((row) => row.kind === "turn" && row.turn.id === matchedTurnId);
    virtualizer.scrollToIndex(target >= 0 ? target : rows.length - 1, { align: target >= 0 ? "start" : "end" });
  }, [matchedTurnId, rows, virtualizer]);

  const jumpToTurn = useCallback((turnId: string) => {
    const index = rows.findIndex((row) => rowTurnId(row) === turnId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
  }, [rows, virtualizer]);

  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const viewport = virtualizer.scrollRect?.height ?? 0;
  const items = virtualizer.getVirtualItems();
  const visibleTurns = items
    .filter((item) => item.end > scrollOffset && item.start < scrollOffset + viewport && rows[item.index])
    .map((item) => rowTurnId(rows[item.index]));

  const toggle = (part: "turns" | "calls" | "subcalls") => setOptions((current) => ({ ...current, [part]: !current[part] }));
  const toggles = [
    { label: l("Duration", "耗时"), icon: <Clock3 size={13} />, pressed: showDuration, onClick: () => setShowDuration((value) => !value) },
    { label: l("Turns", "轮次"), icon: <Rows3 size={13} />, pressed: options.turns, onClick: () => toggle("turns") },
    { label: l("Calls", "调用"), icon: <Wrench size={13} />, pressed: options.calls, onClick: () => toggle("calls") },
    { label: l("Subcalls", "子调用"), icon: <CornerDownRight size={13} />, pressed: options.subcalls, onClick: () => toggle("subcalls") },
  ];

  return (
    <section className="trajectory" aria-label={l("Run trajectory", "运行轨迹")} data-duration={showDuration ? "shown" : "hidden"}>
      <div className="trajectory-toolbar">
        <div className="trajectory-toggles" role="group" aria-label={l("Show in the ledger", "显示内容")}>
          {toggles.map((item) => (
            <button key={item.label} type="button" aria-pressed={item.pressed} onClick={item.onClick}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        {trajectory ? (
          <span className="trajectory-count">
            {l(`${trajectory.length} Turns · ${callCount.toLocaleString()} calls`, `${trajectory.length} 轮 · ${callCount.toLocaleString()} 次调用`)}
          </span>
        ) : null}
        <label className="trajectory-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={options.query}
            placeholder={l("Search the trajectory", "搜索轨迹")}
            aria-label={l("Search the trajectory", "搜索轨迹")}
            onChange={(event) => {
              const query = event.currentTarget.value;
              setOptions((current) => ({ ...current, query }));
            }}
          />
        </label>
      </div>
      {chart ? <ContextLine chart={chart} visibleTurns={visibleTurns} language={language} onJump={jumpToTurn} /> : null}
      {loadError ? <Notice kind="error">{l(`Could not load the trajectory: ${loadError}`, `没能读取运行轨迹：${loadError}`)}</Notice> : null}
      <div className="trajectory-body" data-inspecting={selection ? "true" : "false"}>
        <div className="trajectory-ledger" ref={ledgerRef} role="list" aria-label={l("Trajectory records", "轨迹记录")}>
          {trajectory === null && !loadError ? <div className="trajectory-empty">{l("Loading the trajectory…", "正在读取运行轨迹…")}</div> : null}
          {trajectory !== null && rows.length === 0 ? (
            <div className="trajectory-empty">{options.query ? l("Nothing matches.", "没有匹配的记录。") : l("No records in this Session.", "这个会话没有记录。")}</div>
          ) : null}
          <div className="trajectory-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div key={item.key} className="trajectory-slot" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
                  <LedgerRow
                    row={row}
                    language={language}
                    selected={selection?.key === row.key}
                    onSelect={() => setSelection(selectionOf(row))}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {selection ? (
          <Inspector
            key={selection.key}
            selection={selection}
            language={language}
            onLoadTurn={onLoadTurn}
            onClose={() => setSelection(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function LedgerRow({ row, language, selected, onSelect }: {
  row: TrajectoryRow;
  language: LanguageMode;
  selected: boolean;
  onSelect(): void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (row.kind === "turn") {
    const { turn } = row;
    const duration = durationLabel(durationMs(turn.startedAt, turn.endedAt));
    return (
      <div className="trajectory-turn" role="listitem" data-row-kind="turn" data-status={turn.status}>
        <strong>{l(`Turn ${turn.turnIndex + 1}`, `第 ${turn.turnIndex + 1} 轮`)}</strong>
        {turn.startedAt ? <span>{formatMessageTime(turn.startedAt, language)}</span> : null}
        {duration ? <span>{duration}</span> : null}
        {turn.totalTokens > 0 ? <span>{l(`${formatTokenCount(turn.totalTokens)} tokens`, `${formatTokenCount(turn.totalTokens)} token`)}</span> : null}
        {turn.status === "failed" || turn.status === "running" || turn.status === "aborted" ? (
          <span className="trajectory-status" data-status={turn.status}>{turnStatusLabel(turn.status, language)}</span>
        ) : null}
      </div>
    );
  }
  if (row.kind === "message") {
    return (
      <button type="button" className="trajectory-row" role="listitem" data-row-kind="message" aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <span className="trajectory-badge" data-role={row.message.role}>{roleLabel(row.message.role, language)}</span>
        <span className="trajectory-text">{row.text}</span>
      </button>
    );
  }
  if (row.kind === "step") {
    const duration = durationLabel(durationMs(row.span.startedAt, row.span.endedAt));
    return (
      <button type="button" className="trajectory-row" role="listitem" data-row-kind="step" aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <span className="trajectory-badge" data-role="assistant">{roleLabel("assistant", language)}</span>
        {row.text
          ? <span className="trajectory-text trajectory-reasoning">{row.text}</span>
          : <span className="trajectory-text trajectory-quiet">{l("(called tools only)", "（只调用了工具）")}</span>}
        {duration ? <span className="trajectory-duration">{duration}</span> : null}
      </button>
    );
  }
  const { span } = row;
  const duration = durationLabel(durationMs(span.startedAt, span.endedAt));
  const attention = span.status === "failed" || span.status === "running" || span.status === "aborted";
  return (
    <button
      type="button"
      className="trajectory-row"
      role="listitem"
      data-row-kind="span"
      data-depth={row.depth}
      data-status={span.status}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="trajectory-badge" data-role={row.tool ? (row.depth === 1 ? "subcall" : "tool") : "event"}>{spanBadge(row, language)}</span>
      <span className="trajectory-name">{spanDisplayName(span)}</span>
      <span className="trajectory-text trajectory-code">
        {row.input}
        {row.output ? <span className="trajectory-output">{` → ${row.output}`}</span> : null}
      </span>
      {attention ? <span className="trajectory-status" data-status={span.status}>{spanStatusLabel(span, language)}</span> : null}
      {row.foldedSubcalls > 0 ? <span className="trajectory-folded" title={l(`${row.foldedSubcalls} subcalls folded`, `折叠了 ${row.foldedSubcalls} 个子调用`)}>+{row.foldedSubcalls}</span> : null}
      {duration ? <span className="trajectory-duration">{duration}</span> : null}
    </button>
  );
}

function Inspector({ selection, language, onLoadTurn, onClose }: {
  selection: Selection;
  language: LanguageMode;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  onClose(): void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [turn, setTurn] = useState<SessionTurnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    onLoadTurn(selection.turnId).then(
      (loaded) => {
        if (!active) return;
        if (loaded) setTurn(loaded);
        else setError(l("This Turn is no longer in the index. Refresh the Session and try again.", "索引里已经没有这一轮了，请刷新会话后再试。"));
      },
      (cause: unknown) => { if (active) setError(ipcErrorText(cause)); },
    );
    return () => { active = false; };
    // The parent keys this component by selection, so one load per mount is enough.
  }, []);

  const message = selection.kind === "message" ? turn?.messages.find((item) => item.messageIndex === selection.messageIndex) : undefined;
  const span: SessionTraceSpan | undefined = selection.kind === "span" ? turn?.spans.find((item) => item.id === selection.spanId) : undefined;
  const step = span?.kind === "event" && span.attributes.eventType === "deepseek.step";
  const title = step ? l("Model step", "模型步骤") : span ? spanDisplayName(span) : message ? roleLabel(message.role, language) : "";
  const meta = span
    ? [spanStatusLabel(span, language), span.startedAt ? formatMessageTime(span.startedAt, language) : null, durationLabel(durationMs(span.startedAt, span.endedAt))]
    : message ? [message.timestamp ? formatMessageTime(message.timestamp, language) : null] : [];

  return (
    <aside className="trajectory-inspector" aria-label={l("Record details", "记录详情")}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{meta.filter(Boolean).join(" · ")}</p>
        </div>
        <IconButton label={l("Close", "关闭")} icon={<X size={15} />} onClick={onClose} />
      </header>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!turn && !error ? <p className="trajectory-empty">{l("Loading…", "正在读取…")}</p> : null}
      {message ? (
        <div className="trajectory-inspector-body catalog-markdown">
          <Markdown text={markdownPreview(message.content, INSPECTOR_TEXT_LIMIT, l("…(truncated)", "…（已截断）"))} language={language} />
        </div>
      ) : null}
      {span ? (
        <div className="trajectory-inspector-body">
          {span.input ? <Section title={l("Input", "输入")} text={payloadText(span.input)} /> : null}
          {span.output ? <Section title={step ? l("Reasoning", "思考") : l("Output", "输出")} text={payloadText(span.output)} /> : null}
          {step && !span.output ? <p className="trajectory-empty">{l("The model called tools without writing any reasoning.", "模型没有写思考，直接调用了工具。")}</p> : null}
          {span.error ? <Section title={l("Error", "错误")} text={span.error} /> : null}
        </div>
      ) : null}
      {turn && !message && !span ? <p className="trajectory-empty">{l("This record changed since the list loaded. Refresh the Session.", "这条记录在列表加载后已变化，请刷新会话。")}</p> : null}
    </aside>
  );
}

function Section({ title, text }: { title: string; text: string }): ReactElement {
  return (
    <section>
      <h4>{title}</h4>
      <pre>{text.length > INSPECTOR_TEXT_LIMIT ? `${text.slice(0, INSPECTOR_TEXT_LIMIT)}…` : text}</pre>
    </section>
  );
}
