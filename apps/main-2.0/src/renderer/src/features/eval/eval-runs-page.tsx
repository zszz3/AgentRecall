import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import type {
  EvaluationExperiment,
  EvaluationEvaluator,
  EvaluationNodeRecord,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../automation/contracts";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { EvalCaseArtifact } from "./eval-case-artifact";
import { EvalDimensionCard } from "./eval-dimension-card";
import {
  formatDuration,
  formatRatio,
  nodeLabel,
  nodeReasonText,
  nodeStatusClass,
  nodeStatusText,
  runStatusClass,
  runStatusText,
  skillUseText,
} from "./eval-format";

/**
 * Run history with each case's execution graph.
 *
 * What a score alone cannot say is which step produced the result and which
 * steps never ran: a run whose judge had no Runtime channel and a run whose
 * agent answered badly used to read as the same low number, and here they are
 * two visibly different graphs.
 */
export function EvalRunsPage({
  language,
  onOpenSession,
  initialRunId,
  onInitialRunConsumed,
}: {
  language: LanguageMode;
  onOpenSession: (sessionKey: string) => void;
  initialRunId?: string;
  onInitialRunConsumed?: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [runs, setRuns] = useState<EvaluationRunSummary[] | null>(null);
  const [experiments, setExperiments] = useState<EvaluationExperiment[] | null>(null);
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[] | null>(null);
  const [runTotals, setRunTotals] = useState<Map<string, number>>(new Map());
  const [expandedExperimentIds, setExpandedExperimentIds] = useState<Set<string>>(new Set());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedRunIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!initialRunId) return;
    requestedRunIdRef.current = initialRunId;
    setSelectedRunId(initialRunId);
    onInitialRunConsumed?.();
  }, [initialRunId, onInitialRunConsumed]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [experimentList, evaluatorList] = await Promise.all([
        window.sessionSearch.automation.listEvaluationExperiments(),
        window.sessionSearch.automation.listEvaluationEvaluators(),
      ]);
      // Fetch per task: one very active task must not consume a global page and
      // make every other task look as though it has no history.
      const pages = await Promise.all(experimentList.map((experiment: EvaluationExperiment) => (
        window.sessionSearch.automation.listEvaluationRuns({
          experimentId: experiment.id,
          limit: 50,
        })
      )));
      const nextRuns = pages
        .flatMap((page) => page.items)
        .sort((left, right) => right.startedAt - left.startedAt);
      setRuns(nextRuns);
      setExperiments(experimentList);
      setEvaluators(evaluatorList);
      setRunTotals(new Map(
        experimentList.map((experiment: EvaluationExperiment, index: number) => (
          [experiment.id, pages[index]?.total ?? 0]
        )),
      ));
      setSelectedRunId((current) => (
        current && (nextRuns.some((item) => item.id === current) || current === requestedRunIdRef.current)
          ? current
          : nextRuns[0]?.id ?? null
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const experimentNames = new Map(
    (experiments ?? []).map((item) => [item.id, item.name || item.id]),
  );

  const remove = useCallback(async (run: EvaluationRunSummary) => {
    if (!window.confirm(l(
      `Delete this run of "${experimentNames.get(run.experimentId) ?? run.experimentId}"? Its per-case records go with it.`,
      `删除「${experimentNames.get(run.experimentId) ?? run.experimentId}」的这次运行？它的逐用例记录会一起删除。`,
    ))) {
      return;
    }
    setError(null);
    try {
      await window.sessionSearch.automation.deleteEvaluationRun(run.id);
      // Clearing the selection first: keeping a deleted id selected would ask for
      // a run that no longer exists.
      setSelectedRunId((current) => (current === run.id ? null : current));
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [experimentNames, l, reload]);

  useEffect(() => {
    const experimentId = runs?.find((item) => item.id === selectedRunId)?.experimentId;
    if (!experimentId) return;
    setExpandedExperimentIds((current) => {
      if (current.has(experimentId)) return current;
      return new Set([...current, experimentId]);
    });
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    setLoadingRun(true);
    void (async () => {
      try {
        const next = await window.sessionSearch.automation.getEvaluationRun(selectedRunId);
        if (!cancelled) {
          setRun(next ?? null);
          if (selectedRunId === requestedRunIdRef.current) requestedRunIdRef.current = undefined;
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoadingRun(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  return (
    <div className="eval-graph-page">
      <header className="eval-graph-header">
        <h4><History size={14} /> {l("Runs", "运行")}</h4>
        <button type="button" className="eval-run-button" onClick={() => void reload()}>
          <RefreshCw size={13} />{l("Refresh", "刷新")}
        </button>
      </header>
      {error ? <p className="eval-error" role="alert">{error}</p> : null}
      <div className="eval-graph-body">
        <ul className="eval-graph-run-list" aria-label={l("Evaluation tasks", "评测任务")}>
          {runs === null || experiments === null || evaluators === null ? (
            <li className="eval-muted">{l("Loading...", "加载中...")}</li>
          ) : experiments.length === 0 ? (
            <li className="eval-muted">{l("No evaluation tasks yet.", "还没有评测任务。")}</li>
          ) : experiments.map((experiment) => {
            const taskRuns = runs.filter((item) => item.experimentId === experiment.id);
            const total = runTotals.get(experiment.id) ?? taskRuns.length;
            const expanded = expandedExperimentIds.has(experiment.id);
            const containsSelection = taskRuns.some((item) => item.id === selectedRunId);
            const runsId = `eval-task-runs-${experiment.id}`;
            return (
              <li
                key={experiment.id}
                className={`eval-run-task-group ${containsSelection ? "contains-selection" : ""}`}
                data-eval-task-id={experiment.id}
              >
                <button
                  type="button"
                  className="eval-run-task-toggle"
                  aria-expanded={expanded}
                  aria-controls={runsId}
                  onClick={() => setExpandedExperimentIds((current) => {
                    const next = new Set(current);
                    if (next.has(experiment.id)) next.delete(experiment.id);
                    else next.add(experiment.id);
                    return next;
                  })}
                >
                  <span className="eval-run-task-title">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>{experiment.name || experiment.id}</span>
                  </span>
                  <span className="eval-run-task-count">
                    {l(total === 1 ? "1 run" : `${total} runs`, `${total} 次`)}
                  </span>
                </button>
                {expanded ? (
                  <ul id={runsId} className="eval-run-task-runs">
                    {taskRuns.length === 0 ? (
                      <li className="eval-run-task-empty">
                        {l("No runs yet.", "还没有运行记录。")}
                      </li>
                    ) : taskRuns.map((item, index) => (
                      <li
                        key={item.id}
                        className="eval-graph-run-item"
                        data-eval-run-id={item.id}
                      >
                        <button
                          type="button"
                          className={`eval-graph-run-row ${item.id === selectedRunId ? "active" : ""}`}
                          onClick={() => setSelectedRunId(item.id)}
                        >
                          <span className="eval-graph-run-name">
                            {l(`Run ${total - index}`, `第 ${total - index} 次运行`)}
                          </span>
                          <span className="eval-graph-run-meta">
                            <span className={`eval-badge ${runStatusClass(item.status)}`}>
                              {runStatusText(language, item.status)}
                            </span>
                            <span className="eval-muted">{formatRelativeTime(item.startedAt, language)}</span>
                            {item.engine === undefined ? (
                              <span className="eval-badge eval-badge-dim">{l("legacy", "旧格式")}</span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="eval-icon-button"
                          aria-label={l("Delete run", "删除运行")}
                          onClick={() => void remove(item)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </li>
                    ))}
                    {total > taskRuns.length ? (
                      <li className="eval-run-task-empty">
                        {l(
                          `Showing the latest ${taskRuns.length} of ${total}.`,
                          `显示最近 ${taskRuns.length} / ${total} 次。`,
                        )}
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="eval-graph-detail">
          {loadingRun ? <p className="eval-muted">{l("Loading...", "加载中...")}</p>
            : !run ? <p className="eval-muted">{l("Select a run.", "选择一次运行。")}</p>
            : (
              <RunGraph
                language={language}
                run={run}
                experiment={experiments?.find((item) => item.id === run.experimentId)}
                evaluators={evaluators ?? []}
                onOpenSession={onOpenSession}
              />
            )}
        </div>
      </div>
    </div>
  );
}

function RunGraph({
  language,
  run,
  experiment,
  evaluators,
  onOpenSession,
}: {
  language: LanguageMode;
  run: EvaluationRun;
  experiment?: EvaluationExperiment;
  evaluators: EvaluationEvaluator[];
  onOpenSession: (sessionKey: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [selectedDimension, setSelectedDimension] = useState<string | null>(null);
  const threshold = experiment?.scoring?.resolvedThreshold ?? 0.6;
  const evaluatorNames = new Map(evaluators.map((item) => [item.id, item.name || item.id]));
  const evaluatorDimensions = new Map(
    evaluators.map((item) => [item.id, item.dimension?.trim() || item.name.trim() || item.id]),
  );

  useEffect(() => {
    setSelectedDimension(null);
  }, [run.id]);
  return (
    <>
      <div className="eval-graph-summary">
        <span className={`eval-badge ${runStatusClass(run.status)}`}>
          {runStatusText(language, run.status)}
        </span>
        <span>{l("pass", "通过")} {formatRatio(run.passRate ?? null)}</span>
        <span>{l("average", "平均分")} {run.averageScore !== undefined ? run.averageScore.toFixed(2) : "—"}</span>
        {run.scoredCaseCount !== undefined ? (
          <span>{l("scored", "已评分")} {run.scoredCaseCount}</span>
        ) : null}
        {run.unscoredCaseCount ? (
          <span className="eval-badge eval-badge-dim">
            {l("not scored", "未评分")} {run.unscoredCaseCount}
          </span>
        ) : null}
        {run.coverage !== undefined ? (
          <span title={l(
            "Share of the planned judging that actually decided.",
            "计划中的判定里真正得出结论的比例。",
          )}>
            {l("coverage", "覆盖率")} {formatRatio(run.coverage)}
          </span>
        ) : null}
        {run.skillHash ? (
          <span className="eval-muted">Skill @{run.skillHash.slice(0, 8)}</span>
        ) : null}
        <span className="eval-muted">{formatDuration(run.totalDurationMs ?? null)}</span>
      </div>
      {/* The same cards the plan page shows, so a run reads in the same units. */}
      {run.dimensions?.length ? (
        <div className="eval-dimension-cards">
          {run.dimensions.map((dimension) => (
            <EvalDimensionCard
              key={dimension.dimension}
              language={language}
              selected={selectedDimension === dimension.dimension}
              onClick={() => setSelectedDimension((current) => (
                current === dimension.dimension ? null : dimension.dimension
              ))}
              data={{
                dimension: dimension.dimension,
                score: dimension.score,
                weight: dimension.weight,
                threshold,
                method: l(
                  `${dimension.scoredCaseCount} case(s) · click for reasons`,
                  `${dimension.scoredCaseCount} 个用例 · 点击查看原因`,
                ),
              }}
            />
          ))}
        </div>
      ) : null}
      {selectedDimension ? (
        <DimensionDiagnostics
          language={language}
          run={run}
          dimension={selectedDimension}
          evaluatorNames={evaluatorNames}
          evaluatorDimensions={evaluatorDimensions}
          onClose={() => setSelectedDimension(null)}
        />
      ) : null}
      {run.error ? <p className="eval-error" role="alert">{run.error}</p> : null}
      {run.engine === undefined ? (
        <p className="eval-muted">
          <AlertTriangle size={12} />{" "}
          {l(
            "This run predates the execution graph, so it has no step records. Run the experiment again to see its graph.",
            "这次运行早于执行图，没有步骤记录。重新跑一次该实验即可看到执行图。",
          )}
        </p>
      ) : run.results.length === 0 ? (
        <p className="eval-muted">{l("No cases were recorded.", "没有记录到用例。")}</p>
      ) : (
        <ol className="eval-graph-cases">
          {run.results.map((result, index) => {
            const unscored = result.unscoredReason !== undefined;
            // The dimension-weighted verdict decides, when the run recorded one:
            // a case can clear its threshold with one check unmet, and reading
            // "every check passed" would contradict the score shown beside it.
            const passed = !unscored && (result.passed ?? (
              result.gatePassed !== false
              && result.scores.length > 0
              && result.scores.every((score) => score.passed)
            ));
            return (
              <li key={result.id} className="eval-graph-case">
                <header>
                  <span className="eval-graph-case-title">
                    {l(`Case ${index + 1}`, `用例 ${index + 1}`)}
                    {run.results.filter((item) => item.datasetItemId === result.datasetItemId).length > 1
                      ? ` · #${result.repetition}`
                      : ""}
                  </span>
                  <span className={`eval-badge ${unscored ? "eval-badge-dim" : passed ? "eval-badge-ok" : "eval-badge-warn"}`}>
                    {unscored ? l("Not scored", "未评分") : passed ? l("Passed", "通过") : l("Failed", "未通过")}
                  </span>
                  {result.skillInjection ? (
                    <span className="eval-muted" title={result.skillInjection.skillHash}>
                      Skill {result.skillInjection.skillName}@{result.skillInjection.skillHash.slice(0, 8)}
                    </span>
                  ) : null}
                </header>
                <p className="eval-graph-case-input">{result.input}</p>
                <EvalCaseArtifact
                  language={language}
                  result={result}
                  onOpenSession={onOpenSession}
                />
                {result.score !== undefined || result.coverage !== undefined ? (
                  <p className="eval-graph-case-score">
                    {result.score !== undefined ? (
                      <span>{l("score", "得分")} {result.score.toFixed(2)}</span>
                    ) : null}
                    {result.coverage !== undefined ? (
                      <span className="eval-muted">
                        {l("coverage", "覆盖率")} {formatRatio(result.coverage)}
                      </span>
                    ) : null}
                    {result.dimensions?.map((dimension) => (
                      <span
                        key={dimension.dimension}
                        className={`eval-badge ${dimension.unmet > 0 ? "eval-badge-warn" : dimension.score === null ? "eval-badge-dim" : "eval-badge-ok"}`}
                        title={l(
                          `${dimension.met} met, ${dimension.unmet} unmet, ${dimension.undecided} undecided`,
                          `${dimension.met} 项达成、${dimension.unmet} 项未达成、${dimension.undecided} 项未判定`,
                        )}
                      >
                        {dimension.dimension}
                        {" "}
                        {dimension.score === null ? "—" : dimension.score.toFixed(2)}
                      </span>
                    ))}
                  </p>
                ) : null}
                {result.skippedEvaluatorIds?.length ? (
                  <p className="eval-muted">
                    {l(
                      "Not applicable to this source, so it never ran",
                      "不适用于该产物来源，因此没有执行",
                    )}
                    {" · "}
                    {result.skippedEvaluatorIds.join(", ")}
                  </p>
                ) : null}
                {unscored ? (
                  <p className="eval-muted">
                    {l("Nothing was decided", "没有得出任何结论")}
                    {" · "}{nodeReasonText(language, result.unscoredReason!)}
                  </p>
                ) : null}
                {result.nodes?.length ? (
                  <ol className="eval-graph-nodes">
                    {result.nodes.map((node) => (
                      <GraphNodeRow key={node.nodeId} language={language} node={node} />
                    ))}
                  </ol>
                ) : (
                  <p className="eval-muted">{l("No step records.", "没有步骤记录。")}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/**
 * The explanation behind one run-level dimension score.
 *
 * The run card is an average; reasons and evidence belong to the individual
 * verdicts that produced it. This view keeps that boundary visible by grouping
 * the selected dimension by case, then listing the exact checks beneath it.
 */
function DimensionDiagnostics({
  language,
  run,
  dimension,
  evaluatorNames,
  evaluatorDimensions,
  onClose,
}: {
  language: LanguageMode;
  run: EvaluationRun;
  dimension: string;
  evaluatorNames: ReadonlyMap<string, string>;
  evaluatorDimensions: ReadonlyMap<string, string>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const runDimension = run.dimensions?.find((item) => item.dimension === dimension);
  const cases = run.results.map((result, index) => {
    const aggregate = result.dimensions?.find((item) => item.dimension === dimension);
    const scores = result.scores.filter(
      (score) => (score.dimension ?? evaluatorDimensions.get(score.evaluatorId)) === dimension,
    );
    const skipped = (result.skippedEvaluatorIds ?? []).filter(
      (id) => evaluatorDimensions.get(id) === dimension,
    );
    // A judge node can emit several dimensions. Only use its node-level failure
    // when the entire case was undecided; otherwise it could be mistaken for the
    // reason a different dimension failed.
    const judgeFailures = result.unscoredReason
      ? (result.nodes ?? []).filter((node) => (
        node.role === "judge"
        && node.status !== "pass"
        && node.status !== "pending"
      ))
      : [];
    return { result, index, aggregate, scores, skipped, judgeFailures };
  }).filter((item) => (
    item.aggregate !== undefined
    || item.scores.length > 0
    || item.skipped.length > 0
    || item.result.unscoredReason !== undefined
  ));

  return (
    <section className="eval-dimension-diagnostics" aria-label={l(
      `${dimension} diagnosis`,
      `${dimension} 失败诊断`,
    )}>
      <header>
        <div>
          <h5>{dimension}</h5>
          <p>
            {runDimension?.score === null || runDimension?.score === undefined
              ? l("No score was produced for this dimension.", "这个维度没有得出分数。")
              : l(
                `Run average ${runDimension.score.toFixed(2)} from ${runDimension.scoredCaseCount} scored case(s).`,
                `本次平均分 ${runDimension.score.toFixed(2)}，来自 ${runDimension.scoredCaseCount} 个已评分用例。`,
              )}
          </p>
        </div>
        <button type="button" className="eval-icon-button" aria-label={l("Close diagnosis", "关闭诊断")} onClick={onClose}>
          <X size={12} />
        </button>
      </header>
      {cases.length === 0 ? (
        <p className="eval-muted">
          {l(
            "This older run has a dimension score but no stored per-check reasons.",
            "这条旧运行只有维度分数，没有保存逐检查的失败原因。",
          )}
        </p>
      ) : (
        <ol className="eval-dimension-diagnostic-cases">
          {cases.map(({ result, index, aggregate, scores, skipped, judgeFailures }) => {
            const state = aggregate === undefined || aggregate.score === null
              ? "undecided"
              : aggregate.unmet > 0 ? "unmet" : "met";
            return (
              <li key={result.id} className={`is-${state}`}>
                <header>
                  <span>{l(`Case ${index + 1}`, `用例 ${index + 1}`)}</span>
                  <span className={`eval-badge ${state === "met" ? "eval-badge-ok" : state === "unmet" ? "eval-badge-warn" : "eval-badge-dim"}`}>
                    {aggregate?.score === null || aggregate?.score === undefined
                      ? l("Not decided", "未判定")
                      : `${aggregate.score.toFixed(2)} · ${state === "met" ? l("Met", "达标") : l("Unmet", "未达标")}`}
                  </span>
                </header>
                <p className="eval-dimension-diagnostic-input">{result.input}</p>
                {scores.length > 0 ? (
                  <ol className="eval-dimension-diagnostic-checks">
                    {scores.map((score, scoreIndex) => (
                      <li key={`${score.evaluatorId}:${score.dimension ?? ""}:${scoreIndex}`}>
                        <header>
                          <span>{evaluatorNames.get(score.evaluatorId) ?? score.evaluatorId}</span>
                          <span className={`eval-badge ${score.passed ? "eval-badge-ok" : "eval-badge-warn"}`}>
                            {score.score.toFixed(2)} · {score.passed ? l("Met", "达标") : l("Unmet", "未达标")}
                          </span>
                        </header>
                        <p className={score.reason ? "" : "eval-muted"}>
                          {score.reason ?? l(
                            "This check did not store a written reason.",
                            "这项检查没有保存文字原因。",
                          )}
                        </p>
                        {score.failedCriteria?.length ? (
                          <div className="eval-dimension-diagnostic-list is-failure">
                            <strong>{l("Failed criteria", "未满足项")}</strong>
                            <ul>{score.failedCriteria.map((item) => <li key={item}>{item}</li>)}</ul>
                          </div>
                        ) : null}
                        {score.evidence?.length ? (
                          <div className="eval-dimension-diagnostic-list">
                            <strong>{l("Evidence", "判断证据")}</strong>
                            <ul>{score.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="eval-muted">
                    {result.unscoredReason
                      ? `${l("No verdict was produced", "没有产出判定")} · ${nodeReasonText(language, result.unscoredReason)}`
                      : l("No stored check result for this dimension.", "这个维度没有保存逐检查结果。")}
                  </p>
                )}
                {skipped.length > 0 ? (
                  <p className="eval-muted">
                    {l("Skipped as not applicable", "因不适用而跳过")} · {skipped.map((id) => evaluatorNames.get(id) ?? id).join(", ")}
                  </p>
                ) : null}
                {scores.length === 0 && judgeFailures.length > 0 ? (
                  <ul className="eval-dimension-diagnostic-nodes">
                    {judgeFailures.map((node) => {
                      const reason = node.attribution?.reason ?? node.pendingReason;
                      return (
                        <li key={node.nodeId}>
                          {nodeLabel(language, node)}
                          {reason ? ` · ${nodeReasonText(language, reason)}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function GraphNodeRow({
  language,
  node,
}: {
  language: LanguageMode;
  node: EvaluationNodeRecord;
}): ReactElement {
  const reason = node.attribution?.reason ?? node.pendingReason;
  const skillUse = node.nodeType === "skill_use_observe" ? skillUseText(language, node.facts) : null;
  return (
    <li>
      <span className="eval-graph-node-name">{nodeLabel(language, node)}</span>
      <span className={`eval-badge ${nodeStatusClass(node.status)}`}>
        {nodeStatusText(language, node.status)}
      </span>
      <span className="eval-muted">
        {node.durationMs !== undefined ? formatDuration(node.durationMs) : ""}
      </span>
      <span className="eval-muted eval-graph-node-note">
        {[reason ? nodeReasonText(language, reason) : null, skillUse]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </li>
  );
}
