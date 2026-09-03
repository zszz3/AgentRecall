import { randomUUID } from "node:crypto";

import { executeEvaluationRun } from "../../../core/evaluation/run";
import type { EvaluationPlanEvaluator } from "../../../core/evaluation/case-graph";
import type {
  EvaluationArtifactFile,
  EvaluationExecutionReference,
  EvaluationNodeDependencies,
  EvaluationTaskValue,
  EvaluationTrajectoryValue,
} from "../../../core/evaluation/nodes/contracts";
import type { EvaluationCaseOutcome } from "../../../core/evaluation/run";
import type {
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationScore,
} from "../shared/evaluation/types";

/**
 * Adapter between the stored experiment shape and the evaluation graph.
 *
 * The engine lives in `src/core/evaluation`; everything here is translation. An
 * experiment becomes a run plan — which artifact source, which evaluators on
 * which dimensions, which weights — and each case outcome becomes the rows the
 * store and existing clients understand, plus the node records and dimension
 * breakdown that explain how the score came about.
 */

export type EvaluationExecutionRequest = {
  configuredAgentId: string;
  prompt: string;
  developerInstructions?: string;
  role: string;
  ownerReference: Record<string, string>;
};

export interface EvaluationExecutionResult {
  output: string;
  durationMs: number;
  executionReference?: EvaluationExecutionReference;
}

export interface RunEvaluationInput {
  experiment: EvaluationExperiment;
  dataset: EvaluationDataset;
  evaluators: EvaluationEvaluator[];
  agentRevisionId?: string;
  // Stable id assigned before execution starts so callers can persist and poll
  // the run immediately; generated when omitted.
  runId?: string;
  // Skill version fingerprint attributed to every snapshot of this run.
  skillHash?: string | null;
  // Cooperative cancellation. Checked between cases and forwarded to the
  // executor; an aborted run finalizes as "cancelled" with partial results.
  signal?: AbortSignal;
  // Receives a snapshot at start ("running"), after every finished case, and at
  // the end, so persistence and progress polling share one source of truth.
  onRunUpdate?: (run: EvaluationRun) => Promise<void>;
  execute: (
    request: EvaluationExecutionRequest,
    signal?: AbortSignal,
  ) => Promise<EvaluationExecutionResult>;
  executeJudge?: (
    runtimeId: string,
    prompt: string,
    role: string,
    ownerReference: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
  /** Reads the SKILL.md bytes and hash of the skill this experiment injects. */
  readSkill?: (skillName: string) => Promise<{ content: string; hash: string } | null>;
  /** Resolves a runtime session id to the indexed AgentRecall session. */
  resolveSession?: (rawId: string) => Promise<{ sessionKey: string } | null>;
  readTrajectory?: (sessionKey: string) => Promise<EvaluationTrajectoryValue | null>;
  readSessionArtifact?: (
    sessionKey: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  readFolderArtifact?: (
    path: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  /** Which files a session's tool calls touched, for a fresh run's artifact. */
  readArtifactFiles?: (sessionKey: string) => Promise<EvaluationArtifactFile[] | null>;
  /** Runs a judge the user wrote. Absent means script judges excuse themselves. */
  runJudgeScript?: EvaluationNodeDependencies["runJudgeScript"];
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationRun> {
  const startedAt = Date.now();
  const runId = input.runId ?? `eval-run-${startedAt}-${randomUUID()}`;
  const repetitions = Math.max(1, Math.min(5, input.experiment.repetitions));
  const results: EvaluationCaseResult[] = [];

  const cases: EvaluationTaskValue[] = [];
  for (const item of input.dataset.items) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const artifactRef = artifactRefOf(item.metadata);
      cases.push({
        caseId: `${runId}:${item.id}:${repetition}`,
        datasetItemId: item.id,
        repetition,
        input: item.input,
        ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
        ...(typeof item.metadata.context === "string" ? { context: item.metadata.context } : {}),
        ...(artifactRef ? { artifactRef } : {}),
        metadata: item.metadata,
      });
    }
  }

  const dependencies: EvaluationNodeDependencies = {
    runAgent: (request, signal) =>
      input.execute(
        {
          configuredAgentId: request.agentId,
          prompt: request.prompt,
          role: request.role,
          ownerReference: { runId, ...request.ownerReference },
          ...(request.developerInstructions
            ? { developerInstructions: request.developerInstructions }
            : {}),
        },
        signal,
      ),
    ...(input.executeJudge
      ? {
          executeJudge: (request, signal) =>
            input.executeJudge!(request.runtimeId, request.prompt, request.role, {
              runId,
              ...request.ownerReference,
            }, signal),
        }
      : {}),
    ...(input.readSkill ? { readSkill: input.readSkill } : {}),
    ...(input.resolveSession ? { resolveSession: input.resolveSession } : {}),
    ...(input.readTrajectory ? { readTrajectory: input.readTrajectory } : {}),
    ...(input.readSessionArtifact ? { readSessionArtifact: input.readSessionArtifact } : {}),
    ...(input.readFolderArtifact ? { readFolderArtifact: input.readFolderArtifact } : {}),
    ...(input.readArtifactFiles ? { readArtifactFiles: input.readArtifactFiles } : {}),
    ...(input.runJudgeScript ? { runJudgeScript: input.runJudgeScript } : {}),
    ...(input.wait ? { wait: input.wait } : {}),
  };

  let snapshotScore: EvaluationRunSnapshotScore = {};
  const snapshot = (status: EvaluationRun["status"]): EvaluationRun => ({
    id: runId,
    experimentId: input.experiment.id,
    status,
    engine: "graph",
    ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
    ...(input.skillHash ? { skillHash: input.skillHash } : {}),
    startedAt,
    ...(status === "running" ? {} : { finishedAt: Date.now() }),
    ...snapshotScore,
    totalDurationMs: Date.now() - startedAt,
    results: [...results],
  });
  const publish = async (status: EvaluationRun["status"]) => {
    await input.onRunUpdate?.(snapshot(status));
  };

  await publish("running");

  const outcome = await executeEvaluationRun(
    {
      source: input.experiment.source ?? "run_agent",
      agentId: input.experiment.agentId,
      skillName: input.experiment.skillName ?? null,
      evaluators: planEvaluators(input.experiment, input.evaluators),
      cases,
      // The trajectory half of a fresh run costs a lookup and a bounded wait, so
      // it only runs where the host wired both readers.
      linkTrajectory: Boolean(input.resolveSession && input.readTrajectory),
      sessionLink: { attempts: 6, delayMs: 500 },
      ...(input.experiment.scoring ? { scoring: input.experiment.scoring } : {}),
      // An experiment with an authored graph runs that graph instead of the
      // derived shape; the runner only rewrites its per-case and evaluator config.
      ...(input.experiment.graph?.spec ? { savedSpec: input.experiment.graph.spec } : {}),
    },
    dependencies,
    {
      ...(input.signal ? { signal: input.signal } : {}),
      onCaseComplete: async (caseOutcome) => {
        results.push(caseResult(runId, caseOutcome));
        snapshotScore = partialScore(results);
        await publish("running");
      },
    },
  );

  snapshotScore = {
    ...(outcome.score.averageScore !== null ? { averageScore: outcome.score.averageScore } : {}),
    ...(outcome.score.minimumScore !== null ? { minimumScore: outcome.score.minimumScore } : {}),
    ...(outcome.score.passRate !== null ? { passRate: outcome.score.passRate } : {}),
    ...(outcome.score.coverage !== null ? { coverage: outcome.score.coverage } : {}),
    scoredCaseCount: outcome.score.scoredCaseCount,
    unscoredCaseCount: outcome.score.unscoredCaseCount,
    dimensions: outcome.score.dimensions,
  };

  const status: EvaluationRun["status"] = outcome.cancelled
    ? "cancelled"
    : results.some((result) => result.unscoredReason !== undefined)
      ? "failed"
      : "completed";
  await publish(status);
  return snapshot(status);
}

interface EvaluationRunSnapshotScore {
  averageScore?: number;
  minimumScore?: number;
  passRate?: number;
  coverage?: number;
  scoredCaseCount?: number;
  unscoredCaseCount?: number;
  dimensions?: EvaluationRun["dimensions"];
}

/**
 * Score of the cases finished so far, so a polling client sees the run move.
 * Recomputed from case rows rather than accumulated, so a retried case cannot be
 * counted twice.
 */
function partialScore(results: readonly EvaluationCaseResult[]): EvaluationRunSnapshotScore {
  const scored = results.filter((result) => result.unscoredReason === undefined);
  const values = scored
    .map((result) => result.score)
    .filter((value): value is number => typeof value === "number");
  const passed = scored.filter((result) => result.passed === true).length;
  return {
    ...(values.length > 0
      ? {
          averageScore: values.reduce((left, right) => left + right, 0) / values.length,
          minimumScore: Math.min(...values),
          passRate: passed / scored.length,
        }
      : {}),
    scoredCaseCount: scored.length,
    unscoredCaseCount: results.length - scored.length,
  };
}

function planEvaluators(
  experiment: EvaluationExperiment,
  evaluators: readonly EvaluationEvaluator[],
): EvaluationPlanEvaluator[] {
  return evaluators
    .filter(
      (evaluator) => experiment.evaluatorIds.includes(evaluator.id) && evaluator.enabled,
    )
    .map((evaluator) => ({
      id: evaluator.id,
      kind: evaluator.kind,
      threshold: evaluator.threshold,
      ...(evaluator.dimension ? { dimension: evaluator.dimension } : {}),
      ...(evaluator.priority ? { priority: evaluator.priority } : {}),
      ...(evaluator.runtimeId ? { runtimeId: evaluator.runtimeId } : {}),
      ...(evaluator.prompt ? { prompt: evaluator.prompt } : {}),
      ...(evaluator.maxToolFailures !== undefined
        ? { maxToolFailures: evaluator.maxToolFailures }
        : {}),
      ...(evaluator.scriptMode ? { scriptMode: evaluator.scriptMode } : {}),
      ...(evaluator.script ? { script: evaluator.script } : {}),
      ...(evaluator.command ? { command: evaluator.command } : {}),
      ...(evaluator.commandArgs && evaluator.commandArgs.length > 0
        ? { commandArgs: evaluator.commandArgs }
        : {}),
      ...(evaluator.subject ? { subject: evaluator.subject } : {}),
      ...(evaluator.timeoutMs !== undefined ? { timeoutMs: evaluator.timeoutMs } : {}),
    }));
}

/** Dataset items point at an existing artifact through their metadata. */
function artifactRefOf(
  metadata: Record<string, unknown>,
): { sessionKey?: string; path?: string } | undefined {
  const sessionKey = typeof metadata.sessionKey === "string" ? metadata.sessionKey.trim() : "";
  const path = typeof metadata.artifactPath === "string" ? metadata.artifactPath.trim() : "";
  if (!sessionKey && !path) return undefined;
  return { ...(sessionKey ? { sessionKey } : {}), ...(path ? { path } : {}) };
}

function caseResult(runId: string, outcome: EvaluationCaseOutcome): EvaluationCaseResult {
  const scores: EvaluationScore[] = outcome.aggregate.nodes
    .filter((record) => record.role === "judge" && record.status !== "excused" && record.status !== "error")
    .flatMap((record) => record.verdicts ?? [])
    .filter((verdict) => verdict.evaluatorId !== undefined)
    .map((verdict) => ({
      evaluatorId: verdict.evaluatorId!,
      score: verdict.raw ?? 0,
      passed: verdict.status === "met",
      ...(verdict.labels.dimension ? { dimension: verdict.labels.dimension } : {}),
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
      ...(verdict.failedCriteria ? { failedCriteria: verdict.failedCriteria } : {}),
      durationMs: verdict.durationMs ?? 0,
    }));

  return {
    id: outcome.caseId,
    runId,
    datasetItemId: outcome.task.datasetItemId,
    repetition: outcome.task.repetition,
    input: outcome.task.input,
    ...(outcome.task.expectedOutput !== undefined
      ? { expectedOutput: outcome.task.expectedOutput }
      : {}),
    output: outcome.output,
    // Everything else the artifact is. Stored so a recorded run stays
    // re-readable: a judge written next week can be pointed at these files
    // without running the agent again.
    ...(outcome.artifact
      ? {
          artifact: {
            origin: outcome.artifact.origin,
            ...(outcome.artifact.files ? { files: outcome.artifact.files } : {}),
          },
        }
      : {}),
    // The legacy `error` field is what older clients read to spot a case that
    // did not evaluate; keep it in step with the graph's own reason.
    ...(outcome.unscoredReason ? { error: outcome.unscoredReason } : {}),
    durationMs: outcome.durationMs,
    scores,
    nodes: outcome.aggregate.nodes,
    ...(outcome.score.score !== null ? { score: outcome.score.score } : {}),
    passed: outcome.score.passed,
    coverage: outcome.score.coverage,
    dimensions: outcome.score.dimensions,
    byLabel: outcome.score.byLabel,
    ...(outcome.skippedEvaluatorIds.length > 0
      ? { skippedEvaluatorIds: outcome.skippedEvaluatorIds }
      : {}),
    ...(outcome.sessionKey ? { sessionKey: outcome.sessionKey } : {}),
    ...(outcome.skill ? { skillInjection: outcome.skill } : {}),
    ...(outcome.unscoredReason ? { unscoredReason: outcome.unscoredReason } : {}),
    gatePassed: outcome.aggregate.gate.passed,
  };
}
