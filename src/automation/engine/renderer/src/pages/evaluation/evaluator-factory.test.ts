import { describe, expect, test } from "vitest";
import { createBlankEvaluator, createEvaluatorFromTemplate } from "./evaluator-factory";

describe("evaluator factory", () => {
  test("creates a complete blank evaluator without accepting UI event data", () => {
    expect(createBlankEvaluator(100)).toEqual({
      id: "evaluator-100",
      name: "Contains expected",
      kind: "contains",
      threshold: 1,
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
    });
  });

  test("creates a template evaluator through an explicit template API", () => {
    const evaluator = createEvaluatorFromTemplate({
      id: "quality",
      name: "Quality",
      description: "Judge quality",
      category: "answer-quality",
      kind: "llm_judge",
      prompt: "Score the answer",
      threshold: 0.8,
    }, 200);
    expect(evaluator).toMatchObject({ id: "evaluator-200", name: "Quality", kind: "llm_judge", prompt: "Score the answer", threshold: 0.8 });
  });
});
