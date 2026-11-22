import { useState } from "react";
import type { ReactElement } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, EyeOff, Link2Off, MousePointerClick, RefreshCw } from "lucide-react";

import type { SkillTriggerLink } from "../../../../core/session-store";
import type { SkillFinding } from "../../../../core/skill-eval-findings";
import type { SkillEvalDetail } from "../../../../main/services/skill-service";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { formatDuration, formatRatio, formatTokens } from "./eval-format";
import { EvalSuitesCard } from "./eval-suites-card";
import { skillKey, type SkillPerformance } from "./use-skill-performance";

export function SkillPerformanceView({
  language,
  performance,
  onOpenSession,
}: {
  language: LanguageMode;
  performance: SkillPerformance;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const { overview, skills, selected, detail, triggers, findings, loading, error, refresh, selectSkill } = performance;
  return (
    <>
      {overview && !overview.hookInstalled ? (
        <p className="eval-observability-note">
          <EyeOff size={13} />
          {l(
            "The usage hook is not installed: Claude skill triggers are unobserved, not absent. Install it in Settings.",
            "使用统计 Hook 未安装：Claude 侧的 Skill 触发处于\u201c观测不到\u201d状态，而不是没有使用。请在设置中安装。",
          )}
        </p>
      ) : null}
      <div className="eval-skills-layout">
        <aside className="eval-skill-list">
          <header>
            <span>{l("Skills", "Skill 列表")}</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
              aria-label={l("Refresh", "刷新")}
            >
              <RefreshCw size={14} className={loading ? "spinning" : undefined} />
            </button>
          </header>
          {overview === null ? (
            <p className="eval-muted">{l("Loading...", "加载中...")}</p>
          ) : skills.length === 0 ? (
            <p className="eval-muted">{l(
              "No skills installed or recorded yet.",
              "还没有已安装或有记录的 Skill。",
            )}</p>
          ) : (
            skills.map((item) => (
              <button
                key={skillKey(item.skill)}
                className={`eval-skill-item ${selected && skillKey(selected.skill) === skillKey(item.skill) ? "active" : ""}`}
                onClick={() => selectSkill(item.skill)}
              >
                <span className="eval-skill-name">{item.skill}</span>
                <span className="eval-skill-meta">
                  {item.observation === "exercised" ? (
                    <>
                      {l(`${item.totalTriggers} triggers`, `${item.totalTriggers} 次触发`)}
                      {item.triggers7d > 0 ? ` · 7d ${item.triggers7d}` : ""}
                      {item.lastTriggeredAt ? ` · ${formatRelativeTime(item.lastTriggeredAt, language)}` : ""}
                    </>
                  ) : item.observation === "never-used" ? (
                    <span className="eval-badge eval-badge-warn">{l("Installed, never used", "已装未用")}</span>
                  ) : (
                    <span className="eval-badge eval-badge-dim">{l("Unobserved", "观测不到")}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </aside>
        <section className="eval-trigger-panel">
          {error ? <p className="eval-error" role="alert">{error}</p> : null}
          {selected ? (
            <>
              <header>
                <h3>{selected.skill}</h3>
                <span className="eval-muted">
                  {detail?.remoteVersion != null ? `v${detail.remoteVersion} · ` : ""}
                  {l("Live report", "实况报告")}
                </span>
              </header>
              {selected.observation === "unobserved" ? (
                <p className="eval-muted">{l(
                  "This Claude skill has no records because the collection pipeline cannot see it yet. That is not evidence it was unused.",
                  "这个 Claude Skill 没有记录，是因为采集管道还观测不到它——这不构成\u201c没用过\u201d的证据。",
                )}</p>
              ) : (
                <>
                  <FindingsCard language={language} findings={findings} />
                  <EvalSuitesCard language={language} skill={selected.skill} onOpenSession={onOpenSession} />
                  <SignalsCard language={language} detail={detail} />
                  <VersionsCard language={language} detail={detail} />
                  <TriggersCard
                    language={language}
                    triggers={triggers}
                    onOpenSession={onOpenSession}
                  />
                </>
              )}
            </>
          ) : (
            <p className="eval-muted">{l(
              "Select a skill to review its live report.",
              "选择一个 Skill 查看它的实况报告。",
            )}</p>
          )}
        </section>
      </div>
    </>
  );
}

// Descriptive Exercised-strength facts only: numbers next to a library-wide
// baseline, never a score.
function SignalsCard({
  language,
  detail,
}: {
  language: LanguageMode;
  detail: SkillEvalDetail | null;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const signals = detail?.signals ?? null;
  const enoughSamples = (signals?.sampleSize ?? 0) >= 3;
  return (
    <div className="eval-card">
      <header>
        <h4>{l("Performance signals", "表现信号")}</h4>
        <span className="eval-evidence-tag" title={l(
          "Facts from real linked turns; not a quality score.",
          "来自真实关联 turn 的事实，不是质量评分。",
        )}>
          Exercised · n={signals?.sampleSize ?? "…"}
        </span>
      </header>
      {signals === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : !enoughSamples ? (
        <p className="eval-muted">{l(
          `Not enough linked-turn samples yet (${signals.sampleSize} of 3 needed). Signals appear once more triggers link to turns.`,
          `关联到 turn 的样本还不足（${signals.sampleSize}/3）。等更多触发关联到 turn 后这里会给出信号。`,
        )}</p>
      ) : (
        <ul className="eval-signal-list">
          <li>
            <span>{l("Median tokens per trigger turn", "触发 turn token 中位数")}</span>
            <strong>{formatTokens(signals.medianTotalTokens)}</strong>
            <span className="eval-baseline">{l("library median", "全库中位")} {formatTokens(signals.baselineMedianTotalTokens)}</span>
          </li>
          <li>
            <span>{l("Median trigger turn duration", "触发 turn 时长中位数")}</span>
            <strong>{formatDuration(signals.medianDurationMs)}</strong>
            <span className="eval-baseline">{l("library median", "全库中位")} {formatDuration(signals.baselineMedianDurationMs)}</span>
          </li>
          <li>
            <span>{l("Trigger turns with errors", "触发 turn 带错误占比")}</span>
            <strong>{formatRatio(signals.errorTurnRatio)}</strong>
            <span className="eval-baseline">{l("library", "全库")} {formatRatio(signals.baselineErrorTurnRatio)}</span>
          </li>
        </ul>
      )}
    </div>
  );
}

function VersionsCard({
  language,
  detail,
}: {
  language: LanguageMode;
  detail: SkillEvalDetail | null;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const versions = detail?.versions ?? null;
  return (
    <div className="eval-card">
      <header>
        <h4>{l("Versions", "版本切分")}</h4>
      </header>
      {versions === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : versions.length === 0 ? (
        <p className="eval-muted">{l("No triggers recorded yet.", "还没有触发记录。")}</p>
      ) : (
        <ul className="eval-version-list">
          {versions.map((group) => (
            <li key={group.skillHash ?? "unknown"}>
              <code>{group.skillHash ? group.skillHash.slice(0, 10) : l("version unknown", "版本未知")}</code>
              {group.current ? <span className="eval-badge eval-badge-current">{l("current", "当前版本")}</span> : null}
              <span className="eval-version-meta">
                {l(`${group.triggerCount} triggers`, `${group.triggerCount} 次触发`)}
                {" · "}
                {formatRelativeTime(group.firstTriggeredAt, language)} → {formatRelativeTime(group.lastTriggeredAt, language)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TriggersCard({
  language,
  triggers,
  onOpenSession,
}: {
  language: LanguageMode;
  triggers: SkillTriggerLink[] | null;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="eval-card">
      <header>
        <h4><MousePointerClick size={14} /> {l("Recent triggers", "最近触发")}</h4>
      </header>
      {triggers === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : triggers.length === 0 ? (
        <p className="eval-muted">{l("No triggers recorded yet.", "还没有触发记录。")}</p>
      ) : (
        <ul className="eval-trigger-list">
          {triggers.map((trigger, index) => (
            <li key={`${trigger.occurredAt}-${index}`}>
              <span className="eval-trigger-time">{formatRelativeTime(trigger.occurredAt, language)}</span>
              <span className="eval-trigger-agent">{trigger.agent}</span>
              {trigger.sessionKey ? (
                <button
                  type="button"
                  className="eval-trigger-session"
                  onClick={() => onOpenSession(trigger.sessionKey!)}
                >
                  {trigger.sessionTitle || trigger.sessionKey}
                </button>
              ) : (
                <span className="eval-trigger-unlinked">
                  <Link2Off size={12} />{l("Not linked", "未关联")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingsCard({
  language,
  findings,
}: {
  language: LanguageMode;
  findings: SkillFinding[] | null;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="eval-card eval-findings-card">
      <header>
        <h4>{l("Findings", "Findings")}</h4>
        {findings !== null && findings.length > 0 ? (
          <span className="eval-evidence-tag">{l(`${findings.length} found`, `发现 ${findings.length} 条`)}</span>
        ) : null}
      </header>
      {findings === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : findings.length === 0 ? (
        <p className="eval-muted">
          <CheckCircle2 size={14} style={{ verticalAlign: "middle", marginRight: 4 }} />
          {l(
            "No patterns of concern. This does not prove there are no issues — only that observable data did not meet the evidence threshold.",
            "未发现需要关注的模式。这不证明没有问题——只是可观测数据未达到证据阈值。",
          )}
        </p>
      ) : (
        <ul className="eval-finding-list">
          {findings.map((f, i) => {
            const key = `${f.rule}-${i}`;
            const isExpanded = expanded.has(key);
            return (
              <li key={key} className={`eval-finding eval-finding-${f.severity}`}>
                <button
                  type="button"
                  className="eval-finding-header"
                  onClick={() => toggle(key)}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className={`eval-badge eval-badge-${f.severity === "medium" ? "warn" : "dim"}`}>
                    {f.severity}
                  </span>
                  <span className="eval-finding-rule">{f.rule}</span>
                  <span className="eval-finding-strength">{f.evidenceStrength} · n={f.sampleSize}</span>
                </button>
                {isExpanded ? (
                  <div className="eval-finding-body">
                    <p>{l(f.observation.en, f.observation.zh)}</p>
                    <p className="eval-finding-repair">{l(f.repairDirection.en, f.repairDirection.zh)}</p>
                    {f.evidence.spanIds && f.evidence.spanIds.length > 0 ? (
                      <p className="eval-muted">{l("Evidence spans:", "证据 span：")} {f.evidence.spanIds.slice(0, 3).join(", ")}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
