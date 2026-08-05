import { useEffect, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, ReactElement } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  GitBranch,
  GripVertical,
  MessageCircleMore,
  MessagesSquare,
  PlugZap,
  Plus,
  RefreshCw,
  Sparkles,
  Workflow,
} from "lucide-react";
import type {
  AgentChannel,
  AgentRuntime,
  McpServerDefinition,
} from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { toolCountLabel } from "../../../../automation/engine/renderer/src/pages/mcp/mcp-tools";
import type { InstalledSkill } from "../../../../core/skill-manager";
import type { OpenVikingMemorySnapshot } from "../../../../core/openviking-memory";
import type { TeamChatRoomSummary } from "../../../../shared/team-chat";
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
const WORKBENCH_CARD_ORDER_STORAGE_KEY = "agent-recall.workbench-card-order.v2";

export const DEFAULT_WORKBENCH_CARD_ORDER = [
  "sessions",
  "workflows",
  "memories",
  "chat",
  "runtimes",
  "mcp",
  "skills",
] as const;

export type WorkbenchCardId = typeof DEFAULT_WORKBENCH_CARD_ORDER[number];

export function normalizeWorkbenchCardOrder(value: unknown): WorkbenchCardId[] {
  const known = new Set<WorkbenchCardId>();
  const normalized: WorkbenchCardId[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        typeof item === "string"
        && DEFAULT_WORKBENCH_CARD_ORDER.includes(item as WorkbenchCardId)
        && !known.has(item as WorkbenchCardId)
      ) {
        known.add(item as WorkbenchCardId);
        normalized.push(item as WorkbenchCardId);
      }
    }
  }
  for (const item of DEFAULT_WORKBENCH_CARD_ORDER) {
    if (!known.has(item)) normalized.push(item);
  }
  return normalized;
}

export function reorderWorkbenchCard(
  order: readonly WorkbenchCardId[],
  source: WorkbenchCardId,
  target: WorkbenchCardId,
): WorkbenchCardId[] {
  const normalized = normalizeWorkbenchCardOrder(order);
  if (source === target) return normalized;
  const sourceIndex = normalized.indexOf(source);
  const targetIndex = normalized.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return normalized;
  normalized.splice(sourceIndex, 1);
  normalized.splice(normalized.indexOf(target), 0, source);
  return normalized;
}

function loadWorkbenchCardOrder(): WorkbenchCardId[] {
  if (typeof window === "undefined") return [...DEFAULT_WORKBENCH_CARD_ORDER];
  try {
    return normalizeWorkbenchCardOrder(JSON.parse(
      window.localStorage.getItem(WORKBENCH_CARD_ORDER_STORAGE_KEY) ?? "null",
    ));
  } catch {
    return [...DEFAULT_WORKBENCH_CARD_ORDER];
  }
}

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
  runtimes: AgentRuntime[];
  runtimeChannels: AgentChannel[];
  mcpServers: McpServerDefinition[] | null;
  chatRooms: TeamChatRoomSummary[] | null;
  memoryEnabled: boolean;
  memorySnapshot: OpenVikingMemorySnapshot | null;
  memoryLoading: boolean;
  skills: InstalledSkill[];
  skillsLoading: boolean;
  onShowRuntimes: () => void;
  onShowMcp: () => void;
  onShowChat: (roomId?: string) => void;
  onShowMemories: () => void;
  onShowSkills: () => void;
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
  runtimes,
  runtimeChannels,
  mcpServers,
  chatRooms,
  memoryEnabled,
  memorySnapshot,
  memoryLoading,
  skills,
  skillsLoading,
  onShowRuntimes,
  onShowMcp,
  onShowChat,
  onShowMemories,
  onShowSkills,
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
  const visibleQuotaProviders = (["codex", "claude-code"] as const)
    .filter((provider) => !quotas.hiddenProviders?.includes(provider));
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [cardOrder, setCardOrder] = useState<WorkbenchCardId[]>(loadWorkbenchCardOrder);
  const [draggingCard, setDraggingCard] = useState<WorkbenchCardId | null>(null);
  const availableRuntimeCount = runtimes.filter((runtime) => runtime.available).length;
  const enabledMcpCount = mcpServers?.filter((server) => server.enabled).length ?? 0;
  const activeWorkflowCount = workflows.filter(
    (item) => item.status === "running" || item.status === "waiting_for_user",
  ).length;
  const managedMemoryWorkspaces = memorySnapshot?.workspaces.filter((workspace) => workspace.managed) ?? [];
  const visibleSkills = [...skills]
    .sort((left, right) =>
      (right.usageCount ?? 0) - (left.usageCount ?? 0)
      || (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
      || left.name.localeCompare(right.name))
    .slice(0, 3);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKBENCH_CARD_ORDER_STORAGE_KEY, JSON.stringify(cardOrder));
    } catch {
      // A read-only browser profile should not prevent layout changes for this run.
    }
  }, [cardOrder]);

  const moveCardBy = (cardId: WorkbenchCardId, delta: -1 | 1): void => {
    setCardOrder((current) => {
      const next = normalizeWorkbenchCardOrder(current);
      const index = next.indexOf(cardId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= next.length) return next;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const layoutCardProps = (cardId: WorkbenchCardId) => ({
    "data-card-id": cardId,
    draggable: layoutEditing,
    style: { order: cardOrder.indexOf(cardId) } as CSSProperties,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", cardId);
      setDraggingCard(cardId);
    },
    onDragEnd: () => setDraggingCard(null),
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (layoutEditing && draggingCard && draggingCard !== cardId) event.preventDefault();
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const transferred = event.dataTransfer.getData("text/plain");
      const source = DEFAULT_WORKBENCH_CARD_ORDER.includes(transferred as WorkbenchCardId)
        ? transferred as WorkbenchCardId
        : draggingCard;
      if (!layoutEditing || !source) return;
      setCardOrder((current) => reorderWorkbenchCard(current, source, cardId));
      setDraggingCard(null);
    },
  });

  const layoutControls = (cardId: WorkbenchCardId): ReactElement | null => {
    if (!layoutEditing) return null;
    const index = cardOrder.indexOf(cardId);
    return (
      <div className="workbench-card-layout-controls" aria-label={l("Move card", "移动卡片")}>
        <GripVertical size={14} aria-hidden="true" />
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => moveCardBy(cardId, -1)}
          aria-label={l("Move card left", "向前移动卡片")}
        ><ChevronLeft size={13} /></button>
        <button
          type="button"
          disabled={index < 0 || index >= cardOrder.length - 1}
          onClick={() => moveCardBy(cardId, 1)}
          aria-label={l("Move card right", "向后移动卡片")}
        ><ChevronRight size={13} /></button>
      </div>
    );
  };
  return (
    <div className="workbench-page">
      <header className="app-page-head workbench-page-head">
        <div>
          <h2>{l("Workbench", "工作台")}</h2>
          <p>One for all</p>
        </div>
        <button
          type="button"
          className={`workbench-layout-action ${layoutEditing ? "active" : ""}`}
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          aria-pressed={layoutEditing}
          onClick={() => {
            setLayoutEditing((current) => !current);
            setDraggingCard(null);
          }}
        >
          {layoutEditing ? <Check size={14} /> : <GripVertical size={14} />}
          {layoutEditing ? l("Done", "完成") : l("Adjust layout", "调整布局")}
        </button>
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
          <div className="workbench-quota-pair" data-count={visibleQuotaProviders.length}>
            {visibleQuotaProviders.map((provider) => (
              <WorkbenchQuota
                key={provider}
                card={quotas.providers.find((item) => item.provider === provider) ?? null}
                provider={provider}
                loading={quotaLoading}
                language={language}
                onOpenSettings={onOpenSettings}
              />
            ))}
            {visibleQuotaProviders.length === 0 ? (
              <div className="workbench-quota-hidden">
                <span>{l("Usage limits are hidden in settings.", "额度已在设置中隐藏。")}</span>
                <button onClick={onOpenSettings}>{l("Open settings", "打开设置")}</button>
              </div>
            ) : null}
          </div>
          {quotaFeedback ? <p className={`workbench-feedback quota ${quotaFeedback.kind}`}>{quotaFeedback.message}</p> : null}
        </section>

        <TokenTrendChart points={stats.dailyTokenUsage} language={language} onSelectDay={onSelectTrendDay} />
        </section>

        <div className={`workbench-primary-grid ${layoutEditing ? "is-editing" : ""}`}>
        <article
          className={`workbench-card-slot is-secondary ${draggingCard === "sessions" ? "is-dragging" : ""}`}
          {...layoutCardProps("sessions")}
        >
        {layoutControls("sessions")}
        <section className="workbench-panel workbench-sessions">
          <header className="workbench-feature-card-head">
            <span><MessagesSquare size={18} /></span>
            <div>
              <h2>{l("Sessions", "会话")}</h2>
              <small>{sessionQuery.trim()
                ? l(`${visibleSessions.length} matching sessions`, `${visibleSessions.length} 条匹配会话`)
                : l(`${visibleSessions.length} recent sessions`, `${visibleSessions.length} 条最近会话`)}</small>
            </div>
            <button type="button" onClick={() => onShowSessions(sessionQuery)}>
              {l("View all", "查看全部")} <ArrowRight size={13} />
            </button>
          </header>
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
        </article>

        <article
          className={`workbench-card-slot is-secondary ${draggingCard === "workflows" ? "is-dragging" : ""}`}
          {...layoutCardProps("workflows")}
        >
        {layoutControls("workflows")}
        <section className="workbench-panel workbench-workflows">
          <header className="workbench-feature-card-head">
            <span><Workflow size={18} /></span>
            <div>
              <h2>Workflow</h2>
              <small>{workflowsLoading
                ? l("Loading workflows…", "正在加载工作流…")
                : l(
                  `${workflows.length} workflows · ${activeWorkflowCount} active`,
                  `${workflows.length} 个工作流 · ${activeWorkflowCount} 个进行中`,
                )}</small>
            </div>
            <button type="button" onClick={onShowWorkflows}>
              {l("View all", "查看全部")} <ArrowRight size={13} />
            </button>
          </header>
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
        </article>

        <article
          className={`workbench-card-slot is-secondary ${draggingCard === "memories" ? "is-dragging" : ""}`}
          {...layoutCardProps("memories")}
        >
          {layoutControls("memories")}
          <WorkbenchFeatureCard
            icon={<BookOpen size={18} />}
            title="Memory"
            metric={memoryLoading
              ? l("Loading managed directories…", "正在加载受管理目录…")
              : !memoryEnabled
                ? l("Memory is disabled", "Memory 未启用")
                : memorySnapshot
                  ? l(
                    `${managedMemoryWorkspaces.length} managed directories · ${memoryRuntimeStateLabel(memorySnapshot.runtime.state, language)}`,
                    `${managedMemoryWorkspaces.length} 个受管理目录 · ${memoryRuntimeStateLabel(memorySnapshot.runtime.state, language)}`,
                  )
                  : l("Memory is unavailable", "Memory 暂不可用")}
            description={l(
              "Manage long-term Agent memory by project directory.",
              "按项目目录管理可召回的 Agent 长期记忆。",
            )}
            rows={(memoryEnabled ? managedMemoryWorkspaces : []).slice(0, 3).map((workspace) => ({
              id: workspace.id,
              title: workspace.displayName,
              detail: `${workspace.importedTurns}/${workspace.totalTurns} ${l("turns", "轮")} · ${
                memoryImportStateLabel(workspace.importState, language)
              }`,
            }))}
            empty={memoryLoading
              ? l("Loading Memory…", "正在加载 Memory…")
              : !memoryEnabled
                ? l("Enable Memory in settings to manage directories.", "在设置中启用 Memory 后即可管理目录。")
                : l("No managed directories yet.", "还没有受管理目录。")}
            action={l("Open Memory", "打开 Memory")}
            onOpen={onShowMemories}
          />
        </article>

        <article
          className={`workbench-card-slot is-secondary ${draggingCard === "chat" ? "is-dragging" : ""}`}
          {...layoutCardProps("chat")}
        >
          {layoutControls("chat")}
          <WorkbenchFeatureCard
            icon={<MessageCircleMore size={18} />}
            title="Chat"
            metric={chatRooms === null
              ? l("Loading chat groups…", "正在加载聊天群…")
              : l(`${chatRooms.length} chat groups`, `${chatRooms.length} 个聊天群`)}
            description={l(
              "Continue a recent group or create a new multi-Agent conversation.",
              "继续最近的聊天群，或创建新的多 Agent 对话。",
            )}
            rows={(chatRooms ?? []).slice(0, 3).map((room) => {
              const activityAt = Date.parse(room.lastMessageAt ?? room.updatedAt);
              return {
                id: room.id,
                title: room.name,
                detail: `${room.agentCount} ${l("members", "名员工")} · ${
                  Number.isFinite(activityAt) ? formatRelativeTime(activityAt) : l("No messages yet", "暂无消息")
                }`,
                onOpen: () => onShowChat(room.id),
              };
            })}
            empty={chatRooms === null
              ? l("Loading chat groups…", "正在加载聊天群…")
              : l("No chat groups yet.", "还没有聊天群。")}
            action={l("Open Chat", "打开 Chat")}
            onOpen={() => onShowChat()}
          />
        </article>

        <article
          className={`workbench-card-slot is-compact ${draggingCard === "runtimes" ? "is-dragging" : ""}`}
          {...layoutCardProps("runtimes")}
        >
          {layoutControls("runtimes")}
          <WorkbenchFeatureCard
            icon={<Cpu size={18} />}
            title="Runtime"
            metric={l(
              `${runtimeChannels.length} configs · ${availableRuntimeCount}/${runtimes.length} executors available`,
              `${runtimeChannels.length} 个配置 · ${availableRuntimeCount}/${runtimes.length} 个执行器可用`,
            )}
            description={l(
              "Manage the model executors shared by Chat, Workflow, and AI exploration.",
              "管理 Chat、Workflow 与 AI 探索共用的模型执行器。",
            )}
            rows={runtimeChannels.slice(0, 3).map((channel) => ({
              id: channel.id,
              title: channel.label,
              detail: `${channel.agentId} · ${channel.models.length} ${l("models", "个模型")}`,
            }))}
            empty={l("No Runtime configs yet.", "还没有 Runtime 配置。")}
            action={l("Open Runtime", "打开 Runtime")}
            onOpen={onShowRuntimes}
          />
        </article>

        <article
          className={`workbench-card-slot is-compact ${draggingCard === "mcp" ? "is-dragging" : ""}`}
          {...layoutCardProps("mcp")}
        >
          {layoutControls("mcp")}
          <WorkbenchFeatureCard
            icon={<PlugZap size={18} />}
            title="MCP"
            metric={mcpServers === null
              ? l("Loading project MCP servers…", "正在加载项目 MCP…")
              : l(
                `${enabledMcpCount}/${mcpServers.length} servers enabled`,
                `${enabledMcpCount}/${mcpServers.length} 个服务已启用`,
              )}
            description={l(
              "Keep project tools and their Agent bindings in one place.",
              "集中管理项目工具以及它们与 Agent 的绑定关系。",
            )}
            rows={(mcpServers ?? []).slice(0, 3).map((server) => ({
              id: server.id,
              title: server.name,
              detail: `${server.status} · ${toolCountLabel(server, l("tools", "个工具"))}`,
            }))}
            empty={mcpServers === null
              ? l("Loading MCP servers…", "正在加载 MCP…")
              : l("No project MCP servers yet.", "还没有项目 MCP。")}
            action={l("Open MCP", "打开 MCP")}
            onOpen={onShowMcp}
          />
        </article>

        <article
          className={`workbench-card-slot is-compact ${draggingCard === "skills" ? "is-dragging" : ""}`}
          {...layoutCardProps("skills")}
        >
          {layoutControls("skills")}
          <WorkbenchFeatureCard
            icon={<Sparkles size={18} />}
            title="Skills"
            metric={skillsLoading
              ? l("Loading App Skills…", "正在加载本 App Skill…")
              : l(`${skills.length} App Skills`, `${skills.length} 个本 App Skill`)}
            description={l(
              "Review the reusable capabilities installed in AgentRecall.",
              "查看 AgentRecall 中已安装的可复用能力及最近使用情况。",
            )}
            rows={visibleSkills.map((skill) => ({
              id: skill.id,
              title: skill.name,
              detail: `${l(
                `Used ${formatCompactNumber(skill.usageCount ?? 0)} times`,
                `使用 ${formatCompactNumber(skill.usageCount ?? 0)} 次`,
              )} · ${skill.agent}`,
            }))}
            empty={skillsLoading
              ? l("Loading App Skills…", "正在加载本 App Skill…")
              : l("No App Skills yet.", "本 App 还没有 Skill。")}
            action={l("Open Skills", "打开 Skills")}
            onOpen={onShowSkills}
          />
        </article>
        </div>
      </div>
    </div>
  );
}

function WorkbenchFeatureCard({
  icon,
  title,
  metric,
  description,
  rows,
  empty,
  action,
  onOpen,
}: {
  icon: ReactElement;
  title: string;
  metric: string;
  description: string;
  rows: Array<{ id: string; title: string; detail: string; onOpen?: () => void }>;
  empty: string;
  action: string;
  onOpen: () => void;
}): ReactElement {
  return (
    <section className="workbench-panel workbench-feature-card">
      <header className="workbench-feature-card-head">
        <span>{icon}</span>
        <div><h2>{title}</h2><small>{metric}</small></div>
        <button type="button" onClick={onOpen}>{action}<ArrowRight size={13} /></button>
      </header>
      <p>{description}</p>
      <div className="workbench-feature-list">
        {rows.length > 0 ? rows.map((row) => (
          <button key={row.id} type="button" onClick={row.onOpen ?? onOpen}>
            <span><strong>{row.title}</strong><small>{row.detail}</small></span>
            <ArrowRight size={12} />
          </button>
        )) : <span className="workbench-feature-empty">{empty}</span>}
      </div>
    </section>
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

function memoryRuntimeStateLabel(
  state: OpenVikingMemorySnapshot["runtime"]["state"],
  language: LanguageMode,
): string {
  if (state === "running") return localize(language, "Running", "运行中");
  if (state === "starting") return localize(language, "Starting", "启动中");
  if (state === "installing") return localize(language, "Installing", "安装中");
  if (state === "stopped") return localize(language, "Stopped", "已停止");
  if (state === "not-installed") return localize(language, "Not installed", "未安装");
  return localize(language, "Unavailable", "不可用");
}

function memoryImportStateLabel(
  state: OpenVikingMemorySnapshot["workspaces"][number]["importState"],
  language: LanguageMode,
): string {
  if (state === "completed") return localize(language, "Ready", "已就绪");
  if (state === "running") return localize(language, "Importing", "导入中");
  if (state === "queued") return localize(language, "Queued", "等待导入");
  if (state === "paused") return localize(language, "Paused", "已暂停");
  if (state === "failed") return localize(language, "Failed", "失败");
  return localize(language, "Not imported", "未导入");
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
