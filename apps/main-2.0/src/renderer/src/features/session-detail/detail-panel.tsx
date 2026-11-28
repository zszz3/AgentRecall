import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Sparkles } from "lucide-react";
import { tracePresentation } from "../../../../core/trace-presentation";
import type {
  SessionMessage,
  RuntimeInvocationSummary,
  SessionSearchResult,
  SessionTraceEvent,
  SessionContextSample,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import type { LiveSessionState } from "../../live-filter";
import type { ActionStatus } from "../../app-types";
import { searchHighlightTerms } from "../../search-highlight";
import { isBranchTag } from "../../session-ui";
import { readInitialToolEventsVisibility, storeToolEventsVisibility } from "../../tool-events-visibility";
import { TurnAccordion } from "./turn-accordion";
import type { SessionFamily } from "../../../../core/storage/types";
import { SubagentSessionTree } from "./subagent-session-tree";
import { SessionContextComponentsPanel } from "./session-context-components-panel";
import {
  conversationTimeline,
  filterConversationTimeline,
  timelineFindMatchKeys,
  type ConversationRoleFilter,
} from "./conversation-timeline";
import { ConversationToolbar } from "./conversation-toolbar";
import { DetailActions } from "./detail-actions";
import { DetailHeader, PanelSearchBar } from "./detail-header";
import { DetailSheet } from "./detail-sheet";
import { RuntimeInvocationHistory } from "./invocation-owner";
import { MessageBlock, TraceEventBlock } from "./message-blocks";
import { ContextView } from "./context-view";
import { TrajectoryView } from "./trajectory-view";
import { Segmented } from "../../ui/primitives";

type DetailView = "trajectory" | "context" | "turns";

const DETAIL_VIEW_STORAGE_KEY = "agent-recall-session-detail-view";

function readDetailView(): DetailView {
  try {
    const stored = window.localStorage.getItem(DETAIL_VIEW_STORAGE_KEY);
    return stored === "turns" || stored === "context" ? stored : "trajectory";
  } catch {
    // Storage can be unavailable (blocked or sandboxed); the trajectory is the default view then.
    return "trajectory";
  }
}

function storeDetailView(view: DetailView): void {
  try {
    window.localStorage.setItem(DETAIL_VIEW_STORAGE_KEY, view);
  } catch {
    // Without storage the choice lasts until the panel closes, which is all the reader loses.
  }
}

function conversationRoleEmptyLabel(filter: Exclude<ConversationRoleFilter, "all">, language: LanguageMode): string {
  return filter === "user"
    ? localize(language, "No User messages in the loaded conversation.", "当前已加载内容中没有用户消息。")
    : localize(language, "No Assistant messages in the loaded conversation.", "当前已加载内容中没有助手消息。");
}

export function DetailPanel({
  session,
  turns,
  turnsLoading,
  matchedTurnId,
  onLoadTurn,
  onLoadTrajectory,
  onLoadContext,
  onMigrateTurn,
  onShareTurns,
  messages,
  matchedContextMessages,
  matchedMessageIndex,
  traceEvents,
  loading,
  actionStatus,
  query,
  liveState,
  language,
  revealLabel,
  showItermAction,
  messagePageSize,
  olderMessageCount,
  onClose,
  onShowMore,
  onRename,
  onAddTag,
  onRemoveTag,
  onFavorite,
  onSummarize,
  summarizing,
  canResume,
  canMigrate,
  migrationTitle,
  onResume,
  onResumeIterm,
  onMigrate,
  onUploadRemote,
  remoteUploadDisabled = false,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onExportJson,
  onCopyPlain,
  onDelete,
  onReveal,
  readOnly = false,
  backdropClassName = "",
  sessionFamily,
  onOpenFamilySession,
  sessionFamilyLoadFailed = false,
  onRetrySessionFamily,
  onOpenInvocationOwner,
}: {
  session: SessionSearchResult;
  turns: SessionTurnSummary[] | null;
  turnsLoading: boolean;
  matchedTurnId: string | null;
  onLoadTurn: (turnId: string) => Promise<SessionTurnDetail | null>;
  /** Loads every Turn with short previews; defaults to the preload bridge. */
  onLoadTrajectory?: (sessionKey: string) => Promise<SessionTurnDetail[]>;
  onLoadContext?: (sessionKey: string) => Promise<SessionContextSample[]>;
  onMigrateTurn?: (turn: SessionTurnSummary) => void;
  onShareTurns?: (turnIds: string[]) => void;
  messages: SessionMessage[];
  matchedContextMessages: SessionMessage[];
  matchedMessageIndex: number | null;
  traceEvents: SessionTraceEvent[];
  loading: boolean;
  actionStatus: ActionStatus | null;
  query: string;
  liveState: LiveSessionState;
  language: LanguageMode;
  revealLabel: string;
  showItermAction: boolean;
  messagePageSize: number;
  olderMessageCount: number;
  onClose: () => void;
  onShowMore: () => void;
  onRename: () => void;
  onAddTag: () => void;
  onRemoveTag: (tagName: string) => void;
  onFavorite: () => void;
  onSummarize: () => void;
  summarizing: boolean;
  canResume: boolean;
  canMigrate: boolean;
  migrationTitle: string;
  onResume: () => void;
  onResumeIterm: () => void;
  onMigrate: () => void;
  onUploadRemote?: () => void;
  remoteUploadDisabled?: boolean;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: (includeToolTrace: boolean) => void;
  onExportJson: () => void;
  onCopyPlain: () => void;
  onDelete: () => void;
  onReveal: () => void;
  readOnly?: boolean;
  backdropClassName?: string;
  sessionFamily: SessionFamily;
  onOpenFamilySession?: (sessionKey: string) => void;
  sessionFamilyLoadFailed?: boolean;
  onRetrySessionFamily?: () => void;
  onOpenInvocationOwner?: (invocation: RuntimeInvocationSummary) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const traceCount = useMemo(() => (turns === null
    ? traceEvents.filter((event) => tracePresentation(event).visibility !== "hidden").length
    : turns.reduce((total, turn) => total + turn.spanCount, 0)), [traceEvents, turns]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingInitialScrollRef = useRef<string | null>(session.sessionKey);
  const [roleFilter, setRoleFilter] = useState<ConversationRoleFilter>("all");
  const [showTools, setShowTools] = useState(readInitialToolEventsVisibility);
  const timelineItems = useMemo(() => conversationTimeline(messages, traceEvents), [messages, traceEvents]);
  const visibleTimelineItems = useMemo(
    () => filterConversationTimeline(timelineItems, roleFilter, showTools),
    [roleFilter, showTools, timelineItems],
  );

  const roleFilterEmpty = !loading
    && messages.length > 0
    && roleFilter !== "all"
    && !messages.some((message) => message.role === roleFilter);

  const toggleTools = () => {
    setShowTools((current) => {
      const next = !current;
      storeToolEventsVisibility(next);
      return next;
    });
  };

  const [view, setView] = useState<DetailView>(readDetailView);
  const [trajectoryFindRequest, setTrajectoryFindRequest] = useState(0);
  /** The Turn a click on the context chart asked the trajectory to open at. */
  const [trajectoryTurnId, setTrajectoryTurnId] = useState<string | null>(null);
  const trajectoryMode = turns !== null && view === "trajectory";
  const contextMode = turns !== null && view === "context";
  const [panelSearchOpen, setPanelSearchOpen] = useState(false);
  const [panelSearchQuery, setPanelSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [turnSearchMatchCount, setTurnSearchMatchCount] = useState(0);
  const panelSearchInputRef = useRef<HTMLInputElement>(null);

  const panelSearchTerms = useMemo(
    () => (panelSearchQuery ? searchHighlightTerms(panelSearchQuery) : []),
    [panelSearchQuery],
  );

  const panelSearchMatchKeys = useMemo(
    () => timelineFindMatchKeys(visibleTimelineItems, panelSearchTerms),
    [visibleTimelineItems, panelSearchTerms],
  );
  const panelSearchMatchCount = turns === null
    ? panelSearchMatchKeys.length
    : turnSearchMatchCount;

  useEffect(() => {
    if (panelSearchOpen && panelSearchInputRef.current) {
      panelSearchInputRef.current.focus();
      panelSearchInputRef.current.select();
    }
  }, [panelSearchOpen]);

  useEffect(() => {
    setCurrentMatchIndex(0);
    if (turns === null && panelSearchMatchKeys.length > 0) {
      requestAnimationFrame(() => scrollToPanelMatch(0));
    }
  }, [panelSearchQuery, roleFilter, showTools, turns]);

  useEffect(() => {
    setCurrentMatchIndex((current) => panelSearchMatchCount === 0
      ? 0
      : Math.min(current, panelSearchMatchCount - 1));
  }, [panelSearchMatchCount]);

  const scrollToPanelMatch = (index: number) => {
    if (turns !== null) return;
    const el = bodyRef.current;
    if (!el) return;
    const key = panelSearchMatchKeys[index];
    if (key === undefined) return;
    const target = el.querySelector(`[data-timeline-key="${key}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const nextPanelMatch = () => {
    if (panelSearchMatchCount === 0) return;
    const next = (currentMatchIndex + 1) % panelSearchMatchCount;
    setCurrentMatchIndex(next);
    scrollToPanelMatch(next);
  };

  const prevPanelMatch = () => {
    if (panelSearchMatchCount === 0) return;
    const prev = (currentMatchIndex - 1 + panelSearchMatchCount) % panelSearchMatchCount;
    setCurrentMatchIndex(prev);
    scrollToPanelMatch(prev);
  };

  const closePanelSearch = () => {
    setPanelSearchOpen(false);
    setPanelSearchQuery("");
    setCurrentMatchIndex(0);
  };

  useEffect(() => {
    pendingInitialScrollRef.current = session.sessionKey;
    setRoleFilter("all");
    setTurnSearchMatchCount(0);
    setPanelSearchOpen(false);
    setPanelSearchQuery("");
    setCurrentMatchIndex(0);
  }, [session.sessionKey]);

  useEffect(() => {
    if (pendingInitialScrollRef.current !== session.sessionKey) return;
    if (turns !== null) {
      if (turnsLoading || turns.length === 0) return;
      const frame = window.requestAnimationFrame(() => {
        if (matchedTurnId === null) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
        pendingInitialScrollRef.current = null;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (loading || messages.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      if (matchedMessageIndex !== null) {
        const target = bodyRef.current?.querySelector(`[data-message-index="${matchedMessageIndex}"]`) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: "auto", block: "center" });
        } else {
          bodyRef.current?.scrollTo({ top: 0 });
        }
      } else {
        bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
      }
      pendingInitialScrollRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    loading,
    matchedMessageIndex,
    matchedTurnId,
    messages.length,
    session.sessionKey,
    turns,
    turnsLoading,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = bodyRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;

      // Ctrl+F / Cmd+F: search the trajectory, or open panel search in the other views
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (trajectoryMode || contextMode) {
          if (contextMode) setView("trajectory");
          setTrajectoryFindRequest((current) => current + 1);
          return;
        }
        setPanelSearchOpen(true);
        panelSearchInputRef.current?.focus();
        panelSearchInputRef.current?.select();
        return;
      }

      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      // The trajectory ledger and the context chart scroll themselves; the panel body around them does not move.
      if (trajectoryMode || contextMode) return;
      const headerBottom = el.querySelector(".detail-header")?.getBoundingClientRect().bottom ?? 0;
      const obscuredHeight = Math.min(el.clientHeight, Math.max(0, headerBottom - el.getBoundingClientRect().top - el.clientTop));
      const page = (el.clientHeight - obscuredHeight) * 0.9;
      switch (event.key) {
        case "Escape":
          if (panelSearchOpen) {
            closePanelSearch();
            event.preventDefault();
          }
          return;
        case "ArrowDown":
          el.scrollBy({ top: 64 });
          break;
        case "ArrowUp":
          el.scrollBy({ top: -64 });
          break;
        case "PageDown":
        case " ":
          el.scrollBy({ top: page });
          break;
        case "PageUp":
          el.scrollBy({ top: -page });
          break;
        case "Home":
          el.scrollTo({ top: 0 });
          break;
        case "End":
          el.scrollTo({ top: el.scrollHeight });
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMode, panelSearchOpen, trajectoryMode, turns]);

  const chooseView = (next: DetailView) => {
    if (next !== "turns") closePanelSearch();
    setTrajectoryTurnId(null);
    setView(next);
    storeDetailView(next);
  };

  const openTurnInTrajectory = (turnId: string) => {
    setTrajectoryTurnId(turnId);
    setView("trajectory");
    storeDetailView("trajectory");
  };

  return (
    <DetailSheet backdropClassName={backdropClassName} language={language} onClose={onClose}>
      <div className="detail-body" ref={bodyRef}>
        <DetailHeader
          session={session}
          liveState={liveState}
          language={language}
          readOnly={readOnly}
          traceCount={traceCount}
          onRename={onRename}
          onFavorite={onFavorite}
          onClose={onClose}
        >
          {panelSearchOpen ? (
            <PanelSearchBar
              inputRef={panelSearchInputRef}
              query={panelSearchQuery}
              matchCount={panelSearchMatchCount}
              currentMatchIndex={currentMatchIndex}
              language={language}
              onQueryChange={(value) => {
                setPanelSearchQuery(value);
                setCurrentMatchIndex(0);
              }}
              onPrevious={prevPanelMatch}
              onNext={nextPanelMatch}
              onClose={closePanelSearch}
            />
          ) : null}
        </DetailHeader>
        <div className="detail-body-chrome">
          <RuntimeInvocationHistory session={session} language={language} />
          {!readOnly ? (
            <DetailActions
              session={session}
              language={language}
              actionRunning={actionStatus?.kind === "running"}
              revealLabel={revealLabel}
              showItermAction={showItermAction}
              canResume={canResume}
              canMigrate={canMigrate}
              migrationTitle={migrationTitle}
              summarizing={summarizing}
              remoteUploadDisabled={remoteUploadDisabled}
              onResume={onResume}
              onResumeIterm={onResumeIterm}
              onReveal={onReveal}
              onSummarize={onSummarize}
              onAddTag={onAddTag}
              onMigrate={onMigrate}
              onUploadRemote={onUploadRemote}
              onCopyResume={onCopyResume}
              onCopyMarkdown={onCopyMarkdown}
              onExportMarkdown={onExportMarkdown}
              onExportJson={onExportJson}
              onCopyPlain={onCopyPlain}
              onDelete={onDelete}
              onOpenInvocationOwner={onOpenInvocationOwner}
            />
          ) : null}
          <SessionContextComponentsPanel session={session} language={language} />
          {session.tags.length > 0 ? (
            <div className="detail-tags">
              {session.tags.map((tagName) => (
                <button key={tagName} className={`chip ${isBranchTag(tagName) ? "branch-tag" : ""}`} onClick={() => onRemoveTag(tagName)} disabled={readOnly}>
                  #{tagName} ×
                </button>
              ))}
            </div>
          ) : null}
          {onOpenFamilySession ? (
            <SubagentSessionTree
              key={session.sessionKey}
              family={sessionFamily}
              language={language}
              onOpen={onOpenFamilySession}
              loadFailed={sessionFamilyLoadFailed}
              onRetry={onRetrySessionFamily}
            />
          ) : null}
          {turns !== null ? (
            <div className="detail-view-switch">
              <Segmented<DetailView>
                label={l("Session view", "会话视图")}
                value={view}
                onChange={chooseView}
                options={[
                  { value: "trajectory", label: l("Trajectory", "轨迹") },
                  { value: "context", label: l("Context", "上下文") },
                  { value: "turns", label: l("Turns", "对话") },
                ]}
              />
            </div>
          ) : null}
          {trajectoryMode || contextMode ? null : (
            <ConversationToolbar
              turnCount={turns?.length ?? null}
              turnsLoading={turnsLoading}
              roleFilter={roleFilter}
              showTools={showTools}
              language={language}
              onRoleFilterChange={setRoleFilter}
              onToggleTools={toggleTools}
            />
          )}
          {session.aiSummary ? (
            <div className="detail-summary">
              <span className="detail-summary-label">
                <Sparkles size={12} /> {l("AI summary", "AI 摘要")}
                {session.aiSummaryStale ? ` · ${l("outdated", "已过期")}` : ""}
              </span>
              <p>{session.aiSummary}</p>
            </div>
          ) : null}
        </div>
        {trajectoryMode ? (
          <section className="conversation trajectory-conversation">
            <TrajectoryView
              sessionKey={session.sessionKey}
              version={JSON.stringify([session.fileMtimeMs, session.fileSize])}
              language={language}
              matchedTurnId={trajectoryTurnId ?? matchedTurnId}
              findRequest={trajectoryFindRequest}
              onLoadTurn={onLoadTurn}
              loadTrajectory={onLoadTrajectory}
              loadContext={onLoadContext}
            />
          </section>
        ) : contextMode ? (
          <section className="conversation trajectory-conversation">
            <ContextView
              sessionKey={session.sessionKey}
              version={JSON.stringify([session.fileMtimeMs, session.fileSize])}
              language={language}
              matchedTurnId={matchedTurnId}
              onOpenTurn={openTurnInTrajectory}
              loadContext={onLoadContext}
            />
          </section>
        ) : turns !== null ? (
          <section className="conversation turn-conversation">
            <TurnAccordion
              key={JSON.stringify([session.sessionKey, session.fileMtimeMs, session.fileSize])}
              sessionKey={session.sessionKey}
              turns={turns}
              loading={turnsLoading}
              matchedTurnId={matchedTurnId}
              matchedMessageIndex={matchedMessageIndex}
              showTools={showTools}
              roleFilter={roleFilter}
              query={query}
              findQuery={panelSearchOpen ? panelSearchQuery : ""}
              activeFindMatchIndex={panelSearchOpen && panelSearchQuery ? currentMatchIndex : null}
              language={language}
              live={liveState === "open"}
              isSubagent={session.isSubagent === true}
              onLoadTurn={onLoadTurn}
              onMigrateTurn={onMigrateTurn}
              onShareTurns={onShareTurns}
              onFindMatchCountChange={setTurnSearchMatchCount}
            />
          </section>
        ) : (
          <>
            {matchedContextMessages.length > 0 ? (
              <section className="matched">
                <h3>{l("Matched Context", "命中上下文")}</h3>
                {matchedContextMessages.map((message) => (
                  <MessageBlock
                    key={message.index}
                    timelineKey={`ctx-${message.index}`}
                    sessionKey={session.sessionKey}
                    message={message}
                    query={query}
                    language={language}
                    highlight
                    target={message.index === matchedMessageIndex}
                  />
                ))}
              </section>
            ) : null}
            <section className="conversation">
              {loading ? <div className="loading-state">{l("Loading conversation...", "正在加载会话...")}</div> : null}
              {!loading && messages.length === 0 ? <div className="loading-state">{l("No visible messages indexed for this session.", "这个会话没有可见消息被索引。")}</div> : null}
              {!loading && olderMessageCount > 0 ? (
                <button className="show-more" onClick={onShowMore}>
                  {l(`Show ${Math.min(messagePageSize, olderMessageCount)} older messages`, `再显示 ${Math.min(messagePageSize, olderMessageCount)} 条更早消息`)}
                </button>
              ) : null}
              {roleFilter !== "all" && roleFilterEmpty ? (
                <div className="conversation-empty">{conversationRoleEmptyLabel(roleFilter, language)}</div>
              ) : null}
              {visibleTimelineItems.map((item) => (
                item.kind === "message" ? (
                  <MessageBlock
                    key={item.key}
                    timelineKey={item.key}
                    sessionKey={session.sessionKey}
                    message={item.message}
                    query={panelSearchQuery || query}
                    language={language}
                    highlight={panelSearchQuery ? panelSearchMatchKeys.includes(item.key) : false}
                  />
                ) : (
                  <TraceEventBlock key={item.key} timelineKey={item.key} event={item.event} language={language} />
                )
              ))}
            </section>
          </>
        )}
      </div>
    </DetailSheet>
  );
}
