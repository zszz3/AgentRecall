import type {
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationScore,
} from "../shared/evaluation/types";

type ExecutionResult = { output: string; durationMs: number };

export async function runEvaluation(input: {
  experiment: EvaluationExperiment;
  dataset: EvaluationDataset;
  evaluators: EvaluationEvaluator[];
  agentRevisionId?: string;
  // Stable id assigned before execution starts so callers can persist and poll
  // the run immediately; generated when omitted (blocking legacy path).
  runId?: string;
  // Cooperative cancellation. Checked between cases and forwarded to the
  // executor; an aborted run finalizes as "cancelled" with partial results.
  signal?: AbortSignal;
  // Receives a snapshot at start ("running"), after every finished case, and
  // at the end, so persistence and progress polling share one source of truth.
  onRunUpdate?: (run: EvaluationRun) => Promise<void>;
  execute: (
    agentId: string,
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<ExecutionResult>;
  executeJudge?: (
    runtimeId: string,
    prompt: string,
  ) => Promise<ExecutionResult>;
}): Promise<EvaluationRun> {
  const startedAt = Date.now();
  const runId = input.runId ?? `eval-run-${startedAt}`;
  const results: EvaluationCaseResult[] = [];
  const repetitions = Math.max(1, Math.min(5, input.experiment.repetitions));
  const snapshot = (status: EvaluationRun["status"]): EvaluationRun => {
    const allScores = results.flatMap((result) => result.scores);
    const values = allScores.map((item) => item.score);
    const passed = allScores.filter((item) => item.passed).length;
    return {
      id: runId,
      experimentId: input.experiment.id,
      status,
      ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
      startedAt,
      ...(status === "running" ? {} : { finishedAt: Date.now() }),
      averageScore: values.length
        ? values.reduce((left, right) => left + right, 0) / values.length
        : 0,
      minimumScore: values.length ? Math.min(...values) : 0,
      passRate: allScores.length ? passed / allScores.length : 0,
      totalDurationMs: Date.now() - startedAt,
      results: [...results],
    };
  };
  const publish = async (status: EvaluationRun["status"]) => {
    if (!input.onRunUpdate) return;
    await input.onRunUpdate(snapshot(status));
  };
  await publish("running");
  outer: for (const item of input.dataset.items) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      if (input.signal?.aborted) break outer;
      const caseId = `${runId}:${item.id}:${repetition}`;
      let output = "";
      let durationMs = 0;
      let error: string | undefined;
      try {
        const executed = await input.execute(
          input.experiment.agentId,
          item.input,
          input.signal,
        );
        output = executed.output;
        durationMs = executed.durationMs;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // An abort mid-case leaves no meaningful output to judge.
      const scores = input.signal?.aborted
        ? []
        : await Promise.all(
            input.evaluators
              .filter(
                (evaluator) =>
                  input.experiment.evaluatorIds.includes(evaluator.id) &&
                  evaluator.enabled,
              )
              .map((evaluator) =>
                score(
                  evaluator,
                  item.input,
                  item.expectedOutput,
                  typeof item.metadata.context === "string"
                    ? item.metadata.context
                    : undefined,
                  output,
                  input.executeJudge,
                ),
              ),
          );
      results.push({
        id: caseId,
        runId,
        datasetItemId: item.id,
        repetition,
        input: item.input,
        ...(item.expectedOutput !== undefined
          ? { expectedOutput: item.expectedOutput }
          : {}),
        output,
        ...(error ? { error } : {}),
        durationMs,
        scores,
      });
      await publish("running");
    }
  }
  const finalStatus: EvaluationRun["status"] = input.signal?.aborted
    ? "cancelled"
    : results.some((result) => result.error)
      ? "failed"
      : "completed";
  await publish(finalStatus);
  return snapshot(finalStatus);
}

async function score(
  evaluator: EvaluationEvaluator,
  input: string,
  expected: string | undefined,
  context: string | undefined,
  output: string,
  executeJudge:
    | ((runtimeId: string, prompt: string) => Promise<ExecutionResult>)
    | undefined,
): Promise<EvaluationScore> {
  const startedAt = Date.now();
  let value = 0;
  let reason: string | undefined;
  let evidence: string[] | undefined;
  let failedCriteria: string[] | undefined;
  if (evaluator.kind === "exact_match")
    value = output.trim() === (expected ?? "").trim() ? 1 : 0;
  else if (evaluator.kind === "contains")
    value = expected && output.includes(expected) ? 1 : 0;
  else if (evaluator.kind === "json_valid") {
    try {
      JSON.parse(output);
      value = 1;
    } catch {
      value = 0;
    }
  } else {
    try {
      if (!evaluator.runtimeId)
        throw new Error("LLM Judge Runtime is not configured");
      if (!executeJudge)
        throw new Error("LLM Judge Runtime executor is not available");
      const template = evaluator.prompt ?? "Score the answer from 0 to 1.";
      const usesPlaceholders = /\{\{(?:input|output|ground_truth|context)\}\}/.test(
        template,
      );
      let judgePrompt = renderEvaluationPrompt(template, {
        input,
        output,
        ...(expected !== undefined ? { ground_truth: expected } : {}),
        ...(context !== undefined ? { context } : {}),
      });
      if (!usesPlaceholders) {
        judgePrompt += `\n\nInput: ${input}\n\nAnswer: ${output}\n\nGround truth: ${expected ?? "(none)"}\n\nContext: ${context ?? "(none)"}`;
      }
      if (!judgePrompt.includes('"failedCriteria"')) {
        judgePrompt +=
          '\n\nReturn JSON only: {"score": number, "reason": string, "evidence": [string], "failedCriteria": [string]}';
      }
      const result = await executeJudge(
        evaluator.runtimeId,
        judgePrompt,
      );
      const parsed = JSON.parse(
        result.output.match(/\{[\s\S]*\}/)?.[0] ?? "{}",
      ) as {
        score?: unknown;
        reason?: unknown;
        evidence?: unknown;
        failedCriteria?: unknown;
      };
      value = Math.max(0, Math.min(1, Number(parsed.score) || 0));
      reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
      evidence = stringArray(parsed.evidence);
      failedCriteria = stringArray(parsed.failedCriteria);
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
      value = 0;
    }
  }
  return {
    evaluatorId: evaluator.id,
    score: value,
    passed: value >= evaluator.threshold,
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
    ...(failedCriteria ? { failedCriteria } : {}),
    durationMs: Date.now() - startedAt,
  };
}

export function renderEvaluationPrompt(
  template: string,
  values: {
    input: string;
    output: string;
    ground_truth?: string;
    context?: string;
  },
): string {
  return template.replace(
    /\{\{(input|output|ground_truth|context)\}\}/g,
    (_match, key: keyof typeof values) => values[key] ?? "(not provided)",
  );
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}
