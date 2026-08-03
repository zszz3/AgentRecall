export interface EvaluationDatasetItem {
  id: string;
  input: string;
  expectedOutput?: string;
  metadata: Record<string, unknown>;
  sequence: number;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  items: EvaluationDatasetItem[];
  createdAt: number;
  updatedAt: number;
}

export type EvaluatorKind = "contains" | "exact_match" | "json_valid" | "llm_judge";

export interface EvaluationEvaluator {
  id: string;
  name: string;
  kind: EvaluatorKind;
  prompt?: string;
  runtimeId?: string;
  threshold: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationExperiment {
  id: string;
  name: string;
  datasetId: string;
  agentId: string;
  evaluatorIds: string[];
  repetitions: number;
  // Skill regression binding (phase four). Null for generic experiments created
  // before skill binding existed. skill_hash is the SKILL.md hash at the
  // time of the most recent run, refreshed before every run so each run is
  // attributed to the version that actually executed it.
  skillName?: string | null;
  skillHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvaluationScore {
  evaluatorId: string;
  score: number;
  passed: boolean;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
  durationMs: number;
  tokenCount?: number;
  estimatedCost?: number;
}

export interface EvaluationCaseResult {
  id: string;
  runId: string;
  datasetItemId: string;
  repetition: number;
  input: string;
  expectedOutput?: string;
  output: string;
  error?: string;
  durationMs: number;
  scores: EvaluationScore[];
}

export interface EvaluationRun {
  id: string;
  experimentId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  agentRevisionId?: string;
  startedAt: number;
  finishedAt?: number;
  averageScore?: number;
  minimumScore?: number;
  passRate?: number;
  totalDurationMs?: number;
  error?: string;
  results: EvaluationCaseResult[];
}

export type EvaluationRunSummary = Omit<EvaluationRun, "results"> & {
  resultCount: number;
  failedResultCount: number;
};

export interface ListEvaluationRunsRequest {
  experimentId?: string;
  offset?: number;
  limit?: number;
}

export interface EvaluationRunPage {
  items: EvaluationRunSummary[];
  total: number;
  offset: number;
  limit: number;
}
