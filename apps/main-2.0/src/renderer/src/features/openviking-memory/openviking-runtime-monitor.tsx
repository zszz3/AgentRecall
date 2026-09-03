import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  Filter,
  FolderTree,
  Gauge,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Square,
  X,
} from "lucide-react";

import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingRuntimeHealth,
  OpenVikingRuntimeState,
  OpenVikingWorkspace,
} from "../../../../core/openviking-memory";
import type {
  OpenVikingCommitRun,
  OpenVikingControlDiagnostics,
  OpenVikingMemoryChange,
  OpenVikingOperationEvent,
  OpenVikingRecallTrace,
} from "../../../../core/openviking-memory-control";
import { localize, type LanguageMode } from "../../language";

type RuntimeAction = "start" | "restart" | "stop" | "refresh" | null;
type SelectedDiagnostic =
  | { kind: "commit"; value: OpenVikingCommitRun; workspaceName: string }
  | {
      kind: "event";
      value: OpenVikingOperationEvent;
      workspaceName: string;
      recallTrace?: OpenVikingRecallTrace;
    }
  | { kind: "recall"; value: OpenVikingRecallTrace; workspaceName: string };

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

  const controlRuntime = async (nextAction: Exclude<RuntimeAction, "refresh" | null>) => {
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
              "Local memory runtime and directory-level incremental tracking.",
              "本地记忆服务与目录级增量跟踪的实时状态。",
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
            "Basic status and controls are available now. Restart V2 normally to load process health and runtime events.",
            "基础状态与控制现在已可用；请正常重启 V2，以加载进程健康与运行事件。",
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

          <DirectoryTracking workspaces={snapshot.workspaces} language={language} />

          <ControlDiagnostics
            control={snapshot.control}
            workspaces={snapshot.workspaces}
            language={language}
          />

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

function ControlDiagnostics({
  control,
  workspaces,
  language,
}: {
  control: OpenVikingControlDiagnostics;
  workspaces: OpenVikingWorkspace[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.displayName]));
  const [selected, setSelected] = useState<SelectedDiagnostic | null>(null);
  return (
    <>
      <section className="openviking-runtime-section openviking-control-diagnostics">
        <header>
          <div>
            <h3>{l("Memory pipeline", "记忆流水线")}</h3>
            <p>{l(
              "Commit extraction, stage timing and recall decisions recorded by AgentRecall.",
              "AgentRecall 记录的提交提炼、阶段耗时与召回决策。",
            )}</p>
          </div>
          <span>{l(
            `${control.recentCommits.length} commits · ${control.recentRecallTraces.length} recalls`,
            `${control.recentCommits.length} 次提交 · ${control.recentRecallTraces.length} 次召回`,
          )}</span>
        </header>
        <RecallOverview traces={control.recentRecallTraces} language={language} />
        <div className="openviking-control-columns">
          <ControlColumn title={l("Extraction runs", "提炼任务")} empty={l("No extraction runs yet.", "暂无提炼任务。")}>
            {control.recentCommits.slice(0, 8).map((run) => {
              const workspaceName = workspaceNames.get(run.workspaceId) ?? run.workspaceId;
              return (
                <CommitRow
                  key={run.taskId}
                  run={run}
                  workspaceName={workspaceName}
                  language={language}
                  onOpen={() => setSelected({ kind: "commit", value: run, workspaceName })}
                />
              );
            })}
          </ControlColumn>
          <ControlColumn title={l("Pipeline stages", "处理阶段")} empty={l("No stage events yet.", "暂无阶段事件。")}>
            {control.recentEvents.slice(0, 10).map((event) => {
              const workspaceName = workspaceNames.get(event.workspaceId) ?? event.workspaceId;
              const recallTrace = findRecallTraceForEvent(event, control.recentRecallTraces);
              return (
                <OperationRow
                  key={event.id}
                  event={event}
                  workspaceName={workspaceName}
                  language={language}
                  onOpen={() => setSelected({
                    kind: "event",
                    value: event,
                    workspaceName,
                    ...(recallTrace ? { recallTrace } : {}),
                  })}
                />
              );
            })}
          </ControlColumn>
          <ControlColumn title={l("Recall traces", "召回记录")} empty={l("No recall traces yet.", "暂无召回记录。")}>
            {control.recentRecallTraces.slice(0, 8).map((trace) => {
              const workspaceName = workspaceNames.get(trace.workspaceId) ?? trace.workspaceId;
              return (
                <RecallRow
                  key={trace.id}
                  trace={trace}
                  workspaceName={workspaceName}
                  language={language}
                  onOpen={() => setSelected({ kind: "recall", value: trace, workspaceName })}
                />
              );
            })}
          </ControlColumn>
        </div>
      </section>
      {selected ? (
        <ControlDetailDialog
          item={selected}
          language={language}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function RecallOverview({
  traces,
  language,
}: {
  traces: OpenVikingRecallTrace[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const stats = traces.reduce((current, trace) => {
    current.injected += trace.candidates.filter((candidate) => candidate.decision === "injected").length;
    current.filtered += trace.candidates.filter((candidate) => candidate.decision === "filtered").length;
    current.budget += trace.candidates.filter((candidate) => candidate.decision === "budget").length;
    current.tokens += trace.injectedTokenCount;
    current.duration += trace.durationMs;
    if (trace.injectedUris.length === 0) current.empty += 1;
    if (trace.degradedReason) current.degraded += 1;
    return current;
  }, { injected: 0, filtered: 0, budget: 0, tokens: 0, duration: 0, empty: 0, degraded: 0 });
  const candidates = stats.injected + stats.filtered + stats.budget;
  const segmentWidth = (count: number) => candidates === 0 ? 0 : (count / candidates) * 100;
  return (
    <div className="openviking-recall-overview">
      <div className="openviking-recall-metrics">
        <RecallMetric
          icon={<Search size={15} />}
          label={l("Recall attempts", "召回次数")}
          value={String(traces.length)}
          detail={l(`${stats.empty} injected nothing`, `${stats.empty} 次未注入`)}
        />
        <RecallMetric
          icon={<CheckCircle2 size={15} />}
          label={l("Injected", "成功注入")}
          value={String(stats.injected)}
          detail={l(`${stats.tokens} estimated tokens`, `约 ${stats.tokens} Token`)}
        />
        <RecallMetric
          icon={<Filter size={15} />}
          label={l("Filtered / budget", "过滤 / 超预算")}
          value={`${stats.filtered} / ${stats.budget}`}
          detail={l(`${candidates} candidates inspected`, `共检查 ${candidates} 个候选`)}
        />
        <RecallMetric
          icon={<Gauge size={15} />}
          label={l("Average latency", "平均耗时")}
          value={traces.length === 0 ? "—" : formatDurationMs(Math.round(stats.duration / traces.length))}
          detail={l(`${stats.degraded} degraded`, `${stats.degraded} 次降级`)}
        />
      </div>
      <div className="openviking-recall-funnel" aria-label={l("Recall candidate outcomes", "召回候选结果分布")}>
        <div>
          <span className="injected" style={{ width: `${segmentWidth(stats.injected)}%` }} />
          <span className="filtered" style={{ width: `${segmentWidth(stats.filtered)}%` }} />
          <span className="budget" style={{ width: `${segmentWidth(stats.budget)}%` }} />
        </div>
        <p>
          <span><i className="injected" />{l("Injected", "已注入")} {stats.injected}</span>
          <span><i className="filtered" />{l("Filtered", "已过滤")} {stats.filtered}</span>
          <span><i className="budget" />{l("Over budget", "超预算")} {stats.budget}</span>
        </p>
      </div>
    </div>
  );
}

function RecallMetric({
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
      <div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div>
    </article>
  );
}

function ControlColumn({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactElement[];
}): ReactElement {
  return (
    <div className="openviking-control-column">
      <strong>{title}</strong>
      <div>{children.length > 0 ? children : <span className="openviking-control-empty">{empty}</span>}</div>
    </div>
  );
}

function CommitRow({
  run,
  workspaceName,
  language,
  onOpen,
}: {
  run: OpenVikingCommitRun;
  workspaceName: string;
  language: LanguageMode;
  onOpen: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <button type="button" className="openviking-control-row" onClick={onOpen}>
      <div>
        <strong title={run.taskId}>{workspaceName} · {triggerLabel(run.trigger, language)}</strong>
        <span>{l(
          `${run.sourceTurnIds.length} turns · ~${run.tokenEstimate} tokens`,
          `${run.sourceTurnIds.length} 个 Turn · 约 ${run.tokenEstimate} Token`,
        )}</span>
        {run.error ? <em className="error">{run.error}</em> : null}
      </div>
      <aside>
        <span className={`openviking-runtime-state ${run.state}`}>{commitStateLabel(run.state, language)}</span>
        <time>{formatTime(run.updatedAt, language)}</time>
      </aside>
    </button>
  );
}

function OperationRow({
  event,
  workspaceName,
  language,
  onOpen,
}: {
  event: OpenVikingOperationEvent;
  workspaceName: string;
  language: LanguageMode;
  onOpen: () => void;
}): ReactElement {
  return (
    <button type="button" className="openviking-control-row" onClick={onOpen}>
      <div>
        <strong>{phaseLabel(event.phase, language)}</strong>
        <span>{workspaceName}{event.taskId ? ` · ${shortId(event.taskId)}` : ""}</span>
      </div>
      <aside>
        <span className={`openviking-runtime-state ${event.status}`}>{operationStateLabel(event.status, language)}</span>
        <time>{event.durationMs === undefined ? formatTime(event.startedAt, language) : formatDurationMs(event.durationMs)}</time>
      </aside>
    </button>
  );
}

function RecallRow({
  trace,
  workspaceName,
  language,
  onOpen,
}: {
  trace: OpenVikingRecallTrace;
  workspaceName: string;
  language: LanguageMode;
  onOpen: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <button type="button" className="openviking-control-row" onClick={onOpen}>
      <div>
        <strong title={trace.query}>{trace.query || l("Empty query", "空查询")}</strong>
        <span>{workspaceName} · {trace.agent} · {l(
          `${trace.injectedUris.length}/${trace.candidates.length} injected · ${trace.injectedTokenCount} tokens`,
          `注入 ${trace.injectedUris.length}/${trace.candidates.length} 条 · ${trace.injectedTokenCount} Token`,
        )}</span>
        {trace.degradedReason ? <em>{l("Degraded", "已降级")}: {trace.degradedReason}</em> : null}
      </div>
      <aside>
        <span className={`openviking-runtime-state ${trace.degradedReason ? "degraded" : "completed"}`}>
          {trace.degradedReason ? l("Degraded", "降级") : l("Complete", "完成")}
        </span>
        <time>{formatDurationMs(trace.durationMs)}</time>
      </aside>
    </button>
  );
}

function ControlDetailDialog({
  item,
  language,
  onClose,
}: {
  item: SelectedDiagnostic;
  language: LanguageMode;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const title = item.kind === "recall"
    ? l("Recall detail", "召回详情")
    : item.kind === "commit"
      ? l("Extraction detail", "提炼详情")
      : l("Pipeline stage detail", "处理阶段详情");
  return (
    <div className="dialog-backdrop openviking-control-detail-backdrop" onMouseDown={onClose}>
      <section
        className="openviking-control-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openviking-control-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h3 id="openviking-control-detail-title">{title}</h3>
            <p>{item.workspaceName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={l("Close", "关闭")}><X size={17} /></button>
        </header>
        <div className="openviking-control-detail-body">
          {item.kind === "recall" ? <RecallDetail trace={item.value} language={language} /> : null}
          {item.kind === "commit" ? <CommitDetail run={item.value} language={language} /> : null}
          {item.kind === "event" ? (
            <OperationDetail event={item.value} recallTrace={item.recallTrace} language={language} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function RecallDetail({ trace, language }: { trace: OpenVikingRecallTrace; language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const injected = trace.candidates.filter((candidate) => candidate.decision === "injected").length;
  const outcome = trace.degradedReason
    ? l("Recall degraded", "召回已降级")
    : injected > 0
      ? l("Memory injected", "已注入记忆")
      : trace.candidates.length > 0
        ? l("Candidates found, none injected", "找到候选，但未注入")
        : l("No memory matched", "没有匹配记忆");
  return (
    <>
      <DetailFacts facts={[
        [l("Outcome", "结果"), outcome],
        [l("Candidates", "候选"), String(trace.candidates.length)],
        [l("Injected", "注入"), `${trace.injectedUris.length} · ${trace.injectedTokenCount} Token`],
        [l("Duration", "耗时"), formatDurationMs(trace.durationMs)],
        [l("Agent", "Agent"), trace.agent],
        [l("Time", "时间"), formatTime(trace.createdAt, language)],
      ]} />
      {trace.degradedReason ? (
        <section className="openviking-control-detail-alert">
          <strong>{l("Degraded reason", "降级原因")}</strong>
          <span>{trace.degradedReason}</span>
        </section>
      ) : null}
      <DetailSection title={l("User query", "用户问题")}>
        <p className="openviking-control-detail-query">{trace.query || l("Empty query", "空查询")}</p>
      </DetailSection>
      {trace.contextualQuery && trace.contextualQuery !== trace.query ? (
        <DetailSection title={l("Contextual search query", "带上下文的检索词")}>
          <pre>{trace.contextualQuery}</pre>
        </DetailSection>
      ) : null}
      <DetailSection title={l("Search range", "检索范围")}>
        <div className="openviking-control-detail-tags">
          {[...trace.searchedScopes, ...trace.searchedTypes].map((value, index) => <span key={`${value}:${index}`}>{value}</span>)}
        </div>
      </DetailSection>
      <DetailSection title={l("Candidate decisions", "候选判定")} count={trace.candidates.length}>
        {trace.candidates.length === 0 ? (
          <p className="openviking-control-detail-empty">{l("OpenViking returned no memory candidates.", "OpenViking 没有返回记忆候选。")}</p>
        ) : (
          <div className="openviking-recall-candidates">
            {trace.candidates.map((candidate, index) => (
              <article key={`${candidate.uri}:${index}`}>
                <header>
                  <span className={`openviking-recall-decision ${candidate.decision}`}>
                    {recallDecisionLabel(candidate.decision, language)}
                  </span>
                  <strong title={candidate.uri}>{candidate.uri}</strong>
                  <em>{candidate.score === undefined ? "—" : candidate.score.toFixed(4)}</em>
                </header>
                <p>{candidate.reason}</p>
                <footer>
                  <span>{candidate.memoryType}</span><span>{candidate.authority}</span><span>{candidate.lifecycle}</span>
                  <span>{candidate.evidenceStatus}</span>{candidate.locked ? <span>{l("locked", "已锁定")}</span> : null}
                </footer>
              </article>
            ))}
          </div>
        )}
      </DetailSection>
    </>
  );
}

function CommitDetail({ run, language }: { run: OpenVikingCommitRun; language: LanguageMode }): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [changes, setChanges] = useState<OpenVikingMemoryChange[] | null>(run.memoryDiffUri ? null : []);
  const [changeError, setChangeError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!run.memoryDiffUri) {
      setChanges([]);
      setChangeError(null);
      return () => {
        cancelled = true;
      };
    }
    setChanges(null);
    setChangeError(null);
    void window.sessionSearch.readOpenVikingCommitChanges(run.workspaceId, run.memoryDiffUri)
      .then((value) => {
        if (!cancelled) setChanges(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setChanges([]);
          setChangeError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run.memoryDiffUri, run.workspaceId]);
  return (
    <>
      <DetailFacts facts={[
        [l("State", "状态"), commitStateLabel(run.state, language)],
        [l("Trigger", "触发方式"), triggerLabel(run.trigger, language)],
        [l("Turns", "Turn 数"), String(run.sourceTurnIds.length)],
        [l("Estimated tokens", "预估 Token"), String(run.tokenEstimate)],
        [l("Agent", "Agent"), run.agent || "—"],
        [l("Updated", "更新时间"), formatTime(run.updatedAt, language)],
      ]} />
      {run.error ? <section className="openviking-control-detail-alert"><strong>{l("Failure reason", "失败原因")}</strong><span>{run.error}</span></section> : null}
      <DetailSection title={l("Identifiers", "关联标识")}>
        <DetailKeyValues entries={[
          ["Task ID", run.taskId],
          ["Session ID", run.sessionId],
          ["Source Session ID", run.sourceSessionId],
          [l("Archive", "归档"), run.archiveUri],
          [l("Memory diff", "记忆差异"), run.memoryDiffUri],
        ]} />
      </DetailSection>
      <MemoryChangesDetail
        changes={changes}
        error={changeError}
        operationCounts={run.memoriesExtracted}
        hasDiffArtifact={Boolean(run.memoryDiffUri)}
        language={language}
      />
      <DetailJson title={l("OpenViking operation counts", "OpenViking 操作计数")} value={run.memoriesExtracted} language={language} />
      <DetailJson title={l("Token usage", "Token 用量")} value={run.tokenUsage} language={language} />
      <DetailSection title={l("Source turns", "来源 Turn")} count={run.sourceTurnIds.length}>
        <div className="openviking-control-detail-tags">{run.sourceTurnIds.map((id) => <span key={id}>{id}</span>)}</div>
      </DetailSection>
    </>
  );
}

function MemoryChangesDetail({
  changes,
  error,
  operationCounts,
  hasDiffArtifact,
  language,
}: {
  changes: OpenVikingMemoryChange[] | null;
  error: string | null;
  operationCounts?: Record<string, number>;
  hasDiffArtifact: boolean;
  language: LanguageMode;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const expectedChanges = Object.values(operationCounts ?? {}).reduce((sum, value) => sum + value, 0);
  if (!hasDiffArtifact && expectedChanges === 0) return null;
  return (
    <DetailSection title={l("Concrete memory changes", "具体记忆变更")} count={changes?.length ?? expectedChanges}>
      <div>
        {changes === null ? (
          <p className="openviking-control-detail-empty">{l("Loading the Memory Diff…", "正在读取 Memory Diff…")}</p>
        ) : null}
        {error ? (
          <section className="openviking-control-detail-alert">
            <strong>{l("Memory Diff could not be read", "无法读取 Memory Diff")}</strong>
            <span>{error}</span>
          </section>
        ) : null}
        {changes && changes.length > 0 ? (
          <div className="openviking-memory-changes">
            {changes.map((change, index) => (
              <article key={`${change.kind}:${change.uri}:${index}`}>
                <header>
                  <span className={`openviking-memory-change-kind ${change.kind}`}>
                    {memoryChangeLabel(change.kind, language)}
                  </span>
                  <strong>{change.uri}</strong>
                  <em>{change.memoryType}</em>
                </header>
                {change.kind === "update" ? (
                  <div className="openviking-memory-change-diff">
                    <MemoryChangeContent label={l("Before", "修改前")} value={change.before} tone="before" language={language} />
                    <MemoryChangeContent label={l("After", "修改后")} value={change.after} tone="after" language={language} />
                  </div>
                ) : (
                  <MemoryChangeContent
                    label={change.kind === "delete" ? l("Deleted content", "删除内容") : l("Written content", "写入内容")}
                    value={change.kind === "delete" ? change.before : change.after}
                    tone={change.kind === "delete" ? "before" : "after"}
                    language={language}
                  />
                )}
              </article>
            ))}
          </div>
        ) : null}
        {changes && changes.length === 0 && expectedChanges > 0 && !error ? (
          <p className="openviking-control-detail-empty">{l(
            "This historical run retained operation counts but no readable Memory Diff, so its exact edits cannot be reconstructed.",
            "这条历史记录只保留了操作计数，没有可读取的 Memory Diff，因此无法还原具体修改内容。",
          )}</p>
        ) : null}
        {changes && changes.length === 0 && expectedChanges === 0 && !error ? (
          <p className="openviking-control-detail-empty">{l("No memory content changed in this run.", "本次提炼没有修改记忆内容。")}</p>
        ) : null}
      </div>
    </DetailSection>
  );
}

function MemoryChangeContent({
  label,
  value,
  tone,
  language,
}: {
  label: string;
  value?: string;
  tone: "before" | "after";
  language: LanguageMode;
}): ReactElement {
  return (
    <section className={`openviking-memory-change-content ${tone}`}>
      <small>{label}</small>
      <pre>{value || localize(language, "Content not provided", "未提供内容")}</pre>
    </section>
  );
}

function memoryChangeLabel(kind: OpenVikingMemoryChange["kind"], language: LanguageMode): string {
  if (kind === "add") return localize(language, "Added", "新增");
  if (kind === "update") return localize(language, "Updated", "修改");
  return localize(language, "Deleted", "删除");
}

function OperationDetail({
  event,
  recallTrace,
  language,
}: {
  event: OpenVikingOperationEvent;
  recallTrace?: OpenVikingRecallTrace;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const isSearch = event.phase === "search" || event.phase === "recall";
  return (
    <>
      <DetailFacts facts={[
        [l("Stage", "阶段"), phaseLabel(event.phase, language)],
        [l("State", "状态"), operationStateLabel(event.status, language)],
        [l("Duration", "耗时"), event.durationMs === undefined ? "—" : formatDurationMs(event.durationMs)],
        [l("Started", "开始时间"), formatTime(event.startedAt, language)],
      ]} />
      <DetailSection title={l("Identifiers", "关联标识")}>
        <DetailKeyValues entries={[["Event ID", event.id], ["Session ID", event.sessionId], ["Task ID", event.taskId]]} />
      </DetailSection>
      {isSearch ? <SearchOperationDetail event={event} recallTrace={recallTrace} language={language} /> : null}
      <DetailJson title={l("Stage details", "阶段详情")} value={event.details} language={language} />
    </>
  );
}

function SearchOperationDetail({
  event,
  recallTrace,
  language,
}: {
  event: OpenVikingOperationEvent;
  recallTrace?: OpenVikingRecallTrace;
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const details = event.details ?? {};
  const userQuery = detailString(details.userQuery) || detailString(details.query) || recallTrace?.query || "";
  const contextualQuery = detailString(details.contextualQuery) || recallTrace?.contextualQuery || userQuery;
  const scopes = detailStrings(details.searchedScopes, recallTrace?.searchedScopes ?? []);
  const types = detailStrings(details.searchedTypes, recallTrace?.searchedTypes ?? []);
  const targetUri = detailString(details.targetUri);
  const source = detailString(details.source);
  const candidateCount = detailNumber(details.candidateCount) ?? recallTrace?.candidates.length;
  const returnedCount = detailNumber(details.returnedCount)
    ?? detailNumber(details.injectedCount)
    ?? recallTrace?.injectedUris.length;
  const injectedTokens = detailNumber(details.injectedTokenCount) ?? recallTrace?.injectedTokenCount;
  const limit = detailNumber(details.limit);
  const tokenBudget = detailNumber(details.tokenBudget);
  const failure = detailString(details.error)
    || detailString(details.reason)
    || detailString(details.degradedReason)
    || recallTrace?.degradedReason
    || "";
  return (
    <>
      {failure ? (
        <section className="openviking-control-detail-alert">
          <strong>{l("Search issue", "检索异常")}</strong>
          <span>{failure}</span>
        </section>
      ) : null}
      <DetailSection title={l("User question", "用户问题")}>
        <p className="openviking-control-detail-query">{userQuery || l(
          "This historical event did not retain the original question.",
          "这条历史事件没有保留原始问题。",
        )}</p>
      </DetailSection>
      {contextualQuery && contextualQuery !== userQuery ? (
        <DetailSection title={l("Actual search query", "实际检索词")}>
          <pre>{contextualQuery}</pre>
        </DetailSection>
      ) : null}
      <DetailSection title={l("Search range", "检索范围")}>
        <div>
          <DetailKeyValues entries={[
            [l("Target", "目标目录"), targetUri || undefined],
            [l("Source", "调用来源"), searchSourceLabel(source, language)],
            [l("Result limit", "结果上限"), limit === undefined ? undefined : String(limit)],
          ]} />
          {scopes.length > 0 || types.length > 0 ? (
            <div className="openviking-control-detail-tags openviking-search-scope-tags">
              {scopes.map((scope) => <span key={`scope:${scope}`}>{l("Directory", "目录")}: {scope}</span>)}
              {types.map((type) => <span key={`type:${type}`}>{l("Type", "类型")}: {type}</span>)}
            </div>
          ) : null}
        </div>
      </DetailSection>
      <DetailSection title={l("Search result", "检索结果")}>
        <DetailKeyValues entries={[
          [l("Candidates", "候选数"), candidateCount === undefined ? undefined : String(candidateCount)],
          [event.phase === "recall" ? l("Injected", "注入数") : l("Returned", "返回数"), returnedCount === undefined ? undefined : String(returnedCount)],
          [l("Injected tokens", "注入 Token"), injectedTokens === undefined ? undefined : String(injectedTokens)],
          [l("Token budget", "Token 预算"), tokenBudget === undefined ? undefined : String(tokenBudget)],
        ]} />
      </DetailSection>
    </>
  );
}

function DetailFacts({ facts }: { facts: Array<[string, string]> }): ReactElement {
  return <div className="openviking-control-detail-facts">{facts.map(([label, value]) => <article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>;
}

function DetailSection({ title, count, children }: { title: string; count?: number; children: ReactElement }): ReactElement {
  return <section className="openviking-control-detail-section"><header><strong>{title}</strong>{count === undefined ? null : <span>{count}</span>}</header>{children}</section>;
}

function DetailKeyValues({ entries }: { entries: Array<[string, string | undefined]> }): ReactElement {
  return <dl className="openviking-control-detail-kv">{entries.filter(([, value]) => Boolean(value)).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function DetailJson({ title, value, language }: { title: string; value: Record<string, unknown> | undefined; language: LanguageMode }): ReactElement | null {
  if (!value || Object.keys(value).length === 0) return null;
  return <DetailSection title={title}><pre>{JSON.stringify(value, null, 2) || localize(language, "No details", "暂无详情")}</pre></DetailSection>;
}

function findRecallTraceForEvent(
  event: OpenVikingOperationEvent,
  traces: OpenVikingRecallTrace[],
): OpenVikingRecallTrace | undefined {
  if (event.phase !== "recall") return undefined;
  const traceId = detailString(event.details?.traceId);
  if (traceId) return traces.find((trace) => trace.id === traceId);
  const eventTime = Date.parse(event.completedAt ?? event.startedAt);
  if (!Number.isFinite(eventTime)) return undefined;
  return traces.find((trace) => trace.workspaceId === event.workspaceId
    && Math.abs(Date.parse(trace.createdAt) - eventTime) <= 2_000);
}

function detailString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function detailNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailStrings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function searchSourceLabel(source: string, language: LanguageMode): string | undefined {
  if (source === "agent-hook") return localize(language, "Agent automatic recall", "Agent 自动召回");
  if (source === "memory-page") return localize(language, "Memory page", "Memory 页面");
  if (source === "mcp") return "MCP";
  return source || undefined;
}

function recallDecisionLabel(decision: "injected" | "filtered" | "budget", language: LanguageMode): string {
  if (decision === "injected") return localize(language, "Injected", "已注入");
  if (decision === "filtered") return localize(language, "Filtered", "已过滤");
  return localize(language, "Over budget", "超预算");
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
  language,
}: {
  workspace: OpenVikingWorkspace;
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
          <span className={`openviking-runtime-state ${workspace.managed ? "tracking" : "stopped"}`}>
            {workspace.managed ? l("Tracking", "跟踪中") : l("Stopped", "已停止")}
          </span>
          <em>{workspace.managed
            ? l("New turns only", "仅跟踪新对话")
            : l("Memory retained", "记忆已保留")}</em>
        </div>
      </header>
    </article>
  );
}

function DirectoryTracking({
  workspaces,
  language,
}: {
  workspaces: OpenVikingWorkspace[];
  language: LanguageMode;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const hasIssue = workspaces.some((workspace) => !workspace.managed);
  const [expanded, setExpanded] = useState(hasIssue);
  useEffect(() => {
    if (hasIssue) setExpanded(true);
  }, [hasIssue]);
  const status = workspaces.length === 0
    ? l("No tracked directories", "未配置跟踪目录")
    : hasIssue
      ? l("Directory tracking needs attention", "目录跟踪需要处理")
      : l("Directory tracking is healthy", "目录跟踪正常");
  return (
    <section className={`openviking-directory-tracking ${hasIssue ? "warning" : "healthy"}`}>
      <button
        type="button"
        className="openviking-directory-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="openviking-directory-icon"><FolderTree size={16} /></span>
        <span>
          <strong>{status}</strong>
          <small>{l(
            `${workspaces.length} directories · new turns only`,
            `${workspaces.length} 个目录 · 仅捕获未来对话`,
          )}</small>
        </span>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {expanded ? (
        <div className="openviking-directory-content">
          {workspaces.length === 0 ? (
            <div className="openviking-runtime-empty">{l("No memory directories are configured.", "还没有配置记忆目录。")}</div>
          ) : (
            <div className="openviking-runtime-workspaces">
              {workspaces.map((workspace) => (
                <WorkspaceDiagnostics key={workspace.id} workspace={workspace} language={language} />
              ))}
            </div>
          )}
          <p>{l(
            "Historical sessions are not imported. Extraction runs asynchronously after new turns are appended.",
            "历史会话不会批量导入；新 Turn 追加后，记忆提炼会在后台异步执行。",
          )}</p>
        </div>
      ) : null}
    </section>
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

function triggerLabel(trigger: string, language: LanguageMode): string {
  const labels: Record<string, [string, string]> = {
    "explicit-remember": ["Explicit remember", "明确记住"],
    "token-threshold": ["Token threshold", "Token 阈值"],
    idle: ["Idle flush", "空闲提交"],
    compact: ["Before compact", "压缩前提交"],
    "session-end": ["Session end", "会话结束"],
    manual: ["Manual", "手动"],
  };
  const label = labels[trigger];
  return label ? localize(language, label[0], label[1]) : trigger;
}

function phaseLabel(phase: string, language: LanguageMode): string {
  const labels: Record<string, [string, string]> = {
    append: ["Append turns", "追加 Turn"],
    commit: ["Commit accepted", "提交已接收"],
    summary: ["Summary", "摘要"],
    "long-term-memory": ["Long-term memory", "长期记忆"],
    experience: ["Experience extraction", "经验提炼"],
    vectorize: ["Vector indexing", "向量索引"],
    verify: ["Verify and reconcile", "校验与对账"],
    recall: ["Automatic recall", "自动召回"],
    search: ["Memory search", "记忆搜索"],
    read: ["Memory read", "记忆读取"],
    save: ["Memory save", "记忆保存"],
    delete: ["Memory delete", "记忆删除"],
    feedback: ["Memory feedback", "记忆反馈"],
  };
  const label = labels[phase];
  return label ? localize(language, label[0], label[1]) : phase;
}

function commitStateLabel(state: OpenVikingCommitRun["state"], language: LanguageMode): string {
  if (state === "running") return localize(language, "Running", "进行中");
  if (state === "completed") return localize(language, "Complete", "完成");
  return localize(language, "Failed", "失败");
}

function operationStateLabel(
  status: OpenVikingOperationEvent["status"],
  language: LanguageMode,
): string {
  const labels: Record<OpenVikingOperationEvent["status"], [string, string]> = {
    started: ["Started", "已开始"],
    completed: ["Complete", "完成"],
    failed: ["Failed", "失败"],
    degraded: ["Degraded", "降级"],
    skipped: ["Skipped", "跳过"],
  };
  return localize(language, labels[status][0], labels[status][1]);
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1_000)}s`;
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
      control: {
        recentEvents: [],
        recentRecallTraces: [],
        recentCommits: [],
      },
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
