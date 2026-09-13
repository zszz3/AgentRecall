import { scorableVerdicts, type EvaluationCaseAggregate } from "./aggregate";
import type { EvaluationVerdict } from "./node";

/**
 * Turns neutral aggregates into scores, per dimension and then overall.
 *
 * Dimension-first on purpose. Averaging every verdict in one flat pass — which
 * is what web-eval does — means a dimension's influence grows with the number of
 * checks in it: adding a second correctness check quietly doubles correctness's
 * say while the configured weight still reads 0.4. Averaging inside a dimension
 * first keeps a declared weight meaning what it says.
 *
 * Four rules carry the rest:
 *   - a dimension with no decided verdict has no score, rather than a zero. The
 *     evaluation learned nothing about it, and a zero is indistinguishable from a
 *     judge that deliberately rejected the work;
 *   - the dimensions judging one stage share its weight, so hanging more checks
 *     on a stage does not buy that stage more say;
 *   - coverage reports how much of what was planned actually got decided, and a
 *     result must clear it to pass — otherwise a run that only managed one of
 *     four dimensions could still be reported as passing;
 *   - a gate failure scores 0 only when the agent is at fault. When every hard
 *     defect belongs to AgentRecall or a judge, the result is unscorable. Only
 *     0 → null is allowed, never a manufactured pass.
 */

export interface EvaluationScoringConfig {
  /**
   * Weight per label value, keyed by label. A verdict's weight is the product of
   * every matching entry, defaulting to 1 — so `{ priority: { should: 0.5 } }`
   * halves every "should" verdict without naming each dimension.
   */
  weightByLabels?: Record<string, Record<string, number>>;
  /** Score a result must reach to pass. Defaults to 0.6. */
  resolvedThreshold?: number;
  /** Coverage a result must reach to pass. Defaults to 0. */
  minCoverage?: number;
  /** What to do with a verdict the judge could not decide. Defaults to excluding it. */
  uncertain?: "exclude" | "zero";
  /**
   * Label values that are hard requirements. Every configured value must be
   * present and all matching verdicts must be met; a high soft score cannot
   * compensate for one of these failures.
   */
  requiredLabels?: Record<string, string[]>;
}

export interface EvaluationDimensionScore {
  dimension: string;
  /** Mean of the decided verdicts in this dimension; null when none decided. */
  score: number | null;
  /**
   * Weight as configured. Kept as declared rather than as applied so that two
   * runs of one plan can be compared weight by weight: this number moves only
   * when somebody edits the plan.
   */
  weight: number;
  /**
   * Share of the case score this dimension actually held. Absent when it equals
   * `weight` — which is always, for a plan whose dimensions judge no stage.
   */
  effectiveWeight?: number;
  /**
   * Stage every check in this dimension judges, as the id the plan declared.
   * Absent when the dimension has no stage, and when its checks disagree about
   * which one: a dimension split across stages scores as unstaged rather than
   * being folded into whichever stage was named first.
   */
  stage?: string;
  decided: number;
  /** Verdicts in this dimension the judge could not decide. */
  undecided: number;
  met: number;
  unmet: number;
}

export interface EvaluationCaseScore {
  caseId: string;
  /** Weighted mean across dimensions, 0..1; null when nothing was decided. */
  score: number | null;
  passed: boolean;
  gatePassed: boolean;
  /** Decided weight over planned weight, 0..1. */
  coverage: number;
  dimensions: EvaluationDimensionScore[];
  /** Every label key broken down by value, for reports that slice differently. */
  byLabel: Record<string, Record<string, number | null>>;
  decided: number;
  notDecided: number;
  /** Set when the result cannot be scored at all, naming why. */
  unscorableReason?: string;
}

export interface EvaluationRunScore {
  averageScore: number | null;
  minimumScore: number | null;
  /** Passed cases over scored cases; null when no case produced a score. */
  passRate: number | null;
  /** Mean coverage over the cases that were scorable. */
  coverage: number | null;
  scoredCaseCount: number;
  unscoredCaseCount: number;
  passedCaseCount: number;
  /** Dimension scores averaged across cases, for the run-level breakdown. */
  dimensions: Array<{
    dimension: string;
    score: number | null;
    weight: number;
    effectiveWeight?: number;
    stage?: string;
    scoredCaseCount: number;
  }>;
}

const DEFAULT_THRESHOLD = 0.6;

/**
 * Which rules totalled a run's numbers.
 *
 * Bumped when the arithmetic changes underneath scores that are already stored,
 * so a comparison can say the two runs were measured differently instead of
 * reporting the difference as the agent's. 1 is the rule set every older run was
 * scored under; it was never written down, because nothing recorded a version
 * until stage normalization made the number mean something.
 *
 * Deliberately not part of the rubric fingerprint. That describes what was asked
 * for, this describes how it was added up, and telling somebody their standard
 * changed when only the scoring did sends them looking in the wrong place.
 */
export const EVALUATION_SCORING_VERSION = 2;

/**
 * Failure types whose defect says nothing about the agent: AgentRecall broke, a
 * judge broke, or the case was out of scope. A gate closed only by these has no
 * measurement to report, so the result is unscorable rather than zero.
 */
const UNSCORABLE_ATTRIBUTIONS = new Set(["infra_failure", "judge_failure", "unsupported"]);

export function scoreEvaluationCase(
  aggregate: EvaluationCaseAggregate,
  config: EvaluationScoringConfig = {},
): EvaluationCaseScore {
  const threshold = config.resolvedThreshold ?? DEFAULT_THRESHOLD;
  const minCoverage = config.minCoverage ?? 0;

  if (!aggregate.gate.passed) {
    const unscorable = aggregate.gate.hardDefects.length > 0
      && aggregate.gate.hardDefects.every(
        (defect) => UNSCORABLE_ATTRIBUTIONS.has(defect.attribution.type),
      );
    return {
      caseId: aggregate.caseId,
      score: unscorable ? null : 0,
      passed: false,
      gatePassed: false,
      coverage: 0,
      dimensions: [],
      byLabel: {},
      decided: 0,
      notDecided: aggregate.completeness.notDecided,
      ...(unscorable
        ? { unscorableReason: aggregate.gate.hardDefects[0]!.attribution.reason }
        : {}),
    };
  }

  const verdicts = scorableVerdicts(aggregate);
  const decided = verdicts.filter(
    (verdict) => verdict.status === "met" || verdict.status === "unmet",
  );
  const dimensions = stageShares(dimensionScores(verdicts, config));
  const scored = dimensions.filter((item) => item.score !== null && item.weight > 0);
  const shareOf = (item: EvaluationDimensionScore) => item.effectiveWeight ?? item.weight;
  const totalWeight = scored.reduce((sum, item) => sum + shareOf(item), 0);
  const score = totalWeight > 0
    ? scored.reduce((sum, item) => sum + shareOf(item) * item.score!, 0) / totalWeight
    : null;

  return {
    caseId: aggregate.caseId,
    score,
    passed: score !== null
      && score >= threshold
      && coverageOf(verdicts, aggregate, config) >= minCoverage
      && requiredLabelsPassed(verdicts, config),
    gatePassed: true,
    coverage: coverageOf(verdicts, aggregate, config),
    dimensions,
    byLabel: labelBreakdown(decided, config),
    decided: decided.length,
    notDecided: aggregate.completeness.notDecided,
  };
}

function requiredLabelsPassed(
  verdicts: readonly EvaluationVerdict[],
  config: EvaluationScoringConfig,
): boolean {
  for (const [key, requiredValues] of Object.entries(config.requiredLabels ?? {})) {
    for (const requiredValue of requiredValues) {
      const matches = verdicts.filter((verdict) => verdict.labels[key] === requiredValue);
      if (matches.length === 0 || matches.some((verdict) => verdict.status !== "met")) return false;
    }
  }
  return true;
}

export function scoreEvaluationRun(
  cases: readonly EvaluationCaseScore[],
): EvaluationRunScore {
  const scored = cases.filter((item) => item.score !== null);
  const values = scored.map((item) => item.score!);
  const dimensionNames = [...new Set(cases.flatMap((item) => item.dimensions.map((entry) => entry.dimension)))];
  return {
    averageScore: values.length > 0
      ? values.reduce((left, right) => left + right, 0) / values.length
      : null,
    minimumScore: values.length > 0 ? Math.min(...values) : null,
    passRate: scored.length > 0
      ? scored.filter((item) => item.passed).length / scored.length
      : null,
    coverage: scored.length > 0
      ? scored.reduce((sum, item) => sum + item.coverage, 0) / scored.length
      : null,
    scoredCaseCount: scored.length,
    unscoredCaseCount: cases.length - scored.length,
    passedCaseCount: cases.filter((item) => item.passed).length,
    dimensions: dimensionNames.map((dimension) => {
      const reported = cases.flatMap(
        (item) => item.dimensions.filter((entry) => entry.dimension === dimension),
      );
      const entries = reported.filter((entry) => entry.score !== null);
      const weight = entries[0]?.weight ?? 1;
      const applied = entries[0]?.effectiveWeight;
      const stage = agreedStage(new Set(reported.map((entry) => entry.stage)));
      return {
        dimension,
        score: entries.length > 0
          ? entries.reduce((sum, entry) => sum + entry.score!, 0) / entries.length
          : null,
        weight,
        ...(applied !== undefined && applied !== weight ? { effectiveWeight: applied } : {}),
        ...(stage ? { stage } : {}),
        scoredCaseCount: entries.length,
      };
    }),
  };
}

function dimensionScores(
  verdicts: readonly EvaluationVerdict[],
  config: EvaluationScoringConfig,
): EvaluationDimensionScore[] {
  const names = [...new Set(verdicts.map(dimensionOf))];
  return names.map((dimension) => {
    const group = verdicts.filter((verdict) => dimensionOf(verdict) === dimension);
    const decided = group.filter((verdict) => valueOf(verdict, config) !== null);
    const score = decided.length > 0
      ? decided.reduce((sum, verdict) => sum + valueOf(verdict, config)!, 0) / decided.length
      : null;
    const stage = agreedStage(new Set(group.map((verdict) => verdict.labels.stage)));
    return {
      dimension,
      score,
      // A dimension's weight is the mean weight of its verdicts, so a weight set
      // on `priority` still lands even though weights are declared per label.
      weight: group.reduce((sum, verdict) => sum + weightOf(verdict, config), 0) / group.length,
      ...(stage ? { stage } : {}),
      decided: decided.length,
      undecided: group.length - decided.length,
      met: group.filter((verdict) => verdict.status === "met").length,
      unmet: group.filter((verdict) => verdict.status === "unmet").length,
    };
  });
}

/**
 * A stage's say in the score, split over the dimensions that judge it.
 *
 * Without this a stage's influence grows with the number of checks hung on it:
 * three dimensions weighted 0.3 outvote one weighted 0.5 by 64% to 36%, which is
 * the distortion dimension-first averaging exists to remove, reappearing one
 * level up. Dividing inside the stage leaves its influence as the declared stage
 * weight times the mean of its dimensions' own weights, so `weightByLabels.stage`
 * means what it says.
 *
 * Only dimensions that scored are counted. A sibling that could not decide is
 * already reported through coverage; letting it also dilute the checks that did
 * decide would charge the stage twice for one missing judge.
 */
function stageShares(
  dimensions: readonly EvaluationDimensionScore[],
): EvaluationDimensionScore[] {
  const scoredSiblings = new Map<string, number>();
  for (const item of dimensions) {
    if (item.stage === undefined || item.score === null || item.weight <= 0) continue;
    scoredSiblings.set(item.stage, (scoredSiblings.get(item.stage) ?? 0) + 1);
  }
  return dimensions.map((item) => {
    if (item.stage === undefined || item.score === null || item.weight <= 0) return item;
    const siblings = scoredSiblings.get(item.stage)!;
    return siblings > 1 ? { ...item, effectiveWeight: item.weight / siblings } : item;
  });
}

/** The one stage every item names, or none when they do not all agree. */
function agreedStage(stages: ReadonlySet<string | undefined>): string | undefined {
  const [stage] = stages;
  return stages.size === 1 && stage !== undefined ? stage : undefined;
}

/**
 * Decided weight over planned weight.
 *
 * Planned includes the judges that produced nothing at all — pending, excused or
 * thrown. Their weight is unknowable, so each is charged the mean weight of the
 * verdicts that did land; leaving them out is the blind spot this exists to
 * close, since a judge that throws would otherwise keep coverage at 1.
 */
function coverageOf(
  verdicts: readonly EvaluationVerdict[],
  aggregate: EvaluationCaseAggregate,
  config: EvaluationScoringConfig,
): number {
  const producedWeight = verdicts.reduce((sum, verdict) => sum + weightOf(verdict, config), 0);
  const decidedWeight = verdicts
    .filter((verdict) => valueOf(verdict, config) !== null)
    .reduce((sum, verdict) => sum + weightOf(verdict, config), 0);
  const meanWeight = verdicts.length > 0 ? producedWeight / verdicts.length : 1;
  const plannedWeight = producedWeight + aggregate.completeness.notDecided * meanWeight;
  if (plannedWeight <= 0) return 0;
  return Math.min(1, decidedWeight / plannedWeight);
}

function labelBreakdown(
  decided: readonly EvaluationVerdict[],
  config: EvaluationScoringConfig,
): Record<string, Record<string, number | null>> {
  const keys = [...new Set(decided.flatMap((verdict) => Object.keys(verdict.labels)))];
  const breakdown: Record<string, Record<string, number | null>> = {};
  for (const key of keys) {
    const values = [...new Set(
      decided.map((verdict) => verdict.labels[key]).filter((value): value is string => value !== undefined),
    )];
    breakdown[key] = {};
    for (const value of values) {
      const group = decided.filter((verdict) => verdict.labels[key] === value);
      const usable = group.map((verdict) => valueOf(verdict, config)).filter((item): item is number => item !== null);
      breakdown[key][value] = usable.length > 0
        ? usable.reduce((left, right) => left + right, 0) / usable.length
        : null;
    }
  }
  return breakdown;
}

function dimensionOf(verdict: EvaluationVerdict): string {
  return verdict.labels.dimension ?? verdict.evaluatorId ?? verdict.sourceNodeId;
}

function valueOf(verdict: EvaluationVerdict, config: EvaluationScoringConfig): number | null {
  if (verdict.status === "uncertain") return config.uncertain === "zero" ? 0 : null;
  if (typeof verdict.raw === "number" && Number.isFinite(verdict.raw)) {
    return Math.max(0, Math.min(1, verdict.raw));
  }
  return verdict.status === "met" ? 1 : 0;
}

function weightOf(verdict: EvaluationVerdict, config: EvaluationScoringConfig): number {
  let weight = 1;
  for (const [key, table] of Object.entries(config.weightByLabels ?? {})) {
    const label = verdict.labels[key];
    if (label !== undefined && table[label] !== undefined) weight *= table[label];
  }
  return weight;
}
