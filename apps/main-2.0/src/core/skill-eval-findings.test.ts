import { describe, expect, it } from "vitest";

import { assertFindingWording, evaluateSkillFindings } from "./skill-eval-findings";
import type { SkillPerformanceSignals, SkillToolOutcome } from "./postgres/skill-repository";

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

const NO_TOOLS: SkillToolOutcome[] = [];

describe("evaluateSkillFindings", () => {
  // ── Rule 1: installed-never-exercised ──────────────────────────────

  describe("installed-never-exercised", () => {
    it("fires when skill is installed and observable with zero triggers", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: { observation: "never-used", installed: true, totalTriggers: 0 },
        signals: NO_SIGNALS,
        toolOutcomes: NO_TOOLS,
      });
      const f = findings.find((x) => x.rule === "installed-never-exercised");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("low");
      expect(f!.evidenceStrength).toBe("Present");
      expect(f!.sampleSize).toBe(0);
    });

    it("stays silent when observation is unobserved (not never-used)", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: { observation: "unobserved", installed: true, totalTriggers: 0 },
        signals: NO_SIGNALS,
        toolOutcomes: NO_TOOLS,
      });
      expect(findings.find((x) => x.rule === "installed-never-exercised")).toBeUndefined();
    });

    it("stays silent when skill is exercised (has triggers)", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: { observation: "exercised", installed: true, totalTriggers: 5 },
        signals: NO_SIGNALS,
        toolOutcomes: NO_TOOLS,
      });
      expect(findings.find((x) => x.rule === "installed-never-exercised")).toBeUndefined();
    });

    it("stays silent when no overview item is provided", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: null,
        signals: NO_SIGNALS,
        toolOutcomes: NO_TOOLS,
      });
      expect(findings).toHaveLength(0);
    });
  });

  // ── Rule 2: tool-failure-rate ───────────────────────────────────────
  // Threshold: callCount ≥ 5 AND failureRate ≥ 40%

  describe("tool-failure-rate", () => {
    const baseTool = (overrides: Partial<SkillToolOutcome>): SkillToolOutcome => ({
      toolName: "Bash",
      callCount: 10,
      failureCount: 0,
      sampleSpanIds: [],
      sampleErrors: [],
      ...overrides,
    });

    // Table-driven boundary tests
    const cases: Array<{ label: string; tool: SkillToolOutcome; shouldFire: boolean }> = [
      { label: "callCount=4 (below sample minimum)", tool: baseTool({ callCount: 4, failureCount: 4 }), shouldFire: false },
      { label: "callCount=5, rate=20% (below rate threshold)", tool: baseTool({ callCount: 5, failureCount: 1 }), shouldFire: false },
      { label: "callCount=5, rate=40% (at threshold)", tool: baseTool({ callCount: 5, failureCount: 2 }), shouldFire: true },
      { label: "callCount=10, rate=50% (well above)", tool: baseTool({ callCount: 10, failureCount: 5 }), shouldFire: true },
      { label: "callCount=5, rate=0% (no failures)", tool: baseTool({ callCount: 5, failureCount: 0 }), shouldFire: false },
      { label: "callCount=20, rate=40% (at threshold, larger sample)", tool: baseTool({ callCount: 20, failureCount: 8 }), shouldFire: true },
    ];

    for (const { label, tool, shouldFire } of cases) {
      it(`${shouldFire ? "fires" : "stays silent"} when ${label}`, () => {
        const findings = evaluateSkillFindings({
          skill: "review",
          overviewItem: { observation: "exercised", installed: true, totalTriggers: tool.callCount },
          signals: NO_SIGNALS,
          toolOutcomes: [tool],
        });
        const f = findings.find((x) => x.rule === "tool-failure-rate");
        if (shouldFire) {
          expect(f).toBeDefined();
          expect(f!.severity).toBe("medium");
          expect(f!.evidenceStrength).toBe("Exercised");
          expect(f!.evidence.toolName).toBe("Bash");
          expect(f!.evidence.spanIds).toEqual(tool.sampleSpanIds);
        } else {
          expect(f).toBeUndefined();
        }
      });
    }

    it("only counts status=failed, not aborted (verified by failureCount field)", () => {
      // The evaluator receives pre-aggregated data from listSkillToolOutcomes,
      // which only counts status='failed'. This test verifies the evaluator
      // uses failureCount as-is without adding any other status.
      const tool: SkillToolOutcome = {
        toolName: "Bash",
        callCount: 10,
        failureCount: 4, // 40% exactly
        sampleSpanIds: ["span-1", "span-2"],
        sampleErrors: ["timeout"],
      };
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: { observation: "exercised", installed: true, totalTriggers: 10 },
        signals: NO_SIGNALS,
        toolOutcomes: [tool],
      });
      const f = findings.find((x) => x.rule === "tool-failure-rate");
      expect(f).toBeDefined();
      expect(f!.evidence.values?.failureCount).toBe(4);
    });
  });

  // ── Rule 3: cost-outlier ────────────────────────────────────────────
  // Threshold: sampleSize ≥ 5 AND medianTotalTokens ≥ baseline × 3

  describe("cost-outlier", () => {
    const baseSignals = (overrides: Partial<SkillPerformanceSignals>): SkillPerformanceSignals => ({
      ...NO_SIGNALS,
      sampleSize: 10,
      medianTotalTokens: 30_000,
      baselineMedianTotalTokens: 10_000,
      ...overrides,
    });

    const cases: Array<{ label: string; signals: SkillPerformanceSignals; shouldFire: boolean }> = [
      { label: "sampleSize=4 (below minimum)", signals: baseSignals({ sampleSize: 4, medianTotalTokens: 100_000 }), shouldFire: false },
      { label: "sampleSize=5, multiplier=2.9× (below threshold)", signals: baseSignals({ sampleSize: 5, medianTotalTokens: 29_000, baselineMedianTotalTokens: 10_000 }), shouldFire: false },
      { label: "sampleSize=5, multiplier=3× (at threshold)", signals: baseSignals({ sampleSize: 5, medianTotalTokens: 30_000, baselineMedianTotalTokens: 10_000 }), shouldFire: true },
      { label: "sampleSize=10, multiplier=5× (well above)", signals: baseSignals({ sampleSize: 10, medianTotalTokens: 50_000, baselineMedianTotalTokens: 10_000 }), shouldFire: true },
      { label: "medianTotalTokens=null", signals: baseSignals({ medianTotalTokens: null }), shouldFire: false },
      { label: "baselineMedianTotalTokens=0 (edge: division guard)", signals: baseSignals({ baselineMedianTotalTokens: 0 }), shouldFire: false },
      { label: "baselineMedianTotalTokens=null", signals: baseSignals({ baselineMedianTotalTokens: null }), shouldFire: false },
    ];

    for (const { label, signals, shouldFire } of cases) {
      it(`${shouldFire ? "fires" : "stays silent"} when ${label}`, () => {
        const findings = evaluateSkillFindings({
          skill: "review",
          overviewItem: { observation: "exercised", installed: true, totalTriggers: signals.sampleSize },
          signals,
          toolOutcomes: NO_TOOLS,
        });
        const f = findings.find((x) => x.rule === "cost-outlier");
        if (shouldFire) {
          expect(f).toBeDefined();
          expect(f!.severity).toBe("low");
        } else {
          expect(f).toBeUndefined();
        }
      });
    }
  });

  // ── Rule 4: error-prone-triggers ────────────────────────────────────
  // Threshold: sampleSize ≥ 5 AND errorTurnRatio ≥ 50% AND errorTurnRatio ≥ baseline × 2

  describe("error-prone-triggers", () => {
    const baseSignals = (overrides: Partial<SkillPerformanceSignals>): SkillPerformanceSignals => ({
      ...NO_SIGNALS,
      sampleSize: 10,
      errorTurnRatio: 0.6,
      baselineErrorTurnRatio: 0.2,
      ...overrides,
    });

    const cases: Array<{ label: string; signals: SkillPerformanceSignals; shouldFire: boolean }> = [
      { label: "sampleSize=4 (below minimum)", signals: baseSignals({ sampleSize: 4, errorTurnRatio: 1.0 }), shouldFire: false },
      { label: "sampleSize=5, ratio=49% (below ratio threshold)", signals: baseSignals({ sampleSize: 5, errorTurnRatio: 0.49 }), shouldFire: false },
      { label: "sampleSize=5, ratio=50%, but baseline=0.3 (×1.67, below ×2)", signals: baseSignals({ sampleSize: 5, errorTurnRatio: 0.5, baselineErrorTurnRatio: 0.3 }), shouldFire: false },
      { label: "sampleSize=5, ratio=50%, baseline=0.25 (×2, at threshold)", signals: baseSignals({ sampleSize: 5, errorTurnRatio: 0.5, baselineErrorTurnRatio: 0.25 }), shouldFire: true },
      { label: "sampleSize=10, ratio=60%, baseline=0.2 (×3, well above)", signals: baseSignals({ sampleSize: 10, errorTurnRatio: 0.6, baselineErrorTurnRatio: 0.2 }), shouldFire: true },
      { label: "errorTurnRatio=null", signals: baseSignals({ errorTurnRatio: null }), shouldFire: false },
      { label: "baselineErrorTurnRatio=null", signals: baseSignals({ baselineErrorTurnRatio: null }), shouldFire: false },
      { label: "baselineErrorTurnRatio=0 (edge: division guard)", signals: baseSignals({ baselineErrorTurnRatio: 0 }), shouldFire: false },
    ];

    for (const { label, signals, shouldFire } of cases) {
      it(`${shouldFire ? "fires" : "stays silent"} when ${label}`, () => {
        const findings = evaluateSkillFindings({
          skill: "review",
          overviewItem: { observation: "exercised", installed: true, totalTriggers: signals.sampleSize },
          signals,
          toolOutcomes: NO_TOOLS,
        });
        const f = findings.find((x) => x.rule === "error-prone-triggers");
        if (shouldFire) {
          expect(f).toBeDefined();
          expect(f!.severity).toBe("medium");
        } else {
          expect(f).toBeUndefined();
        }
      });
    }
  });

  // ── Wording discipline ───────────────────────────────────────────────

  describe("wording discipline", () => {
    it("no finding contains causal language in observation", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: { observation: "never-used", installed: true, totalTriggers: 0 },
        signals: {
          sampleSize: 10,
          medianTotalTokens: 50_000,
          baselineMedianTotalTokens: 10_000,
          errorTurnRatio: 0.6,
          baselineErrorTurnRatio: 0.2,
          baselineTurnCount: 100,
          baselineMedianDurationMs: null,
          medianDurationMs: null,
        },
        toolOutcomes: [{
          toolName: "Bash",
          callCount: 10,
          failureCount: 5,
          sampleSpanIds: ["s1"],
          sampleErrors: ["err"],
        }],
      });
      // Should have 4 findings (all rules fire)
      expect(findings).toHaveLength(4);
      const violations = assertFindingWording(findings);
      expect(violations).toEqual([]);
    });

    it("assertFindingWording catches violations", () => {
      const fakeFindings = [
        {
          rule: "test",
          skill: "test",
          severity: "low" as const,
          evidenceStrength: "Present" as const,
          sampleSize: 0,
          observation: "This skill 导致 errors",
          repairDirection: "You should fix it",
          evidence: {},
        },
      ];
      const violations = assertFindingWording(fakeFindings);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("导致"))).toBe(true);
      expect(violations.some((v) => v.includes("Consider checking"))).toBe(true);
    });
  });

  // ── Multiple rules can fire simultaneously ──────────────────────────

  describe("multiple findings", () => {
    it("fires all four rules when all thresholds are met", () => {
      const findings = evaluateSkillFindings({
        skill: "review",
        overviewItem: null, // no installed-never-exercised
        signals: {
          sampleSize: 10,
          medianTotalTokens: 50_000,
          baselineMedianTotalTokens: 10_000,
          medianDurationMs: null,
          errorTurnRatio: 0.6,
          baselineErrorTurnRatio: 0.2,
          baselineTurnCount: 100,
          baselineMedianDurationMs: null,
        },
        toolOutcomes: [{
          toolName: "Bash",
          callCount: 10,
          failureCount: 5,
          sampleSpanIds: ["s1", "s2"],
          sampleErrors: ["timeout"],
        }],
      });
      // 3 rules fire: cost-outlier, error-prone-triggers, tool-failure-rate
      expect(findings).toHaveLength(3);
      const rules = findings.map((f) => f.rule);
      expect(rules).toContain("cost-outlier");
      expect(rules).toContain("error-prone-triggers");
      expect(rules).toContain("tool-failure-rate");
    });
  });
});
