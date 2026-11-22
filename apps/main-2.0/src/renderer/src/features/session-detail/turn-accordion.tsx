import { MAX_SHARED_TURNS } from "../../../../shared/team-sessions";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactElement } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, BotMessageSquare, ChevronDown, ChevronRight, Clock3, GitFork, LoaderCircle, RotateCw, Wrench } from "lucide-react";

import { formatMessageTime } from "../../../../core/format-session";
import type {
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import { formatTokenCount } from "../../format-count";
import type { ContextMenuPoint } from "../../context-menu-position";
import { HighlightedSearchText, searchHighlightTerms } from "../../search-highlight";
import { localize, type LanguageMode } from "../../language";
import { createTurnAccordionState, turnAccordionReducer } from "./turn-accordion-state";
import {
  buildTurnTimeline,
  durationLabel,
  durationMs,
  turnStatusLabel,
  turnTimelineSearchText,
  turnTitle,
  type TurnMessageRoleFilter,
} from "./turn-timeline";
import { TurnContextMenu, TurnDetailTimeline, TurnDisplayState } from "./turn-blocks";

const EMPTY_TURN_DETAILS: Record<string, SessionTurnDetail | undefined> = {};

interface TurnFindMatch {
  key: string;
  turnId: string;
}

export function TurnAccordion({
  sessionKey,
  turns,
  loading,
  matchedTurnId,
  matchedMessageIndex,
  showTools,
  roleFilter = "all",
  query,
  findQuery = "",
  activeFindMatchIndex = null,
  language,
  live = false,
  isSubagent = false,
  onLoadTurn,
  onMigrateTurn,
  onShareTurns,
  turnNumbering = "visible",
  attachmentAccess = "session",
  onFindMatchCountChange,
}: {
  sessionKey: string;
  turns: SessionTurnSummary[];
  loading: boolean;
  matchedTurnId: string | null;
  matchedMessageIndex: number | null;
  showTools: boolean;
  roleFilter?: TurnMessageRoleFilter;
  query: string;
  findQuery?: string;
  activeFindMatchIndex?: number | null;
  language: LanguageMode;
  live?: boolean;
  isSubagent?: boolean;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  onMigrateTurn?: (turn: SessionTurnSummary) => void;
  onShareTurns?: (turnIds: string[]) => void;
  turnNumbering?: "visible" | "source";
  attachmentAccess?: "session" | "download";
  onFindMatchCountChange?: (count: number) => void;
}): ReactElement {
  const [state, dispatch] = useReducer(turnAccordionReducer, sessionKey, createTurnAccordionState);
  const activeSessionRef = useRef<string | null>(sessionKey);
  const detailsByIdRef = useRef(state.detailsById);
  const inFlightRef = useRef(new Map<string, Promise<void>>());
  const sessionGeneration = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusFrame = useRef<number | null>(null);
  const highlightTerms = useMemo(() => searchHighlightTerms(query), [query]);
  const findTerms = useMemo(() => searchHighlightTerms(findQuery), [findQuery]);
  const displayHighlightTerms = findTerms.length > 0 ? findTerms : highlightTerms;
  const messageQuery = findTerms.length > 0 ? findQuery : query;
  const [migrationMenu, setMigrationMenu] = useState<{
    point: ContextMenuPoint;
    turn: SessionTurnSummary;
  } | null>(null);
  const [selection, setSelection] = useState<{ sessionKey: string; ids: Set<string> } | null>(null);
  const selecting = Boolean(onShareTurns && selection?.sessionKey === sessionKey);
  const selectedIds = selecting ? turns.filter((turn) => selection!.ids.has(turn.id)).map((turn) => turn.id) : [];
  function toggleSelection(id: string) {
    setSelection((current) => {
      const ids = new Set(current?.sessionKey === sessionKey ? current.ids : []);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return { sessionKey, ids };
    });
  }
  const stateMatchesSession = state.sessionKey === sessionKey;
  const currentDetailsById = stateMatchesSession ? state.detailsById : EMPTY_TURN_DETAILS;

  detailsByIdRef.current = currentDetailsById;

  const loadTurn = useCallback(async (turnId: string): Promise<void> => {
    const generation = sessionGeneration.current;
    const requestKey = `${sessionKey}:${turnId}`;
    if (detailsByIdRef.current[turnId]) return;
    const inFlight = inFlightRef.current.get(requestKey);
    if (inFlight) return inFlight;
    const request = (async (): Promise<void> => {
      dispatch({ type: "load-started", turnId });
      try {
        const detail = await onLoadTurn(turnId);
        if (activeSessionRef.current !== sessionKey || generation !== sessionGeneration.current) return;
        if (!detail) throw new Error(localize(language, "Turn detail is unavailable.", "这一轮的详情不可用。"));
        dispatch({ type: "load-succeeded", turnId, detail });
      } catch (error) {
        if (activeSessionRef.current === sessionKey && generation === sessionGeneration.current) {
          dispatch({
            type: "load-failed",
            turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (generation === sessionGeneration.current) inFlightRef.current.delete(requestKey);
      }
    })();
    inFlightRef.current.set(requestKey, request);
    return request;
  }, [language, onLoadTurn, sessionKey]);

  const findMatches = useMemo(() => {
    if (findTerms.length === 0) return [] as TurnFindMatch[];
    const matches: TurnFindMatch[] = [];
    for (const turn of turns) {
      const detail = currentDetailsById[turn.id];
      if (!detail) continue;
      for (const item of buildTurnTimeline(detail, showTools, roleFilter)) {
        const text = turnTimelineSearchText(item).toLocaleLowerCase();
        if (findTerms.some((term) => text.includes(term))) {
          matches.push({ key: `${turn.id}:${item.key}`, turnId: turn.id });
        }
      }
    }
    return matches;
  }, [currentDetailsById, findTerms, roleFilter, showTools, turns]);
  const activeFindMatch = activeFindMatchIndex === null
    ? null
    : findMatches[activeFindMatchIndex] ?? null;

  const virtualized = turns.length > 100 && !loading;
  const [focusedTurn, setFocusedTurn] = useState<string | null>(null);
  const displayStates = useMemo(() => new Map<string, Map<string, boolean>>(), [sessionKey]);
  const turnIndexes = useMemo(() => new Map(turns.map((turn, index) => [turn.id, index])), [turns]);
  const getTurnKey = useCallback((index: number) => `${sessionKey}:${turns[index].id}`, [sessionKey, turns]);
  const virtualizer = useVirtualizer({
    count: turns.length,
    enabled: virtualized,
    getScrollElement: () => rootRef.current,
    estimateSize: () => 112,
    getItemKey: getTurnKey,
    overscan: 6,
    initialRect: { width: 800, height: 600 },
    useAnimationFrameWithResizeObserver: true,
    rangeExtractor: useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = new Set(defaultRangeExtractor(range));
      // Keep focus and its neighbors mounted so Tab can cross the window edge.
      const focused = focusedTurn ? turnIndexes.get(focusedTurn) : undefined;
      if (focused !== undefined) for (const index of [focused - 1, focused, focused + 1]) {
        if (index >= 0 && index < turns.length) indexes.add(index);
      }
      for (const id of [matchedTurnId, activeFindMatch?.turnId]) {
        const index = id ? turnIndexes.get(id) : undefined;
        if (index !== undefined) indexes.add(index);
      }
      return [...indexes].sort((a, b) => a - b);
    }, [activeFindMatch?.turnId, focusedTurn, matchedTurnId, turnIndexes, turns.length]),
  });
  const scrollToTurn = useCallback((id: string) => {
    const index = turnIndexes.get(id);
    if (virtualized && index !== undefined) virtualizer.scrollToIndex(index, { align: "center" });
  }, [turnIndexes, virtualized, virtualizer]);

  useLayoutEffect(() => {
    activeSessionRef.current = sessionKey;
    sessionGeneration.current++;
    inFlightRef.current.clear();
    dispatch({ type: "reset", sessionKey });
    setMigrationMenu(null);
    setSelection(null);
    setFocusedTurn(null);
    rootRef.current?.scrollTo?.({ top: 0 });
    return () => {
      activeSessionRef.current = null;
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    };
  }, [sessionKey]);

  useEffect(() => {
    if (findTerms.length === 0) return;
    let cancelled = false;
    const expectedSessionKey = sessionKey;
    void (async () => {
      for (const turn of turns) {
        if (cancelled || activeSessionRef.current !== expectedSessionKey) return;
        await loadTurn(turn.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [findTerms, loadTurn, sessionKey, turns]);

  useEffect(() => {
    onFindMatchCountChange?.(findMatches.length);
  }, [findMatches.length, onFindMatchCountChange]);

  useEffect(() => {
    if (!activeFindMatch) return;
    dispatch({ type: "open", turnId: activeFindMatch.turnId });
    scrollToTurn(activeFindMatch.turnId);
    const frame = window.requestAnimationFrame(() => {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-find-key]") ?? [])]
        .find((element) => element.dataset.findKey === activeFindMatch.key);
      target?.scrollIntoView({ behavior: virtualized ? "auto" : "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFindMatch?.key, scrollToTurn, virtualized]);

  useEffect(() => {
    if (!migrationMenu) return;
    const close = (): void => setMigrationMenu(null);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [migrationMenu]);

  useEffect(() => {
    if (!matchedTurnId || !turns.some((turn) => turn.id === matchedTurnId)) return;
    dispatch({ type: "open", turnId: matchedTurnId });
    void loadTurn(matchedTurnId);
    scrollToTurn(matchedTurnId);
    const frame = window.requestAnimationFrame(() => {
      [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [])]
        .find((element) => element.dataset.turnId === matchedTurnId)
        ?.scrollIntoView({ behavior: "auto", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadTurn, matchedTurnId, scrollToTurn, sessionKey, turns]);

  const matchedTurnDetail = matchedTurnId ? currentDetailsById[matchedTurnId] : undefined;
  useEffect(() => {
    if (!matchedTurnId || matchedMessageIndex === null || !matchedTurnDetail) return;
    const frame = window.requestAnimationFrame(() => {
      [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [])]
        .find((element) => element.dataset.turnId === matchedTurnId)
        ?.querySelector<HTMLElement>(`[data-message-index="${matchedMessageIndex}"]`)
        ?.scrollIntoView({ behavior: "auto", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [matchedMessageIndex, matchedTurnDetail, matchedTurnId]);

  function toggleTurn(turnId: string): void {
    const opening = !stateMatchesSession || !state.expandedTurnIds.has(turnId);
    dispatch({ type: "toggle", turnId });
    if (opening) void loadTurn(turnId);
  }

  const { executionStartIndex, forkedTurnCount, turnPresentation } = useMemo(() => {
    let visibleTurnNumber = 0;
    let subagentTurnNumber = 0;
    const executionStartIndex = isSubagent
      ? turns.findIndex((turn) => turn.subagentExecutionStart === true)
      : -1;
    const forkedTurnCount = executionStartIndex > 0
      ? turns.slice(0, executionStartIndex).filter((turn) => !turn.synthetic).length
      : 0;
    const turnPresentation = new Map(turns.map((turn, index) => {
      const agentTriggered = turn.agentTriggered === true
        && turn.sourceMessageIndex === null;
      if (!turn.synthetic || agentTriggered) visibleTurnNumber += 1;
      const origin = executionStartIndex >= 0
        ? index < executionStartIndex ? "inherited" as const : "subagent" as const
        : null;
      if (origin === "subagent" && (!turn.synthetic || agentTriggered)) subagentTurnNumber += 1;
      return [turn.id, {
        agentTriggered,
        displayTurnNumber: turnNumbering === "source" ? turn.turnIndex + 1 : visibleTurnNumber,
        origin,
        subagentTurnNumber: origin === "subagent" ? subagentTurnNumber : null,
      }] as const;
    }));

    return { executionStartIndex, forkedTurnCount, turnPresentation };
  }, [isSubagent, turns, turnNumbering]);
  if (loading) {
    return (
      <div className="turn-list-loading">
        <LoaderCircle size={16} className="spin" />
        {localize(language, "Loading Turns…", "正在加载各轮对话…")}
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="turn-list-empty">
        {localize(language, "No visible Turns were indexed for this Session.", "这个 Session 没有可展示的 Turn。")}
      </div>
    );
  }

  return (
    <div className="turn-list-shell">
    {selecting && <div className="turn-selection-toolbar" role="toolbar" aria-label={localize(language, "Turn selection", "轮次多选")}>
      <span role="status">{localize(language, `${selectedIds.length} selected`, `已选 ${selectedIds.length} 个轮次`)}</span>
      <button type="button" onClick={() => setSelection({ sessionKey, ids: new Set() })}>{localize(language, "Clear", "清空")}</button>
      <button type="button" className="turn-share-button" disabled={selectedIds.length === 0 || selectedIds.length > MAX_SHARED_TURNS} onClick={() => onShareTurns?.(selectedIds)}>{localize(language, "Share to team…", "分享到团队…")}</button>
      <button type="button" onClick={() => setSelection(null)}>{localize(language, "Cancel", "取消")}</button>
      {selectedIds.length > MAX_SHARED_TURNS && <small role="alert">{localize(language, `Select at most ${MAX_SHARED_TURNS} turns.`, `一次最多分享 ${MAX_SHARED_TURNS} 个轮次。`)}</small>}
    </div>}
    <div className="turn-list" ref={rootRef} data-virtualized={virtualized}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-turn-row]");
        setFocusedTurn(row?.dataset.turnRow ?? null);
      }}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedTurn(null);
      }}
      onKeyDown={(event) => {
        if (!virtualized || !(event.target instanceof HTMLButtonElement) || !event.target.classList.contains("turn-card-summary")) return;
        const id = event.target.closest<HTMLElement>("[data-turn-row]")?.dataset.turnRow;
        const current = id ? turnIndexes.get(id) : undefined;
        if (current === undefined) return;
        const index = event.key === "ArrowDown" ? Math.min(turns.length - 1, current + 1)
          : event.key === "ArrowUp" ? Math.max(0, current - 1)
          : event.key === "Home" ? 0 : event.key === "End" ? turns.length - 1 : null;
        if (index === null) return;
        event.preventDefault();
        const target = turns[index].id;
        setFocusedTurn(target);
        virtualizer.scrollToIndex(index, { align: "auto" });
        if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
        focusFrame.current = window.requestAnimationFrame(() => {
          focusFrame.current = null;
          if (activeSessionRef.current !== sessionKey) return;
          [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-turn-row]") ?? [])]
            .find((row) => row.dataset.turnRow === target)?.querySelector<HTMLButtonElement>(".turn-card-summary")?.focus({ preventScroll: true });
        });
      }}>
      <div className="turn-list-content" role="list" aria-label={localize(language, "Conversation turns", "对话轮次")}
        style={virtualized ? { height: virtualizer.getTotalSize(), position: "relative" } : { display: "contents" }}>
      {(virtualized ? virtualizer.getVirtualItems() : turns.map((turn, index) => ({ index, key: turn.id, start: 0 }))).map((row) => {
        const turnListIndex = row.index;
        const turn = turns[turnListIndex];
        const expanded = stateMatchesSession && state.expandedTurnIds.has(turn.id);
        const detail = currentDetailsById[turn.id];
        let displayState = displayStates.get(turn.id);
        if (expanded && !displayState) { displayState = new Map(); displayStates.set(turn.id, displayState); }
        const loadingDetail = stateMatchesSession && state.loadingTurnIds.has(turn.id);
        const error = stateMatchesSession ? state.errorsById[turn.id] : undefined;
        const elapsed = durationLabel(turn.durationMs ?? durationMs(turn.startedAt, turn.endedAt));
        const firstToken = durationLabel(turn.timeToFirstTokenMs ?? null);
        const presentation = turnPresentation.get(turn.id) ?? {
          agentTriggered: false,
          displayTurnNumber: turn.turnIndex + 1,
          origin: null,
          subagentTurnNumber: null,
        };
        const displayStatus: SessionTurnSummary["status"] =
          turn.status === "running"
            ? live ? "running" : "completed"
            : turn.status;
        const primaryPreview = roleFilter === "assistant"
          ? turn.assistantPreview
          : turn.userPreview || (roleFilter === "all" ? turn.assistantPreview : "");
        const secondaryPreview = roleFilter === "all" && turn.userPreview && turn.assistantPreview
          ? turn.assistantPreview
          : "";
        const previewText = primaryPreview || (presentation.agentTriggered
          ? localize(
              language,
              "Triggered by an agent; task text was not captured",
              "由 Agent 触发，任务文本未记录",
            )
          : localize(language, "No text captured", "没有记录文本"));
        return (
          <div key={row.key} data-index={turnListIndex} data-turn-row={turn.id}
            role="listitem" aria-posinset={turnListIndex + 1} aria-setsize={turns.length}
            ref={virtualized ? virtualizer.measureElement : undefined}
            className="turn-list-row"
            style={virtualized ? { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)`, paddingBottom: 7 } : undefined}>
            {turnListIndex === 0 && forkedTurnCount > 0 ? (
              <div className="turn-phase-divider inherited">
                <GitFork size={15} />
                <span>
                  <strong>{localize(language, "Context inherited from the parent Session", "继承自父会话的上下文")}</strong>
                  <small>{localize(
                    language,
                    `The following ${forkedTurnCount} Turns are conversation context inherited when the subagent was created`,
                    `以下 ${forkedTurnCount} 个 Turn 为创建子 Agent 时继承的会话上下文`,
                  )}</small>
                </span>
              </div>
            ) : null}
            {turnListIndex === executionStartIndex ? (
              <div className="turn-phase-divider subagent">
                <BotMessageSquare size={15} />
                <span>
                  <strong>{localize(language, "Subagent task execution", "子 Agent 任务执行")}</strong>
                  <small>{localize(
                    language,
                    "The following Turns record this subagent's task execution",
                    "以下 Turn 为该子 Agent 的任务执行记录",
                  )}</small>
                </span>
              </div>
            ) : null}
            <article
              className={`turn-card ${selecting && selection?.ids.has(turn.id) ? "is-selected" : ""} ${displayStatus} ${presentation.origin ? `turn-origin-${presentation.origin}` : ""} ${turn.id === matchedTurnId ? "match-target" : ""}`}
              data-turn-id={turn.id}
              data-turn-origin={presentation.origin ?? undefined}
              onContextMenu={onShareTurns || (onMigrateTurn && !turn.synthetic && turn.sourceMessageIndex !== null)
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMigrationMenu({
                      point: { x: event.clientX, y: event.clientY },
                      turn,
                    });
                  }
                : undefined}
            >
            <div className="turn-card-heading">
            {selecting && <input type="checkbox" className="turn-selection-checkbox"
              aria-label={localize(language, `Select turn ${turn.turnIndex + 1}`, `选择第 ${turn.turnIndex + 1} 轮`)}
              checked={selection?.ids.has(turn.id) ?? false} onChange={() => toggleSelection(turn.id)} />}
            <button
              className="turn-card-summary"
              type="button"
              aria-expanded={expanded}
              aria-controls={`turn-detail-${turn.id}`}
              onClick={() => toggleTurn(turn.id)}
            >
              <span className="turn-card-chevron">
                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </span>
              <span className="turn-card-copy">
                <span className="turn-card-eyebrow">
                  {turnTitle(
                    turn,
                    language,
                    presentation.displayTurnNumber,
                    presentation.agentTriggered,
                    presentation.origin,
                    presentation.subagentTurnNumber,
                  )}
                  {turn.startedAt ? <span>{formatMessageTime(turn.startedAt, language)}</span> : null}
                </span>
                <strong>
                  {displayHighlightTerms.length > 0
                    ? <HighlightedSearchText text={previewText} terms={displayHighlightTerms} />
                    : previewText}
                </strong>
                {secondaryPreview ? <small>{secondaryPreview}</small> : null}
              </span>
              <span className="turn-card-meta">
                <span className={`turn-status ${displayStatus}`}>{turnStatusLabel(displayStatus, language)}</span>
                {turn.spanCount > 0 ? (
                  <span title={localize(language, `${turn.spanCount} tool calls`, `${turn.spanCount} 次工具调用`)}>
                    <Wrench size={11} />
                    {turn.spanCount}
                  </span>
                ) : null}
                {turn.errorCount > 0 ? (
                  <span title={localize(language, `${turn.errorCount} errors`, `${turn.errorCount} 个错误`)}>
                    <AlertCircle size={11} />
                    {turn.errorCount}
                  </span>
                ) : null}
                {elapsed ? (
                  <span>
                    <Clock3 size={11} />
                    {elapsed}
                  </span>
                ) : null}
                {firstToken ? <span>TTFT {firstToken}</span> : null}
                {turn.totalTokens > 0 ? <span>{formatTokenCount(turn.totalTokens)} token</span> : null}
              </span>
            </button>
            </div>
            {expanded ? (
              <div className="turn-card-detail" id={`turn-detail-${turn.id}`}>
                {loadingDetail ? (
                  <div className="turn-detail-state">
                    <LoaderCircle size={15} className="spin" />
                    {localize(language, "Loading trajectory…", "正在加载轨迹…")}
                  </div>
                ) : error ? (
                  <div className="turn-detail-state error">
                    <span>{error}</span>
                    <button type="button" onClick={() => void loadTurn(turn.id)}>
                      <RotateCw size={13} />
                      {localize(language, "Retry", "重试")}
                    </button>
                  </div>
                ) : detail ? (
                  <TurnDisplayState.Provider value={displayState ?? null}>
                  <TurnDetailTimeline
                    sessionKey={sessionKey}
                    turnId={turn.id}
                    detail={detail}
                    showTools={showTools}
                    roleFilter={roleFilter}
                    query={messageQuery}
                    language={language}
                    matchedMessageIndex={turn.id === matchedTurnId ? matchedMessageIndex : null}
                    activeFindMatchKey={activeFindMatch?.key ?? null}
                    attachmentAccess={attachmentAccess}
                  />
                  </TurnDisplayState.Provider>
                ) : null}
              </div>
            ) : null}
            </article>
          </div>
        );
      })}
      </div>
      {migrationMenu ? (
        <TurnContextMenu
          point={migrationMenu.point}
          language={language}
          onSelect={onShareTurns ? () => {
            const id = migrationMenu.turn.id;
            setSelection((current) => ({ sessionKey, ids: new Set([...(current?.sessionKey === sessionKey ? current.ids : []), id]) }));
            setMigrationMenu(null);
          } : undefined}
          onMigrate={onMigrateTurn && !migrationMenu.turn.synthetic && migrationMenu.turn.sourceMessageIndex !== null ? () => {
            const selectedTurn = migrationMenu.turn;
            setMigrationMenu(null);
            onMigrateTurn(selectedTurn);
          } : undefined}
        />
      ) : null}
    </div>
    </div>
  );
}
