import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarClock, CheckCircle2, ChevronRight, CircleAlert, CircleStop, Clock3, GitBranch, History, LockKeyhole, MessageSquareText, X } from "lucide-react";
import type { ApprovalDecision, ChatEvent, RegisteredArtifact, WorkflowRunState, WorkflowStatus } from "../../../../shared/types";
import type { WorkflowRunFilters, } from "./workflow-run-center-model";
import { filterWorkflowRuns, getWorkflowErrorCode, getWorkflowRunDuration, getWorkflowRunTimeline, getWorkflowRunTimelineBounds, getWorkflowRunTimelineSegmentStyle } from "./workflow-run-center-model";
import type { WorkflowRunTimelineSegment, WorkflowRunTriggerSource } from "../../../../shared/workflow/run";
import type { WorkflowRunNodeTelemetry } from "../../../../shared/workflow/run";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";
import type { WorkflowNodeMessage } from "../../../../shared/workflow/run";
import type { WorkflowRecoveryAction } from "../../../../shared/workflow-v2/transaction";
import type { WorkflowV2InterventionAction } from "../../../../shared/workflow-v2/review";
import { WorkflowReviewTrace } from "./WorkflowReviewTrace";
import { ChatEventMessage } from "../chat/chat-event-display";

interface WorkflowRunCenterProps {
  runs: WorkflowRunState[];
  conversations?: WorkflowNodeConversation[];
  artifacts?: RegisteredArtifact[];
  loading?: boolean;
  error?: string;
  open: boolean;
  selectedRunId?: string;
  language?: "en" | "zh";
  onSelectRun: (runId: string | undefined) => void;
  onClose: () => void;
  onResolveRecovery?: (runId: string, action: WorkflowRecoveryAction, reason: string) => void | Promise<void>;
  onRefreshRecovery?: (runId: string) => void | Promise<void>;
  onResolveConflict?: (runId: string, input: { path: string; resolution: "isolated" | "current" | "manual"; expectedCurrentSha256?: string; content?: string; reason: string }) => void | Promise<void>;
  onResolveUnknownOperation?: (runId: string, input: { operationId: string; verifiedState: "applied" | "not_applied"; reason: string }) => void | Promise<void>;
  onCleanupRunMaterials?: (runId: string) => void | Promise<void>;
  writableRunId?: string;
  onResolveIntervention?: (nodeId: string, action: WorkflowV2InterventionAction, reason?: string) => void | Promise<void>;
  onResolveRuntimeApproval?: (ownerId: string, requestId: string, decision: ApprovalDecision) => void | Promise<void>;
}

const STATUS_LABELS: Record<WorkflowStatus, { en: string; zh: string }> = {
  draft: { en: "draft", zh: "草稿" },
  running: { en: "running", zh: "运行中" },
  waiting_for_user: { en: "waiting for you", zh: "等待你处理" },
  completed: { en: "completed", zh: "已完成" },
  failed: { en: "failed", zh: "失败" },
  stopped: { en: "stopped", zh: "已停止" },
};

function formatDate(value: number, language: "en" | "zh"): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(run: WorkflowRunState): string {
  const seconds = Math.round(getWorkflowRunDuration(run) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatNodeDuration(telemetry: WorkflowRunNodeTelemetry | undefined): string {
  if (!telemetry) return "—";
  const end = telemetry.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - telemetry.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString();
}

function runResultSummary(run: WorkflowRunState): string {
  if (run.finalReport?.trim()) return run.finalReport.trim().slice(0, 120);
  const output = run.progress.find((item) => item.outputs)?.outputs;
  if (output && typeof output.result === "string" && output.result.trim()) return output.result.trim().slice(0, 120);
  return run.progress.find((item) => item.detail?.trim())?.detail?.trim().slice(0, 120) ?? "—";
}

function formatCost(telemetry: WorkflowRunNodeTelemetry | undefined, language: "en" | "zh"): string {
  return telemetry?.estimatedCost === undefined ? (language === "zh" ? "未提供" : "Not provided") : `$${telemetry.estimatedCost.toFixed(3)}`;
}

function statusLabel(status: WorkflowStatus, language: "en" | "zh"): string {
  return STATUS_LABELS[status][language];
}

function eventLabel(type: string, language: "en" | "zh"): string {
  if (language === "zh") {
    const labels: Record<string, string> = {
      node_ready: "节点就绪",
      node_started: "节点开始",
      node_paused: "节点暂停",
      node_output: "节点输出",
      node_judged: "节点评估",
      node_failed: "节点失败",
      node_completed: "节点完成",
      gate_opened: "等待处理",
      gate_answered: "已处理",
      graph_revised: "图已修订",
    };
    return labels[type] ?? type;
  }
  return type.replaceAll("_", " ");
}

function recoveryActionLabel(action: string, language: "en" | "zh"): string {
  const labels: Record<string, { en: string; zh: string }> = {
    continue: { en: "Continue", zh: "继续" },
    rollback_savepoint: { en: "Roll back to savepoint", zh: "回滚到保存点" },
    compensate_all: { en: "Best-effort compensation", zh: "尽力全量补偿" },
    keep_state: { en: "Keep current state", zh: "保留现场" },
    abandon: { en: "Abandon recovery", zh: "放弃处理" },
  };
  return labels[action]?.[language] ?? action;
}

function runIcon(status: WorkflowStatus) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed" || status === "waiting_for_user") return CircleAlert;
  if (status === "stopped") return CircleStop;
  return Clock3;
}

function nodeStatusIcon(status: WorkflowRunState["progress"][number]["status"]) {
  if (status === "completed" || status === "completed_with_override") return CheckCircle2;
  if (status === "failed" || status === "awaiting_input") return CircleAlert;
  if (status === "paused") return CircleStop;
  return Clock3;
}

function messageLabel(message: WorkflowNodeMessage, language: "en" | "zh"): string {
  const toolLabel = message.eventType === "tool_call"
    ? (language === "zh" ? "工具调用" : "Tool call")
    : message.eventType === "tool_result"
      ? (language === "zh" ? "工具结果" : "Tool result")
      : undefined;
  if (toolLabel) return message.name ? `${toolLabel} · ${message.name}` : toolLabel;
  return message.name || message.role;
}

const TRIGGER_SOURCES: WorkflowRunTriggerSource[] = ["manual", "scheduled", "mcp", "recovery", "rerun"];

function triggerSourceLabel(source: WorkflowRunTriggerSource | undefined, language: "en" | "zh"): string {
  const labels: Record<WorkflowRunTriggerSource, { en: string; zh: string }> = {
    manual: { en: "manual", zh: "手动" },
    scheduled: { en: "scheduled", zh: "定时" },
    mcp: { en: "MCP", zh: "MCP" },
    recovery: { en: "recovery", zh: "恢复" },
    rerun: { en: "rerun", zh: "重跑" },
  };
  return labels[source ?? "manual"][language];
}

function artifactFileName(path: string | undefined): string {
  return path?.split(/[\\/]/).pop() || "—";
}

function artifactUrlPreview(url: string | undefined): string {
  if (!url) return "—";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] || "—";
  }
}

function dateBoundary(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export function WorkflowRunCenter(props: WorkflowRunCenterProps) {
  if (!props.open) return null;
  return <WorkflowRunCenterOpen {...props} />;
}

function WorkflowRunCenterOpen({ runs, conversations = [], artifacts = [], loading = false, error, selectedRunId, language = "en", onSelectRun, onClose, onResolveRecovery, onRefreshRecovery, onResolveConflict, onResolveUnknownOperation, onCleanupRunMaterials, writableRunId, onResolveIntervention, onResolveRuntimeApproval }: WorkflowRunCenterProps) {
  const [activeRunId, setActiveRunId] = useState<string | undefined>(selectedRunId);
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<WorkflowRunTriggerSource | "all">("all");
  const [graphVersionFilter, setGraphVersionFilter] = useState("all");
  const [runListLimit, setRunListLimit] = useState(50);
  const [startedAfter, setStartedAfter] = useState("");
  const [startedBefore, setStartedBefore] = useState("");
  const [recoveryReason, setRecoveryReason] = useState("");
  const [recoveryActionError, setRecoveryActionError] = useState<string>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string>();
  const [conflictDrafts, setConflictDrafts] = useState<Record<string, { resolution: "isolated" | "current" | "manual"; content: string; reason: string }>>({});
  const [conflictBusyPath, setConflictBusyPath] = useState<string>();
  const [conflictError, setConflictError] = useState<string>();
  const [unknownOperationReasons, setUnknownOperationReasons] = useState<Record<string, string>>({});
  const [unknownOperationBusyId, setUnknownOperationBusyId] = useState<string>();
  const [unknownOperationError, setUnknownOperationError] = useState<string>();
  const [refreshedRecoveryRunIds, setRefreshedRecoveryRunIds] = useState<string[]>([]);
  const [nodeActionReason, setNodeActionReason] = useState("");
  const [nodeActionBusy, setNodeActionBusy] = useState(false);
  const [nodeActionError, setNodeActionError] = useState<string>();
  const selectedRun = activeRunId ? runs.find((run) => run.runId === activeRunId) : undefined;
  const graphVersions = useMemo(() => [...new Set(runs.map((run) => run.workflowV2Plan.graphVersion))].sort((left, right) => right - left), [runs]);
  const filters: WorkflowRunFilters = {
    ...(statusFilter !== "all" ? { statuses: [statusFilter] } : {}),
    ...(sourceFilter !== "all" ? { triggerSources: [sourceFilter] } : {}),
    ...(graphVersionFilter !== "all" ? { graphVersions: [Number(graphVersionFilter)] } : {}),
    startedAfter: dateBoundary(startedAfter, false),
    startedBefore: dateBoundary(startedBefore, true),
  };
  const visibleRuns = useMemo(() => filterWorkflowRuns(runs, filters), [runs, statusFilter, sourceFilter, graphVersionFilter, startedAfter, startedBefore]);
  const displayedRuns = visibleRuns.slice(0, runListLimit);

  useEffect(() => {
    if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) setActiveRunId(selectedRunId);
    else if (activeRunId && !runs.some((run) => run.runId === activeRunId)) setActiveRunId(undefined);
  }, [activeRunId, runs, selectedRunId]);

  useEffect(() => {
    if (!selectedRun?.recovery || !onRefreshRecovery || refreshedRecoveryRunIds.includes(selectedRun.runId)) return;
    setRefreshedRecoveryRunIds((current) => [...current, selectedRun.runId]);
    void Promise.resolve(onRefreshRecovery(selectedRun.runId)).catch((refreshError) => setRecoveryActionError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
  }, [onRefreshRecovery, refreshedRecoveryRunIds, selectedRun]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedProgressByNodeId = useMemo(() => new Map(selectedRun?.progress.map((item) => [item.nodeId, item]) ?? []), [selectedRun]);
  const selectedEventsByNodeId = useMemo(() => {
    const result = new Map<string, WorkflowRunState["events"]>();
    for (const event of selectedRun?.events ?? []) {
      if (!event.nodeId) continue;
      const events = result.get(event.nodeId) ?? [];
      events.push(event);
      result.set(event.nodeId, events);
    }
    for (const events of result.values()) events.sort((left, right) => left.at - right.at);
    return result;
  }, [selectedRun]);
  const selectedConversationsByNodeId = useMemo(() => new Map(
    conversations.filter((item) => item.runId === selectedRun?.runId).map((item) => [item.nodeId, item]),
  ), [conversations, selectedRun?.runId]);
  const selectedArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.target === selectedRun?.runId), [artifacts, selectedRun?.runId]);
  const selectedTimeline = useMemo<Map<string, WorkflowRunTimelineSegment[]>>(() => selectedRun ? getWorkflowRunTimeline(selectedRun) : new Map<string, WorkflowRunTimelineSegment[]>(), [selectedRun]);
  const selectedTimelineBounds = useMemo(() => selectedRun ? getWorkflowRunTimelineBounds(selectedRun) : undefined, [selectedRun]);
  const labels = language === "zh"
    ? { title: "运行历史", close: "关闭运行历史", empty: "还没有运行记录", loading: "正在加载运行历史", loadMore: "加载更多运行记录", noMatches: "没有符合筛选条件的 Run", choose: "选择一条运行记录查看详情", back: "返回运行列表", detail: "运行详情", readOnly: "只读快照", timeline: "节点时间线", messages: "消息历史", outputs: "输出摘要", artifacts: "历史产物", inputSummary: "输入摘要", inputRequested: "请求输入", result: "结果", config: "冻结配置", agent: "Agent", agentRevision: "Agent 版本", graph: "图版本", started: "开始", finished: "结束", duration: "耗时", trigger: "触发来源", approvedBy: "确认人", nodes: "节点", noEvents: "暂无事件记录", notStarted: "未开始", runtime: "Runtime", channel: "Channel", model: "模型", attempts: "尝试次数", executionDetails: "执行明细", tokenUsage: "Token 用量", provider: "计量风格", inputTokens: "输入 tokens", outputTokens: "输出 tokens", reasoningTokens: "推理 tokens", cachedInput: "缓存输入（OpenAI）", cacheRead: "缓存读取（Anthropic）", cacheWrite: "缓存写入（Anthropic）", cacheWrite5m: "缓存写入 · 5 分钟", cacheWrite1h: "缓存写入 · 1 小时", totalTokens: "总 tokens", cost: "成本", filters: "筛选运行" }
    : { title: "Run history", close: "Close run history", empty: "No runs yet", loading: "Loading run history", loadMore: "Load more runs", noMatches: "No runs match the filters", choose: "Select a run to view its details", back: "Back to run list", detail: "Run details", readOnly: "Read-only snapshot", timeline: "Node timeline", messages: "Message history", outputs: "Outputs", artifacts: "Artifacts", inputSummary: "Input summary", inputRequested: "Input requested", result: "Result", config: "Frozen configuration", agent: "Agent", agentRevision: "Agent revision", graph: "Graph version", started: "Started", finished: "Finished", duration: "Duration", trigger: "Trigger source", approvedBy: "Approved by", nodes: "Nodes", noEvents: "No events recorded", notStarted: "Not started", runtime: "Runtime", channel: "Channel", model: "Model", attempts: "Attempts", executionDetails: "Execution details", tokenUsage: "Token usage", provider: "Accounting style", inputTokens: "Input tokens", outputTokens: "Output tokens", reasoningTokens: "Reasoning tokens", cachedInput: "Cached input (OpenAI)", cacheRead: "Cache read (Anthropic)", cacheWrite: "Cache write (Anthropic)", cacheWrite5m: "Cache write · 5 min", cacheWrite1h: "Cache write · 1 hour", totalTokens: "Total tokens", cost: "Cost", filters: "Filter runs" };

  return (
    <div className="workflow-run-center-backdrop" role="presentation" onClick={onClose}>
      <section className={`workflow-run-center ${selectedRun ? "is-detail" : ""}`} role="dialog" aria-modal="true" aria-label={labels.title} onClick={(event) => event.stopPropagation()}>
        <header className="workflow-run-center-header">
          <div className="workflow-run-center-title">
            <History size={17} />
            <div><strong>{labels.title}</strong><span>{Math.min(displayedRuns.length, visibleRuns.length)}/{runs.length} {language === "zh" ? "次运行" : "runs"}</span></div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={labels.close}><X size={15} /></button>
        </header>
        {loading ? <div className="workflow-run-center-empty is-loading" aria-live="polite"><Clock3 size={22} /><strong>{labels.loading}</strong></div> : error ? <div className="workflow-run-center-empty is-error" role="alert"><CircleAlert size={22} /><strong>{error}</strong></div> : runs.length === 0 ? <div className="workflow-run-center-empty"><History size={22} /><strong>{labels.empty}</strong></div> : (
          <div className={`workflow-run-center-body ${selectedRun ? "is-detail" : ""}`}>
            <nav className="workflow-run-center-list" aria-label={labels.title}>
              <form className="workflow-run-center-filters" onSubmit={(event) => event.preventDefault()}>
                <strong>{labels.filters}</strong>
                <label><span>{language === "zh" ? "状态" : "Status"}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as WorkflowStatus | "all")}><option value="all">{language === "zh" ? "全部" : "All"}</option>{["running", "waiting_for_user", "completed", "failed", "stopped"].map((status) => <option key={status} value={status}>{statusLabel(status as WorkflowStatus, language)}</option>)}</select></label>
                <label><span>{labels.trigger}</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.currentTarget.value as WorkflowRunTriggerSource | "all")}><option value="all">{language === "zh" ? "全部" : "All"}</option>{TRIGGER_SOURCES.map((source) => <option key={source} value={source}>{triggerSourceLabel(source, language)}</option>)}</select></label>
                <label><span>{labels.graph}</span><select value={graphVersionFilter} onChange={(event) => setGraphVersionFilter(event.currentTarget.value)}><option value="all">{language === "zh" ? "全部" : "All"}</option>{graphVersions.map((version) => <option key={version} value={version}>v{version}</option>)}</select></label>
                <div className="workflow-run-center-filter-dates"><label><span>{language === "zh" ? "起始日期" : "From"}</span><input type="date" value={startedAfter} onChange={(event) => setStartedAfter(event.currentTarget.value)} /></label><label><span>{language === "zh" ? "结束日期" : "To"}</span><input type="date" value={startedBefore} onChange={(event) => setStartedBefore(event.currentTarget.value)} /></label></div>
              </form>
              {displayedRuns.map((run) => {
                const Icon = runIcon(run.status);
                return (
                  <button key={run.runId} type="button" className={`workflow-run-center-item ${run.runId === selectedRun?.runId ? "is-active" : ""}`} onClick={() => { setActiveRunId(run.runId); onSelectRun(run.runId); }}>
                    <Icon size={14} />
                    <span><strong>{statusLabel(run.status, language)}</strong><small>{labels.started} {formatDate(run.startedAt, language)}</small><small>{labels.finished} {run.finishedAt ? formatDate(run.finishedAt, language) : "—"}</small><small>{labels.trigger}: {triggerSourceLabel(run.triggerSource, language)}</small><small>{labels.result}: {runResultSummary(run)}</small></span>
                    <em>{formatDuration(run)}</em>
                    <ChevronRight size={13} aria-hidden="true" />
                  </button>
                );
              })}
              {displayedRuns.length < visibleRuns.length ? <button type="button" className="workflow-run-center-load-more" onClick={() => setRunListLimit((limit) => limit + 50)}>{labels.loadMore}</button> : null}
              {visibleRuns.length === 0 ? <div className="workflow-run-center-filter-empty">{labels.noMatches}</div> : null}
            </nav>
            {selectedRun ? (
              <main className="workflow-run-center-detail">
                <header className="workflow-run-center-detail-head">
                  <div><button type="button" className="workflow-run-center-back" onClick={() => { setActiveRunId(undefined); onSelectRun(undefined); }} aria-label={labels.back}><ArrowLeft size={14} /><span>{labels.back}</span></button><span className={`workflow-run-center-status is-${selectedRun.status}`}>{statusLabel(selectedRun.status, language)}</span><span className="workflow-run-center-readonly"><LockKeyhole size={11} />{labels.readOnly}</span><h3>{labels.detail}</h3><small>{selectedRun.runId}</small></div>
                  <div className="workflow-run-center-metrics"><span><b>{labels.started}</b>{formatDate(selectedRun.startedAt, language)}</span><span><b>{labels.finished}</b>{selectedRun.finishedAt ? formatDate(selectedRun.finishedAt, language) : "—"}</span><span><b>{labels.duration}</b>{formatDuration(selectedRun)}</span><span><b>{labels.trigger}</b>{triggerSourceLabel(selectedRun.triggerSource, language)}</span><span><b>{labels.graph}</b>v{selectedRun.workflowV2Plan.graphVersion}</span></div>
                </header>
                {selectedRun.lastError ? <div className="workflow-run-center-error"><CircleAlert size={15} /><span>{selectedRun.lastError}</span></div> : null}
                {selectedRun.transaction ? <section className="workflow-run-center-section workflow-run-center-transaction">
                  <header><CircleAlert size={14} /><strong>{language === "zh" ? "事务与恢复" : "Transaction and recovery"}</strong></header>
                  <div className="workflow-run-center-config-grid">
                    <span><b>{language === "zh" ? "事务模式" : "Mode"}</b>{selectedRun.transaction.mode}</span>
                    <span><b>{language === "zh" ? "事务状态" : "Status"}</b>{selectedRun.transaction.status}</span>
                    <span><b>{language === "zh" ? "审批模式" : "Approval mode"}</b>{selectedRun.workflowV2Plan.definition.transactionPolicy?.approvalMode ?? "—"}</span>
                    <span><b>{language === "zh" ? "保存点" : "Savepoint"}</b>{selectedRun.transaction.currentSavepointId ?? "—"}</span>
                    <span><b>{language === "zh" ? "待审批检查点" : "Pending checkpoint"}</b>{selectedRun.transaction.pendingCheckpointId ?? "—"}</span>
                    <span><b>{language === "zh" ? "待审批计划摘要" : "Pending plan digest"}</b>{selectedRun.transaction.pendingCheckpointPlanDigest?.slice(0, 16) ?? "—"}</span>
                    <span><b>{language === "zh" ? "已完成检查点" : "Completed checkpoints"}</b>{selectedRun.transaction.completedCheckpointIds?.join(", ") || "—"}</span>
                    <span><b>{language === "zh" ? "受治理文件" : "Governed files"}</b>{selectedRun.transaction.governedFileCount ?? "—"}</span>
                    <span><b>{language === "zh" ? "排除路径" : "Excluded paths"}</b>{selectedRun.transaction.excludedPaths?.join(", ") || "—"}</span>
                    <span><b>{language === "zh" ? "操作总数" : "Operations"}</b>{selectedRun.transaction.operationCount}</span>
                    <span><b>{language === "zh" ? "已提交" : "Applied"}</b>{selectedRun.operations?.filter((operation) => operation.state === "applied").length ?? 0}</span>
                    <span><b>{language === "zh" ? "已补偿" : "Compensated"}</b>{selectedRun.operations?.filter((operation) => operation.state === "compensated").length ?? 0}</span>
                    <span><b>{language === "zh" ? "状态未知" : "Unknown"}</b>{selectedRun.transaction.unknownOperationCount}</span>
                    <span><b>{language === "zh" ? "不可撤销" : "Irreversible"}</b>{selectedRun.transaction.irreversibleOperationCount}</span>
                    <span><b>{language === "zh" ? "材料保留至" : "Retained until"}</b>{formatDate(selectedRun.transaction.retentionUntil, language)}</span>
                  </div>
                  {selectedRun.workflowV2Plan.definition.transactionPolicy?.defaultMode === "controlled" ? <small>{language === "zh" ? "自动提交授权绑定到已确认的操作语义；目标、参数或动态新增操作发生变化后必须重新确认。" : "Auto-commit authorization is bound to confirmed operation semantics; changed targets, parameters, or dynamically added operations require confirmation again."}</small> : null}
                  <div className="workflow-run-center-material-actions">
                    {selectedRun.finalReport?.trim() ? <button type="button" onClick={() => downloadWorkflowRunReport(selectedRun)}>{language === "zh" ? "下载最终报告" : "Download final report"}</button> : null}
                    {onCleanupRunMaterials && (selectedRun.transaction.status === "committed" || selectedRun.transaction.status === "rolled_back") ? <button type="button" disabled={cleanupBusy} onClick={() => {
                      const prompt = language === "zh" ? "确认清理该 Run 的事务账本、快照、receipt 和本地报告材料？此操作不可撤销，运行摘要仍会保留。" : "Delete this run's transaction ledger, snapshots, receipts, and local report materials? This cannot be undone; the run summary remains.";
                      if (!window.confirm(prompt)) return;
                      setCleanupBusy(true);
                      setCleanupError(undefined);
                      void Promise.resolve(onCleanupRunMaterials(selectedRun.runId)).catch((cleanupActionError) => setCleanupError(cleanupActionError instanceof Error ? cleanupActionError.message : String(cleanupActionError))).finally(() => setCleanupBusy(false));
                    }}>{language === "zh" ? "安全清理材料" : "Safely clean materials"}</button> : null}
                    {cleanupError ? <p className="is-error">{cleanupError}</p> : null}
                  </div>
                  {selectedRun.recovery ? <div className="workflow-run-center-events">
                    {selectedRun.recovery.blockers.map((blocker) => <span key={blocker}>{language === "zh" ? "阻塞" : "Blocker"} · {blocker}</span>)}
                    {selectedRun.recovery.conflicts.map((conflict) => <span key={`conflict:${conflict}`}>{language === "zh" ? "冲突" : "Conflict"} · {conflict}</span>)}
                    {selectedRun.recovery.cancelledNodeIds.length > 0 ? <span>{language === "zh" ? "已取消节点" : "Cancelled nodes"} · {selectedRun.recovery.cancelledNodeIds.join(", ")}</span> : null}
                    {selectedRun.recovery.cancellingNodeIds.length > 0 ? <span>{language === "zh" ? "正在取消或停止状态未知" : "Cancelling or stop unconfirmed"} · {selectedRun.recovery.cancellingNodeIds.join(", ")}</span> : null}
                    {(selectedRun.operations?.some((operation) => operation.state === "applying" || operation.state === "unknown" || operation.state === "compensating") ?? false) ? <span>{language === "zh" ? "可能仍有副作用的外部请求" : "External requests that may still have side effects"} · {selectedRun.operations!.filter((operation) => operation.state === "applying" || operation.state === "unknown" || operation.state === "compensating").map((operation) => `${operation.operationId} (${operation.target})`).join(", ")}</span> : null}
                    {selectedRun.recovery.notStartedNodeIds.length > 0 ? <span>{language === "zh" ? "fail-fast 后未启动" : "Not started after fail-fast"} · {selectedRun.recovery.notStartedNodeIds.join(", ")}</span> : null}
                    <span>{language === "zh" ? "可用处理动作" : "Available actions"} · {selectedRun.recovery.availableActions.map((action) => recoveryActionLabel(action, language)).join(" / ")}</span>
                    {onRefreshRecovery ? <button type="button" disabled={recoveryBusy} onClick={() => void Promise.resolve(onRefreshRecovery(selectedRun.runId)).catch((refreshError) => setRecoveryActionError(refreshError instanceof Error ? refreshError.message : String(refreshError)))}>{language === "zh" ? "重新检查恢复事实" : "Re-inspect recovery facts"}</button> : null}
                  </div> : null}
                  {selectedRun.recovery ? <details className="workflow-run-center-manager-candidate">
                    <summary>{selectedRun.recovery.managerRecommendation.source === "agent" ? (language === "zh" ? "查看 Manager Agent 候选结果" : "View Manager Agent candidate") : (language === "zh" ? "查看规则恢复候选结果" : "View rules-based recovery candidate")}</summary>
                    <strong>{language === "zh" ? "建议动作" : "Recommended action"} · {recoveryActionLabel(selectedRun.recovery.managerRecommendation.recommendedAction, language)}</strong>
                    <p>{selectedRun.recovery.managerRecommendation.rationale}</p>
                    {selectedRun.recovery.managerRecommendation.rollbackTarget ? <p>{language === "zh" ? "建议回滚目标" : "Rollback target"} · {selectedRun.recovery.managerRecommendation.rollbackTarget}</p> : null}
                    {selectedRun.recovery.managerRecommendation.compensationOperationIds.length > 0 ? <p>{language === "zh" ? "逆序补偿计划" : "Reverse compensation plan"} · {selectedRun.recovery.managerRecommendation.compensationOperationIds.join(" → ")}</p> : null}
                    {selectedRun.recovery.managerRecommendation.conflictCandidates.map((candidate) => <p key={candidate.path}>{candidate.path} · {candidate.resolution} · {candidate.rationale}</p>)}
                    {selectedRun.recovery.managerRecommendation.manualSteps.map((step) => <p key={step}>{language === "zh" ? "人工步骤" : "Manual step"} · {step}</p>)}
                    <div>{selectedRun.recovery.managerRecommendation.riskComparison.map((item) => <span key={item.action}>{recoveryActionLabel(item.action, language)} · {item.risk} · {item.detail}</span>)}</div>
                    <small>{language === "zh" ? "候选结果只读；任何写入、补偿或事务状态变更仍需下方确认。" : "This candidate is read-only; writes, compensation, and transaction changes still require confirmation below."}</small>
                  </details> : null}
                  {selectedRun.recovery && onResolveRecovery ? <div className="workflow-run-center-recovery-actions">
                    <label><span>{language === "zh" ? "决定依据" : "Decision reason"}</span><input value={recoveryReason} maxLength={2_000} onChange={(event) => setRecoveryReason(event.currentTarget.value)} placeholder={language === "zh" ? "说明核验依据和预期结果" : "Describe the evidence and expected outcome"} /></label>
                    <div>{selectedRun.recovery.availableActions.map((action) => <button key={action} type="button" disabled={recoveryBusy || recoveryReason.trim().length === 0} onClick={() => {
                      const prompt = language === "zh" ? `确认执行“${recoveryActionLabel(action, language)}”？执行前请再次核对当前 diff 与 operation receipt。` : `Confirm “${recoveryActionLabel(action, language)}”? Re-check the current diff and operation receipts first.`;
                      if (!window.confirm(prompt)) return;
                      setRecoveryBusy(true);
                      setRecoveryActionError(undefined);
                      void Promise.resolve(onResolveRecovery(selectedRun.runId, action, recoveryReason.trim()))
                        .then(() => setRecoveryReason(""))
                        .catch((actionError) => setRecoveryActionError(actionError instanceof Error ? actionError.message : String(actionError)))
                        .finally(() => setRecoveryBusy(false));
                    }}>{recoveryActionLabel(action, language)}</button>)}</div>
                    {recoveryActionError ? <p className="is-error">{recoveryActionError}</p> : null}
                  </div> : null}
                  {(selectedRun.recovery?.conflictDetails.length ?? 0) > 0 ? <div className="workflow-run-center-conflicts">
                    {selectedRun.recovery!.conflictDetails.map((conflict) => {
                      const draft = conflictDrafts[conflict.path] ?? { resolution: "isolated" as const, content: "", reason: "" };
                      const finalContent = draft.resolution === "isolated" ? conflict.isolated.preview : draft.resolution === "current" ? conflict.current.preview : draft.content;
                      return <article key={conflict.path}>
                      <strong>{conflict.path}</strong>
                      <div className="workflow-run-center-conflict-columns">
                        {([
                          [language === "zh" ? "Workflow 基线" : "Workflow baseline", conflict.baseline],
                          [language === "zh" ? "Workflow 隔离结果" : "Workflow isolated result", conflict.isolated],
                          [language === "zh" ? "用户当前工作区" : "Current user workspace", conflict.current],
                        ] as const).map(([title, version]) => <section key={title}><b>{title}</b><small>{version.exists ? `${version.sha256?.slice(0, 12) ?? "no digest"} · ${version.size ?? 0} B` : (language === "zh" ? "文件不存在" : "File absent")}</small>{version.preview !== undefined ? <pre>{version.preview}</pre> : version.binary ? <p>{language === "zh" ? "二进制文件，仅显示摘要" : "Binary file; digest only"}</p> : null}</section>)}
                      </div>
                      {onResolveConflict ? <div className="workflow-run-center-recovery-actions">
                        <label><span>{language === "zh" ? "解决方式" : "Resolution"}</span><select value={draft.resolution} onChange={(event) => setConflictDrafts((current) => ({ ...current, [conflict.path]: { ...draft, resolution: event.currentTarget.value as typeof draft.resolution } }))}><option value="isolated">{language === "zh" ? "采用 Workflow 结果" : "Use workflow result"}</option><option value="current">{language === "zh" ? "保留用户当前版本" : "Keep current version"}</option><option value="manual">{language === "zh" ? "手动合并" : "Manual merge"}</option></select></label>
                        {draft.resolution === "manual" ? <label><span>{language === "zh" ? "最终文件内容" : "Final file content"}</span><textarea value={draft.content} onChange={(event) => setConflictDrafts((current) => ({ ...current, [conflict.path]: { ...draft, content: event.currentTarget.value } }))} /></label> : null}
                        <label><span>{language === "zh" ? "决定依据" : "Decision reason"}</span><input value={draft.reason} maxLength={2_000} onChange={(event) => setConflictDrafts((current) => ({ ...current, [conflict.path]: { ...draft, reason: event.currentTarget.value } }))} /></label>
                        <details open><summary>{language === "zh" ? "最终写入前差异确认" : "Final diff before write"}</summary><pre>{finalContent ?? (language === "zh" ? "（删除文件）" : "(delete file)")}</pre></details>
                        <button type="button" disabled={conflictBusyPath === conflict.path || !draft.reason.trim() || (draft.resolution === "manual" && (conflict.isolated.binary || conflict.current.binary))} onClick={() => {
                          const prompt = language === "zh" ? `确认按“${draft.resolution}”解决 ${conflict.path}？上方内容将成为确认后的最终版本。` : `Resolve ${conflict.path} with “${draft.resolution}”? The content above is the confirmed final version.`;
                          if (!window.confirm(prompt)) return;
                          setConflictBusyPath(conflict.path);
                          setConflictError(undefined);
                          void Promise.resolve(onResolveConflict(selectedRun.runId, { path: conflict.path, resolution: draft.resolution, ...(conflict.current.sha256 ? { expectedCurrentSha256: conflict.current.sha256 } : {}), ...(draft.resolution === "manual" ? { content: draft.content } : {}), reason: draft.reason.trim() })).then(() => setConflictDrafts((current) => { const next = { ...current }; delete next[conflict.path]; return next; })).catch((resolveError) => setConflictError(resolveError instanceof Error ? resolveError.message : String(resolveError))).finally(() => setConflictBusyPath(undefined));
                        }}>{language === "zh" ? "确认并写入" : "Confirm and write"}</button>
                      </div> : null}
                    </article>})}
                    {conflictError ? <p className="is-error">{conflictError}</p> : null}
                  </div> : null}
                  {(selectedRun.operations?.length ?? 0) > 0 ? <div className="workflow-run-center-artifact-list">
                    {selectedRun.operations!.map((operation) => <article key={operation.operationId}>
                      <strong>{operation.kind} · {operation.state}</strong>
                      <small>{operation.operationId}</small>
                      <small>nodeId · {operation.nodeId} · attempt #{operation.attempt}</small>
                      <p>{operation.target}</p>
                      <small>{operation.reversible ? (language === "zh" ? "可补偿" : "Reversible") : (language === "zh" ? "不可撤销" : "Irreversible")}</small>
                      <small>{language === "zh" ? "补偿适配器" : "Compensation adapter"} · {operation.compensationAdapter ?? (language === "zh" ? "无" : "none")}</small>
                      {operation.requestSummary !== undefined ? <details><summary>{language === "zh" ? "查看授权目标与参数摘要" : "View authorized target and parameter summary"}</summary><pre>{JSON.stringify(operation.requestSummary, null, 2)}</pre></details> : null}
                      {operation.error ? <p className="is-error">{operation.error}</p> : null}
                      {operation.receipt !== undefined ? <details><summary>{language === "zh" ? "查看 receipt" : "View receipt"}</summary><pre>{JSON.stringify(operation.receipt, null, 2)}</pre></details> : null}
                      {operation.state === "unknown" && onResolveUnknownOperation && selectedRun.runId === writableRunId ? <div className="workflow-run-center-recovery-actions">
                        <label><span>{language === "zh" ? "核验依据" : "Verification reason"}</span><input value={unknownOperationReasons[operation.operationId] ?? ""} maxLength={2_000} onChange={(event) => setUnknownOperationReasons((current) => ({ ...current, [operation.operationId]: event.currentTarget.value }))} placeholder={language === "zh" ? "填写远端记录、回执或人工核对结果" : "Describe the remote record, receipt, or manual verification"} /></label>
                        <div>{(["applied", "not_applied"] as const).map((verifiedState) => <button key={verifiedState} type="button" disabled={unknownOperationBusyId === operation.operationId || !(unknownOperationReasons[operation.operationId]?.trim())} onClick={() => {
                          const reason = unknownOperationReasons[operation.operationId]!.trim();
                          const prompt = language === "zh" ? `确认将 ${operation.operationId} 核验为“${verifiedState === "applied" ? "已应用" : "未应用"}”？此决定会写入事务账本。` : `Verify ${operation.operationId} as “${verifiedState === "applied" ? "applied" : "not applied"}”? This decision will be written to the transaction ledger.`;
                          if (!window.confirm(prompt)) return;
                          setUnknownOperationBusyId(operation.operationId);
                          setUnknownOperationError(undefined);
                          void Promise.resolve(onResolveUnknownOperation(selectedRun.runId, { operationId: operation.operationId, verifiedState, reason }))
                            .then(() => setUnknownOperationReasons((current) => { const next = { ...current }; delete next[operation.operationId]; return next; }))
                            .catch((resolveError) => setUnknownOperationError(resolveError instanceof Error ? resolveError.message : String(resolveError)))
                            .finally(() => setUnknownOperationBusyId(undefined));
                        }}>{verifiedState === "applied" ? (language === "zh" ? "核验为已应用" : "Verify applied") : (language === "zh" ? "核验为未应用" : "Verify not applied")}</button>)}</div>
                      </div> : null}
                    </article>)}
                    {unknownOperationError ? <p className="is-error">{unknownOperationError}</p> : null}
                  </div> : null}
                  {(selectedRun.recoveryDecisions?.length ?? 0) > 0 ? <details className="workflow-run-center-node-outputs">
                    <summary>{language === "zh" ? "用户恢复决定" : "Recovery decisions"} · {selectedRun.recoveryDecisions!.length}</summary>
                    <div className="workflow-run-center-events">{selectedRun.recoveryDecisions!.map((decision) => <span key={decision.decisionId}>{recoveryActionLabel(decision.action, language)} · {decision.actor} · {formatDate(decision.decidedAt, language)} · {decision.reason} · operationId: {decision.operationIds.join(", ") || "—"}</span>)}</div>
                  </details> : null}
                </section> : null}
                {selectedArtifacts.length > 0 ? <section className="workflow-run-center-section workflow-run-center-artifacts"><header><GitBranch size={14} /><strong>{labels.artifacts}</strong></header><div className="workflow-run-center-artifact-list">{selectedArtifacts.map((artifact) => <article key={artifact.id}><strong>{artifact.title}</strong><small>{artifact.kind === "file" ? artifactFileName(artifact.path) : artifact.kind === "url" ? artifactUrlPreview(artifact.url) : "text"}</small>{artifact.description ? <p>{artifact.description}</p> : null}{artifact.kind === "text" && artifact.content ? <pre>{artifact.content.slice(0, 4000)}</pre> : null}</article>)}</div></section> : null}
                <section className="workflow-run-center-section">
                  <header><GitBranch size={14} /><strong>{labels.config}</strong></header>
                  <div className="workflow-run-center-config-grid"><span><b>{labels.approvedBy}</b>{selectedRun.workflowV2Plan.approvedBy || "—"}</span><span><b>{labels.nodes}</b>{selectedRun.workflowV2Plan.nodes.length}</span><span><b>{language === "zh" ? "上下文预算" : "Context budget"}</b>{selectedRun.workflowV2Plan.budget.context.maxContextTokens ?? "—"}</span><span><b>{language === "zh" ? "上一次运行" : "Parent run"}</b>{selectedRun.parentRunId ?? "—"}</span><span><b>{labels.agent}</b>{selectedRun.configurationSnapshot?.configuredAgentId ?? "—"}</span><span><b>{labels.agentRevision}</b>{selectedRun.configurationSnapshot?.agentRevision ?? "—"}</span><span><b>{labels.runtime}</b>{selectedRun.configurationSnapshot?.runtimeId ?? "—"}</span><span><b>{labels.channel}</b>{selectedRun.configurationSnapshot?.channelId ?? "—"}</span><span><b>{labels.model}</b>{selectedRun.configurationSnapshot?.modelId ?? "—"}</span></div>
                </section>
                <section className="workflow-run-center-section">
                  <header><CalendarClock size={14} /><strong>{labels.timeline}</strong></header>
                  <div className="workflow-run-center-timeline">
                    {selectedRun.workflowV2Plan.nodes.map((node) => {
                      const progress = selectedProgressByNodeId.get(node.nodeId);
                      const events = selectedEventsByNodeId.get(node.nodeId) ?? [];
                      const eventError = [...events].reverse().find((event) => event.error)?.error;
                      const conversation = selectedConversationsByNodeId.get(node.nodeId);
                      const messages = conversation?.messages.length ? conversation.messages : progress?.messages ?? [];
                      const hasLiveApproval = messages.some((message) => {
                        const event = message.event as Partial<ChatEvent> | undefined;
                        return event?.type === "approval_request" && event.requestState === "live";
                      });
                      const approvalOwnerId = conversation
                        ? `workflow-node:${conversation.workflowId}:${conversation.runId}:${conversation.nodeId}`
                        : progress?.taskId;
                      const reviewMessages = progress?.reviewMessages ?? [];
                      const reviewHasLiveApproval = reviewMessages.some((message) => {
                        const event = message.event as Partial<ChatEvent> | undefined;
                        return event?.type === "approval_request" && event.requestState === "live";
                      });
                      const telemetry = progress?.telemetry ?? conversation?.telemetry;
                      const timelineSegments = selectedTimeline.get(node.nodeId) ?? [];
                      return (
                        <article key={node.nodeId} className={`workflow-run-center-node ${progress ? `is-${progress.status}` : ""}`}>
                          <div className="workflow-run-center-node-head">
                            {(() => { const nodeStatus = progress?.status ?? "queued"; const StatusIcon = nodeStatusIcon(nodeStatus); return <span><StatusIcon size={11} aria-label={`Node status: ${nodeStatus}`} />{nodeStatus}</span>; })()}
                            <strong>{node.title}</strong>
                            <small>{node.execModel} · {node.modelId ?? node.modelProfile}</small>
                          </div>
                          <details className="workflow-run-center-node-telemetry">
                            <summary><span>{labels.executionDetails}</span><em>{telemetry?.attempt ?? "—"} · {formatNodeDuration(telemetry)}</em></summary>
                            <div className="workflow-run-center-node-telemetry-grid">
                              <span><b>{labels.runtime}</b>{telemetry?.runtimeId ?? "—"}</span>
                              <span><b>{labels.channel}</b>{telemetry?.channelId ?? "—"}</span>
                              <span><b>{labels.model}</b>{telemetry?.modelId ?? node.modelId ?? node.modelProfile ?? "—"}</span>
                              <span><b>{labels.attempts}</b>{telemetry?.attempt ?? "—"}</span>
                              <span><b>{labels.duration}</b>{formatNodeDuration(telemetry)}</span>
                              <span><b>{labels.cost}</b>{formatCost(telemetry, language)}</span>
                              <span><b>{language === "zh" ? "模型调用" : "Model calls"}</b>{formatMetric(telemetry?.modelCalls)}</span>
                              <span><b>{language === "zh" ? "审查调用" : "Review calls"}</b>{formatMetric(telemetry?.reviewModelCalls)}</span>
                              <span><b>{language === "zh" ? "质量尝试" : "Quality attempts"}</b>{formatMetric(telemetry?.reviewQualityAttempts)}</span>
                              <span><b>{language === "zh" ? "审查通道尝试" : "Review channel attempts"}</b>{formatMetric(telemetry?.reviewInfrastructureAttempts)}</span>
                            </div>
                            <div className="workflow-run-center-node-token-usage">
                              <strong>{labels.tokenUsage}</strong>
                              <span className="workflow-run-center-node-token-provider">{labels.provider}: {telemetry?.provider ?? "—"}</span>
                              <div className="workflow-run-center-node-telemetry-grid">
                                <span><b>{labels.inputTokens}</b>{formatMetric(telemetry?.inputTokens)}</span>
                                <span><b>{labels.outputTokens}</b>{formatMetric(telemetry?.outputTokens)}</span>
                                <span><b>{labels.reasoningTokens}</b>{formatMetric(telemetry?.reasoningTokens)}</span>
                                <span><b>{labels.cachedInput}</b>{telemetry?.provider === "openai" ? formatMetric(telemetry.cacheReadInputTokens) : "—"}</span>
                                <span><b>{labels.cacheRead}</b>{telemetry?.provider === "anthropic" ? formatMetric(telemetry.cacheReadInputTokens) : "—"}</span>
                                <span><b>{labels.cacheWrite}</b>{telemetry?.provider === "anthropic" ? formatMetric(telemetry.cacheWriteInputTokens) : "—"}</span>
                                <span><b>{labels.cacheWrite5m}</b>{telemetry?.provider === "anthropic" ? formatMetric(telemetry.cacheWrite5mInputTokens) : "—"}</span>
                                <span><b>{labels.cacheWrite1h}</b>{telemetry?.provider === "anthropic" ? formatMetric(telemetry.cacheWrite1hInputTokens) : "—"}</span>
                                <span><b>{labels.totalTokens}</b>{formatMetric(telemetry?.totalTokens)}</span>
                              </div>
                            </div>
                          </details>
                          {progress?.detail ? <p>{progress.detail}</p> : null}
                          {progress?.inputRequest ? <p>{labels.inputRequested}: {progress.inputRequest.kind === "script_parameters" ? progress.inputRequest.parameters.map((parameter) => parameter.key).join(", ") : progress.inputRequest.prompt}</p> : null}
                          {eventError ? <p className="is-error">{getWorkflowErrorCode(eventError)} · {eventError}</p> : null}
                          {progress?.inputSummary ? <details className="workflow-run-center-node-outputs"><summary>{labels.inputSummary}</summary><pre>{JSON.stringify(progress.inputSummary, null, 2)}</pre></details> : null}
                          {progress?.outputs ? <details className="workflow-run-center-node-outputs"><summary>{labels.outputs}</summary><pre>{JSON.stringify(progress.outputs, null, 2)}</pre></details> : null}
                          {reviewMessages.length ? <details className="workflow-run-center-messages" open={reviewHasLiveApproval}>
                            <summary><MessageSquareText size={13} /><span>{language === "zh" ? "实时 Review Gate" : "Live Review Gate"}</span><em>{reviewMessages.length}</em></summary>
                            <div className="workflow-run-center-message-list">
                              {reviewMessages.map((message) => <article key={message.id} className={`is-${message.role}${message.eventType ? ` is-${message.eventType}` : ""}`}>
                                <header><strong>{messageLabel(message, language)}</strong><time>{formatDate(message.at, language)}</time></header>
                                {message.event && progress?.reviewTaskId
                                  ? <ChatEventMessage
                                      event={message.event as ChatEvent}
                                      ownerId={progress.reviewTaskId}
                                      onResolveApproval={selectedRun.runId === writableRunId ? onResolveRuntimeApproval : undefined}
                                    />
                                  : <p>{message.content}</p>}
                              </article>)}
                            </div>
                          </details> : null}
                          {progress?.reviewHistory?.length ? <details className="workflow-run-center-node-outputs" open={progress.intervention?.source === "review_rejection" || progress.intervention?.source === "review_escalation"}>
                            <summary>{language === "zh" ? "质量审查历史" : "Quality review history"} · {progress.reviewHistory.length}</summary>
                            <div className="workflow-run-center-events">{progress.reviewHistory.map((review) => <details key={review.reviewAttempt}>
                              <summary>#{review.reviewAttempt} · {review.verdict.qualityLevel}/{review.requiredLevel} · {review.passed ? (language === "zh" ? "通过" : "passed") : (language === "zh" ? "未通过" : "failed")} · {new Date(review.reviewedAt).toLocaleString()}</summary>
                              {review.gateId || review.reviewerConfiguredAgentId ? <span><b>Review Gate</b>{review.gateId ?? "—"} · Agent {review.reviewerConfiguredAgentId ?? "—"}</span> : null}
                              <strong>{language === "zh" ? "候选结果" : "Candidate result"}</strong>
                              <pre>{JSON.stringify(review.candidate, null, 2)}</pre>
                              {review.verdict.dimensionResults.map((dimension) => <span key={dimension.key}><b>{dimension.key}: {dimension.qualityLevel}</b>{dimension.reason}{dimension.evidence.length ? ` · ${dimension.evidence.join("; ")}` : ""}</span>)}
                              {review.trace?.length ? <details className="workflow-run-center-review-trace">
                                <summary>{language === "zh" ? "审查全过程" : "Full review process"} · {review.trace.length}</summary>
                                <WorkflowReviewTrace trace={review.trace} language={language} />
                              </details> : null}
                            </details>)}</div>
                          </details> : null}
                          {progress?.intervention?.reviewTrace?.length ? <details className="workflow-run-center-node-outputs" open>
                            <summary>{language === "zh" ? "失败的审查全过程" : "Failed review process"} · {progress.intervention.reviewTrace.length}</summary>
                            <WorkflowReviewTrace trace={progress.intervention.reviewTrace} language={language} />
                          </details> : null}
                          {progress?.acceptance ? <details className="workflow-run-center-node-outputs" open={progress.acceptance.outcome !== "clean"}>
                            <summary>{language === "zh" ? "节点验收" : "Node acceptance"} · {progress.acceptance.outcome}</summary>
                            <div className="workflow-run-center-events">
                              <span>{language === "zh" ? "变更路径" : "Changed paths"} · {progress.acceptance.changedPaths.join(", ") || "—"}</span>
                              <span>operationId · {progress.acceptance.operationIds.join(", ") || "—"}</span>
                              {progress.acceptance.issues.map((issue) => <span key={`${issue.code}:${issue.detail}`}>{issue.severity} · {issue.code} · {issue.detail}</span>)}
                            </div>
                          </details> : null}
                          {progress?.scriptReceipt ? <details className="workflow-run-center-node-outputs" open={progress.scriptReceipt.timedOut || progress.scriptReceipt.effectState === "unknown" || Boolean(progress.scriptReceipt.stderrSummary)}>
                            <summary>{language === "zh" ? "脚本执行凭据" : "Script execution receipt"} · {progress.scriptReceipt.effectState}</summary>
                            <div className="workflow-run-center-events">
                              <span>exitCode · {progress.scriptReceipt.exitCode ?? "—"}</span>
                              <span>signal · {progress.scriptReceipt.signal ?? "—"}</span>
                              <span>timeout · {String(progress.scriptReceipt.timedOut)}</span>
                              <span>effectState · {progress.scriptReceipt.effectState}</span>
                              {progress.scriptReceipt.stderrSummary ? <span>stderr · {progress.scriptReceipt.stderrSummary}</span> : null}
                            </div>
                          </details> : null}
                          {progress?.intervention && selectedRun.runId === writableRunId && onResolveIntervention ? <div className="workflow-run-center-node-actions">
                            {!progress.intervention.allowedActions.includes("accept_last_result") ? <input value={nodeActionReason} maxLength={2_000} onChange={(event) => setNodeActionReason(event.currentTarget.value)} placeholder={language === "zh" ? "处理依据（可选）" : "Decision reason (optional)"} /> : null}
                            <div>{progress.intervention.allowedActions.map((action) => <button key={action} type="button" disabled={nodeActionBusy} onClick={() => {
                              const isReviewResolution = action === "rerun_all" || action === "accept_last_result";
                              if (!isReviewResolution && !window.confirm(language === "zh" ? `确认对节点 ${progress.title} 执行 ${action}？` : `Confirm ${action} for node ${progress.title}?`)) return;
                              setNodeActionBusy(true);
                              setNodeActionError(undefined);
                              void Promise.resolve(onResolveIntervention(progress.nodeId, action, isReviewResolution ? undefined : nodeActionReason.trim() || undefined)).then(() => setNodeActionReason("")).catch((nodeActionFailure) => setNodeActionError(nodeActionFailure instanceof Error ? nodeActionFailure.message : String(nodeActionFailure))).finally(() => setNodeActionBusy(false));
                            }}>{action === "continue" ? (language === "zh" ? "继续/重试" : "Continue / retry") : action === "rerun_all" ? (language === "zh" ? "全部节点重新运行" : "Rerun all nodes") : action === "accept_last_result" ? (language === "zh" ? "采用最后一次结果" : "Accept last result") : action}</button>)}</div>
                            {nodeActionError ? <p className="is-error">{nodeActionError}</p> : null}
                          </div> : null}
                          {selectedRun.recovery?.availableActions.includes("rollback_savepoint") && selectedRun.runId === writableRunId && onResolveRecovery && selectedRun.recovery.uncertainNodeIds.includes(node.nodeId) ? <div className="workflow-run-center-node-actions">
                            <input value={nodeActionReason} maxLength={2_000} onChange={(event) => setNodeActionReason(event.currentTarget.value)} placeholder={language === "zh" ? "回滚依据（必填）" : "Rollback reason (required)"} />
                            <button type="button" disabled={nodeActionBusy || !nodeActionReason.trim()} onClick={() => {
                              if (!window.confirm(language === "zh" ? `确认从节点 ${node.title} 回滚到当前保存点？` : `Roll back from node ${node.title} to the current savepoint?`)) return;
                              setNodeActionBusy(true);
                              setNodeActionError(undefined);
                              void Promise.resolve(onResolveRecovery(selectedRun.runId, "rollback_savepoint", nodeActionReason.trim())).then(() => setNodeActionReason("")).catch((nodeActionFailure) => setNodeActionError(nodeActionFailure instanceof Error ? nodeActionFailure.message : String(nodeActionFailure))).finally(() => setNodeActionBusy(false));
                            }}>{language === "zh" ? "回滚到保存点" : "Roll back to savepoint"}</button>
                          </div> : null}
                          {timelineSegments.length > 0 ? <div className="workflow-run-center-node-timeline-visual" aria-label={labels.timeline}><div className="workflow-run-center-node-track">{timelineSegments.map((segment, index) => <span key={`${segment.kind}-${segment.startedAt}-${index}`} className={`workflow-run-center-node-track-segment is-${segment.kind}`} style={selectedTimelineBounds ? getWorkflowRunTimelineSegmentStyle(segment, selectedTimelineBounds) : undefined} title={`${segment.kind.replaceAll("_", " ")} · ${formatNodeDuration({ attempt: segment.attempt ?? 1, startedAt: segment.startedAt, finishedAt: segment.finishedAt })}`} />)}</div><div className="workflow-run-center-node-segments">{timelineSegments.map((segment, index) => <span key={`${segment.kind}-${segment.startedAt}-${index}`}><b>{segment.kind.replaceAll("_", " ")}</b> {formatNodeDuration({ attempt: segment.attempt ?? 1, startedAt: segment.startedAt, finishedAt: segment.finishedAt })}</span>)}</div></div> : null}
                          {events.length > 0 ? (
                            <div className="workflow-run-center-events">
                              {events.map((event, index) => <span key={`${event.type}-${event.at}-${index}`}>{eventLabel(event.type, language)} · {formatDate(event.at, language)}{event.attempt ? ` · #${event.attempt}` : ""}{event.detail ? ` · ${event.detail}` : ""}{event.question ? ` · ${event.question}` : ""}{event.answer ? ` · ${event.answer}` : ""}{event.intervention ? ` · ${event.intervention.source}${event.intervention.reviewVerdict ? ` · ${event.intervention.reviewVerdict.decision}` : ""}` : ""}</span>)}
                            </div>
                          ) : <small className="workflow-run-center-no-events">{selectedProgressByNodeId.has(node.nodeId) ? labels.noEvents : labels.notStarted}</small>}
                          {messages.length > 0 ? <details className="workflow-run-center-messages" open={hasLiveApproval}>
                            <summary><MessageSquareText size={13} /><span>{labels.messages}</span><em>{messages.length}</em></summary>
                            <div className="workflow-run-center-message-list">
                              {messages.map((message) => <article key={message.id} className={`is-${message.role}${message.eventType ? ` is-${message.eventType}` : ""}`}>
                                <header><strong>{messageLabel(message, language)}</strong><time>{formatDate(message.at, language)}</time></header>
                                {message.event && approvalOwnerId
                                  ? <ChatEventMessage
                                      event={message.event as ChatEvent}
                                      ownerId={approvalOwnerId}
                                      onResolveApproval={selectedRun.runId === writableRunId ? onResolveRuntimeApproval : undefined}
                                    />
                                  : <p>{message.content}</p>}
                              </article>)}
                            </div>
                          </details> : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              </main>
            ) : <div className="workflow-run-center-choose"><History size={22} /><strong>{labels.choose}</strong></div>}
          </div>
        )}
      </section>
    </div>
  );
}

function downloadWorkflowRunReport(run: WorkflowRunState): void {
  const blob = new Blob([run.finalReport ?? ""], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `workflow-${run.workflowId}-${run.runId}-report.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}
