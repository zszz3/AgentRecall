import type { EvaluationJudgeSubject } from "../../../../core/evaluation/case-graph";
import type {
  EvaluationArtifactFile,
  EvaluationArtifactValue,
} from "../../../../core/evaluation/nodes/contracts";
import type { EvaluationNodeRecord } from "../../../../core/evaluation/graph/node";
import type { EvaluationGraphSpec } from "../../../../core/evaluation/graph/builder";
import type {
  EvaluationDimensionScore,
  EvaluationRunScore,
  EvaluationScoringConfig,
} from "../../../../core/evaluation/graph/scorer";

export type { EvaluationNodeRecord } from "../../../../core/evaluation/graph/node";
export type {
  EvaluationDimensionScore,
  EvaluationScoringConfig,
} from "../../../../core/evaluation/graph/scorer";
export type { EvaluationJudgeSubject } from "../../../../core/evaluation/case-graph";
export type {
  EvaluationArtifactFile,
  EvaluationArtifactValue,
} from "../../../../core/evaluation/nodes/contracts";
export type {
  EvaluationGraphNodeSpec,
  EvaluationGraphSpec,
  EvaluationInputBinding,
} from "../../../../core/evaluation/graph/builder";
export type {
  EvaluationFailureAttribution,
  EvaluationFailureType,
  EvaluationPendingReason,
  EvaluationRecordStatus,
  EvaluationVerdict,
  EvaluationVerdictStatus,
} from "../../../../core/evaluation/graph/node";

export interface EvaluationDatasetItem {
  id: string;
  input: string;
  expectedOutput?: string;
  metadata: Record<string, unknown>;
  sequence: number;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  items: EvaluationDatasetItem[];
  createdAt: number;
  updatedAt: number;
}

/**
 * `tool_failures` and `trajectory_budget` decide on the trajectory rather than
 * the answer, so they only apply to a source that has one — a folder artifact
 * has none. A `script` evaluator picks its own subject.
 */
export type EvaluatorKind =
  | "contains"
  | "exact_match"
  | "json_valid"
  | "llm_judge"
  | "tool_failures"
  | "trajectory_budget"
  | "script";

export interface EvaluationEvaluator {
  id: string;
  name: string;
  kind: EvaluatorKind;
  prompt?: string;
  runtimeId?: string;
  threshold: number;
  enabled: boolean;
  /**
   * Dimension this evaluator scores. Scores are averaged inside a dimension
   * before dimensions are combined, so adding a second check to a dimension does
   * not quietly increase that dimension's say. Defaults to the evaluator id.
   */
  dimension?: string;
  /** Weighted through the experiment's scoring config, not on its own. */
  priority?: "must" | "should";
  /** Only for `tool_failures`: failures tolerated before the verdict goes unmet. */
  maxToolFailures?: number;
  /**
   * Only for `trajectory_budget`: what the work may spend. A metric left unset
   * is not budgeted, which is not the same as a budget of zero, and one the
   * runtime never reported is skipped rather than charged as an overrun.
   */
  maxTurns?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxDurationMs?: number;
  /**
   * Only for `script`. Inline JS runs sandboxed with no filesystem, network or
   * module access; a command is spawned with the subject on stdin and must print
   * its verdicts to stdout. Either way, a script that breaks excuses its own
   * judgement rather than scoring the agent zero.
   */
  scriptMode?: "inline_js" | "command";
  /** Function body for `inline_js`, with `task`, `artifact` and `trajectory` in scope. */
  script?: string;
  command?: string;
  commandArgs?: string[];
  /** What the script looks at. Defaults to the artifact. */
  subject?: EvaluationJudgeSubject;
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A graph authored in the editor, replacing the shape the runner would otherwise
 * derive from the experiment's dataset, agent and evaluators.
 *
 * `layout` is editor state only. It lives beside the spec rather than inside it
 * so the engine contract stays free of presentation, while both still travel and
 * version as one document.
 */
export interface EvaluationExperimentGraph {
  version: number;
  spec: EvaluationGraphSpec;
  layout: Record<string, { x: number; y: number }>;
}

export interface EvaluationExperiment {
  id: string;
  name: string;
  datasetId: string;
  agentId: string;
  evaluatorIds: string[];
  repetitions: number;
  /**
   * Where each case's artifact comes from. Absent means `run_agent`, which is
   * what every experiment created before artifact sources existed did.
   */
  source?: "run_agent" | "session" | "folder";
  /** Dimension weights, pass threshold and minimum coverage for this experiment. */
  scoring?: EvaluationScoringConfig | null;
  /**
   * Custom graph for this experiment. Null or absent means the runner derives
   * the standard shape, which is what every experiment created before the editor
   * existed does.
   */
  graph?: EvaluationExperimentGraph | null;
  // Skill regression binding (phase four). Null for generic experiments created
  // before skill binding existed. skill_hash is the SKILL.md hash at the
  // time of the most recent run, refreshed before every run so each run is
  // attributed to the version that actually executed it.
  skillName?: string | null;
  skillHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationScore {
  evaluatorId: string;
  score: number;
  passed: boolean;
  /** Dimension the verdict belongs to, for the per-dimension breakdown. */
  dimension?: string;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  durationMs: number;
  tokenCount?: number;
  estimatedCost?: number;
}

/**
 * What a case produced, as stored — the artifact contract minus its text.
 *
 * `output` and `durationMs` are columns of the case result already, so repeating
 * them here would give one fact two homes that could disagree. Everything else a
 * judge was handed is kept, which is what makes a recorded run re-readable: a new
 * judge can be written against last week's files without running the agent again.
 */
export interface EvaluationCaseArtifact {
  origin: EvaluationArtifactValue["origin"];
  /** Absent means "not observed", which is not the same as "nothing touched". */
  files?: EvaluationArtifactFile[];
}

export interface EvaluationCaseResult {
  id: string;
  runId: string;
  datasetItemId: string;
  repetition: number;
  input: string;
  expectedOutput?: string;
  output: string;
  /**
   * Where the answer came from and which files came with it. Absent on runs
   * recorded before the artifact was stored, and on cases whose source failed
   * before producing one.
   */
  artifact?: EvaluationCaseArtifact;
  error?: string;
  durationMs: number;
  scores: EvaluationScore[];
  /**
   * Per-node execution records from the evaluation graph. Absent on runs
   * recorded before the graph engine existed; those runs keep only the case and
   * score rows they were written with.
   */
  nodes?: EvaluationNodeRecord[];
  /** Session this case's agent execution produced, once indexing linked it. */
  sessionKey?: string;
  /** The skill whose instructions were injected with the task, if any. */
  skillInjection?: {
    skillName: string;
    skillHash: string;
    contentLength: number;
  };
  /** Weighted score across dimensions, 0..1. Absent when nothing was decided. */
  score?: number;
  /** True when the score cleared the threshold and coverage was sufficient. */
  passed?: boolean;
  /** Decided weight over planned weight, 0..1. */
  coverage?: number;
  /** Per-dimension breakdown, which is what a single score cannot show. */
  dimensions?: EvaluationDimensionScore[];
  /** Every label key broken down by value, for reports that slice differently. */
  byLabel?: Record<string, Record<string, number | null>>;
  /**
   * Evaluators this source could not judge — a trajectory judge against a folder
   * artifact, for instance. Reported so the omission is visible.
   */
  skippedEvaluatorIds?: string[];
  /**
   * Why this case has no score. Set when nothing was decided — a missing judge
   * runtime, an agent that never answered, a cancelled run — so the absence is
   * never mistaken for a zero.
   */
  unscoredReason?: string;
  /** False when a hard defect closed the case's gate. */
  gatePassed?: boolean;
}

/**
 * How far apart one case's repetitions landed.
 *
 * An average over repetitions hides the thing a regression suite most needs to
 * show: a case that scores 1.00 and then 0.40 on the same version is not a case
 * worth 0.70, it is a case that does not reproduce.
 */
export interface EvaluationConsistencyEntry {
  datasetItemId: string;
  /** Repetitions that produced a score. */
  scored: number;
  /** Repetitions that passed, out of `scored`. */
  passed: number;
  averageScore: number | null;
  /**
   * Widest gap between two scored repetitions. Null unless at least two scored:
   * a single repetition reports no spread rather than a spread of zero, because
   * zero would claim a stability that was never measured.
   */
  spread: number | null;
}

export interface EvaluationRunConsistency {
  /** Cases with at least one scored repetition. */
  entries: EvaluationConsistencyEntry[];
  /** Of those, how many ran often enough to have a spread at all. */
  repeatedCaseCount: number;
  /** Mean spread over those cases; null when none ran more than once. */
  meanSpread: number | null;
}

export interface EvaluationRun {
  id: string;
  experimentId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agentRevisionId?: string;
  // SKILL.md fingerprint of the version that executed; null for generic
  // (non-skill) experiments and runs recorded before attribution existed.
  skillHash?: string | null;
  /**
   * Fingerprint of the judges and scoring policy this run was measured with.
   * Runs recorded before rubric attribution existed carry none, so a comparison
   * can only call a rubric change a fact when both runs have one.
   */
  rubricHash?: string | null;
  startedAt: number;
  finishedAt?: number;
  averageScore?: number;
  minimumScore?: number;
  passRate?: number;
  totalDurationMs?: number;
  error?: string;
  results: EvaluationCaseResult[];
  /**
   * Marks a run executed by the evaluation graph. Absent means the run predates
   * it, so its scores follow the older rules and carry no node records.
   */
  engine?: "graph";
  /** Cases that produced a score. The score fields average over these only. */
  scoredCaseCount?: number;
  /** Cases that decided nothing; excluded from every score above. */
  unscoredCaseCount?: number;
  /** Mean coverage over the scored cases. */
  coverage?: number;
  /** Dimension scores averaged across cases. */
  dimensions?: EvaluationRunScore["dimensions"];
  /**
   * How far apart each case's repetitions landed. Absent on runs recorded before
   * it existed; a suite that runs every case once has a `repeatedCaseCount` of
   * zero and no mean, which is not the same as being stable.
   */
  consistency?: EvaluationRunConsistency;
}

export type EvaluationRunSummary = Omit<EvaluationRun, "results"> & {
  resultCount: number;
  failedResultCount: number;
};

export interface ListEvaluationRunsRequest {
  experimentId?: string;
  offset?: number;
  limit?: number;
}

export interface EvaluationRunPage {
  items: EvaluationRunSummary[];
  total: number;
  offset: number;
  limit: number;
}
