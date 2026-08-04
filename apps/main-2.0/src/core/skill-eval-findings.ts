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

// Finding copy is authored bilingually at the source; the renderer picks the
// text matching the app language.
export interface FindingText {
  en: string;
  zh: string;
}

export interface SkillFinding {
  rule: string;
  skill: string;
  severity: SkillFindingSeverity;
  evidenceStrength: SkillFindingEvidenceStrength;
  sampleSize: number;
  observation: FindingText;
  repairDirection: FindingText;
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

// Causal wording forbidden in observation text (asserted in tests).
const CAUSAL_WORDS_ZH = ["导致", "造成", "因为", "引起", "使得"];
const CAUSAL_PATTERN_EN = /\bbecause\b|\bcaus(es|ed?)\b|\bleads? to\b|\bresults? in\b/i;

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
      observation: {
        en: `Skill "${skill}" is installed but has zero trigger records within the observable range.`,
        zh: `技能「${skill}」已安装，但在可观测范围内没有任何触发记录。`,
      },
      repairDirection: {
        en: "Consider checking whether the description makes it hard for the model to select this skill, or removing it to reduce context usage.",
        zh: "建议检查该技能的描述是否让模型难以选中它，或考虑移除以减少上下文占用。",
      },
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
          observation: {
            en: `Tool "${outcome.toolName}" failed ${outcome.failureCount} of ${outcome.callCount} times (${Math.round(rate * 100)}%) in turns where this skill was triggered.`,
            zh: `在触发该技能的轮次中，工具「${outcome.toolName}」调用 ${outcome.callCount} 次，失败 ${outcome.failureCount} 次（${Math.round(rate * 100)}%）。`,
          },
          repairDirection: {
            en: "Consider checking the skill's usage instructions and prerequisites for this tool.",
            zh: "建议检查该技能中此工具的使用说明与前置条件。",
          },
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
        observation: {
          en: `Trigger turns have a median of ${signals.medianTotalTokens} tokens, ${multiplier.toFixed(1)}× the library-wide median of ${signals.baselineMedianTotalTokens}. This is a correlation, not a causal claim.`,
          zh: `触发轮次的 token 中位数为 ${signals.medianTotalTokens}，是全库中位数 ${signals.baselineMedianTotalTokens} 的 ${multiplier.toFixed(1)} 倍。这是相关性观察，不是因果结论。`,
        },
        repairDirection: {
          en: "Consider checking whether the skill introduces excessive context or a long workflow.",
          zh: "建议检查该技能是否引入了过多上下文或过长的工作流。",
        },
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
      observation: {
        en: `${Math.round(signals.errorTurnRatio * 100)}% of trigger turns (${signals.sampleSize} samples) had errors, compared to ${Math.round(signals.baselineErrorTurnRatio * 100)}% library-wide.`,
        zh: `${Math.round(signals.errorTurnRatio * 100)}% 的触发轮次（${signals.sampleSize} 个样本）带有错误，全库占比为 ${Math.round(signals.baselineErrorTurnRatio * 100)}%。`,
      },
      repairDirection: {
        en: "Consider checking the skill's failure-path handling.",
        zh: "建议检查该技能对失败路径的处理。",
      },
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
// language in either language, and that repairDirection only suggests checking.
export function assertFindingWording(findings: SkillFinding[]): string[] {
  const violations: string[] = [];
  for (const f of findings) {
    for (const word of CAUSAL_WORDS_ZH) {
      if (f.observation.zh.includes(word)) {
        violations.push(`${f.rule}: observation(zh) contains "${word}"`);
      }
    }
    if (CAUSAL_PATTERN_EN.test(f.observation.en)) {
      violations.push(`${f.rule}: observation(en) contains causal wording`);
    }
    if (!/^Consider checking/i.test(f.repairDirection.en)) {
      violations.push(`${f.rule}: repairDirection(en) must start with "Consider checking"`);
    }
    if (!/^建议检查/.test(f.repairDirection.zh)) {
      violations.push(`${f.rule}: repairDirection(zh) must start with "建议检查"`);
    }
  }
  return violations;
}
