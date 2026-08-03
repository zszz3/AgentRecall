import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
} from "lucide-react";

import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingImportTaskDiagnostics,
  OpenVikingRuntimeHealth,
  OpenVikingRuntimeState,
  OpenVikingWorkspace,
} from "../../../../core/openviking-memory";
import { localize, type LanguageMode } from "../../language";

type RuntimeAction = "start" | "restart" | "stop" | "refresh" | null;

export function OpenVikingRuntimeMonitor({
  language,
}: {
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [snapshot, setSnapshot] = useState<OpenVikingDiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compatibilityMode, setCompatibilityMode] = useState(false);
  const [action, setAction] = useState<RuntimeAction>(null);
  const requestPending = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async (manual = false) => {
    if (requestPending.current) return;
    requestPending.current = true;
    if (manual) setAction("refresh");
    try {
      const next = await readDiagnostics();
      if (!mounted.current) return;
      setSnapshot(next.snapshot);
      setCompatibilityMode(next.compatibilityMode);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      requestPending.current = false;
      if (mounted.current && manual) setAction(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const activeImports = useMemo(
    () => snapshot?.workspaces.filter((workspace) =>
      workspace.importState === "queued" || workspace.importState === "running") ?? [],
    [snapshot?.workspaces],
  );
  const tasksByWorkspace = useMemo(() => {
    const grouped = new Map<string, OpenVikingImportTaskDiagnostics[]>();
    for (const task of snapshot?.tasks ?? []) {
      const tasks = grouped.get(task.workspaceId) ?? [];
      tasks.push(task);
      grouped.set(task.workspaceId, tasks);
    }
    return grouped;
  }, [snapshot?.tasks]);

  const controlRuntime = async (nextAction: Exclude<RuntimeAction, "refresh" | null>) => {
    if ((nextAction === "stop" || nextAction === "restart") && activeImports.length > 0) {
      const confirmed = window.confirm(l(
        `${activeImports.length} import operation(s) are active. Continue?`,
        `当前有 ${activeImports.length} 个目录正在导入，仍要继续吗？`,
      ));
      if (!confirmed) return;
    }
    setAction(nextAction);
    setError(null);
    try {
      if (nextAction === "start") await window.sessionSearch.startOpenVikingRuntime();
      else if (nextAction === "restart") await restartRuntime();
      else await window.sessionSearch.stopOpenVikingRuntime();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setAction(null);
    }
  };

  const runtime = snapshot?.runtime;
  const runtimeState = runtime?.status.state;
  const runtimeBusy = action !== null || runtimeState === "starting" || runtimeState === "installing";
  const canStart = runtimeState === "stopped" || runtimeState === "error";
  const canStop = runtimeState === "running" || runtimeState === "starting";

  return (
    <div className="openviking-runtime-monitor">
      <section className="openviking-runtime-hero">
        <div className="openviking-runtime-identity">
          <span className={`openviking-runtime-mark ${runtime?.health ?? "not-running"}`}>
            <Server size={21} />
          </span>
          <div>
            <div>
              <h3>OpenViking</h3>
              <RuntimeStateBadge state={runtimeState} language={language} />
              {runtime ? <HealthBadge health={runtime.health} language={language} /> : null}
            </div>
            <p>{l(
              "Local memory runtime, extraction queue and import activity.",
              "本地记忆服务、提取队列与导入活动的实时状态。",
            )}</p>
          </div>
        </div>
        <div className="openviking-runtime-controls">
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={action !== null}
            title={l("Refresh now", "立即刷新")}
          >
            <RefreshCw size={14} className={action === "refresh" ? "spin" : ""} />
            {l("Refresh", "刷新")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void controlRuntime("start")}
            disabled={!canStart || runtimeBusy}
          >
            {action === "start"
              ? <><RefreshCw size={14} className="spin" />{l("Starting", "启动中")}</>
              : <><Play size={14} />{l("Start", "启动")}</>}
          </button>
          <button
            type="button"
            onClick={() => void controlRuntime("restart")}
            disabled={runtimeState !== "running" || runtimeBusy}
          >
            {action === "restart"
              ? <><RefreshCw size={14} className="spin" />{l("Restarting", "重启中")}</>
              : <><RotateCcw size={14} />{l("Restart", "重启")}</>}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void controlRuntime("stop")}
            disabled={!canStop || runtimeBusy}
          >
            {action === "stop"
              ? <><RefreshCw size={13} className="spin" />{l("Stopping", "关闭中")}</>
              : <><Square size={13} />{l("Stop", "关闭")}</>}
          </button>
        </div>
      </section>

      {error ? (
        <div className="openviking-runtime-warning">
          <AlertTriangle size={15} />
          <span>{error}</span>
          {snapshot ? <em>{l("Showing the last successful snapshot.", "当前保留上一次成功读取的状态。")}</em> : null}
        </div>
      ) : null}

      {compatibilityMode ? (
        <div className="openviking-runtime-warning compatibility">
          <AlertTriangle size={15} />
          <span>{l(
            "Basic status and controls are available now. Restart V2 normally when imports are idle to load process health, task details and runtime events.",
            "基础状态与控制现在已可用；请在没有导入任务运行时正常重启 V2，以加载进程健康、任务明细与运行事件。",
          )}</span>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="openviking-runtime-loading">
          <RefreshCw size={18} className="spin" />{l("Reading OpenViking status…", "正在读取 OpenViking 状态…")}
        </div>
      ) : (
        <>
          <section className="openviking-runtime-facts">
            <RuntimeFact
              icon={<Activity size={16} />}
              label={l("Process", "进程")}
              value={runtime?.pid
                ? `PID ${runtime.pid}`
                : runtimeState === "running"
                  ? l("Running", "运行中")
                  : l("Not running", "未运行")}
              detail={runtime?.port ? `127.0.0.1:${runtime.port}` : runtimeStateLabel(runtimeState, language)}
            />
            <RuntimeFact
              icon={<Clock3 size={16} />}
              label={l("Uptime", "运行时长")}
              value={runtimeState === "running" && runtime?.uptimeSeconds === undefined
                ? l("Unavailable", "暂不可用")
                : formatDuration(runtime?.uptimeSeconds, language)}
              detail={runtime?.startedAt
                ? l(`Started ${formatTime(runtime.startedAt, language)}`, `启动于 ${formatTime(runtime.startedAt, language)}`)
                : runtimeState === "running"
                  ? l("The current window did not provide a start time", "当前窗口未提供启动时间")
                  : l("No active process", "当前没有活动进程")}
            />
            <RuntimeFact
              icon={<CheckCircle2 size={16} />}
              label={l("Health probe", "健康检查")}
              value={runtime?.health === "healthy" ? l("Available", "可用") : healthLabel(runtime?.health, language)}
              detail={runtime?.healthLatencyMs === undefined
                ? runtimeState === "running"
                  ? l("The current window did not provide probe latency", "当前窗口未提供探测耗时")
                  : l("Waiting for a running service", "等待服务启动")
                : `${runtime.healthLatencyMs} ms`}
            />
            <RuntimeFact
              icon={<Database size={16} />}
              label={l("Components", "组件")}
              value={runtime?.status.version
                ? `OpenViking ${runtime.status.version}`
                : l("Runtime unavailable", "运行组件不可用")}
              detail={l(
                `${formatBytes(runtime?.status.installedBytes)} · model ${snapshot.model.installed ? "ready" : "missing"}`,
                `${formatBytes(runtime?.status.installedBytes)} · 向量模型${snapshot.model.installed ? "已就绪" : "未安装"}`,
              )}
            />
          </section>

          <section className="openviking-runtime-section">
            <header>
              <div>
                <h3>{l("Import activity", "导入活动")}</h3>
                <p>{l(
                  "Local checkpoints and the latest OpenViking task state; no session content is exposed here.",
                  "显示本地检查点与最新的 OpenViking 任务状态；此处不会展示会话正文。",
                )}</p>
              </div>
              <span>{l(
                `${snapshot.workspaces.length} directories · ${snapshot.tasks.length} tasks`,
                `${snapshot.workspaces.length} 个目录 · ${snapshot.tasks.length} 个任务`,
              )}</span>
            </header>
            {snapshot.workspaces.length === 0 ? (
              <div className="openviking-runtime-empty">
                {l("No memory directories are configured.", "还没有配置记忆目录。")}
              </div>
            ) : (
              <div className="openviking-runtime-workspaces">
                {snapshot.workspaces.map((workspace) => (
                  <WorkspaceDiagnostics
                    key={workspace.id}
                    workspace={workspace}
                    tasks={tasksByWorkspace.get(workspace.id) ?? []}
                    language={language}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="openviking-runtime-section openviking-runtime-events">
            <header>
              <div>
                <h3>{l("Runtime events", "运行事件")}</h3>
                <p>{l("Recent lifecycle events from this app session.", "当前应用会话内最近的生命周期事件。")}</p>
              </div>
              <span>{l(`Updated ${formatTime(snapshot.capturedAt, language)}`, `更新于 ${formatTime(snapshot.capturedAt, language)}`)}</span>
            </header>
            {runtime?.events.length ? (
              <div>
                {runtime.events.map((event) => (
                  <article className={event.level} key={event.id}>
                    <i aria-hidden="true" />
                    <span>{event.message}</span>
                    <time>{formatTime(event.createdAt, language)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="openviking-runtime-empty">{l("No runtime events yet.", "暂无运行事件。")}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RuntimeFact({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  detail: string;
}): ReactElement {
  return (
    <article>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </article>
  );
}

function WorkspaceDiagnostics({
  workspace,
  tasks,
  language,
}: {
  workspace: OpenVikingWorkspace;
  tasks: OpenVikingImportTaskDiagnostics[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <article className="openviking-runtime-workspace">
      <header>
        <div>
          <strong>{workspace.displayName}</strong>
          <span title={workspace.rootPath}>{workspace.rootPath}</span>
        </div>
        <div>
          <span className={`openviking-runtime-state ${workspace.importState}`}>
            {workspaceStateLabel(workspace.importState, language)}
          </span>
          <em>{workspace.importedTurns} / {workspace.totalTurns} {l("turns", "轮")}</em>
          {(workspace.totalTasks ?? 0) > 0
            ? <em>{workspace.completedTasks ?? 0} / {workspace.totalTasks} {l("tasks", "任务")}</em>
            : null}
        </div>
      </header>
      {workspace.importActivity ? (
        <div className="openviking-runtime-current">
          <Activity size={13} className="pulse" />
          <strong>{activityLabel(workspace.importActivity.phase, language)}</strong>
          {workspace.importActivity.sessionTitle ? <span>{workspace.importActivity.sessionTitle}</span> : null}
          {workspace.importActivity.currentTask !== undefined
            && workspace.importActivity.totalTasks !== undefined
            ? <em>{workspace.importActivity.currentTask} / {workspace.importActivity.totalTasks}</em>
            : null}
        </div>
      ) : null}
      {workspace.lastError ? (
        <div className="openviking-runtime-task-error"><AlertTriangle size={13} />{workspace.lastError}</div>
      ) : null}
      {tasks.length > 0 ? (
        <div className="openviking-runtime-task-list">
          {tasks.map((task) => (
            <div key={task.id}>
              <span className={`openviking-runtime-task-dot ${task.state}`} aria-hidden="true" />
              <span title={task.sessionTitle}>{task.sessionTitle}</span>
              <em>{task.turnCount} {l("turns", "轮")}</em>
              <strong>{remoteTaskLabel(task, language)}</strong>
              <small>{l(`attempt ${task.attemptCount}`, `第 ${task.attemptCount} 次`)}</small>
              {task.remoteError || task.lastError
                ? <p>{task.remoteError ?? task.lastError}</p>
                : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="openviking-runtime-no-tasks">{l("No recorded import tasks.", "暂无已记录的导入任务。")}</div>
      )}
    </article>
  );
}

function RuntimeStateBadge({ state, language }: { state?: OpenVikingRuntimeState; language: LanguageMode }) {
  return <span className={`openviking-runtime-state ${state ?? "unknown"}`}>{runtimeStateLabel(state, language)}</span>;
}

function HealthBadge({
  health,
  language,
}: {
  health: OpenVikingRuntimeHealth;
  language: LanguageMode;
}) {
  return <span className={`openviking-runtime-state ${health}`}>{healthLabel(health, language)}</span>;
}

function runtimeStateLabel(state: OpenVikingRuntimeState | undefined, language: LanguageMode): string {
  const labels: Record<OpenVikingRuntimeState, [string, string]> = {
    "not-installed": ["Not installed", "未安装"],
    installing: ["Installing", "安装中"],
    stopped: ["Stopped", "已关闭"],
    starting: ["Starting", "启动中"],
    running: ["Running", "运行中"],
    error: ["Error", "异常"],
  };
  const label = state ? labels[state] : ["Loading", "读取中"];
  return localize(language, label[0], label[1]);
}

function healthLabel(
  health: OpenVikingRuntimeHealth | undefined,
  language: LanguageMode,
): string {
  if (health === "healthy") return localize(language, "Healthy", "健康");
  if (health === "unhealthy") return localize(language, "Unhealthy", "不可用");
  if (health === "unknown") return localize(language, "Not checked", "未检查");
  return localize(language, "Not running", "未运行");
}

async function readDiagnostics(): Promise<{
  snapshot: OpenVikingDiagnosticsSnapshot;
  compatibilityMode: boolean;
}> {
  const api = window.sessionSearch;
  if (typeof api.getOpenVikingDiagnostics === "function") {
    return {
      snapshot: await api.getOpenVikingDiagnostics(),
      compatibilityMode: false,
    };
  }
  const snapshot = await api.getOpenVikingMemorySnapshot();
  return {
    compatibilityMode: true,
    snapshot: {
      capturedAt: new Date().toISOString(),
      runtime: {
        status: snapshot.runtime,
        health: snapshot.runtime.state === "running" ? "unknown" : "not-running",
        ...(snapshot.runtime.port === undefined ? {} : { port: snapshot.runtime.port }),
        events: [],
      },
      model: snapshot.model,
      workspaces: snapshot.workspaces,
      tasks: [],
    },
  };
}

async function restartRuntime(): Promise<void> {
  const api = window.sessionSearch;
  if (typeof api.restartOpenVikingRuntime === "function") {
    await api.restartOpenVikingRuntime();
    return;
  }
  await api.stopOpenVikingRuntime();
  await api.startOpenVikingRuntime();
}

function workspaceStateLabel(state: OpenVikingWorkspace["importState"], language: LanguageMode): string {
  const labels: Record<OpenVikingWorkspace["importState"], [string, string]> = {
    idle: ["Idle", "空闲"],
    queued: ["Queued", "排队中"],
    running: ["Importing", "导入中"],
    paused: ["Paused", "已暂停"],
    failed: ["Failed", "失败"],
    completed: ["Complete", "已完成"],
  };
  return localize(language, labels[state][0], labels[state][1]);
}

function taskStateLabel(state: OpenVikingImportTaskDiagnostics["state"], language: LanguageMode): string {
  const labels: Record<OpenVikingImportTaskDiagnostics["state"], [string, string]> = {
    queued: ["Queued", "排队中"],
    uploading: ["Uploading", "上传中"],
    waiting: ["Extracting", "提取中"],
    completed: ["Complete", "已完成"],
    failed: ["Failed", "失败"],
  };
  return localize(language, labels[state][0], labels[state][1]);
}

function remoteTaskLabel(task: OpenVikingImportTaskDiagnostics, language: LanguageMode): string {
  const remote = (task.remoteStage ?? task.remoteState)?.trim().toLowerCase();
  if (!remote) return taskStateLabel(task.state, language);
  if (["scanning", "scan"].includes(remote)) return localize(language, "Scanning", "扫描中");
  if (["uploading", "upload"].includes(remote)) return localize(language, "Uploading", "上传中");
  if (["extracting", "processing", "running"].includes(remote)) {
    return localize(language, "Extracting", "提取中");
  }
  if (["queued", "pending"].includes(remote)) return localize(language, "Queued", "排队中");
  if (["completed", "succeeded", "success", "done"].includes(remote)) {
    return localize(language, "Complete", "已完成");
  }
  if (["failed", "error", "cancelled", "canceled"].includes(remote)) {
    return localize(language, "Failed", "失败");
  }
  return remote.slice(0, 40);
}

function activityLabel(phase: "scanning" | "uploading" | "extracting", language: LanguageMode): string {
  if (phase === "scanning") return localize(language, "Scanning sessions", "正在扫描会话");
  if (phase === "uploading") return localize(language, "Uploading session", "正在上传会话");
  return localize(language, "Extracting memory", "正在提取记忆");
}

function formatTime(value: string, language: LanguageMode): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(seconds: number | undefined, language: LanguageMode): string {
  if (seconds === undefined) return localize(language, "Not running", "未运行");
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return localize(language, `${days}d ${hours}h`, `${days} 天 ${hours} 小时`);
  if (hours > 0) return localize(language, `${hours}h ${minutes}m`, `${hours} 小时 ${minutes} 分`);
  return localize(language, `${minutes}m ${seconds % 60}s`, `${minutes} 分 ${seconds % 60} 秒`);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
