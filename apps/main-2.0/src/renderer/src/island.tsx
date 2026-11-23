import { useEffect, useMemo, useRef, useState } from "react";
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
  const interactiveRef = useRef(false);

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

  const mode: "hidden" | "compact" | "toast" | "drawer" = !snapshot.enabled || snapshot.tasks.length === 0
    ? "hidden"
    : drawerOpen
      ? "drawer"
      : highlightedTask
        ? "toast"
        : "compact";

  useEffect(() => {
    if (mode === "hidden") return;
    const target = mode === "drawer"
      ? { width: 420, height: Math.min(460, 118 + snapshot.tasks.length * 78) }
      : mode === "toast"
        ? { width: 400, height: 126 }
        : { width: 256, height: 48 };
    void window.sessionSearch.resizeIslandBounds(target.width, target.height);
  }, [mode, snapshot.tasks.length]);

  useEffect(() => {
    return () => {
      if (interactiveRef.current) {
        interactiveRef.current = false;
        void window.sessionSearch.setIslandInteractive(false);
      }
    };
  }, []);

  if (mode === "hidden" || !primaryTask) return null;

  const setInteractive = (interactive: boolean) => {
    if (interactiveRef.current === interactive) return;
    interactiveRef.current = interactive;
    void window.sessionSearch.setIslandInteractive(interactive);
  };

  const handleFocus = (taskId: string) => {
    setDrawerOpen(false);
    void window.sessionSearch.focusIslandTask(taskId);
  };

  const handleTrajectory = (taskId: string) => {
    setDrawerOpen(false);
    void window.sessionSearch.openIslandTrajectory(taskId);
  };

  const handleShare = (taskId: string) => {
    setDrawerOpen(false);
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
      if (next.tasks.length === 0) setDrawerOpen(false);
    });
  };

  return (
    <div className="island-stage">
      <div
        className={`island-pill island-mode-${mode}`}
        data-mode={mode}
        data-highlight-version={snapshot.highlightVersion}
        onMouseEnter={() => setInteractive(true)}
        onMouseLeave={() => {
          setInteractive(false);
          setDrawerOpen(false);
        }}
      >
        {mode === "compact" ? (
          <button
            type="button"
            className="island-compact-btn"
            onClick={() => setDrawerOpen(true)}
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
              {highlightedTask.signalSource !== "test" ? (
                <button
                  type="button"
                  className="island-action-btn"
                  onClick={() => handleShare(highlightedTask.id)}
                >
                  <GitBranch size={12} />
                  <span>{l("Share to Team", "分享团队")}</span>
                </button>
              ) : null}
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
                  className="island-icon-btn"
                  title={l("Collapse", "收起")}
                  aria-label={l("Collapse", "收起")}
                  onClick={() => setDrawerOpen(false)}
                >
                  <X size={13} />
                </button>
              </span>
            </div>
            <div className="island-drawer-list">
              {snapshot.tasks.map((task) => (
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
                    {task.signalSource !== "test" ? (
                      <button
                        type="button"
                        className="island-icon-btn"
                        title={l("Share to team", "分享到团队")}
                        aria-label={l("Share to team", "分享到团队")}
                        onClick={() => handleShare(task.id)}
                      >
                        <GitBranch size={13} />
                      </button>
                    ) : null}
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
  );
}
