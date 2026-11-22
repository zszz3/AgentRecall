import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { CornerUpLeft } from "lucide-react";
import type { RuntimeInvocationSummary, SessionSearchResult } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";

/** Owner-navigation buttons shown before the "show all" toggle collapses the rest. */
const INVOCATION_OWNER_ACTION_LIMIT = 3;

/**
 * Collapses the invocation history to one button per distinct navigation
 * target. Invocations arrive newest-first, so the first occurrence of each
 * surface + owner reference combination is its most recent invocation.
 */
function distinctInvocationOwnerActions(invocations: readonly RuntimeInvocationSummary[]): RuntimeInvocationSummary[] {
  const actions: RuntimeInvocationSummary[] = [];
  const seenOwnerReferences = new Set<string>();
  for (const invocation of invocations) {
    if (Object.keys(invocation.ownerReference).length === 0) continue;
    const ownerKey = `${invocation.surface}:${JSON.stringify(invocation.ownerReference)}`;
    if (seenOwnerReferences.has(ownerKey)) continue;
    seenOwnerReferences.add(ownerKey);
    actions.push(invocation);
  }
  return actions;
}

function invocationSurfaceLabel(surface: string, language: LanguageMode): string {
  const labels: Record<string, [string, string]> = {
    workflow: ["Workflow", "工作流"],
    evaluation: ["Evaluation", "评测"],
    team_chat: ["Team Chat", "团队会话"],
    agent: ["Agent", "智能体"],
    skill: ["Skill", "技能"],
    system: ["System", "系统"],
  };
  const label = labels[surface];
  return label ? localize(language, label[0], label[1]) : surface;
}

function invocationRoleLabel(role: string | null, language: LanguageMode): string | null {
  if (!role) return null;
  const labels: Record<string, [string, string]> = {
    recovery_manager: ["Recovery manager", "恢复管理"],
    reviewer: ["Reviewer", "审核"],
    node: ["Node", "节点"],
    draft: ["Draft", "草稿生成"],
    chat: ["Chat", "对话"],
    task: ["Task", "任务"],
    subject: ["Subject", "受测对象"],
    judge: ["Judge", "裁判"],
    member: ["Member", "成员"],
    discovery: ["Discovery", "探索"],
    channel_test: ["Connection test", "连接测试"],
  };
  const label = labels[role];
  return label ? localize(language, label[0], label[1]) : role;
}

function invocationStatusLabel(status: RuntimeInvocationSummary["status"], language: LanguageMode): string {
  const labels: Record<RuntimeInvocationSummary["status"], [string, string]> = {
    pending: ["Running", "进行中"],
    completed: ["Completed", "已完成"],
    failed: ["Failed", "失败"],
    cancelled: ["Cancelled", "已取消"],
    timed_out: ["Timed out", "已超时"],
  };
  const label = labels[status];
  return localize(language, label[0], label[1]);
}

function invocationOwnerActionLabel(
  invocation: RuntimeInvocationSummary,
  language: LanguageMode,
): string {
  const exactOwner =
    (invocation.surface === "evaluation" && Boolean(invocation.ownerReference.runId))
    || (invocation.surface === "system" && Boolean(invocation.ownerReference.channelId))
    || (invocation.surface === "agent" && Boolean(invocation.ownerReference.agentId));
  if (exactOwner) return localize(language, "Back to source", "返回调用来源");
  if (invocation.surface === "skill") return localize(language, "Open Skills", "打开 Skills");
  if (invocation.surface === "workflow") return localize(language, "Workflow removed", "工作流已移除");
  if (invocation.surface === "team_chat") return localize(language, "Multi-agent Chat removed", "多人 Chat 已移除");
  if (invocation.surface === "evaluation") return localize(language, "Open Evaluations", "打开评测");
  if (invocation.surface === "system") return localize(language, "Open Runtimes", "打开 Runtime");
  return localize(language, "Open Workbench", "打开工作台");
}

/** Read-only list of the AgentRecall Runtime invocations that created or continued this session. */
export function RuntimeInvocationHistory({
  session,
  language,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
}): ReactElement | null {
  const invocations = session.runtimeInvocations ?? [];
  if (invocations.length === 0) return null;
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <section className="runtime-invocation-history" aria-label={l("AgentRecall invocation history", "AgentRecall 调用记录")}>
      <div className="runtime-invocation-history-title">
        <strong>{session.createdByAgentRecall
          ? l("Created by AgentRecall", "由 AgentRecall 创建")
          : l("Continued by AgentRecall", "曾由 AgentRecall 续接")}</strong>
        <span>{l(
          `${invocations.length} invocations`,
          `${invocations.length} 次调用`,
        )}</span>
      </div>
      <div className="runtime-invocation-history-list">
        {invocations.map((invocation) => (
          <div className="runtime-invocation-history-item" key={invocation.invocationId}>
            <span>{invocationSurfaceLabel(invocation.surface, language)}
              {invocationRoleLabel(invocation.role, language)
                ? ` · ${invocationRoleLabel(invocation.role, language)}`
                : ""}</span>
            <span>{invocationStatusLabel(invocation.status, language)} · {new Date(invocation.startedAt).toLocaleString(
              language === "zh" ? "zh-CN" : "en-US",
            )}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Navigation back to the surfaces that invoked this session, one button per
 * distinct owner. Removed surfaces (Workflow, multi-agent Chat) stay visible
 * but disabled. The expanded state resets when another session opens.
 */
export function InvocationOwnerActions({
  session,
  language,
  onOpen,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
  onOpen: (invocation: RuntimeInvocationSummary) => void;
}): ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  const invocations = session.runtimeInvocations;
  const actions = useMemo(() => distinctInvocationOwnerActions(invocations ?? []), [invocations]);

  useEffect(() => setShowAll(false), [session.sessionKey]);

  if (actions.length === 0) return null;
  return (
    <div className="detail-action-group">
      {(showAll ? actions : actions.slice(0, INVOCATION_OWNER_ACTION_LIMIT))
        .map((invocation) => (
          <button type="button" key={invocation.invocationId} disabled={invocation.surface === "team_chat" || invocation.surface === "workflow"} onClick={() => onOpen(invocation)}>
            <CornerUpLeft size={15} /> {invocationOwnerActionLabel(invocation, language)}
          </button>
        ))}
      {actions.length > INVOCATION_OWNER_ACTION_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
        >
          {showAll
            ? localize(language, "Show fewer", "收起")
            : localize(
              language,
              `Show all ${actions.length}`,
              `查看全部 ${actions.length} 处`,
            )}
        </button>
      ) : null}
    </div>
  );
}
