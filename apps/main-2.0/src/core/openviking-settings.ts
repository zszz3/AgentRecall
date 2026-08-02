export const OPENVIKING_EXTRACTION_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const DEFAULT_OPENVIKING_CODEX_EXTRACTION_MODEL = "gpt-5.6-terra";

export type OpenVikingExtractionReasoningEffort =
  typeof OPENVIKING_EXTRACTION_REASONING_EFFORTS[number];
