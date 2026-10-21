export const OPENVIKING_EXTRACTION_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENVIKING_RECALL_TOKEN_BUDGET = 1_200;
export const MIN_OPENVIKING_RECALL_TOKEN_BUDGET = 256;
export const MAX_OPENVIKING_RECALL_TOKEN_BUDGET = 8_192;

export const OPENVIKING_RECALL_MEMORY_TYPES = [
  "profile",
  "preferences",
  "entities",
  "events",
  "decisions",
  "open_loops",
  "cases",
  "experiences",
  "trajectories",
  "skills",
  "tools",
] as const;

export type OpenVikingRecallMemoryType = typeof OPENVIKING_RECALL_MEMORY_TYPES[number];
export type OpenVikingRecallScoreThresholds = Record<string, number>;

export const DEFAULT_OPENVIKING_RECALL_SCORE_THRESHOLDS: OpenVikingRecallScoreThresholds = {
  default: 0.25,
  profile: 0.20,
  preferences: 0.30,
  entities: 0.35,
  events: 0.45,
  decisions: 0.45,
  open_loops: 0.40,
  cases: 0.50,
  experiences: 0.50,
  trajectories: 0.55,
  skills: 0.50,
  tools: 0.50,
};

export type OpenVikingExtractionReasoningEffort =
  typeof OPENVIKING_EXTRACTION_REASONING_EFFORTS[number];

export function normalizeOpenVikingRecallTokenBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPENVIKING_RECALL_TOKEN_BUDGET;
  return Math.max(
    MIN_OPENVIKING_RECALL_TOKEN_BUDGET,
    Math.min(MAX_OPENVIKING_RECALL_TOKEN_BUDGET, Math.floor(value)),
  );
}

export function normalizeOpenVikingRecallScoreThresholds(value: unknown): OpenVikingRecallScoreThresholds {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalized: OpenVikingRecallScoreThresholds = { ...DEFAULT_OPENVIKING_RECALL_SCORE_THRESHOLDS };
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(key) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
    normalized[key] = Math.max(0, Math.min(1, raw));
  }
  return normalized;
}
