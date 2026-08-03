import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, Beaker, CheckCircle2, ChevronDown, ChevronRight, EyeOff, Link2Off, Lock, MousePointerClick, Play, Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";

import type { SkillTriggerLink } from "../../../../core/session-store";
import type { SkillFinding } from "../../../../core/skill-eval-findings";
import type { SkillEvalDetail, SkillEvalOverview, SkillEvalOverviewItem, SkillEvalSuite, CreateSkillEvalSuiteInput } from "../../../../main/services/skill-service";
import type { EvaluationEvaluator, ConfiguredAgent } from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { EvaluationFeaturePage } from "../automation/evaluation-feature-page";

type EvalTab = "skills" | "experiments";

export function EvalPage({
  language,
  enabled,
  onOpenSettings,
  onOpenSession,
  onNavigationGuardChange,
  preselectedSkill,
  onPreselectedConsumed,
}: {
  language: LanguageMode;
  enabled: boolean;
  onOpenSettings: () => void;
  onOpenSession: (sessionKey: string) => void;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  preselectedSkill?: string | null;
  onPreselectedConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [tab, setTab] = useState<EvalTab>("skills");
  const [overview, setOverview] = useState<SkillEvalOverview | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillEvalDetail | null>(null);
  const [triggers, setTriggers] = useState<SkillTriggerLink[] | null>(null);
  const [findings, setFindings] = useState<SkillFinding[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await window.sessionSearch.refreshSkillUsage();
      setOverview(await window.sessionSearch.getSkillEvalOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setOverview(null);
      setDetail(null);
      setTriggers(null);
      setFindings(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const skills = overview?.skills ?? [];
  const selected = skills.find((item) => skillKey(item.skill) === selectedSkill) ?? skills[0] ?? null;

  useEffect(() => {
    if (!enabled || !selected) {
      setDetail(null);
      setTriggers(null);
      setFindings(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setTriggers(null);
    setFindings(null);
    void (async () => {
      try {
        const [nextDetail, nextTriggers, nextFindings] = await Promise.all([
          window.sessionSearch.getSkillEvalDetail(selected.skill),
          window.sessionSearch.listSkillTriggers({ skill: selected.skill, limit: 50 }),
          window.sessionSearch.getSkillEvalFindings(selected.skill),
        ]);
        if (cancelled) return;
        setDetail(nextDetail);
        setTriggers(nextTriggers);
        setFindings(nextFindings);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
    // selected object identity changes on every refresh; key on the name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selected?.skill]);

  // Consume preselected skill from Skills page badge click.
  useEffect(() => {
    if (preselectedSkill) {
      setSelectedSkill(skillKey(preselectedSkill));
      onPreselectedConsumed?.();
    }
  }, [preselectedSkill, onPreselectedConsumed]);

  return (
    <div className="eval-page">
      <header className="app-page-head">
        <div>
          <h2>Eval</h2>
          <p>{l(
            "Review how the assets you can change actually perform.",
            "回看你能改动的资产在真实使用中的表现。",
          )}</p>
        </div>
      </header>

      <nav className="eval-tabs" aria-label={l("Eval objects", "评测对象")}>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          {l("Skills", "Skills")}
        </button>
        <button className={tab === "experiments" ? "active" : ""} onClick={() => setTab("experiments")}>
          {l("Experiments", "实验")}
        </button>
        <button disabled title={l("Coming later", "后续开放")}>
          <Lock size={12} /> Workflows
        </button>
        <button disabled title={l("Coming later", "后续开放")}>
          <Lock size={12} /> Rules
        </button>
      </nav>

      {tab === "experiments" ? (
        <EvaluationFeaturePage language={language} onNavigationGuardChange={onNavigationGuardChange} />
      ) : !enabled ? (
        <section className="eval-disabled-state">
          <span><Beaker size={24} /></span>
          <h3>{l("Eval is off by default", "Eval 默认关闭")}</h3>
          <p>{l(
            "Enable it in Settings and install the usage hook, then new skill triggers link to their sessions.",
            "请先在设置中开启并安装使用统计 Hook，此后新的 Skill 触发会关联到对应会话。",
          )}</p>
          <button type="button" onClick={onOpenSettings}>
            <Settings2 size={15} />{l("Open Settings", "前往设置")}
          </button>
        </section>
      ) : (
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
                    onClick={() => setSelectedSkill(skillKey(item.skill))}
                  >
                    <span className="eval-skill-name">{item.skill}</span>
                    <span className="eval-skill-meta">
                      {item.observation === "exercised" ? (
                        <>
                          {l(`${item.totalTriggers} triggers`, `${item.totalTriggers} 次触发`)}
                          {item.triggers7d > 0 ? ` · 7d ${item.triggers7d}` : ""}
                          {item.lastTriggeredAt ? ` · ${formatRelativeTime(item.lastTriggeredAt)}` : ""}
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
                      <FindingsCard language={language} findings={findings} onOpenSession={onOpenSession} />
                      <EvalSuitesCard language={language} skill={selected.skill} />
                      <SignalsCard language={language} item={selected} detail={detail} />
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
      )}
    </div>
  );
}

// Descriptive Exercised-strength facts only: numbers next to a library-wide
// baseline, never a score.
function SignalsCard({
  language,
  item,
  detail,
}: {
  language: LanguageMode;
  item: SkillEvalOverviewItem;
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
                {formatRelativeTime(group.firstTriggeredAt)} → {formatRelativeTime(group.lastTriggeredAt)}
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
              <span className="eval-trigger-time">{formatRelativeTime(trigger.occurredAt)}</span>
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

function skillKey(skill: string): string {
  return skill.trim().toLowerCase();
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = value / 1000;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

// Skill regression evaluation (phase four). Cases are the specification the user
// defines ("given this input, expect this output"); runs executed through the
// automation engine are the evidence. The card stays mounted for suites are fetched
// for the selected skill and runs are attributed to the then-current skill hash.
function EvalSuitesCard({
  language,
  skill,
}: {
  language: LanguageMode;
  skill: string;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [suites, setSuites] = useState<SkillEvalSuite[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSuites(await window.sessionSearch.listSkillEvalSuites(skill));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [skill]);

  useEffect(() => {
    setSuites(null);
    void reload();
  }, [reload]);

  const run = useCallback(async (suiteId: string) => {
    setRunningId(suiteId);
    setError(null);
    try {
      await window.sessionSearch.runSkillEvalSuite(suiteId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunningId(null);
    }
  }, [reload]);

  return (
    <div className="eval-card eval-suites-card">
      <header>
        <h4>{l("Regression evaluation", "回归评测")}</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {suites !== null && suites.length > 0 ? (
            <span className="eval-evidence-tag">{l(`${suites.length} suite(s)`, `${suites.length} 个方案`)}</span>
          ) : null}
          <button type="button" className="eval-create-button" onClick={() => setCreateOpen(true)}>
            <Plus size={13} />{l("New suite", "新建方案")}
          </button>
        </div>
      </header>

      {error ? <p className="eval-error" role="alert">{error}</p> : null}

      {suites === null ? (
        <p className="eval-muted">{l("Loading...", "加载中...")}</p>
      ) : suites.length === 0 ? (
        <p className="eval-muted">{l(
          "No regression suite yet. Define cases once re-run this skill after it changes.",
          "还没有回归评测方案。定义测试用例，就能在该 Skill 改动后重跑验证。",
        )}</p>
      ) : (
        <ul className="eval-suite-list">
          {suites.map((suite) => (
            <li key={suite.id} className="eval-suite-item">
              <div className="eval-suite-row-main">
                <span className="eval-suite-name-name">{suite.name}</span>
                <span className="eval-muted">{l(`${suite.caseCount} cases`, `${suite.caseCount} 个用例`)}</span>
                {suite.drifted ? (
                  <span className="eval-badge eval-badge-warn" title={l(
                    "The skill version changed since the last run.",
                    "该 Skill 自上次运行后版本已变化。",
                  )}>
                    <AlertTriangle size={11} />{l("Version drifted", "版本已变化")}
                  </span>
                ) : suite.skillHash ? (
                  <span className="eval-badge eval-badge-dim">
                    <CheckCircle2 size={11} />{l("Current version", "当前版本")}
                  </span>
                ) : null}
              </div>
              <div className="eval-suite-row-sub">
                <span className="eval-muted">
                  {suite.lastRun
                    ? `${l("Last run", "上次运行")} ${formatRelativeTime(suite.lastRun.startedAt)} · ${l("pass", "通过")} ${suite.lastRun.passRate != null ? Math.round(suite.lastRun.passRate * 100) : "—"}%`
                    : l("Never run", "从未运行")}
                  {" · "}×{suite.repetitions}
                </span>
                <button
                  type="button"
                  className="eval-run-button"
                  disabled={runningId === suite.id}
                  onClick={() => void run(suite.id)}
                >
                  <Play size={12} />
                  {runningId === suite.id ? l("Running...", "运行中...") : l("Run", "运行")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {createOpen ? (
        <CreateSuiteDialog
          language={language}
          skill={skill}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateSuiteDialog({
  language,
  skill,
  onClose,
  onCreated,
}: {
  language: LanguageMode;
  skill: string;
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [repetitions, setRepetitions] = useState(1);
  const [evaluatorIds, setEvaluatorIds] = useState<string[]>([]);
  const [cases, setCases] = useState<Array<{ input: string; expectedOutput: string }>>([
    { input: "", expectedOutput: "" },
  ]);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[]>([]);
  const [agents, setAgents] = useState<ConfiguredAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextEvaluators, snapshot] = await Promise.all([
          window.sessionSearch.automation.listEvaluationEvaluators(),
          window.sessionSearch.automation.getSnapshot(),
        ]);
        if (cancelled) return;
        setEvaluators(nextEvaluators.filter((item) => item.enabled));
        setAgents(snapshot.configuredAgents);
        if (snapshot.configuredAgents[0]) setAgentId(snapshot.configuredAgents[0].id);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const input: CreateSkillEvalSuiteInput = {
        skill,
        name,
        agentId,
        evaluatorIds,
        repetitions,
        cases: cases
          .filter((item) => item.input.trim())
          .map((item) => ({
            input: item.input,
            ...(item.expectedOutput.trim() ? { expectedOutput: item.expectedOutput } : {}),
          })),
      };
      await window.sessionSearch.createSkillEvalSuite(input);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }, [skill, name, agentId, evaluatorIds, repetitions, cases, onCreated]);

  const canSave = name.trim() && agentId && cases.some((item) => item.input.trim());

  return (
    <div className="eval-suite-dialog-backdrop" onClick={onClose}>
      <div className="eval-suite-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <h4>{l("New regression suite", "新建回归方案")} · {skill}</h4>
          <button type="button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={15} />
          </button>
        </header>

        {error ? <p className="eval-error" role="alert">{error}</p> : null}

        <label className="eval-suite-field">
          <span>{l("Suite name", "方案名称")}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={l("e.g. Basic feature regression", "如：基础功能回归")} />
        </label>

        <label className="eval-suite-field">
          <span>{l("Execution Agent", "执行 Agent")}</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.length === 0 ? <option value="">{l("No configured Agent", "暂无已配置 Agent")}</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </label>

        <div className="eval-suite-field">
          <span>{l("Evaluators", "评分器")}</span>
          <div className="eval-suite-evaluators">
            {evaluators.length === 0 ? (
              <p className="eval-muted">{l(
                "No evaluators yet. Create one in the Experiments tab first.",
                "还没有评分器。请先在实验页创建。",
              )}</p>
            ) : evaluators.map((evaluator) => {
              const checked = evaluatorIds.includes(evaluator.id);
              return (
                <label key={evaluator.id} className="eval-suite-evaluator-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setEvaluatorIds((ids) => event.target.checked
                      ? [...ids, evaluator.id]
                      : ids.filter((id) => id !== evaluator.id))}
                  />
                  {evaluator.name}
                </label>
              );
            })}
          </div>
        </div>

        <label className="eval-suite-field">
          <span>{l("Repetitions per case", "每个用例重复次数")}</span>
          <select value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <div className="eval-suite-field">
          <div className="eval-suite-cases-header">
            <span>{l("Test cases", "测试用例")}</span>
            <button type="button" onClick={() => setCases((items) => [...items, { input: "", expectedOutput: "" }])}>
              <Plus size={12} />{l("Case", "用例")}
            </button>
          </div>
          {cases.map((item, index) => (
            <div key={index} className="eval-suite-case-row">
              <textarea
                value={item.input}
                placeholder={l(`Use ${skill} to: ...`, `使用 ${skill} 处理：...`)}
                onChange={(event) => setCases((items) => items.map((value, i) => i === index ? { ...value, input: event.target.value } : value))}
              />
              <textarea
                value={item.expectedOutput}
                placeholder={l("Expected output (optional)", "期望输出（可选）")}
                onChange={(event) => setCases((items) => items.map((value, i) => i === index ? { ...value, expectedOutput: event.target.value } : value))}
              />
              <button
                type="button"
                aria-label={l("Remove case", "删除用例")}
                disabled={cases.length <= 1}
                onClick={() => setCases((items) => items.filter((_, i) => i !== index))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <footer>
          <button type="button" className="eval-suite-cancel" onClick={onClose}>{l("Cancel", "取消")}</button>
          <button
            type="button"
            className="eval-suite-save"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {saving ? l("Saving...", "保存中...") : l("Create", "创建")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatRatio(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

function FindingsCard({
  language,
  findings,
  onOpenSession,
}: {
  language: LanguageMode;
  findings: SkillFinding[] | null;
  onOpenSession: (sessionKey: string) => void;
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
                    <p>{f.observation}</p>
                    <p className="eval-finding-repair">{f.repairDirection}</p>
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
