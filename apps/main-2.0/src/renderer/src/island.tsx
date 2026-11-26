import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  AlertCircle,
  Bell,
  BellOff,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  HelpCircle,
  Route,
  Trash2,
  X,
} from "lucide-react";
import type { IslandSnapshot, IslandTask } from "../../shared/ipc/island";
import { AgentIcon } from "./features/sessions/agent-icon";
import { readInitialLanguage, localize, type LanguageMode } from "./language";

const EMPTY_SNAPSHOT: IslandSnapshot = {
  enabled: false,
  muted: false,
  soundEnabled: true,
  suppressWhenFocused: true,
  autoCollapseSeconds: 6,
  tasks: [],
  highlightedTaskId: null,
  highlightVersion: 0,
};

// Matches .island-stage padding-top in island.css.
const STAGE_PADDING_TOP_PX = 6;
// Forgiveness halo used ONLY while the drawer/toast is already open so slight edge jitter never
// snaps it shut. Collapsed pills use 0px padding so passing near the pill never ghost-triggers.
const OPEN_LEAVE_PADDING_PX = 10;
const HOVER_OPEN_DELAY_MS = 220;
const LEAVE_CLOSE_DELAY_MS = 240;

interface HitRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 1000) return "";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function formatCompactTokens(tokens: IslandTask["tokens"]): string {
  if (!tokens) return "";
  const total = tokens.input + tokens.output + tokens.cached;
  if (total <= 0) return "";
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

function statusText(task: IslandTask, language: LanguageMode): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (task.status === "completed") return l("Replied", "回复完成");
  if (task.status === "waiting_input") return l("Needs confirmation", "等待确认");
  if (task.status === "error") return l("Failed", "执行异常");
  return task.activeTool ? l(`Running ${task.activeTool}`, `执行 ${task.activeTool}`) : l("Thinking…", "思考中…");
}

function StatusGlyph({ status }: { status: IslandTask["status"] }): ReactElement {
  if (status === "completed") return <CheckCircle2 size={14} className="island-glyph-completed" />;
  if (status === "waiting_input") return <HelpCircle size={14} className="island-glyph-waiting" />;
  if (status === "error") return <AlertCircle size={14} className="island-glyph-error" />;
  return <span className="island-pulse-dot" aria-hidden="true" />;
}

export function DynamicIsland(): ReactElement | null {
  const [snapshot, setSnapshot] = useState<IslandSnapshot>(EMPTY_SNAPSHOT);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [language] = useState<LanguageMode>(() => readInitialLanguage());
  const l = (en: string, zh: string) => localize(language, en, zh);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageWidthRef = useRef(0);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const pillSizeRef = useRef({ width: 156, height: 32 });
  const interactiveRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const suppressHoverUntilLeaveRef = useRef(false);
  const modeRef = useRef<"hidden" | "standby" | "compact" | "toast" | "drawer">("hidden");
  const hoverOpenTimerRef = useRef<number | null>(null);
  const leaveCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    void window.sessionSearch.getIslandSnapshot().then((initial) => {
      if (active) setSnapshot(initial);
    }).catch(() => undefined);
    const unsubscribe = window.sessionSearch.onIslandSnapshot((next) => {
      if (active) setSnapshot(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const highlightedTask = useMemo(
    () => (snapshot.highlightedTaskId ? snapshot.tasks.find((task) => task.id === snapshot.highlightedTaskId) ?? null : null),
    [snapshot.highlightedTaskId, snapshot.tasks],
  );
  const runningTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.status === "running"),
    [snapshot.tasks],
  );
  const unreadTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.unread),
    [snapshot.tasks],
  );
  const primaryTask = highlightedTask ?? unreadTasks[0] ?? runningTasks[0] ?? snapshot.tasks[0] ?? null;

  const mode: "hidden" | "standby" | "compact" | "toast" | "drawer" = !snapshot.enabled
    ? "hidden"
    : drawerOpen
      ? "drawer"
      : highlightedTask
        ? "toast"
        : primaryTask
          ? "compact"
          : "standby";

  const pillSize = useMemo(() => {
    if (mode === "drawer") {
      return {
        width: 412,
        height: snapshot.tasks.length > 0 ? Math.min(404, 58 + snapshot.tasks.length * 64) : 84,
      };
    }
    if (mode === "toast") return { width: 396, height: 112 };
    if (mode === "compact") return { width: 248, height: 34 };
    return { width: 156, height: 32 };
  }, [mode, snapshot.tasks.length]);

  const tone: "idle" | IslandTask["status"] = highlightedTask?.status ?? primaryTask?.status ?? "idle";
  modeRef.current = mode;
  pillSizeRef.current = pillSize;

  const setInteractive = (interactive: boolean) => {
    if (interactiveRef.current === interactive) return;
    interactiveRef.current = interactive;
    void window.sessionSearch.setIslandInteractive(interactive);
  };

  const clearHoverTimers = () => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (leaveCloseTimerRef.current !== null) {
      window.clearTimeout(leaveCloseTimerRef.current);
      leaveCloseTimerRef.current = null;
    }
  };

  const enterPill = () => {
    pointerInsideRef.current = true;
    clearHoverTimers();
    setInteractive(true);
    const currentMode = modeRef.current;
    if (!suppressHoverUntilLeaveRef.current && (currentMode === "standby" || currentMode === "compact")) {
      hoverOpenTimerRef.current = window.setTimeout(() => {
        hoverOpenTimerRef.current = null;
        if (pointerInsideRef.current && !suppressHoverUntilLeaveRef.current) {
          setDrawerOpen(true);
        }
      }, HOVER_OPEN_DELAY_MS);
    }
  };

  const leavePill = () => {
    pointerInsideRef.current = false;
    suppressHoverUntilLeaveRef.current = false;
    clearHoverTimers();
    // Release click-through immediately when the pointer exits so clicks on apps behind
    // the transparent overlay are never swallowed during the collapse grace delay.
    setInteractive(false);
    const currentMode = modeRef.current;
    if (currentMode === "drawer" || currentMode === "toast") {
      leaveCloseTimerRef.current = window.setTimeout(() => {
        leaveCloseTimerRef.current = null;
        if (!pointerInsideRef.current) {
          setDrawerOpen(false);
        }
      }, LEAVE_CLOSE_DELAY_MS);
    }
  };

  // Cache stage width on mount/resize; pill hit-box is derived purely from stageWidth and
  // target pillSize so CSS width/height transitions never leave a stale pre-transition rect.
  useLayoutEffect(() => {
    if (mode === "hidden") {
      stageWidthRef.current = 0;
      return;
    }
    const updateStageWidth = () => {
      stageWidthRef.current = stageRef.current?.clientWidth ?? 0;
    };
    updateStageWidth();
    window.addEventListener("resize", updateStageWidth);
    return () => window.removeEventListener("resize", updateStageWidth);
  }, [mode === "hidden"]);

  // Fixed-size transparent overlay uses OS click-through forwarding (setIgnoreMouseEvents(true, { forward: true }))
  // so hit-testing target pill geometry on mousemove switches interactivity with zero window resizing.
  useEffect(() => {
    if (mode === "hidden") return;

    const getTargetHitRect = (): HitRect | null => {
      const stageWidth = stageWidthRef.current || stageRef.current?.clientWidth || 0;
      if (stageWidth > 0) {
        stageWidthRef.current = stageWidth;
        const { width, height } = pillSizeRef.current;
        const left = (stageWidth - width) / 2;
        return {
          left,
          right: left + width,
          top: STAGE_PADDING_TOP_PX,
          bottom: STAGE_PADDING_TOP_PX + height,
        };
      }
      // Fallback for unit-test DOM environments (happy-dom) without layout width.
      const domRect = pillRef.current?.getBoundingClientRect();
      if (!domRect || domRect.width <= 0 || domRect.height <= 0) return null;
      return {
        left: domRect.left,
        right: domRect.right,
        top: domRect.top,
        bottom: domRect.bottom,
      };
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = getTargetHitRect();
      if (!rect) return;
      const x = event.clientX;
      const y = event.clientY;
      const insideExact = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      const isExpanded = modeRef.current === "drawer" || modeRef.current === "toast";
      const stayPad = isExpanded && pointerInsideRef.current ? OPEN_LEAVE_PADDING_PX : 0;
      const insideForHover = stayPad > 0
        ? x >= rect.left - stayPad && x <= rect.right + stayPad && y >= rect.top - stayPad && y <= rect.bottom + stayPad
        : insideExact;

      setInteractive(insideExact);

      if (!insideForHover) {
        suppressHoverUntilLeaveRef.current = false;
        if (pointerInsideRef.current) {
          leavePill();
        }
      } else if (!pointerInsideRef.current) {
        enterPill();
      }
    };

    const handleExitWindow = () => {
      suppressHoverUntilLeaveRef.current = false;
      if (pointerInsideRef.current || interactiveRef.current) {
        leavePill();
      }
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleExitWindow);
    window.addEventListener("blur", handleExitWindow);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleExitWindow);
      window.removeEventListener("blur", handleExitWindow);
    };
  }, [mode === "hidden"]);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
      if (leaveCloseTimerRef.current !== null) window.clearTimeout(leaveCloseTimerRef.current);
      if (interactiveRef.current) {
        interactiveRef.current = false;
        void window.sessionSearch.setIslandInteractive(false);
      }
    };
  }, []);

  if (mode === "hidden") return null;

  const collapseAndRelease = (suppressHover = false) => {
    clearHoverTimers();
    suppressHoverUntilLeaveRef.current = suppressHover;
    pointerInsideRef.current = false;
    setDrawerOpen(false);
    setInteractive(false);
  };

  const handleFocus = (taskId: string) => {
    collapseAndRelease(true);
    void window.sessionSearch.focusIslandTask(taskId);
  };

  const handleTrajectory = (taskId: string) => {
    collapseAndRelease(true);
    void window.sessionSearch.openIslandTrajectory(taskId);
  };

  const handleShare = (taskId: string) => {
    collapseAndRelease(true);
    void window.sessionSearch.shareIslandTaskToTeam(taskId);
  };

  const handleDismiss = (taskId: string) => {
    void window.sessionSearch.dismissIslandTask(taskId).then(setSnapshot);
  };

  const handleToggleMute = () => {
    void window.sessionSearch.setIslandMuted(!snapshot.muted).then(setSnapshot);
  };

  const handleClearCompleted = () => {
    void window.sessionSearch.clearCompletedIslandTasks().then((next) => {
      setSnapshot(next);
      if (next.tasks.length === 0) collapseAndRelease(true);
    });
  };

  const handleCloseIsland = () => {
    collapseAndRelease(true);
    void window.sessionSearch.closeIsland().then(setSnapshot);
  };

  return (
    <div ref={stageRef} className="island-stage">
      <div
        ref={pillRef}
        className={`island-pill island-mode-${mode}`}
        data-mode={mode}
        data-tone={tone}
        data-highlight-version={snapshot.highlightVersion}
        style={{ width: `${pillSize.width}px`, height: `${pillSize.height}px` }}
      >
        <div
          key={mode === "toast" ? `toast:${snapshot.highlightVersion}` : mode}
          className="island-view"
          style={{ width: `${pillSize.width}px` }}
        >
          {mode === "standby" ? (
            <button
              type="button"
              className="island-compact-btn"
              onClick={() => {
                clearHoverTimers();
                suppressHoverUntilLeaveRef.current = false;
                pointerInsideRef.current = true;
                setInteractive(true);
                setDrawerOpen(true);
              }}
              aria-label={l("Expand AgentRecall Dynamic Island", "展开 AgentRecall 灵动岛")}
            >
              <span className={snapshot.muted ? "island-standby-dot is-muted" : "island-standby-dot"} aria-hidden="true" />
              <span className="island-compact-label">
                {snapshot.muted ? l("AgentRecall · Muted", "灵动岛 · 已静音") : l("AgentRecall · Ready", "灵动岛 · 监听中")}
              </span>
            </button>
          ) : null}

          {mode === "compact" && primaryTask ? (
            <button
              type="button"
              className="island-compact-btn"
              onClick={() => {
                clearHoverTimers();
                suppressHoverUntilLeaveRef.current = false;
                pointerInsideRef.current = true;
                setInteractive(true);
                setDrawerOpen(true);
              }}
              aria-label={l("Expand AgentRecall Dynamic Island", "展开 AgentRecall 灵动岛")}
            >
              <span className="island-compact-left">
                <AgentIcon source={primaryTask.source} size={15} />
                <StatusGlyph status={primaryTask.status} />
              </span>
              <span className="island-compact-label">
                {runningTasks.length > 0
                  ? (runningTasks.length === 1
                    ? `${runningTasks[0].projectName || runningTasks[0].agentLabel} · ${statusText(runningTasks[0], language)}`
                    : l(`${runningTasks.length} agents running`, `${runningTasks.length} 个任务运行中`))
                  : `${primaryTask.projectName || primaryTask.agentLabel} · ${statusText(primaryTask, language)}`}
              </span>
              {unreadTasks.length > 0 ? (
                <span className="island-unread-pill" aria-label={l(`${unreadTasks.length} unread`, `${unreadTasks.length} 条未读`)}>
                  {unreadTasks.length}
                </span>
              ) : null}
            </button>
          ) : null}

          {mode === "toast" && highlightedTask ? (
            <div className="island-toast">
              <div className="island-toast-head">
                <button
                  type="button"
                  className="island-toast-main"
                  onClick={() => handleFocus(highlightedTask.id)}
                >
                  <span className="island-avatar">
                    <AgentIcon source={highlightedTask.source} size={18} />
                  </span>
                  <span className="island-toast-copy">
                    <span className="island-toast-title-row">
                      <StatusGlyph status={highlightedTask.status} />
                      <strong className="island-toast-agent">{highlightedTask.agentLabel}</strong>
                      {highlightedTask.projectName ? (
                        <span className="island-toast-project">{highlightedTask.projectName}</span>
                      ) : null}
                      <span className="island-toast-meta">
                        {[formatDuration(highlightedTask.durationMs), formatCompactTokens(highlightedTask.tokens)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="island-toast-summary">
                      {highlightedTask.summary || statusText(highlightedTask, language)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="island-icon-btn"
                  title={l("Dismiss", "关闭提醒")}
                  aria-label={l("Dismiss", "关闭提醒")}
                  onClick={() => handleDismiss(highlightedTask.id)}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="island-toast-actions">
                <button
                  type="button"
                  className="island-action-primary"
                  onClick={() => handleFocus(highlightedTask.id)}
                >
                  <ExternalLink size={12} />
                  <span>{highlightedTask.appKind === "desktop" ? l("Switch to App", "切回应用") : l("Focus Terminal", "切回终端")}</span>
                </button>
                <button
                  type="button"
                  className="island-action-btn"
                  onClick={() => handleTrajectory(highlightedTask.id)}
                >
                  <Route size={12} />
                  <span>{l("Trajectory", "看轨迹")}</span>
                </button>
                <button
                  type="button"
                  className="island-action-btn"
                  onClick={() => handleShare(highlightedTask.id)}
                >
                  <GitBranch size={12} />
                  <span>{l("Share to Team", "分享团队")}</span>
                </button>
                <button
                  type="button"
                  className="island-action-btn island-action-tail"
                  onClick={() => setDrawerOpen(true)}
                >
                  {l("All", "全部")} ({snapshot.tasks.length})
                </button>
              </div>
            </div>
          ) : null}

          {mode === "drawer" ? (
            <div className="island-drawer">
              <div className="island-drawer-head">
                <span className="island-drawer-title">
                  <strong>AgentRecall</strong>
                  <span className="island-drawer-count">
                    {runningTasks.length > 0
                      ? l(`${runningTasks.length} running`, `${runningTasks.length} 进行中`)
                      : l(`${snapshot.tasks.length} recent`, `近期 ${snapshot.tasks.length} 项`)}
                  </span>
                </span>
                <span className="island-drawer-controls">
                  <button
                    type="button"
                    className="island-icon-btn"
                    title={snapshot.muted ? l("Unmute alerts", "取消静音") : l("Mute alerts", "静音免打扰")}
                    aria-label={snapshot.muted ? l("Unmute alerts", "取消静音") : l("Mute alerts", "静音免打扰")}
                    onClick={handleToggleMute}
                  >
                    {snapshot.muted ? <BellOff size={13} /> : <Bell size={13} />}
                  </button>
                  <button
                    type="button"
                    className="island-icon-btn"
                    title={l("Clear completed", "清空已完成")}
                    aria-label={l("Clear completed", "清空已完成")}
                    onClick={handleClearCompleted}
                  >
                    <Trash2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="island-icon-btn island-icon-btn-close"
                    title={l("Close Dynamic Island", "关闭灵动岛")}
                    aria-label={l("Close Dynamic Island", "关闭灵动岛")}
                    onClick={handleCloseIsland}
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
              <div className="island-drawer-list">
                {snapshot.tasks.length === 0 ? (
                  <div className="island-empty-drawer">
                    <span>
                      {l(
                        "Watching DSH Desktop, Claude Code, Codex and Pi in real time.",
                        "实时监听中 · DSH Desktop、Claude、Codex、Pi 回复完成后会自动提醒。",
                      )}
                    </span>
                  </div>
                ) : snapshot.tasks.map((task) => (
                  <div key={task.id} className={`island-row${task.unread ? " island-row-unread" : ""}`}>
                    <button
                      type="button"
                      className="island-row-main"
                      onClick={() => handleFocus(task.id)}
                    >
                      <AgentIcon source={task.source} size={16} />
                      <span className="island-row-body">
                        <span className="island-row-top">
                          <StatusGlyph status={task.status} />
                          <span className="island-row-name">{task.projectName || task.agentLabel}</span>
                          <span className="island-row-status">{statusText(task, language)}</span>
                          {task.durationMs ? (
                            <span className="island-row-duration">{formatDuration(task.durationMs)}</span>
                          ) : null}
                        </span>
                        <span className="island-row-summary">{task.summary || task.title}</span>
                      </span>
                    </button>
                    <span className="island-row-actions">
                      <button
                        type="button"
                        className="island-icon-btn"
                        title={l("Open trajectory", "查看轨迹")}
                        aria-label={l("Open trajectory", "查看轨迹")}
                        onClick={() => handleTrajectory(task.id)}
                      >
                        <Route size={13} />
                      </button>
                      <button
                        type="button"
                        className="island-icon-btn"
                        title={l("Share to team", "分享到团队")}
                        aria-label={l("Share to team", "分享到团队")}
                        onClick={() => handleShare(task.id)}
                      >
                        <GitBranch size={13} />
                      </button>
                      <button
                        type="button"
                        className="island-icon-btn"
                        title={l("Remove", "移除")}
                        aria-label={l("Remove", "移除")}
                        onClick={() => handleDismiss(task.id)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
