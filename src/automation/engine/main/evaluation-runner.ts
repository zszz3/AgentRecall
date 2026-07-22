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
  execute: (agentId: string, prompt: string) => Promise<ExecutionResult>;
  executeJudge?: (
    runtimeId: string,
    prompt: string,
  ) => Promise<ExecutionResult>;
}): Promise<EvaluationRun> {
  const startedAt = Date.now();
  const runId = `eval-run-${startedAt}`;
  const results: EvaluationCaseResult[] = [];
  for (const item of input.dataset.items) {
    for (
      let repetition = 1;
      repetition <= Math.max(1, Math.min(5, input.experiment.repetitions));
      repetition += 1
    ) {
      const caseId = `${runId}:${item.id}:${repetition}`;
      let output = "";
      let durationMs = 0;
      let error: string | undefined;
      try {
        const executed = await input.execute(
          input.experiment.agentId,
          item.input,
        );
        output = executed.output;
        durationMs = executed.durationMs;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const scores = await Promise.all(
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
    }
  }
  const allScores = results.flatMap((result) => result.scores);
  const values = allScores.map((result) => result.score);
  const passed = allScores.filter((result) => result.passed).length;
  const finishedAt = Date.now();
  return {
    id: runId,
    experimentId: input.experiment.id,
    status: results.some((result) => result.error) ? "failed" : "completed",
    ...(input.agentRevisionId
      ? { agentRevisionId: input.agentRevisionId }
      : {}),
    startedAt,
    finishedAt,
    averageScore: values.length
      ? values.reduce((left, right) => left + right, 0) / values.length
      : 0,
    minimumScore: values.length ? Math.min(...values) : 0,
    passRate: allScores.length ? passed / allScores.length : 0,
    totalDurationMs: finishedAt - startedAt,
    results,
  };
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
