import type { EvaluationEvaluator } from "../../../../automation/contracts";
import { judgeNodeType } from "../../../../core/evaluation/case-graph";
import { parseEvaluationDimensionContract } from "../../../../core/evaluation/dimension-contract";
import { localize, type LanguageMode } from "../../language";

/**
 * Dimensions, from the checks that judge them.
 *
 * A dimension is not a stored object: it is the group of checks that share a
 * `dimension` label, which is exactly how the engine reads them — verdicts are
 * averaged inside a dimension before dimensions combine by weight, so two checks on
 * one dimension do not quietly double that dimension's say.
 *
 * A check with no label is its own dimension, named after itself. That mirrors the
 * engine's default (`buildVerdict` in `nodes/judge-nodes.ts` falls back to the
 * evaluator id), so what is shown and what is scored cannot drift.
 */

export interface EvalDimension {
  name: string;
  checks: EvaluationEvaluator[];
  priority?: "must" | "should";
}

export function dimensionsOf(
  evaluators: readonly EvaluationEvaluator[],
): EvalDimension[] {
  const groups = new Map<string, EvalDimension>();
  for (const evaluator of evaluators) {
    const contract = parseEvaluationDimensionContract(evaluator.prompt ?? "");
    const declared = contract.length > 0
      ? contract
      : [{
          name: evaluator.dimension?.trim() || evaluator.name.trim() || evaluator.id,
          ...(evaluator.priority ? { priority: evaluator.priority } : {}),
        }];
    for (const item of declared) {
      const current = groups.get(item.name);
      groups.set(item.name, {
        name: item.name,
        checks: [...(current?.checks ?? []), evaluator],
        ...(item.priority ?? current?.priority
          ? { priority: item.priority ?? current?.priority }
          : {}),
      });
    }
  }
  return [...groups.values()];
}

/**
 * How a dimension decides, in words.
 *
 * The question a reader has is "is this judged by a model or by code", so the
 * answer names the methods rather than the checks. Several checks of one method
 * collapse into a count, because "LLM ×2" says what two lines would.
 */
export function methodText(
  language: LanguageMode,
  dimension: { name: string; checks: readonly EvaluationEvaluator[] },
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const counts = new Map<string, number>();
  for (const check of dimension.checks) {
    const method = methodOf(language, check);
    counts.set(method, (counts.get(method) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([method, count]) => (count > 1 ? l(`${method} ×${count}`, `${method} ${count} 条`) : method))
    .join(" · ");
}

/** One check's method, taken from the node type the runner would build for it. */
export function methodOf(language: LanguageMode, check: EvaluationEvaluator): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const type = judgeNodeType({
    id: check.id,
    kind: check.kind,
    threshold: check.threshold,
    ...(check.subject ? { subject: check.subject } : {}),
  });
  if (type === "llm_judge") return l("LLM", "LLM 评判");
  if (type === "script_judge") return l("script", "脚本");
  if (type === "script_trajectory_judge") return l("script · trajectory", "脚本 · 轨迹");
  if (type === "tool_failure_judge" || type === "trajectory_budget_judge") {
    return l("trajectory", "轨迹");
  }
  return l("check", "确定性");
}
