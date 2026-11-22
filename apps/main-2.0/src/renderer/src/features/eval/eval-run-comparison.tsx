import type { ReactElement } from "react";
import { X } from "lucide-react";

import type { EvaluationCaseResult, EvaluationRun } from "../../../../automation/contracts";
import { localize, type LanguageMode } from "../../language";
import { deltaBadgeClass, deltaReading, deltaTitle, widerBand, type DeltaReading } from "./eval-delta-reading";
import { dimensionGroups } from "./eval-dimension-card";

// Side-by-side comparison of two runs of the same suite. Case results pair by
// dataset item + repetition; the view presents per-case facts (score deltas,
// both outputs) and never turns them into advice. A delta is read against the
// spread the same case showed across its own repetitions, so ordinary variation
// is not reported as a regression.
export function RunComparison({
  language,
  base,
  compare,
  stages,
  onClose,
}: {
  language: LanguageMode;
  base: EvaluationRun;
  compare: EvaluationRun;
  /** The plan's declared stages, whose order is the order of the groups. */
  stages: ReadonlyArray<{ id: string; name: string }>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  // The case's own weighted score, not a flat mean of its evaluator rows: the
  // header delta compares averageScore, which is weighted, so a flat mean here
  // would put the two deltas in different units and disagree with the run page.
  const caseScore = (result: EvaluationCaseResult | undefined): number | null =>
    result?.score ?? null;
  const pairKey = (result: { datasetItemId: string; repetition: number }) =>
    `${result.datasetItemId}:${result.repetition}`;
  const baseByKey = new Map(base.results.map((result) => [pairKey(result), result]));
  const compareByKey = new Map(compare.results.map((result) => [pairKey(result), result]));
  const keys = [
    ...base.results.map(pairKey),
    ...compare.results.map(pairKey).filter((key) => !baseByKey.has(key)),
  ];
  const sameVersion = Boolean(base.skillHash && base.skillHash === compare.skillHash);
  // A score delta measures the subject only when the same rubric produced both
  // scores. Runs from before rubric attribution cannot say either way, so an
  // unrecorded standard gets a weaker note than a confirmed change.
  const rubricRecorded = Boolean(base.rubricHash && compare.rubricHash);
  const rubricChanged = rubricRecorded && base.rubricHash !== compare.rubricHash;
  // The rubric says what was asked for; this says how the answers were totalled.
  // Two runs of an unchanged plan can still be incomparable, because the scoring
  // underneath the stored numbers changed — and unlike a rubric edit, nothing the
  // user did shows up in the plan to explain it.
  const scoringRecorded = base.scoringVersion != null && compare.scoringVersion != null;
  const scoringChanged = scoringRecorded && base.scoringVersion !== compare.scoringVersion;
  const unattributable = rubricChanged || scoringChanged;
  const totalDelta = base.averageScore != null && compare.averageScore != null
    ? compare.averageScore - base.averageScore
    : null;
  const runBand = widerBand(
    base.consistency?.meanSpread ?? null,
    compare.consistency?.meanSpread ?? null,
  );
  // A case's own band, from whichever run repeated it enough to score. Null means
  // fewer than two scored repetitions on both sides, so its delta cannot be read.
  const bandOf = (datasetItemId: string): number | null => {
    const spreadIn = (run: EvaluationRun): number | null =>
      run.consistency?.entries.find((entry) => entry.datasetItemId === datasetItemId)?.spread ?? null;
    return widerBand(spreadIn(base), spreadIn(compare));
  };
  const totalReading: DeltaReading = totalDelta !== null
    ? deltaReading(totalDelta, runBand)
    : "unmeasured";
  // Union of both runs' dimensions in the base run's order. A dimension only one
  // side scored still has to appear: dropping it would read as "no change".
  const dimensionNames = [
    ...(base.dimensions ?? []).map((entry) => entry.dimension),
    ...(compare.dimensions ?? [])
      .map((entry) => entry.dimension)
      .filter((name) => !(base.dimensions ?? []).some((entry) => entry.dimension === name)),
  ];
  const pairedCount = keys.filter((key) => baseByKey.has(key) && compareByKey.has(key)).length;
  const baseOnlyCount = keys.filter((key) => baseByKey.has(key) && !compareByKey.has(key)).length;
  const compareOnlyCount = keys.filter((key) => !baseByKey.has(key)).length;
  const repeatedCount = Math.max(
    base.consistency?.repeatedCaseCount ?? 0,
    compare.consistency?.repeatedCaseCount ?? 0,
  );
  // Which stage a dimension judged, read from whichever run tagged it: a dimension
  // only one side scored still belongs to the stage that side put it in.
  const stageOf = (name: string): string | undefined =>
    (base.dimensions ?? []).find((entry) => entry.dimension === name)?.stage
    ?? (compare.dimensions ?? []).find((entry) => entry.dimension === name)?.stage;
  const stageGroups = dimensionGroups(language, dimensionNames, stageOf, stages).map((group) => {
    const totalIn = (run: EvaluationRun) => group.stage === undefined
      ? undefined
      : (run.stageScores ?? []).find((entry) => entry.stage === group.stage);
    const fromBase = totalIn(base);
    const fromCompare = totalIn(compare);
    return {
      group,
      fromBase,
      fromCompare,
      delta: fromBase?.score != null && fromCompare?.score != null
        ? fromCompare.score - fromBase.score
        : null,
    };
  });
  const stageTotalUnrecorded = stageGroups.some(
    ({ group, fromBase, fromCompare }) =>
      group.stage !== undefined && (fromBase === undefined || fromCompare === undefined),
  );
  const dimensionRow = (name: string): ReactElement => {
    const fromBase = (base.dimensions ?? []).find((entry) => entry.dimension === name);
    const fromCompare = (compare.dimensions ?? []).find((entry) => entry.dimension === name);
    const delta = fromBase?.score != null && fromCompare?.score != null
      ? fromCompare.score - fromBase.score
      : null;
    const reading: DeltaReading = delta !== null
      ? deltaReading(delta, runBand)
      : "unmeasured";
    const weight = fromCompare?.weight ?? fromBase?.weight ?? 1;
    const weightChanged = fromBase !== undefined && fromCompare !== undefined
      && fromBase.weight !== fromCompare.weight;
    return (
      <li key={name} className="eval-comparison-dimension-row">
        <span className="eval-comparison-dimension-name">
          {name}
          {weightChanged ? (
            <span className="eval-muted">
              {` · ${l("weight", "权重")} ${fromBase?.weight} → ${fromCompare?.weight}`}
            </span>
          ) : weight !== 1 ? (
            <span className="eval-muted">{` · ${l("weight", "权重")} ${weight}`}</span>
          ) : null}
        </span>
        <span
          className="eval-comparison-dimension-scores"
          title={l(
            `Averaged over the cases that scored this dimension: ${fromBase?.scoredCaseCount ?? 0} in the base run, ${fromCompare?.scoredCaseCount ?? 0} in the compare run.`,
            `按为该维度打了分的用例求平均：基准运行 ${fromBase?.scoredCaseCount ?? 0} 个，对比运行 ${fromCompare?.scoredCaseCount ?? 0} 个。`,
          )}
        >
          {fromBase?.score != null ? fromBase.score.toFixed(2) : "—"}
          {" → "}
          {fromCompare?.score != null ? fromCompare.score.toFixed(2) : "—"}
          {` · n=${fromCompare?.scoredCaseCount ?? 0}`}
        </span>
        {delta != null ? (
          <span
            className={`eval-badge ${unattributable ? "eval-badge-dim" : deltaBadgeClass(reading)}`}
            title={deltaTitle(reading, runBand, l)}
          >
            {delta > 0 ? "+" : ""}{delta.toFixed(2)}
          </span>
        ) : !fromBase ? (
          <span className="eval-badge eval-badge-dim">{l("Only in compare run", "仅对比运行存在")}</span>
        ) : !fromCompare ? (
          <span className="eval-badge eval-badge-dim">{l("Only in base run", "仅基准运行存在")}</span>
        ) : (
          <span
            className="eval-badge eval-badge-dim"
            title={l(
              "One side decided nothing for this dimension, so there is no delta to read.",
              "其中一次运行没有为这个维度得出结论，所以没有涨跌可判读。",
            )}
          >
            {l("Not decided", "未判定")}
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="eval-run-comparison">
      <header className="eval-run-comparison-header">
        <span className="eval-run-case-title">{l("Run comparison", "运行对比")}</span>
        {sameVersion ? (
          <span className="eval-badge eval-badge-dim">{l("Same skill version", "同一 Skill 版本")}</span>
        ) : (
          <span className="eval-badge eval-badge-current">
            {(base.skillHash ?? "?").slice(0, 8)} → {(compare.skillHash ?? "?").slice(0, 8)}
          </span>
        )}
        {rubricChanged ? (
          <span className="eval-badge eval-badge-warn">{l("Rubric changed", "评分标准已变更")}</span>
        ) : rubricRecorded ? (
          <span className="eval-badge eval-badge-dim">{l("Same rubric", "同一评分标准")}</span>
        ) : (
          <span className="eval-badge eval-badge-dim">{l("Rubric not recorded", "评分标准未记录")}</span>
        )}
        {scoringChanged ? (
          <span className="eval-badge eval-badge-warn">{l("Scoring changed", "计分口径已变更")}</span>
        ) : null}
        {!scoringRecorded ? (
          <span className="eval-badge eval-badge-dim">
            {l("Scoring not recorded", "计分口径未记录")}
          </span>
        ) : null}
        {stageTotalUnrecorded ? (
          <span
            className="eval-badge eval-badge-dim"
            title={l(
              "One of the two runs was scored before a stage total was recorded, so that stage shows no difference rather than no change.",
              "两次运行中有一次是在记录阶段总分之前评的，所以那个阶段显示的是没有差值，而不是没有变化。",
            )}
          >
            {l("Stage totals not recorded", "阶段总分未记录")}
          </span>
        ) : null}
        {totalDelta != null ? (
          <span
            className={`eval-badge ${unattributable ? "eval-badge-dim" : deltaBadgeClass(totalReading)}`}
            title={deltaTitle(totalReading, runBand, l)}
          >
            {l("avg score", "平均分")} {totalDelta >= 0 ? "+" : ""}{totalDelta.toFixed(2)}
          </span>
        ) : null}
        <button type="button" className="eval-run-button" onClick={onClose} aria-label={l("Close comparison", "关闭对比")}>
          <X size={12} />{l("Close", "关闭")}
        </button>
      </header>
      {rubricChanged ? (
        <p className="eval-muted">
          {l(
            "The two runs were scored by different rubrics, so the differences below are not attributable to the subject alone.",
            "两次运行使用的评分标准不同，下面的分数差异不能只归因于被测对象。",
          )}
        </p>
      ) : null}
      {scoringChanged ? (
        <p className="eval-muted">
          {l(
            "The two runs were totalled by different scoring rules, so a difference below can come from the arithmetic itself. The plan was not edited: the way its weights are combined changed between the two runs.",
            "两次运行是用不同的计分口径汇总出来的，下面的涨跌可能来自算法本身。方案没有被改过：是两次运行之间，权重的合并方式变了。",
          )}
        </p>
      ) : null}
      {keys.length > 0 ? (
        <p className="eval-muted">
          {runBand === null ? l(
            "Neither run scored the same case more than once, so there is no repeat spread to judge against: the differences below cannot be told apart from ordinary variation.",
            "两次运行都没有把同一个用例评分两次以上，没有可参照的重复波动，下面的涨跌分不清是本次改动带来的还是本来就有的抖动。",
          ) : l(
            `A delta counts as an improvement or a regression only past ±${runBand.toFixed(2)}, the mean of each case's own gap across its repetitions; anything inside that is treated as variation.`,
            `涨跌只有超过 ±${runBand.toFixed(2)}（各用例自身重复次之间分差的均值）才算改进或回归，带内一律按波动处理。`,
          )}
        </p>
      ) : null}
      {keys.length > 0 ? (
        <p className="eval-muted eval-comparison-sample">
          <span title={l(
            "Case results present in both runs. Every per-case delta below rests on these alone.",
            "两次运行都有的用例结果。下面每个用例的涨跌只建立在这些之上。",
          )}>
            {l(`${pairedCount} paired case(s)`, `${pairedCount} 个配对用例`)}
          </span>
          {repeatedCount > 0 ? (
            <span title={l(
              "Cases scored more than once in at least one of the two runs. That repetition is where the spread above comes from.",
              "两次运行中至少有一次评分过不止一遍的用例。上面的波动带就来自这些重复。",
            )}>
              {l(`${repeatedCount} ran more than once`, `${repeatedCount} 个跑了不止一次`)}
            </span>
          ) : null}
          {base.unscoredCaseCount ? (
            <span title={l(
              "Cases the base run decided nothing for. They are left out of its average rather than counted as zero.",
              "基准运行没有得出结论的用例。它们被排除在平均分之外，而不是按 0 分计入。",
            )}>
              {l(`base left ${base.unscoredCaseCount} unscored`, `基准有 ${base.unscoredCaseCount} 个未评分`)}
            </span>
          ) : null}
          {compare.unscoredCaseCount ? (
            <span title={l(
              "Cases the compare run decided nothing for. They are left out of its average rather than counted as zero.",
              "对比运行没有得出结论的用例。它们被排除在平均分之外，而不是按 0 分计入。",
            )}>
              {l(`compare left ${compare.unscoredCaseCount} unscored`, `对比有 ${compare.unscoredCaseCount} 个未评分`)}
            </span>
          ) : null}
          {baseOnlyCount > 0 ? (
            <span>{l(`${baseOnlyCount} only in base`, `${baseOnlyCount} 个仅基准运行有`)}</span>
          ) : null}
          {compareOnlyCount > 0 ? (
            <span>{l(`${compareOnlyCount} only in compare`, `${compareOnlyCount} 个仅对比运行有`)}</span>
          ) : null}
        </p>
      ) : null}
      {dimensionNames.length > 0 ? (
        <div className="eval-comparison-dimensions">
          <span
            className="eval-comparison-section-title"
            title={l(
              "Each dimension's average over the cases that scored it, read against the same repeat spread as the total: there is no per-dimension spread, and no per-stage one either.",
              "每个维度在已评分用例上的平均分，判读用的是与总分相同的重复波动带——维度本身没有单独的波动数据，阶段也没有。",
            )}
          >
            {l("By dimension", "按维度")}
          </span>
          {stageGroups.map(({ group, fromBase, fromCompare, delta }) => {
            const reading: DeltaReading = delta !== null
              ? deltaReading(delta, runBand)
              : "unmeasured";
            return (
              <section key={group.key} className="eval-comparison-stage-group">
                {group.label ? (
                  <h6 className="eval-comparison-stage-name">
                    <span>{group.label}</span>
                    {group.stage ? (
                      <span
                        className="eval-comparison-stage-total"
                        title={l(
                          `Weighted over the dimensions that scored this stage: ${fromBase?.scoredDimensionCount ?? 0} of ${fromBase?.dimensionCount ?? 0} in the base run, ${fromCompare?.scoredDimensionCount ?? 0} of ${fromCompare?.dimensionCount ?? 0} in the compare run.`,
                          `按该阶段里打出分的维度加权：基准运行 ${fromBase?.scoredDimensionCount ?? 0}/${fromBase?.dimensionCount ?? 0} 条，对比运行 ${fromCompare?.scoredDimensionCount ?? 0}/${fromCompare?.dimensionCount ?? 0} 条。`,
                        )}
                      >
                        {fromBase?.score != null ? fromBase.score.toFixed(2) : "—"}
                        {" → "}
                        {fromCompare?.score != null ? fromCompare.score.toFixed(2) : "—"}
                      </span>
                    ) : null}
                    {delta != null ? (
                      <span
                        className={`eval-badge ${unattributable ? "eval-badge-dim" : deltaBadgeClass(reading)}`}
                        title={deltaTitle(reading, runBand, l)}
                      >
                        {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                      </span>
                    ) : null}
                  </h6>
                ) : null}
                <ul className="eval-comparison-dimension-list">
                  {group.items.map(dimensionRow)}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="eval-muted">{l("Neither run recorded case results.", "两次运行都没有用例结果。")}</p>
      ) : keys.map((key) => {
        const baseResult = baseByKey.get(key);
        const compareResult = compareByKey.get(key);
        const present = baseResult ?? compareResult;
        if (!present) return null;
        const baseScore = caseScore(baseResult);
        const compareScore = caseScore(compareResult);
        const delta = baseScore != null && compareScore != null ? compareScore - baseScore : null;
        const band = bandOf(present.datasetItemId);
        const reading: DeltaReading = delta !== null ? deltaReading(delta, band) : "unmeasured";
        return (
          <div key={key} className="eval-run-case">
            <header className="eval-run-case-header">
              <span className="eval-run-case-title">
                {present.input.length > 60 ? `${present.input.slice(0, 60)}…` : present.input}
              </span>
              {delta != null ? (
                <span
                  className={`eval-badge ${unattributable ? "eval-badge-dim" : deltaBadgeClass(reading)}`}
                  title={deltaTitle(reading, band, l)}
                >
                  {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                </span>
              ) : !baseResult ? (
                <span className="eval-badge eval-badge-dim">{l("Only in compare run", "仅对比运行存在")}</span>
              ) : !compareResult ? (
                <span className="eval-badge eval-badge-dim">{l("Not re-run", "未在对比运行中重跑")}</span>
              ) : (
                <span
                  className="eval-badge eval-badge-dim"
                  title={compareResult.unscoredReason ?? baseResult.unscoredReason ?? l(
                    "One side recorded no score for this case.",
                    "其中一次运行没有为这个用例记下分数。",
                  )}
                >
                  {l("Not scored", "未评分")}
                </span>
              )}
            </header>
            <div className="eval-run-compare-columns">
              <details className="eval-run-text">
                <summary>
                  {l("Base output", "基准输出")}
                  {baseScore != null ? ` · ${baseScore.toFixed(2)}` : ""}
                </summary>
                <pre>{baseResult ? baseResult.output || l("(empty)", "（空）") : l("(not run)", "（未运行）")}</pre>
              </details>
              <details className="eval-run-text">
                <summary>
                  {l("Compare output", "对比输出")}
                  {compareScore != null ? ` · ${compareScore.toFixed(2)}` : ""}
                </summary>
                <pre>{compareResult ? compareResult.output || l("(empty)", "（空）") : l("(not run)", "（未运行）")}</pre>
              </details>
            </div>
          </div>
        );
      })}
    </div>
  );
}
