/**
 * Reasoning effort levels the AI summary routes can ask for.
 *
 * The empty string is a deliberate, first-class choice rather than "unset": it means send no
 * reasoning parameter at all and let the model, the gateway, or `config.toml` decide. That is
 * the only value guaranteed to be safe against an arbitrary OpenAI-compatible endpoint, some of
 * which reject `reasoning_effort` outright, so it is what the custom route defaults to.
 */
export const SUMMARY_REASONING_EFFORTS = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type SummaryReasoningEffort = typeof SUMMARY_REASONING_EFFORTS[number];

export function normalizeSummaryReasoningEffort(value: unknown): SummaryReasoningEffort {
  const candidate = String(value ?? "").trim();
  return SUMMARY_REASONING_EFFORTS.includes(candidate as SummaryReasoningEffort)
    ? (candidate as SummaryReasoningEffort)
    : "";
}
