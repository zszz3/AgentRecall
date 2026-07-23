import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarClock, CheckCircle2, ChevronRight, CircleAlert, CircleStop, Clock3, GitBranch, History, MessageSquareText, X } from "lucide-react";
import type { WorkflowRunState, WorkflowStatus } from "../../../../shared/types";
import type { WorkflowRunNodeTelemetry } from "../../../../shared/workflow/run";
import type { WorkflowNodeConversation } from "../../../../shared/workflow-v2/conversation";

interface WorkflowRunCenterProps {
  runs: WorkflowRunState[];
  conversations?: WorkflowNodeConversation[];
  open: boolean;
  selectedRunId?: string;
  language?: "en" | "zh";
  onSelectRun: (runId: string | undefined) => void;
  onClose: () => void;
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
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
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

function runIcon(status: WorkflowStatus) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed" || status === "waiting_for_user") return CircleAlert;
  if (status === "stopped") return CircleStop;
  return Clock3;
}

function messageLabel(message: WorkflowNodeConversation["messages"][number], language: "en" | "zh"): string {
  const toolLabel = message.eventType === "tool_call"
    ? (language === "zh" ? "工具调用" : "Tool call")
    : message.eventType === "tool_result"
      ? (language === "zh" ? "工具结果" : "Tool result")
      : undefined;
  if (toolLabel) return message.name ? `${toolLabel} · ${message.name}` : toolLabel;
  return message.name || message.role;
}

export function WorkflowRunCenter({ runs, conversations = [], open, selectedRunId, language = "en", onSelectRun, onClose }: WorkflowRunCenterProps) {
  const [activeRunId, setActiveRunId] = useState<string | undefined>(selectedRunId);
  const selectedRun = activeRunId ? runs.find((run) => run.runId === activeRunId) : undefined;

  useEffect(() => {
    if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) setActiveRunId(selectedRunId);
    else if (activeRunId && !runs.some((run) => run.runId === activeRunId)) setActiveRunId(undefined);
  }, [activeRunId, runs, selectedRunId]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const selectedNodeIds = useMemo(() => new Set(selectedRun?.progress.map((item) => item.nodeId) ?? []), [selectedRun]);
  if (!open) return null;

  const labels = language === "zh"
    ? { title: "运行历史", close: "关闭运行历史", empty: "还没有运行记录", choose: "选择一条运行记录查看详情", back: "返回运行列表", detail: "运行详情", timeline: "节点时间线", messages: "消息历史", config: "冻结配置", graph: "图版本", started: "开始", duration: "耗时", approvedBy: "确认人", nodes: "节点", noEvents: "暂无事件记录", notStarted: "未开始", runtime: "Runtime", channel: "Channel", model: "模型", attempts: "尝试次数", executionDetails: "执行明细", tokenUsage: "Token 用量", provider: "计量风格", inputTokens: "输入 tokens", outputTokens: "输出 tokens", reasoningTokens: "推理 tokens", cachedInput: "缓存输入（OpenAI）", cacheRead: "缓存读取（Anthropic）", cacheWrite: "缓存写入（Anthropic）", cacheWrite5m: "缓存写入 · 5 分钟", cacheWrite1h: "缓存写入 · 1 小时", totalTokens: "总 tokens", cost: "成本" }
    : { title: "Run history", close: "Close run history", empty: "No runs yet", choose: "Select a run to view its details", back: "Back to run list", detail: "Run details", timeline: "Node timeline", messages: "Message history", config: "Frozen configuration", graph: "Graph version", started: "Started", duration: "Duration", approvedBy: "Approved by", nodes: "Nodes", noEvents: "No events recorded", notStarted: "Not started", runtime: "Runtime", channel: "Channel", model: "Model", attempts: "Attempts", executionDetails: "Execution details", tokenUsage: "Token usage", provider: "Accounting style", inputTokens: "Input tokens", outputTokens: "Output tokens", reasoningTokens: "Reasoning tokens", cachedInput: "Cached input (OpenAI)", cacheRead: "Cache read (Anthropic)", cacheWrite: "Cache write (Anthropic)", cacheWrite5m: "Cache write · 5 min", cacheWrite1h: "Cache write · 1 hour", totalTokens: "Total tokens", cost: "Cost" };

  return (
    <div className="workflow-run-center-backdrop" role="presentation" onClick={onClose}>
      <section className={`workflow-run-center ${selectedRun ? "is-detail" : ""}`} role="dialog" aria-modal="true" aria-label={labels.title} onClick={(event) => event.stopPropagation()}>
        <header className="workflow-run-center-header">
          <div className="workflow-run-center-title">
            <History size={17} />
            <div><strong>{labels.title}</strong><span>{runs.length} {language === "zh" ? "次运行" : "runs"}</span></div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={labels.close}><X size={15} /></button>
        </header>
        {runs.length === 0 ? <div className="workflow-run-center-empty"><History size={22} /><strong>{labels.empty}</strong></div> : (
          <div className={`workflow-run-center-body ${selectedRun ? "is-detail" : ""}`}>
            <nav className="workflow-run-center-list" aria-label={labels.title}>
              {runs.map((run) => {
                const Icon = runIcon(run.status);
                return (
                  <button key={run.runId} type="button" className={`workflow-run-center-item ${run.runId === selectedRun?.runId ? "is-active" : ""}`} onClick={() => { setActiveRunId(run.runId); onSelectRun(run.runId); }}>
                    <Icon size={14} />
                    <span><strong>{statusLabel(run.status, language)}</strong><small>{formatDate(run.startedAt, language)}</small></span>
                    <em>{formatDuration(run)}</em>
                    <ChevronRight size={13} aria-hidden="true" />
                  </button>
                );
              })}
            </nav>
            {selectedRun ? (
              <main className="workflow-run-center-detail">
                <header className="workflow-run-center-detail-head">
                  <div><button type="button" className="workflow-run-center-back" onClick={() => { setActiveRunId(undefined); onSelectRun(undefined); }} aria-label={labels.back}><ArrowLeft size={14} /><span>{labels.back}</span></button><span className={`workflow-run-center-status is-${selectedRun.status}`}>{statusLabel(selectedRun.status, language)}</span><h3>{labels.detail}</h3><small>{selectedRun.runId}</small></div>
                  <div className="workflow-run-center-metrics"><span><b>{labels.started}</b>{formatDate(selectedRun.startedAt, language)}</span><span><b>{labels.duration}</b>{formatDuration(selectedRun)}</span><span><b>{labels.graph}</b>v{selectedRun.workflowV2Plan.graphVersion}</span></div>
                </header>
                {selectedRun.lastError ? <div className="workflow-run-center-error"><CircleAlert size={15} /><span>{selectedRun.lastError}</span></div> : null}
                <section className="workflow-run-center-section">
                  <header><GitBranch size={14} /><strong>{labels.config}</strong></header>
                  <div className="workflow-run-center-config-grid"><span><b>{labels.approvedBy}</b>{selectedRun.workflowV2Plan.approvedBy || "—"}</span><span><b>{labels.nodes}</b>{selectedRun.workflowV2Plan.nodes.length}</span><span><b>{language === "zh" ? "上下文预算" : "Context budget"}</b>{selectedRun.workflowV2Plan.budget.context.maxContextTokens ?? "—"}</span></div>
                </section>
                <section className="workflow-run-center-section">
                  <header><CalendarClock size={14} /><strong>{labels.timeline}</strong></header>
                  <div className="workflow-run-center-timeline">
                    {selectedRun.workflowV2Plan.nodes.map((node) => {
                      const progress = selectedRun.progress.find((item) => item.nodeId === node.nodeId);
                      const events = selectedRun.events.filter((event) => event.nodeId === node.nodeId).sort((left, right) => left.at - right.at);
                      const eventError = [...events].reverse().find((event) => event.error)?.error;
                      const conversation = conversations.find((item) => item.runId === selectedRun.runId && item.nodeId === node.nodeId);
                      const messages = conversation?.messages.length ? conversation.messages : progress?.messages ?? [];
                      const telemetry = progress?.telemetry ?? conversation?.telemetry;
                      return (
                        <article key={node.nodeId} className={`workflow-run-center-node ${progress ? `is-${progress.status}` : ""}`}>
                          <div className="workflow-run-center-node-head">
                            <span>{progress?.status ?? "queued"}</span>
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
                          {eventError ? <p className="is-error">{eventError}</p> : null}
                          {events.length > 0 ? (
                            <div className="workflow-run-center-events">
                              {events.map((event, index) => <span key={`${event.type}-${event.at}-${index}`}>{eventLabel(event.type, language)} · {formatDate(event.at, language)}{event.attempt ? ` · #${event.attempt}` : ""}</span>)}
                            </div>
                          ) : <small className="workflow-run-center-no-events">{selectedNodeIds.has(node.nodeId) ? labels.noEvents : labels.notStarted}</small>}
                          {messages.length > 0 ? <details className="workflow-run-center-messages">
                            <summary><MessageSquareText size={13} /><span>{labels.messages}</span><em>{messages.length}</em></summary>
                            <div className="workflow-run-center-message-list">
                              {messages.map((message) => <article key={message.id} className={`is-${message.role}${message.eventType ? ` is-${message.eventType}` : ""}`}>
                                <header><strong>{messageLabel(message, language)}</strong><time>{formatDate(message.at, language)}</time></header>
                                <p>{message.content}</p>
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
