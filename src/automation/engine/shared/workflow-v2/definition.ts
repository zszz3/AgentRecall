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

export type WorkflowV2NodeRole = "orchestrator" | "executor" | "reviewer";
export type WorkflowV2ExecModel = "llm" | "script";
export type WorkflowV2ExecutionMode = "one-shot" | "interactive" | "script";
export type WorkflowV2ModelProfile = "fast" | "balanced" | "expert";
export type WorkflowV2ScriptLanguage = "python" | "typescript" | "bash";
export type WorkflowV2ScriptRiskLevel = "safe" | "read" | "write" | "dangerous";
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
export type WorkflowV2PassThreshold = "must" | "should" | "nice_to_have";
export type WorkflowV2ValidationOutcome = "pass" | "retry" | "fail" | "ask_human";
export type WorkflowV2TemplateParamValue = string | number | boolean | string[] | number[] | boolean[];

export interface WorkflowV2OutputFieldDef {
  key: string;
  required?: boolean;
  description?: string;
  valueType?: WorkflowV2ScriptParameterValueType;
}

export interface WorkflowV2ConstraintDef {
  key: string;
  description: string;
  rule?: string;
}

export interface WorkflowV2JudgeDimensionDef {
  key: string;
  description?: string;
  passThreshold?: WorkflowV2PassThreshold;
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
}

export interface WorkflowV2LLMNode extends WorkflowV2BaseNode {
  execModel: "llm";
  configuredAgentId?: string;
  modelId?: string;
  modelProfile?: WorkflowV2ModelProfile;
  prompt: string;
  judgeDimensions?: WorkflowV2JudgeDimensionDef[];
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
  timeoutMs?: number;
  outputSchema?: { type: "object"; required?: string[] };
}

export function createWorkflowV2InlineScriptSpec(input: {
  language: WorkflowV2ScriptLanguage;
  code: string;
  risk?: WorkflowV2ScriptRiskLevel;
  rationale?: string;
  timeoutMs?: number;
  outputSchema?: { type: "object"; required?: string[] };
}): WorkflowV2ScriptSpec {
  return {
    executable: { kind: "inline", language: input.language, code: input.code },
    parameters: [],
    capabilities: [],
    managerRisk: { level: input.risk ?? "safe", rationale: input.rationale ?? "Pure in-memory transformation without external side effects." },
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
}

export interface WorkflowV2ScriptNode extends WorkflowV2BaseNode {
  execModel: "script";
  script: WorkflowV2ScriptSpec;
  expectedExitCode?: number;
  onError?: WorkflowV2ExhaustedPolicy;
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
  script?: WorkflowV2ScriptSpec;
  expectedExitCode?: number;
  onError?: WorkflowV2ExhaustedPolicy;
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
  nodes: WorkflowV2Node[];
  edges: WorkflowV2Edge[];
}

export interface WorkflowV2AuthoredDefinition {
  workflowId: string;
  graphVersion: number;
  objective: string;
  nodes: WorkflowV2AuthoredNode[];
  edges: WorkflowV2Edge[];
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
