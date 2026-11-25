import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { SkillEvalSuite } from "../../../../shared/ipc/skills";
import type { EvaluationNodeRecord, EvaluationRun, EvaluationRunSummary } from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import {
  formatDuration,
  nodeLabel,
  nodeReasonText,
  nodeStatusClass,
  nodeStatusText,
  runStatusClass,
  runStatusText,
  skillUseText,
} from "./eval-format";
import { RunComparison } from "./eval-run-comparison";

// Run history drill-down for one suite: summaries first, then per-case evidence
// (input / output / every evaluator's score, reason and failedCriteria).
export function SuiteRunsSection({
  language,
  suite,
  onOpenSession,
}: {
  language: LanguageMode;
  suite: SkillEvalSuite;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<EvaluationRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [baseRunId, setBaseRunId] = useState("");
  const [compareRunId, setCompareRunId] = useState("");
  const [comparison, setComparison] = useState<{ base: EvaluationRun; compare: EvaluationRun } | null>(null);
  const [comparing, setComparing] = useState(false);

  const toggle = useCallback(() => {
    setOpen((value) => !value);
    if (!open && runs === null) {
      void (async () => {
        try {
          const nextRuns = await window.sessionSearch.getSkillEvalSuiteRuns(suite.id);
          setRuns(nextRuns);
          // Default to comparing the two newest runs.
          if (nextRuns.length >= 2) {
            setCompareRunId(nextRuns[0].id);
            setBaseRunId(nextRuns[1].id);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    }
  }, [open, runs, suite.id]);

  const compare = useCallback(async () => {
    if (!baseRunId || !compareRunId || baseRunId === compareRunId) return;
    setComparing(true);
    setError(null);
    try {
      const [base, compareRun] = await Promise.all([
        window.sessionSearch.getSkillEvalRun(baseRunId),
        window.sessionSearch.getSkillEvalRun(compareRunId),
      ]);
      if (!base || !compareRun) throw new Error("Run not found.");
      setComparison({ base, compare: compareRun });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setComparing(false);
    }
  }, [baseRunId, compareRunId]);

  return (
    <div className="eval-suite-runs">
      <button type="button" className="eval-suite-runs-toggle" onClick={toggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {l("Run history", "运行历史")}
        {runs !== null && runs.length > 0 ? ` · ${runs.length}` : ""}
      </button>
      {open ? (
        error ? <p className="eval-error" role="alert">{error}</p>
        : runs === null ? <p className="eval-muted">{l("Loading...", "加载中...")}</p>
        : runs.length === 0 ? <p className="eval-muted">{l("No runs yet.", "还没有运行记录。")}</p>
        : (
          <>
            {runs.length >= 2 ? (
              <div className="eval-run-compare-bar">
                <label>
                  <span>{l("Base run", "基准运行")}</span>
                  <select value={baseRunId} onChange={(event) => setBaseRunId(event.target.value)}>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatRelativeTime(run.startedAt, language)}{run.skillHash ? ` · ${run.skillHash.slice(0, 8)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="eval-muted">→</span>
                <label>
                  <span>{l("Compare run", "对比运行")}</span>
                  <select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatRelativeTime(run.startedAt, language)}{run.skillHash ? ` · ${run.skillHash.slice(0, 8)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="eval-run-button"
                  disabled={comparing || !baseRunId || !compareRunId || baseRunId === compareRunId}
                  onClick={() => void compare()}
                >
                  {comparing ? l("Comparing...", "对比中...") : l("Compare", "对比")}
                </button>
              </div>
            ) : null}
            {comparison ? (
              <RunComparison
                language={language}
                base={comparison.base}
                compare={comparison.compare}
                stages={suite.stages}
                onClose={() => setComparison(null)}
              />
            ) : null}
            <ul className="eval-run-list">
            {runs.map((run) => (
              <li key={run.id} className="eval-run-item">
                <button
                  type="button"
                  className="eval-run-row"
                  onClick={() => setExpandedRunId((current) => current === run.id ? null : run.id)}
                >
                  {expandedRunId === run.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className={`eval-badge ${runStatusClass(run.status)}`}>
                    {runStatusText(language, run.status)}
                  </span>
                  <span className="eval-muted">{formatRelativeTime(run.startedAt, language)}</span>
                  {run.passRate != null ? (
                    <span>{l("pass", "通过")} {Math.round(run.passRate * 100)}%</span>
                  ) : null}
                  {run.failedResultCount > 0 ? (
                    <span className="eval-badge eval-badge-warn">{l(`${run.failedResultCount} failed`, `${run.failedResultCount} 条失败`)}</span>
                  ) : null}
                </button>
                {expandedRunId === run.id ? <RunCaseDetail language={language} runId={run.id} onOpenSession={onOpenSession} /> : null}
              </li>
            ))}
          </ul>
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * Read-only view of one case's evaluation graph.
 *
 * Shows every node, including the ones that never ran, so a reader can tell
 * "the judge rejected the answer" from "the judge never got a chance".
 */
function CaseNodeGraph({
  language,
  nodes,
}: {
  language: LanguageMode;
  nodes: readonly EvaluationNodeRecord[];
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <details className="eval-run-text eval-case-graph">
      <summary>
        {l("Graph", "执行图")}
        {" · "}
        {nodes.filter((node) => node.status === "pass").length}/{nodes.length}
      </summary>
      <ol className="eval-case-graph-nodes">
        {nodes.map((node) => {
          const reason = node.attribution?.reason ?? node.pendingReason;
          const skillUse = node.nodeType === "skill_use_observe"
            ? skillUseText(language, node.facts)
            : null;
          return (
            <li key={node.nodeId}>
              <span className="eval-case-graph-name">{nodeLabel(language, node)}</span>
              <span className={`eval-badge ${nodeStatusClass(node.status)}`}>
                {nodeStatusText(language, node.status)}
              </span>
              {node.durationMs !== undefined ? (
                <span className="eval-muted">{formatDuration(node.durationMs)}</span>
              ) : null}
              {reason ? (
                <span className="eval-muted">{nodeReasonText(language, reason)}</span>
              ) : null}
              {skillUse ? <span className="eval-muted">{skillUse}</span> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function RunCaseDetail({
  language,
  runId,
  onOpenSession,
}: {
  language: LanguageMode;
  runId: string;
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [evaluatorNames, setEvaluatorNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextRun, evaluators] = await Promise.all([
          window.sessionSearch.getSkillEvalRun(runId),
          window.sessionSearch.automation.listEvaluationEvaluators(),
        ]);
        if (cancelled) return;
        setRun(nextRun);
        setEvaluatorNames(new Map(evaluators.map((item) => [item.id, item.name])));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) return <p className="eval-error" role="alert">{error}</p>;
  if (!run) return <p className="eval-muted">{l("Loading...", "加载中...")}</p>;
  if (run.error) return <p className="eval-error" role="alert">{run.error}</p>;

  return (
    <div className="eval-run-cases">
      {run.results.length === 0 ? (
        <p className="eval-muted">{l("No case results were recorded.", "没有记录到用例结果。")}</p>
      ) : run.results.map((result, index) => {
        // Three outcomes, not two: a case that decided nothing is unscored, and
        // showing it as "failed" would blame the agent for a judge that could
        // not run.
        const unscored = result.unscoredReason !== undefined;
        const passed = !unscored
          && result.gatePassed !== false
          && result.scores.length > 0
          && result.scores.every((score) => score.passed);
        return (
          <div key={result.id} className="eval-run-case">
            <header className="eval-run-case-header">
              <span className="eval-run-case-title">{l(`Case ${index + 1}`, `用例 ${index + 1}`)}{run.results.filter((item) => item.datasetItemId === result.datasetItemId).length > 1 ? ` · #${result.repetition}` : ""}</span>
              <span className={`eval-badge ${unscored ? "eval-badge-dim" : passed ? "eval-badge-ok" : "eval-badge-warn"}`}>
                {unscored ? l("Not scored", "未评分") : passed ? l("Passed", "通过") : l("Failed", "未通过")}
              </span>
              <span className="eval-muted">{formatDuration(result.durationMs)}</span>
              {result.skillInjection ? (
                <span className="eval-badge eval-badge-dim" title={result.skillInjection.skillHash}>
                  {l("skill", "Skill")} {result.skillInjection.skillName}@{result.skillInjection.skillHash.slice(0, 8)}
                </span>
              ) : null}
              {result.sessionKey ? (
                <button
                  type="button"
                  className="eval-trigger-session"
                  onClick={() => onOpenSession(result.sessionKey!)}
                >
                  {l("Open session", "打开会话")}
                </button>
              ) : null}
            </header>
            {unscored ? (
              <p className="eval-muted">
                {l("Nothing was decided for this case", "本用例没有得出任何评分结论")}
                {" · "}{nodeReasonText(language, result.unscoredReason!)}
              </p>
            ) : null}
            {result.nodes && result.nodes.length > 0 ? (
              <CaseNodeGraph language={language} nodes={result.nodes} />
            ) : result.error ? (
              // Runs recorded before the graph engine carry only this message.
              <p className="eval-error">{result.error}</p>
            ) : null}
            <details className="eval-run-text">
              <summary>{l("Input", "输入")}</summary>
              <pre>{result.input}</pre>
            </details>
            {result.expectedOutput ? (
              <details className="eval-run-text">
                <summary>{l("Expected output", "期望输出")}</summary>
                <pre>{result.expectedOutput}</pre>
              </details>
            ) : null}
            <details className="eval-run-text" open={result.scores.some((score) => !score.passed)}>
              <summary>{l("Actual output", "实际输出")}</summary>
              <pre>{result.output || l("(empty)", "（空）")}</pre>
            </details>
            {result.scores.map((score) => (
              <div key={score.evaluatorId} className="eval-run-score">
                <header>
                  <span className="eval-run-score-name">{evaluatorNames.get(score.evaluatorId) ?? score.evaluatorId}</span>
                  <span className={`eval-badge ${score.passed ? "eval-badge-ok" : "eval-badge-warn"}`}>
                    {score.score.toFixed(2)}{score.passed ? "" : ` · ${l("below threshold", "未达标")}`}
                  </span>
                </header>
                {score.reason ? <p className="eval-run-score-reason">{score.reason}</p> : null}
                {score.failedCriteria && score.failedCriteria.length > 0 ? (
                  <ul className="eval-run-score-criteria">
                    {score.failedCriteria.map((criteria) => <li key={criteria}>{criteria}</li>)}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
