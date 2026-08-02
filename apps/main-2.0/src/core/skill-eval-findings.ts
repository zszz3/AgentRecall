// Pure-function finding evaluator for Eval phase three.
//
// Rules are the core asset of this design. They are kept as a table-driven
// module so tests can cover every threshold boundary without going through
// the service layer's mocks. The evaluator has a single domain responsibility
// (rule evaluation) and no I/O.
//
// Design constraints (see docs/eval/phase-03):
// - No "high" severity: all rules prove correlation, not causation.
// - Wording discipline: observation states facts; repairDirection suggests
//   checking, never prescribes a fix.
// - Samples below threshold stay silent — better to miss than to noise.

import type { SkillPerformanceSignals, SkillToolOutcome } from "./postgres/skill-repository";

export type SkillFindingSeverity = "low" | "medium";

export type SkillFindingEvidenceStrength = "Present" | "Exercised";

export interface SkillFinding {
  rule: string;
  skill: string;
  severity: SkillFindingSeverity;
  evidenceStrength: SkillFindingEvidenceStrength;
  sampleSize: number;
  observation: string;
  repairDirection: string;
  evidence: {
    turnIds?: string[];
    spanIds?: string[];
    toolName?: string;
    values?: Record<string, number | string>;
  };
}

// Threshold constants — engineering defaults, tunable with real data.
const MIN_SAMPLE = 5;
const TOOL_FAILURE_RATE = 0.4; // ≥40%
const COST_OUTLIER_MULTIPLIER = 3; // ≥3× baseline median
const ERROR_PRONE_RATIO = 0.5; // ≥50%
const ERROR_PRONE_BASELINE_MULTIPLIER = 2; // ≥2× baseline ratio

// Causal words forbidden in observation text (asserted in tests).
const CAUSAL_WORDS = ["导致", "造成", "因为", "导致", "引起", "使得"];

interface OverviewItemLike {
  observation: "exercised" | "never-used" | "unobserved";
  installed: boolean;
  totalTriggers: number;
}

interface EvaluateInput {
  skill: string;
  overviewItem: OverviewItemLike | null;
  signals: SkillPerformanceSignals;
  toolOutcomes: SkillToolOutcome[];
}

export function evaluateSkillFindings(input: EvaluateInput): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const { skill, overviewItem, signals, toolOutcomes } = input;

  // Rule 1: installed-never-exercised
  if (overviewItem?.installed && overviewItem.observation === "never-used") {
    findings.push({
      rule: "installed-never-exercised",
      skill,
      severity: "low",
      evidenceStrength: "Present",
      sampleSize: 0,
      observation: `Skill "${skill}" is installed but has zero trigger records within the observable range.`,
      repairDirection: "Consider checking whether the description makes it hard for the model to select this skill, or removing it to reduce context usage.",
      evidence: {},
    });
  }

  // Rule 2: tool-failure-rate
  for (const outcome of toolOutcomes) {
    if (outcome.callCount >= MIN_SAMPLE) {
      const rate = outcome.failureCount / outcome.callCount;
      if (rate >= TOOL_FAILURE_RATE) {
        findings.push({
          rule: "tool-failure-rate",
          skill,
          severity: "medium",
          evidenceStrength: "Exercised",
          sampleSize: outcome.callCount,
          observation: `Tool "${outcome.toolName}" failed ${outcome.failureCount} of ${outcome.callCount} times (${Math.round(rate * 100)}%) in turns where this skill was triggered.`,
          repairDirection: "Consider checking the skill's usage instructions and prerequisites for this tool.",
          evidence: {
            toolName: outcome.toolName,
            spanIds: outcome.sampleSpanIds,
            values: {
              callCount: outcome.callCount,
              failureCount: outcome.failureCount,
              failureRate: Math.round(rate * 100) / 100,
            },
          },
        });
      }
    }
  }

  // Rule 3: cost-outlier
  if (
    signals.sampleSize >= MIN_SAMPLE
    && signals.medianTotalTokens != null
    && signals.baselineMedianTotalTokens != null
    && signals.baselineMedianTotalTokens > 0
  ) {
    const multiplier = signals.medianTotalTokens / signals.baselineMedianTotalTokens;
    if (multiplier >= COST_OUTLIER_MULTIPLIER) {
      findings.push({
        rule: "cost-outlier",
        skill,
        severity: "low",
        evidenceStrength: "Exercised",
        sampleSize: signals.sampleSize,
        observation: `Trigger turns have a median of ${signals.medianTotalTokens} tokens, ${multiplier.toFixed(1)}× the library-wide median of ${signals.baselineMedianTotalTokens}. This is a correlation, not a causal claim.`,
        repairDirection: "Consider checking whether the skill introduces excessive context or a long workflow.",
        evidence: {
          values: {
            medianTotalTokens: signals.medianTotalTokens,
            baselineMedianTotalTokens: signals.baselineMedianTotalTokens,
            multiplier: Math.round(multiplier * 10) / 10,
            sampleSize: signals.sampleSize,
          },
        },
      });
    }
  }

  // Rule 4: error-prone-triggers
  if (
    signals.sampleSize >= MIN_SAMPLE
    && signals.errorTurnRatio != null
    && signals.errorTurnRatio >= ERROR_PRONE_RATIO
    && signals.baselineErrorTurnRatio != null
    && signals.baselineErrorTurnRatio > 0
    && signals.errorTurnRatio >= signals.baselineErrorTurnRatio * ERROR_PRONE_BASELINE_MULTIPLIER
  ) {
    findings.push({
      rule: "error-prone-triggers",
      skill,
      severity: "medium",
      evidenceStrength: "Exercised",
      sampleSize: signals.sampleSize,
      observation: `${Math.round(signals.errorTurnRatio * 100)}% of trigger turns (${signals.sampleSize} samples) had errors, compared to ${Math.round(signals.baselineErrorTurnRatio * 100)}% library-wide.`,
      repairDirection: "Consider checking the skill's failure-path handling.",
      evidence: {
        values: {
          errorTurnRatio: Math.round(signals.errorTurnRatio * 100) / 100,
          baselineErrorTurnRatio: Math.round(signals.baselineErrorTurnRatio * 100) / 100,
          sampleSize: signals.sampleSize,
        },
      },
    });
  }

  return findings;
}

// Exported for test assertions: verifies that no observation contains causal
// language, and that repairDirection only suggests checking.
export function assertFindingWording(findings: SkillFinding[]): string[] {
  const violations: string[] = [];
  for (const f of findings) {
    for (const word of CAUSAL_WORDS) {
      if (f.observation.includes(word)) {
        violations.push(`${f.rule}: observation contains "${word}"`);
      }
    }
    if (!/Consider checking/i.test(f.repairDirection)) {
      violations.push(`${f.rule}: repairDirection must start with "Consider checking"`);
    }
  }
  return violations;
}
