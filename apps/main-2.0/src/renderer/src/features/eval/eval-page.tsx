import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Beaker, Database, Gauge, History, Settings2, Target } from "lucide-react";

import { localize, type LanguageMode } from "../../language";
import { EvalDatasetsPage } from "./eval-datasets-page";
import { EvalEvaluatorsPage } from "./eval-evaluators-page";
import { EvalPlanPage } from "./eval-plan-page";
import { EvalRunsPage } from "./eval-runs-page";
import { SkillPerformanceView } from "./eval-skill-performance";
import { useSkillPerformance } from "./use-skill-performance";

type EvalTab = "skills" | "datasets" | "evaluators" | "graph" | "runs";

export function EvalPage({
  language,
  enabled,
  onOpenSettings,
  onOpenSession,
  onNavigationGuardChange,
  preselectedSkill,
  onPreselectedConsumed,
  initialRunId,
  initialCaseId,
  initialEvaluatorId,
  onInitialRunConsumed,
}: {
  language: LanguageMode;
  enabled: boolean;
  onOpenSettings: () => void;
  onOpenSession: (sessionKey: string) => void;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  preselectedSkill?: string | null;
  onPreselectedConsumed?: () => void;
  initialRunId?: string;
  initialCaseId?: string;
  initialEvaluatorId?: string;
  onInitialRunConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [tab, setTab] = useState<EvalTab>("skills");
  // Dataset and evaluator drafts live in their pages; leaving the tab unmounts
  // them, so an unsaved edit has to be confirmed rather than silently dropped.
  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<EvalTab, boolean>>>({});
  const skillPerformance = useSkillPerformance({ enabled, preselectedSkill, onPreselectedConsumed });

  const confirmDiscard = useCallback(
    () => window.confirm(l(
      "Discard the unsaved changes on this tab?",
      "当前标签页有未保存的修改，确定要放弃吗？",
    )),
    [l],
  );

  // Report unsaved work upward so leaving Eval entirely is guarded too.
  useEffect(() => {
    const anyDirty = Object.values(dirtyTabs).some(Boolean);
    onNavigationGuardChange?.(anyDirty ? async () => confirmDiscard() : null);
    return () => onNavigationGuardChange?.(null);
  }, [confirmDiscard, dirtyTabs, onNavigationGuardChange]);

  const switchTab = useCallback((next: EvalTab) => {
    if (next === tab) return;
    if (dirtyTabs[tab] && !confirmDiscard()) return;
    setDirtyTabs((current) => ({ ...current, [tab]: false }));
    setTab(next);
  }, [confirmDiscard, dirtyTabs, tab]);

  const reportDirty = useCallback(
    (page: EvalTab, dirty: boolean) => setDirtyTabs((current) => current[page] === dirty
      ? current
      : { ...current, [page]: dirty }),
    [],
  );

  useEffect(() => {
    if (initialRunId) setTab("runs");
  }, [initialRunId]);

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
        <button className={tab === "skills" ? "active" : ""} onClick={() => switchTab("skills")}>
          {l("Skill performance", "Skill 表现")}
        </button>
        <button className={tab === "datasets" ? "active" : ""} onClick={() => switchTab("datasets")}>
          <Database size={12} /> {l("Datasets", "数据集")}
        </button>
        <button className={tab === "evaluators" ? "active" : ""} onClick={() => switchTab("evaluators")}>
          <Gauge size={12} /> {l("Evaluators", "评分器")}
        </button>
        <button className={tab === "graph" ? "active" : ""} onClick={() => switchTab("graph")}>
          <Target size={12} /> {l("Plans", "方案")}
        </button>
        <button className={tab === "runs" ? "active" : ""} onClick={() => switchTab("runs")}>
          <History size={12} /> {l("Runs", "运行")}
        </button>
      </nav>

      {tab === "datasets" ? (
        <EvalDatasetsPage language={language} onDirtyChange={(dirty) => reportDirty("datasets", dirty)} />
      ) : tab === "evaluators" ? (
        <EvalEvaluatorsPage language={language} onDirtyChange={(dirty) => reportDirty("evaluators", dirty)} />
      ) : tab === "graph" ? (
        <EvalPlanPage
          language={language}
          onDirtyChange={(dirty) => reportDirty("graph", dirty)}
          onOpenRuns={() => switchTab("runs")}
        />
      ) : tab === "runs" ? (
        <EvalRunsPage
          language={language}
          onOpenSession={onOpenSession}
          initialRunId={initialRunId}
          initialCaseId={initialCaseId}
          initialEvaluatorId={initialEvaluatorId}
          onInitialRunConsumed={onInitialRunConsumed}
        />
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
        <SkillPerformanceView language={language} performance={skillPerformance} onOpenSession={onOpenSession} />
      )}
    </div>
  );
}
