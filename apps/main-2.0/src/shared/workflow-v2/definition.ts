import type { WorkflowV2ExecutionLeasePolicy } from "./supervision";
import type { WorkflowV2HookActionDef, WorkflowV2NodeHooks } from "./hooks";
export type {
  WorkflowV2HookActionDef,
  WorkflowV2HookActionKind,
  WorkflowV2HookFailurePolicy,
  WorkflowV2HookLifecycle,
  WorkflowV2HookSource,
  WorkflowV2NodeHooks,
} from "./hooks";

// Core shared contract for Workflow V2. This file is kept close to the source
// repo shape so higher layers can be migrated without inventing an adapter yet.
export type WorkflowV2NodeRole = "orchestrator" | "executor" | "reviewer";
export type WorkflowV2ExecModel = "llm" | "script";
export type WorkflowV2ExecutionMode = "one-shot" | "interactive" | "script";
export type WorkflowV2ModelProfile = "fast" | "balanced" | "expert";
export type WorkflowV2ScriptLanguage = "python" | "typescript" | "bash";
export type WorkflowV2ScriptRiskLevel = "safe" | "read" | "write" | "dangerous";
export type WorkflowV2ScriptEffectMode = "pure" | "workspace_only" | "brokered_external";
export type WorkflowV2ScriptIdempotency = "safe_retry" | "keyed" | "non_idempotent";
export type WorkflowV2ScriptStderrPolicy = "ignore" | "warn" | "fail";
export type WorkflowV2ScriptErrorPolicy = "fail" | "skip" | "ask_human" | "retry";
export type WorkflowV2ScriptCapability = "workspace_read" | "workspace_write" | "workspace_delete" | "external_read" | "external_write" | "external_delete" | "network_read" | "network_write" | "process_spawn" | "shell_execute" | "environment_read" | "credential_read" | "system_config_write";
export type WorkflowV2ScriptPermissionDecision = "auto_allow" | "allow_once" | "require_confirmation" | "deny";
export type WorkflowV2ScriptParameterLocation = "argument" | "environment" | "header" | "query" | "body" | "stdin";
export type WorkflowV2ScriptParameterValueType = "string" | "number" | "boolean" | "json" | "secret" | "file" | "directory";
export type WorkflowV2ScriptParameterSource = "user" | "workflow" | "upstream" | "literal";
export type WorkflowV2ScriptParameterValue = string | number | boolean | Record<string, unknown> | unknown[];
export type WorkflowV2ScriptParameterEnumValue = string | number | boolean;
export interface WorkflowV2ScriptAuthorization {
  decision: WorkflowV2ScriptPermissionDecision;
  workflowId: string;
  graphVersion: number;
  runId: string;
  nodeId: string;
  risk: WorkflowV2ScriptRiskLevel;
  capabilities: WorkflowV2ScriptCapability[];
  capabilityDigest: string;
  operationDigest: string;
  approvalRequestId?: string;
}
export interface WorkflowV2ScriptParameterDef {
  key: string;
  label: string;
  location: WorkflowV2ScriptParameterLocation;
  valueType: WorkflowV2ScriptParameterValueType;
  source: WorkflowV2ScriptParameterSource;
  required: boolean;
  description?: string;
  enum?: WorkflowV2ScriptParameterEnumValue[];
  defaultValue?: WorkflowV2ScriptParameterValue;
  workflowPath?: string;
  upstreamNodeId?: string;
  upstreamOutputKey?: string;
  literalValue?: WorkflowV2ScriptParameterValue;
}
export type WorkflowV2ExhaustedPolicy = "fail" | "skip" | "ask_human";
export type WorkflowV2ReviewLevel = "none" | "low" | "medium" | "high";
export type WorkflowV2ValidationOutcome = "pass" | "retry" | "fail" | "ask_human";
export type WorkflowV2TemplateParamValue = string | number | boolean | string[] | number[] | boolean[];
export type WorkflowV2OutputArtifactFormat = "markdown" | "text" | "json" | "html" | "csv";

export interface WorkflowTransactionPolicy {
  defaultMode: "strict_atomic" | "controlled" | "direct";
  approvalMode: "batch" | "per_operation" | "user_choice";
  checkpoints: Array<{
    id: string;
    title: string;
    afterNodeIds: string[];
    kind: "savepoint" | "commit";
    approval: "automatic" | "required";
  }>;
  retentionDays: number;
  onUnknown: "pause";
  onConflict: "user_or_manager";
}

export interface WorkflowV2OutputArtifactDef {
  format: WorkflowV2OutputArtifactFormat;
  fileName?: string;
}

export interface WorkflowV2OutputFieldDef {
  key: string;
  required?: boolean;
  description?: string;
  valueType?: WorkflowV2ScriptParameterValueType;
  artifact?: WorkflowV2OutputArtifactDef;
}

export interface WorkflowV2ConstraintDef {
  key: string;
  description: string;
  rule?: string;
}

export interface WorkflowV2JudgeDimensionDef {
  key: string;
  description: string;
}

export interface WorkflowV2ReviewGate {
  id: string;
  targetNodeId: string;
  configuredAgentId: string;
  reviewLevel: Exclude<WorkflowV2ReviewLevel, "none">;
  judgeDimensions: WorkflowV2JudgeDimensionDef[];
  maxQualityRetries: number;
}

export interface WorkflowV2ContextBudget {
  maxContextTokens: number;
  maxEvidenceItems?: number;
  maxUpstreamNodes?: number;
  summaryFallbackPolicy?: "truncate" | "summarize" | "ask_human";
}

export interface WorkflowV2Edge {
  fromNodeId: string;
  toNodeId: string;
}

export interface WorkflowV2BaseNode {
  id: string;
  kind: string;
  title: string;
  execModel: WorkflowV2ExecModel;
  role?: WorkflowV2NodeRole;
  outputFields: WorkflowV2OutputFieldDef[];
  hooks?: WorkflowV2NodeHooks;
  resourceLocks?: string[];
  executionLease?: WorkflowV2ExecutionLeasePolicy;
  executionMode?: WorkflowV2ExecutionMode;
  executionModeRationale?: string;
  executionModeConfidence?: number;
  /** @deprecated Read-only compatibility for definitions created before Review Gates. */
  reviewLevel?: WorkflowV2ReviewLevel;
  /** @deprecated Read-only compatibility for definitions created before Review Gates. */
  reviewMaxRetries?: number;
  /** @deprecated Read-only compatibility for definitions created before Review Gates. */
  judgeDimensions?: WorkflowV2JudgeDimensionDef[];
}

export interface WorkflowV2LLMNode extends WorkflowV2BaseNode {
  execModel: "llm";
  configuredAgentId?: string;
  modelId?: string;
  modelProfile?: WorkflowV2ModelProfile;
  prompt: string;
  constraints?: WorkflowV2ConstraintDef[];
  maxRetry?: number;
  onExhausted?: WorkflowV2ExhaustedPolicy;
  requiredTools?: string[];
  contextBudget?: WorkflowV2ContextBudget;
}

export interface WorkflowV2ScriptSpec {
  executable: { kind: "inline"; language: WorkflowV2ScriptLanguage; code: string } | { kind: "command"; command: string; args?: string[] };
  parameters: WorkflowV2ScriptParameterDef[];
  capabilities: WorkflowV2ScriptCapability[];
  managerRisk: { level: WorkflowV2ScriptRiskLevel; rationale: string };
  /** Required for governed workflows; optional only while loading legacy direct-mode definitions. */
  effectMode?: WorkflowV2ScriptEffectMode;
  /** Required for governed workflows; optional only while loading legacy direct-mode definitions. */
  idempotency?: WorkflowV2ScriptIdempotency;
  /** Required for governed workflows; optional only while loading legacy direct-mode definitions. */
  stderrPolicy?: WorkflowV2ScriptStderrPolicy;
  compensationAdapter?: string;
  timeoutMs?: number;
  outputSchema?: {
    type: "object";
    required?: string[];
    properties?: Record<string, {
      type: "string" | "number" | "boolean" | "object" | "array" | "null";
      nullable?: boolean;
      items?: { type: "string" | "number" | "boolean" | "object" };
    }>;
  };
}

export function createWorkflowV2InlineScriptSpec(input: {
  language: WorkflowV2ScriptLanguage;
  code: string;
  risk?: WorkflowV2ScriptRiskLevel;
  rationale?: string;
  timeoutMs?: number;
  outputSchema?: WorkflowV2ScriptSpec["outputSchema"];
}): WorkflowV2ScriptSpec {
  // Shared helper for tests and future callers that need a canonical "pure
  // inline transform" script contract without filling every field manually.
  return {
    executable: { kind: "inline", language: input.language, code: input.code },
    parameters: [],
    capabilities: [],
    managerRisk: { level: input.risk ?? "safe", rationale: input.rationale ?? "Pure in-memory transformation without external side effects." },
    effectMode: "pure",
    idempotency: "safe_retry",
    stderrPolicy: "warn",
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
}

export interface WorkflowV2ScriptNode extends WorkflowV2BaseNode {
  execModel: "script";
  script: WorkflowV2ScriptSpec;
  expectedExitCode?: number;
  maxRetry?: number;
  onError?: WorkflowV2ScriptErrorPolicy;
}

export type WorkflowV2Node = WorkflowV2LLMNode | WorkflowV2ScriptNode;

export interface WorkflowV2LLMNodeTemplate extends Omit<WorkflowV2LLMNode, "id" | "title"> {
  id: string;
  title?: string;
  category?: string;
  description?: string;
  whenToUse?: string;
}

export interface WorkflowV2ScriptNodeTemplate extends Omit<WorkflowV2ScriptNode, "id" | "title"> {
  id: string;
  title?: string;
  category?: string;
  description?: string;
  whenToUse?: string;
}

export type WorkflowV2NodeTemplate = WorkflowV2LLMNodeTemplate | WorkflowV2ScriptNodeTemplate;

export interface WorkflowV2TemplateNodeOverrides {
  kind?: string;
  title?: string;
  role?: WorkflowV2NodeRole;
  outputFields?: WorkflowV2OutputFieldDef[];
  hooks?: WorkflowV2NodeHooks;
  resourceLocks?: string[];
  executionLease?: WorkflowV2ExecutionLeasePolicy;
  modelProfile?: WorkflowV2ModelProfile;
  configuredAgentId?: string;
  modelId?: string;
  prompt?: string;
  judgeDimensions?: WorkflowV2JudgeDimensionDef[];
  constraints?: WorkflowV2ConstraintDef[];
  maxRetry?: number;
  onExhausted?: WorkflowV2ExhaustedPolicy;
  requiredTools?: string[];
  contextBudget?: WorkflowV2ContextBudget;
  reviewLevel?: WorkflowV2ReviewLevel;
  reviewMaxRetries?: number;
  script?: WorkflowV2ScriptSpec;
  expectedExitCode?: number;
  onError?: WorkflowV2ScriptErrorPolicy;
}

export interface WorkflowV2TemplateNodeDraft {
  id: string;
  templateId: string;
  params?: Record<string, WorkflowV2TemplateParamValue>;
  overrides?: WorkflowV2TemplateNodeOverrides;
}

export type WorkflowV2AuthoredNode = WorkflowV2Node | WorkflowV2TemplateNodeDraft;

export interface WorkflowV2Definition {
  workflowId: string;
  graphVersion: number;
  objective: string;
  /** @deprecated Runtime Review is required whenever reviewGates is non-empty. */
  reviewEnabled?: boolean;
  nodes: WorkflowV2Node[];
  edges: WorkflowV2Edge[];
  /** Optional only while reading definitions created before Review Gates. */
  reviewGates?: WorkflowV2ReviewGate[];
  /** Missing on legacy definitions, which are normalized to direct mode. */
  transactionPolicy?: WorkflowTransactionPolicy;
}

export interface WorkflowV2AuthoredDefinition {
  workflowId: string;
  graphVersion: number;
  objective: string;
  reviewEnabled?: boolean;
  nodes: WorkflowV2AuthoredNode[];
  edges: WorkflowV2Edge[];
  reviewGates?: WorkflowV2ReviewGate[];
  transactionPolicy?: WorkflowTransactionPolicy;
}

export interface WorkflowV2ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  topologicalNodeIds: string[];
}

export interface WorkflowV2NodeValidationResult {
  outcome: WorkflowV2ValidationOutcome;
  reasons: string[];
  missingOutputFields: string[];
}
