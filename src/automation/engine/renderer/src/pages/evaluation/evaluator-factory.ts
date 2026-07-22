import type { EvaluationEvaluator } from "../../../../shared/types";
import { instantiateEvaluatorTemplate, type EvaluationEvaluatorTemplate } from "../../../../shared/evaluation-templates";

export function createBlankEvaluator(now = Date.now()): EvaluationEvaluator {
  return {
    id: `evaluator-${now}`,
    name: "Contains expected",
    kind: "contains",
    threshold: 1,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createEvaluatorFromTemplate(template: EvaluationEvaluatorTemplate, now = Date.now()): EvaluationEvaluator {
  return instantiateEvaluatorTemplate(template, now);
}
