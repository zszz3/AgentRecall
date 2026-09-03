import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationPass,
  type EvaluationNodeVerdict,
  type EvaluationVerdictStatus,
} from "../graph/node";
import {
  parseEvaluationDimensionContract,
  type EvaluationDimensionContractItem,
} from "../dimension-contract";
import {
  ARTIFACT_PORT,
  TASK_PORT,
  TRAJECTORY_PORT,
  type EvaluationJudgeScript,
  type EvaluationJudgeScriptVerdict,
  type EvaluationNodeDependencies,
} from "./contracts";

/**
 * Judges: the nodes that decide, each on one dimension.
 *
 * Every verdict carries the dimension it belongs to, so a report can break a
 * score down by dimension instead of showing one opaque number, and weights can
 * be set per dimension rather than per check.
 *
 * The rule they all follow: a judge either decides, or says it could not.
 * "Could not" is `excused` and is excluded from the score — a judge with no
 * runtime, or one whose model returned prose instead of JSON, has learned
 * nothing about the agent, and recording that as a zero is how an evaluation
 * ends up blaming the agent for its own broken plumbing.
 */

export const DETERMINISTIC_JUDGE_NODE_TYPE = "deterministic_judge";
export const LLM_JUDGE_NODE_TYPE = "llm_judge";
export const TOOL_FAILURE_JUDGE_NODE_TYPE = "tool_failure_judge";
export const SCRIPT_JUDGE_NODE_TYPE = "script_judge";
export const SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE = "script_trajectory_judge";

export type DeterministicEvaluatorKind = "exact_match" | "contains" | "json_valid";

/** Shared by every judge: which dimension it scores and how much it matters. */
export interface JudgeDimensionConfig {
  evaluatorId: string;
  threshold: number;
  /** Dimension this judge's verdict belongs to. Defaults to the evaluator id. */
  dimension?: string;
  priority?: "must" | "should";
}

export interface DeterministicJudgeConfig extends JudgeDimensionConfig {
  kind: DeterministicEvaluatorKind;
}

function verdictStatus(raw: number, threshold: number): EvaluationVerdictStatus {
  return raw >= threshold ? "met" : "unmet";
}

function buildVerdict(input: {
  nodeId: string;
  config: JudgeDimensionConfig;
  evaluator: string;
  raw: number;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  durationMs?: number;
}): EvaluationNodeVerdict {
  const dimension = input.config.dimension?.trim() || input.config.evaluatorId;
  return {
    verdictId: `${input.nodeId}:${input.config.evaluatorId}`,
    evaluatorId: input.config.evaluatorId,
    labels: {
      dimension,
      evaluator: input.evaluator,
      ...(input.config.priority ? { priority: input.config.priority } : {}),
    },
    status: verdictStatus(input.raw, input.config.threshold),
    raw: input.raw,
    threshold: input.config.threshold,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
    ...(input.failedCriteria && input.failedCriteria.length > 0
      ? { failedCriteria: input.failedCriteria }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/** Exact-match, substring and JSON-shape checks on the artifact. No model involved. */
export const deterministicJudgeNode = defineEvaluationNode<
  { task: typeof TASK_PORT; artifact: typeof ARTIFACT_PORT },
  Record<string, never>,
  DeterministicJudgeConfig
>({
  type: DETERMINISTIC_JUDGE_NODE_TYPE,
  version: 1,
  role: "judge",
  verdicts: true,
  inputs: { task: TASK_PORT, artifact: ARTIFACT_PORT },
  outputs: {},
  async run(context) {
    const { kind, evaluatorId } = context.config;
    const output = context.in.artifact.output;
    const expected = context.in.task.expectedOutput;

    if (kind !== "json_valid" && expected === undefined) {
      // Without a ground truth there is nothing to compare against; deciding
      // "unmet" here would grade the dataset, not the agent.
      return evaluationExcused.judge("expected_output_missing", {
        facts: { evaluatorId, kind },
      });
    }

    let raw = 0;
    let reason: string | undefined;
    if (kind === "exact_match") {
      raw = output.trim() === (expected ?? "").trim() ? 1 : 0;
      reason = raw === 1 ? "output matched the expected value" : "output differed from the expected value";
    } else if (kind === "contains") {
      raw = expected && output.includes(expected) ? 1 : 0;
      reason = raw === 1 ? "output contained the expected value" : "output did not contain the expected value";
    } else {
      try {
        JSON.parse(output);
        raw = 1;
        reason = "output parsed as JSON";
      } catch {
        raw = 0;
        reason = "output did not parse as JSON";
      }
    }

    return evaluationPass({
      verdicts: [buildVerdict({
        nodeId: context.nodeId,
        config: context.config,
        evaluator: kind,
        raw,
        reason,
      })],
    });
  },
});

export interface LlmJudgeConfig extends JudgeDimensionConfig {
  runtimeId: string;
  prompt: string;
}

const JUDGE_RETURN_CONTRACT =
  '\n\nReturn JSON only: {"score": number, "reason": string, "evidence": [string], "failedCriteria": [string]}';

export function renderEvaluationPrompt(
  template: string,
  values: { input: string; output: string; ground_truth?: string; context?: string },
): string {
  return template.replace(
    /\{\{(input|output|ground_truth|context)\}\}/g,
    (_match, key: keyof typeof values) => values[key] ?? "(not provided)",
  );
}

/** Scores the artifact with a judge model, on one dimension. */
export function createLlmJudgeNode(
  dependencies: Pick<EvaluationNodeDependencies, "executeJudge">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; artifact: typeof ARTIFACT_PORT },
    Record<string, never>,
    LlmJudgeConfig
  >({
    type: LLM_JUDGE_NODE_TYPE,
    version: 1,
    role: "judge",
    verdicts: true,
    inputs: { task: TASK_PORT, artifact: ARTIFACT_PORT },
    outputs: {},
    async run(context) {
      const { evaluatorId, runtimeId } = context.config;
      if (!runtimeId.trim()) {
        return evaluationExcused.infra("judge_runtime_not_configured", { facts: { evaluatorId } });
      }
      if (!dependencies.executeJudge) {
        return evaluationExcused.infra("judge_executor_unavailable", { facts: { evaluatorId } });
      }

      const { task, artifact } = context.in;
      const template = context.config.prompt || "Score the answer from 0 to 1.";
      const usesPlaceholders = /\{\{(?:input|output|ground_truth|context)\}\}/.test(template);
      let prompt = renderEvaluationPrompt(template, {
        input: task.input,
        output: artifact.output,
        ...(task.expectedOutput !== undefined ? { ground_truth: task.expectedOutput } : {}),
        ...(task.context !== undefined ? { context: task.context } : {}),
      });
      if (!usesPlaceholders) {
        prompt += `\n\nInput: ${task.input}\n\nAnswer: ${artifact.output}\n\nGround truth: ${task.expectedOutput ?? "(none)"}\n\nContext: ${task.context ?? "(none)"}`;
      }
      if (!prompt.includes('"failedCriteria"')) prompt += JUDGE_RETURN_CONTRACT;

      let judged: { output: string; durationMs: number };
      try {
        judged = await dependencies.executeJudge({
          runtimeId,
          prompt,
          role: "judge",
          ownerReference: {
            caseId: task.caseId,
            datasetItemId: task.datasetItemId,
            repetition: String(task.repetition),
            evaluatorId,
          },
        }, context.signal);
      } catch (cause) {
        return evaluationExcused.infra(
          cause instanceof Error ? cause.message : String(cause),
          { facts: { evaluatorId, runtimeId } },
        );
      }

      const parsed = parseJudgeOutput(judged.output);
      if (!parsed) {
        return evaluationExcused.judge("judge_output_unparseable", {
          facts: { evaluatorId, outputLength: judged.output.length },
        });
      }
      const dimensionContract = parseEvaluationDimensionContract(template);
      if (dimensionContract.length > 0 && !matchesDimensionContract(parsed, dimensionContract)) {
        return evaluationExcused.judge("judge_dimensions_incomplete", {
          facts: {
            evaluatorId,
            expectedDimensions: dimensionContract.map((item) => item.name),
            receivedDimensions: parsed.map((item) => item.dimension ?? ""),
          },
        });
      }
      if (parsed.some((item) => item.score === null)) {
        return evaluationExcused.judge("judge_score_missing", {
          facts: {
            evaluatorId,
            ...(parsed.find((item) => item.score === null)?.reason
              ? { judgeReason: parsed.find((item) => item.score === null)!.reason }
              : {}),
          },
        });
      }

      const contractByName = new Map(dimensionContract.map((item) => [item.name, item]));
      return evaluationPass({
        verdicts: parsed.map((item, index) => {
          const contracted = item.dimension ? contractByName.get(item.dimension) : undefined;
          const config = item.dimension
            ? {
                ...context.config,
                dimension: item.dimension,
                ...(contracted?.priority ? { priority: contracted.priority } : {}),
              }
            : context.config;
          const verdict = buildVerdict({
            nodeId: context.nodeId,
            config,
            evaluator: "llm_judge",
            raw: item.score!,
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.evidence ? { evidence: item.evidence } : {}),
            ...(item.failedCriteria ? { failedCriteria: item.failedCriteria } : {}),
            // One judge call produced every verdict. Recording its latency once
            // avoids making a ten-dimensional rubric look ten times slower.
            durationMs: index === 0 ? judged.durationMs : 0,
          });
          return parsed.length > 1
            ? { ...verdict, verdictId: `${verdict.verdictId}:${item.dimension ?? index}` }
            : verdict;
        }),
      });
    },
  });
}

export interface ToolFailureJudgeConfig extends JudgeDimensionConfig {
  /** Tool failures tolerated before the verdict goes unmet. Defaults to 0. */
  maxToolFailures?: number;
}

/**
 * Decides on the trajectory rather than the artifact: how the agent worked.
 *
 * Only reachable in a graph whose source has a trajectory. From a folder there
 * is none, and this judge then never runs — reported as such instead of scored.
 */
export const toolFailureJudgeNode = defineEvaluationNode<
  { trajectory: typeof TRAJECTORY_PORT },
  Record<string, never>,
  ToolFailureJudgeConfig
>({
  type: TOOL_FAILURE_JUDGE_NODE_TYPE,
  version: 1,
  role: "judge",
  verdicts: true,
  inputs: { trajectory: TRAJECTORY_PORT },
  outputs: {},
  async run(context) {
    const allowed = Math.max(0, context.config.maxToolFailures ?? 0);
    const { toolFailureCount, failedToolNames } = context.in.trajectory;
    const withinBudget = toolFailureCount <= allowed;
    return evaluationPass({
      verdicts: [buildVerdict({
        nodeId: context.nodeId,
        config: context.config,
        evaluator: "tool_failures",
        raw: withinBudget ? 1 : 0,
        reason: withinBudget
          ? `tool failures within budget (${toolFailureCount} of ${allowed} allowed)`
          : `tool failures above budget (${toolFailureCount} of ${allowed} allowed)`,
        ...(failedToolNames.length > 0 ? { failedCriteria: failedToolNames } : {}),
      })],
    });
  },
});


export interface ScriptJudgeConfig extends JudgeDimensionConfig {
  script: EvaluationJudgeScript;
}

/**
 * Turns whatever a judge script returned into verdicts.
 *
 * A script may return several, each naming its own dimension, so one pass over
 * the artifact can score efficiency and cost together instead of paying for two.
 */
function scriptVerdicts(
  nodeId: string,
  config: ScriptJudgeConfig,
  results: readonly EvaluationJudgeScriptVerdict[],
  durationMs: number,
): EvaluationNodeVerdict[] {
  return results.map((result, index) => {
    const dimension = result.dimension?.trim();
    const verdict = buildVerdict({
      nodeId,
      config: dimension ? { ...config, dimension } : config,
      evaluator: "script",
      raw: Math.max(0, Math.min(1, result.score)),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.evidence ? { evidence: result.evidence } : {}),
      ...(result.failedCriteria ? { failedCriteria: result.failedCriteria } : {}),
      durationMs,
    });
    // Several verdicts from one node need distinct ids, and the dimension is what
    // distinguishes them.
    return results.length > 1
      ? { ...verdict, verdictId: `${verdict.verdictId}:${dimension || index}` }
      : verdict;
  });
}

function scriptFailure(cause: unknown, evaluatorId: string) {
  // The script is the judge; when it breaks, nothing was learned about the agent.
  return evaluationExcused.judge(
    cause instanceof Error ? cause.message : String(cause),
    { facts: { evaluatorId, judge: "script" } },
  );
}

/** Judges the artifact with code the user wrote. */
export function createScriptJudgeNode(
  dependencies: Pick<EvaluationNodeDependencies, "runJudgeScript">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; artifact: typeof ARTIFACT_PORT },
    Record<string, never>,
    ScriptJudgeConfig
  >({
    type: SCRIPT_JUDGE_NODE_TYPE,
    version: 1,
    role: "judge",
    verdicts: true,
    inputs: { task: TASK_PORT, artifact: ARTIFACT_PORT },
    outputs: {},
    async run(context) {
      if (!dependencies.runJudgeScript) {
        return evaluationExcused.infra("script_runner_unavailable", {
          facts: { evaluatorId: context.config.evaluatorId },
        });
      }
      try {
        const result = await dependencies.runJudgeScript({
          script: context.config.script,
          task: context.in.task,
          artifact: context.in.artifact,
          signal: context.signal,
        });
        if (result.verdicts.length === 0) {
          return evaluationExcused.judge("script_returned_no_verdict", {
            facts: { evaluatorId: context.config.evaluatorId },
          });
        }
        return evaluationPass({
          verdicts: scriptVerdicts(
            context.nodeId,
            context.config,
            result.verdicts,
            result.durationMs,
          ),
        });
      } catch (cause) {
        return scriptFailure(cause, context.config.evaluatorId);
      }
    },
  });
}

/** Judges the trajectory with code the user wrote. */
export function createScriptTrajectoryJudgeNode(
  dependencies: Pick<EvaluationNodeDependencies, "runJudgeScript">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; trajectory: typeof TRAJECTORY_PORT },
    Record<string, never>,
    ScriptJudgeConfig
  >({
    type: SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE,
    version: 1,
    role: "judge",
    verdicts: true,
    inputs: { task: TASK_PORT, trajectory: TRAJECTORY_PORT },
    outputs: {},
    async run(context) {
      if (!dependencies.runJudgeScript) {
        return evaluationExcused.infra("script_runner_unavailable", {
          facts: { evaluatorId: context.config.evaluatorId },
        });
      }
      try {
        const result = await dependencies.runJudgeScript({
          script: context.config.script,
          task: context.in.task,
          trajectory: context.in.trajectory,
          signal: context.signal,
        });
        if (result.verdicts.length === 0) {
          return evaluationExcused.judge("script_returned_no_verdict", {
            facts: { evaluatorId: context.config.evaluatorId },
          });
        }
        return evaluationPass({
          verdicts: scriptVerdicts(
            context.nodeId,
            context.config,
            result.verdicts,
            result.durationMs,
          ),
        });
      } catch (cause) {
        return scriptFailure(cause, context.config.evaluatorId);
      }
    },
  });
}

interface ParsedJudgeVerdict {
  score: number | null;
  dimension?: string;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
}

function parseJudgeOutput(output: string): ParsedJudgeVerdict[] | null {
  const block = output.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.verdicts)) {
    const verdicts = record.verdicts
      .map((item) => parsedJudgeVerdict(item))
      .filter((item): item is ParsedJudgeVerdict => item !== null);
    return verdicts.length > 0 ? verdicts : null;
  }
  const verdict = parsedJudgeVerdict(record);
  return verdict ? [verdict] : null;
}

function parsedJudgeVerdict(value: unknown): ParsedJudgeVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawScore = typeof record.score === "number" ? record.score : Number.NaN;
  const dimension = typeof record.dimension === "string" ? record.dimension.trim() : "";
  return {
    // A judge that answered without a usable number has not scored anything.
    // Coercing that to 0 is indistinguishable from a judge that deliberately
    // failed the answer.
    score: Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : null,
    ...(dimension ? { dimension } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(stringArray(record.evidence) ? { evidence: stringArray(record.evidence)! } : {}),
    ...(stringArray(record.failedCriteria)
      ? { failedCriteria: stringArray(record.failedCriteria)! }
      : {}),
  };
}

function matchesDimensionContract(
  verdicts: readonly ParsedJudgeVerdict[],
  contract: readonly EvaluationDimensionContractItem[],
): boolean {
  if (verdicts.length !== contract.length) return false;
  const received = verdicts.map((item) => item.dimension ?? "");
  return new Set(received).size === received.length
    && contract.every((item) => received.includes(item.name));
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}
