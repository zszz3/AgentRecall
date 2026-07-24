import type { CSSProperties, ReactElement } from "react";
import { ArrowRight, Clock3, GitBranch, Plus, RefreshCw, Workflow } from "lucide-react";
import { formatRelativeTime } from "../../../../core/format-session";
import type {
  SessionSearchResult,
  SessionDailyTokenUsage,
  SessionStats,
  SessionStatsPeriod,
  UsageQuota,
  UsageQuotaCard,
  UsageQuotaSnapshot,
} from "../../../../core/types";
import type { QuotaFeedback, StatsFeedback } from "../../app-types";
import { formatCompactNumber, formatTokenCount } from "../../format-count";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { getLiveSessionState } from "../../live-filter";
import { SearchBox } from "../search/search-box";
import { TokenTrendChart } from "./token-trend-chart";
import type { WorkbenchWorkflowItem } from "../automation/workbench-workflows";
import {
  SOURCE_LABEL,
  isRemoteSession,
  selectWorkbenchSessions,
  sourceUiFamily,
  statsPeriodLabel,
  supportsResumeSource,
  usageCacheRate,
  usageStatsDisplayRows,
  localizedLiveStateLabel,
  WORKBENCH_SESSION_LIMIT,
} from "../../session-ui";

const PERIODS: SessionStatsPeriod[] = ["today", "sevenDay", "thirtyDay", "allTime"];

export interface WorkbenchPageProps {
  stats: SessionStats;
  statsPeriod: SessionStatsPeriod;
  statsRefreshing: boolean;
  statsFeedback: StatsFeedback;
  quotas: UsageQuotaSnapshot;
  quotaLoading: boolean;
  quotaFeedback: QuotaFeedback;
  sessions: SessionSearchResult[];
  sessionQuery: string;
  liveSessionKeys: Set<string>;
  liveDetectionFailed: boolean;
  platform: NodeJS.Platform;
  language: LanguageMode;
  onStatsPeriodChange: (period: SessionStatsPeriod) => void;
  onRefreshStats: () => void;
  onRefreshQuotas: () => void;
  onOpenSettings: () => void;
  onSearchSessions: (query: string) => void;
  onOpenSession: (session: SessionSearchResult) => void;
  onResumeSession: (session: SessionSearchResult) => void;
  onShowSessions: (query: string) => void;
  onSelectTrendDay: (day: SessionDailyTokenUsage) => void;
  workflows: WorkbenchWorkflowItem[];
  workflowsLoading: boolean;
  workflowsError: string | null;
  onOpenWorkflow: (workflowId: string) => void;
  onNewWorkflow: () => void;
  onShowWorkflows: () => void;
}

export function WorkbenchPage({
  stats,
  statsPeriod,
  statsRefreshing,
  statsFeedback,
  quotas,
  quotaLoading,
  quotaFeedback,
  sessions,
  sessionQuery,
  liveSessionKeys,
  liveDetectionFailed,
  platform,
  language,
  onStatsPeriodChange,
  onRefreshStats,
  onRefreshQuotas,
  onOpenSettings,
  onSearchSessions,
  onOpenSession,
  onResumeSession,
  onShowSessions,
  onSelectTrendDay,
  workflows,
  workflowsLoading,
  workflowsError,
  onOpenWorkflow,
  onNewWorkflow,
  onShowWorkflows,
}: WorkbenchPageProps): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const cacheRate = usageCacheRate(stats.total);
  const sourceRows = usageStatsDisplayRows(stats.bySource);
  const tokenParts = [
    { key: "input", label: l("Input", "输入"), value: stats.total.inputTokens },
    { key: "cached", label: l("Cached", "缓存"), value: stats.total.cachedInputTokens },
    { key: "output", label: l("Output", "输出"), value: stats.total.outputTokens },
    { key: "reasoning", label: l("Reasoning", "推理"), value: stats.total.reasoningOutputTokens },
  ];
  const tokenPartTotal = tokenParts.reduce((total, part) => total + Math.max(0, part.value), 0);
  const visibleSessions = sessionQuery.trim()
    ? sessions.slice(0, WORKBENCH_SESSION_LIMIT)
    : selectWorkbenchSessions(sessions, liveSessionKeys, liveDetectionFailed);
  return (
    <div className="workbench-page">
      <header className="app-page-head workbench-page-head">
        <div>
          <h2>{l("Workbench", "工作台")}</h2>
          <p>One for all</p>
        </div>
      </header>
      <div className="workbench-page-content">
        <section className="workbench-overview" aria-label={l("Agent usage overview", "Agent 使用总览")}>
        <div className="workbench-usage">
          <div className="workbench-usage-head">
            <strong>{l("Usage", "用量")}</strong>
            <div className="workbench-usage-actions">
              <select
                className="workbench-period-select"
                value={statsPeriod}
                onChange={(event) => onStatsPeriodChange(event.currentTarget.value as SessionStatsPeriod)}
                aria-label={l("Usage period", "用量周期")}
              >
                {PERIODS.map((period) => (
                  <option key={period} value={period}>{statsPeriodLabel(period, language)}</option>
                ))}
              </select>
              <button
                className="workbench-icon-button"
                onClick={onRefreshStats}
                disabled={statsRefreshing}
                aria-label={l("Refresh usage", "刷新用量")}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
          <div className="usage-metrics">
            <UsageMetric value={formatCompactNumber(stats.total.sessionCount)} label={l("Sessions", "会话")} />
            <UsageMetric value={formatCompactNumber(stats.total.messageCount)} label={l("Messages", "消息")} />
            <UsageMetric value={formatTokenCount(stats.total.totalTokens)} label="Token" />
            <UsageMetric value={cacheRate == null ? "—" : `${cacheRate}%`} label={l("Cache rate", "缓存率")} />
          </div>
          <div className="workbench-usage-detail">
            <div className="workbench-token-composition">
              <div className="workbench-detail-title">
                <strong>{l("Token composition", "Token 构成")}</strong>
                <span>{cacheRate == null
                  ? l("No input token data", "暂无输入 Token 数据")
                  : l(`Cached input is ${cacheRate}% of input`, `缓存输入占输入 ${cacheRate}%`)}</span>
              </div>
              <div className="workbench-token-track" aria-hidden="true">
                {tokenParts.map((part) => (
                  <i
                    key={part.key}
                    className={part.key}
                    style={{ width: tokenPartTotal > 0 ? `${(Math.max(0, part.value) / tokenPartTotal) * 100}%` : "0%" } as CSSProperties}
                  />
                ))}
              </div>
              <div className="workbench-token-legend">
                {tokenParts.map((part) => <span key={part.key} className={part.key}><i />{part.label} {formatTokenCount(part.value)}</span>)}
              </div>
            </div>
            <div className="workbench-source-usage" aria-label={l("Token usage by Agent", "按 Agent 查看 Token 用量")}>
              {sourceRows.length > 0 ? sourceRows.map((row) => (
                <div key={row.key} className="workbench-source-row" data-source={row.key}>
                  <span><i />{row.label}</span><strong>{formatTokenCount(row.totalTokens)}</strong>
                </div>
              )) : <span className="workbench-source-empty">{l("No source data", "暂无来源数据")}</span>}
            </div>
          </div>
          {statsFeedback ? <p className={`workbench-feedback ${statsFeedback.kind}`}>{statsFeedback.message}</p> : null}
        </div>

        <section className="workbench-quota-card" aria-label={l("Model quotas", "模型额度")}>
          <div className="workbench-quota-card-head">
            <strong>{l("Model quotas", "模型额度")}</strong>
            <button className="workbench-icon-button" onClick={onRefreshQuotas} disabled={quotaLoading} aria-label={l("Refresh model quotas", "刷新模型额度")}>
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="workbench-quota-pair">
            {(["codex", "claude-code"] as const).map((provider) => (
              <WorkbenchQuota
                key={provider}
                card={quotas.providers.find((item) => item.provider === provider) ?? null}
                provider={provider}
                loading={quotaLoading}
                language={language}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
          {quotaFeedback ? <p className={`workbench-feedback quota ${quotaFeedback.kind}`}>{quotaFeedback.message}</p> : null}
        </section>

        <TokenTrendChart points={stats.dailyTokenUsage} language={language} onSelectDay={onSelectTrendDay} />
        </section>

        <div className="workbench-primary-grid">
        <section className="workbench-panel workbench-sessions">
          <div className="workbench-panel-head">
            <h2>{l("Sessions", "会话")}</h2>
            <button onClick={() => onShowSessions(sessionQuery)}>{l("View all", "查看全部")} <ArrowRight size={13} /></button>
          </div>
          <div className="workbench-session-search">
            <SearchBox
              platform={platform}
              placeholder={l("Search sessions, then press Enter", "搜索会话，按 Enter 查询")}
              recentLabel={l("Recent searches", "最近搜索")}
              clearRecentLabel={l("Clear", "清空")}
              deleteRecentLabel={l("Delete recent search", "删除最近搜索")}
              submittedValue={sessionQuery}
              onSearch={onSearchSessions}
            />
          </div>
          <div className="workbench-session-list">
            {visibleSessions.length > 0 ? visibleSessions.map((session) => {
              const canResume = supportsResumeSource(session.source) && !isRemoteSession(session);
              const liveState = getLiveSessionState(session, liveSessionKeys, liveDetectionFailed);
              const live = liveState === "open";
              return (
                <article key={session.sessionKey} className={`workbench-session-row ${live ? "live" : ""}`} data-source={sourceUiFamily(session.source)} onClick={() => onOpenSession(session)}>
                  <i className="session-trajectory" aria-hidden="true" />
                  <div className="workbench-session-copy">
                    <strong title={session.displayTitle}>{session.displayTitle}</strong>
                    <span title={session.projectPath}>
                      <GitBranch size={12} />
                      <span className="workbench-session-meta-text">{projectName(session.projectPath)} · {SOURCE_LABEL[session.source]}</span>
                      <span className={`workbench-session-state ${liveState}`}><i aria-hidden="true" />{localizedLiveStateLabel(liveState, language)}</span>
                    </span>
                  </div>
                  <time><Clock3 size={12} />{formatRelativeTime(session.lastActivityAt)}</time>
                  {canResume ? <button className="workbench-resume" onClick={(event) => { event.stopPropagation(); onResumeSession(session); }}>Resume</button> : null}
                </article>
              );
            }) : <div className="workbench-section-empty">{sessionQuery ? l("No matching sessions.", "没有匹配的会话。") : l("No recent sessions.", "暂无最近会话。")}</div>}
          </div>
        </section>

        <section className="workbench-panel workbench-workflows">
          <div className="workbench-panel-head">
            <h2>Workflow</h2>
            <button onClick={onShowWorkflows}>{l("View all", "查看全部")} <ArrowRight size={13} /></button>
          </div>
          {workflowsLoading ? (
            <div className="workbench-empty-state"><RefreshCw className="is-spinning" size={20} /><span>{l("Loading workflows…", "正在加载工作流…")}</span></div>
          ) : workflowsError ? (
            <div className="workbench-empty-state is-error"><Workflow size={20} /><strong>{l("Workflow unavailable", "Workflow 暂不可用")}</strong><span>{workflowsError}</span></div>
          ) : workflows.length > 0 ? (
            <div className="workbench-workflow-list">
              {workflows.map((item) => (
                <button key={item.workflow.workflowId} className="workbench-workflow-row" type="button" onClick={() => onOpenWorkflow(item.workflow.workflowId)}>
                  <span className={`workbench-workflow-status is-${item.status}`}><i />{workflowStatusLabel(item.status, language)}</span>
                  <strong title={item.workflow.title}>{item.workflow.title || l("Untitled workflow", "未命名工作流")}</strong>
                  <small>{item.workflow.definition.nodes.length} {l("nodes", "个节点")} · {formatRelativeTime(item.updatedAt)}</small>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          ) : (
            <div className="workbench-empty-state">
              <Workflow size={22} />
              <strong>{l("No workflows yet", "还没有工作流")}</strong>
              <span>{l("Create a reusable Agent workflow and run it from here.", "创建可复用的 Agent 工作流，并从这里继续运行。")}</span>
              <button className="workbench-workflow-create" type="button" onClick={onNewWorkflow}><Plus size={13} />{l("New workflow", "新建 Workflow")}</button>
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}

function workflowStatusLabel(status: WorkbenchWorkflowItem["status"], language: LanguageMode): string {
  if (status === "waiting_for_user") return localize(language, "Needs input", "等待输入");
  if (status === "running") return localize(language, "Running", "运行中");
  if (status === "completed") return localize(language, "Completed", "已完成");
  if (status === "failed") return localize(language, "Failed", "失败");
  if (status === "stopped") return localize(language, "Stopped", "已停止");
  return localize(language, "Draft", "草稿");
}

function UsageMetric({ value, label }: { value: string; label: string }): ReactElement {
  return (
    <div className="workbench-metric" aria-label={`${label}: ${value}`}>
      <strong>{value}</strong><span>{label}</span>
    </div>
  );
}

function WorkbenchQuota({
  card,
  provider,
  loading,
  language,
  onOpenSettings,
}: {
  card: UsageQuotaCard | null;
  provider: UsageQuotaCard["provider"];
  loading: boolean;
  language: LanguageMode;
  onOpenSettings: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const displayName = provider === "codex" ? "Codex" : "Claude Code";
  const quotas = card?.quotas.filter((quota) => quota.key === "five_hour" || quota.key === "seven_day") ?? [];
  const available = card?.status === "supported" && quotas.length > 0;
  return (
    <div className={`workbench-quota ${provider}`}>
      <div className="quota-identity"><i>{provider === "codex" ? "CX" : "CC"}</i><strong>{displayName}</strong></div>
      {available ? <div className="workbench-quota-windows">{quotas.map((quota) => <WorkbenchQuotaWindow key={quota.key} quota={quota} language={language} />)}</div> : (
        <div className="workbench-quota-empty">
          <span>{loading ? l("Checking quota...", "正在检查额度...") : card?.detail || l("Quota is unavailable.", "额度暂不可用。")}</span>
          {!loading ? <button onClick={onOpenSettings}>{l("Open settings", "打开设置")}</button> : null}
        </div>
      )}
    </div>
  );
}

function WorkbenchQuotaWindow({ quota, language }: { quota: UsageQuota; language: LanguageMode }): ReactElement {
  const label = quota.label === "5h" ? localize(language, "5 hours", "5 小时") : localize(language, "7 days", "7 天");
  const detail = quota.stale ? localize(language, "Data expired", "数据已过期") : formatQuotaReset(quota.resetsAt, language);
  return (
    <div className="workbench-quota-window" aria-label={`${label}: ${Math.round(quota.remainingPercent)}%. ${detail}`}>
      <div><span>{label}</span><strong>{Math.round(quota.remainingPercent)}%</strong></div>
      <div className="workbench-quota-track" aria-hidden="true"><i style={{ width: `${quota.remainingPercent}%` } as CSSProperties} /></div>
      <span className="workbench-quota-reset">{detail || "\u00A0"}</span>
    </div>
  );
}

function projectName(projectPath: string): string {
  const normalized = projectPath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || projectPath;
}

function formatQuotaReset(resetsAt: string | undefined, language: LanguageMode): string {
  if (!resetsAt) return "";
  const timestamp = Date.parse(resetsAt);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000);
  if (minutes <= 0) return localize(language, "Reset due", "应重置");
  if (minutes < 60) return localize(language, `Resets in ${minutes}m`, `${minutes} 分钟后重置`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return localize(language, `Resets in ${hours}h`, `${hours} 小时后重置`);
  const days = Math.ceil(hours / 24);
  return localize(language, `Resets in ${days}d`, `${days} 天后重置`);
}
