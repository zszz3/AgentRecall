import { describe, expect, it } from "vitest";

import { assertFindingWording, evaluateSkillFindings } from "./skill-eval-findings";
import type { SkillPerformanceSignals } from "./storage/types";

const NO_SIGNALS: SkillPerformanceSignals = {
  sampleSize: 0,
  medianTotalTokens: null,
  medianDurationMs: null,
  errorTurnRatio: null,
  baselineTurnCount: 0,
  baselineMedianTotalTokens: null,
  baselineMedianDurationMs: null,
  baselineErrorTurnRatio: null,
};

describe("evaluateSkillFindings", () => {
  it("enforces threshold boundaries across all four finding rules without division-by-zero", () => {
    expect(evaluateSkillFindings({
      skill: "review",
      overviewItem: { observation: "unobserved", installed: true, totalTriggers: 0 },
      signals: { ...NO_SIGNALS, sampleSize: 4, medianTotalTokens: 99_999, baselineMedianTotalTokens: 0, errorTurnRatio: 1, baselineErrorTurnRatio: 0 },
      toolOutcomes: [{ toolName: "Bash", callCount: 4, failureCount: 4, sampleSpanIds: [], sampleErrors: [] }],
    })).toEqual([]);

    expect(evaluateSkillFindings({
      skill: "review",
      overviewItem: { observation: "exercised", installed: true, totalTriggers: 5 },
      signals: { ...NO_SIGNALS, sampleSize: 5, medianTotalTokens: 29_000, baselineMedianTotalTokens: 10_000, errorTurnRatio: 0.5, baselineErrorTurnRatio: 0.3 },
      toolOutcomes: [{ toolName: "Bash", callCount: 5, failureCount: 1, sampleSpanIds: [], sampleErrors: [] }],
    })).toEqual([]);

    const fired = evaluateSkillFindings({
      skill: "review",
      overviewItem: { observation: "never-used", installed: true, totalTriggers: 0 },
      signals: {
        ...NO_SIGNALS,
        sampleSize: 5,
        medianTotalTokens: 30_000,
        baselineMedianTotalTokens: 10_000,
        errorTurnRatio: 0.5,
        baselineErrorTurnRatio: 0.25,
      },
      toolOutcomes: [{ toolName: "Bash", callCount: 5, failureCount: 2, sampleSpanIds: ["s1"], sampleErrors: ["timeout"] }],
    });

    expect(fired.map((f) => f.rule).sort()).toEqual([
      "cost-outlier",
      "error-prone-triggers",
      "installed-never-exercised",
      "tool-failure-rate",
    ]);
    expect(assertFindingWording(fired)).toEqual([]);
  });

  it("flags causal or prescriptive wording violations", () => {
    const violations = assertFindingWording([{
      rule: "test",
      skill: "test",
      severity: "low",
      evidenceStrength: "Present",
      sampleSize: 0,
      observation: { en: "This skill causes errors", zh: "这个技能导致错误" },
      repairDirection: { en: "You should fix it", zh: "你应该修复它" },
      evidence: {},
    }]);
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });
});
