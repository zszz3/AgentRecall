import type {
  WorkflowV2ConstraintDef,
  WorkflowV2ContextBudget,
  WorkflowV2Definition,
  WorkflowV2ExecModel,
  WorkflowV2ExecutionMode,
  WorkflowV2ModelProfile,
  WorkflowV2Node,
  WorkflowV2NodeRole,
  WorkflowV2OutputFieldDef,
  WorkflowV2ScriptCapability,
  WorkflowV2ScriptParameterLocation,
  WorkflowV2ScriptParameterValueType,
  WorkflowV2ScriptRiskLevel,
} from "./definition";
import { isWorkflowV2ModelProfile, isWorkflowV2NodeRole } from "./validation";

export interface WorkflowV2CostBudget {
  maxModelCalls?: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
  maxWallClockMs?: number;
}

export interface WorkflowV2AcceptanceCriterion {
  key: string;
  description: string;
  required?: boolean;
}

export interface WorkflowV2RoleRoute {
  role: WorkflowV2NodeRole;
  modelProfile: WorkflowV2ModelProfile;
}

export interface WorkflowV2BudgetEnvelope {
  context: WorkflowV2ContextBudget;
  cost?: WorkflowV2CostBudget;
}

export interface WorkflowV2UpstreamDigest {
  nodeId: string;
  title: string;
  summary: string;
  outputKeys?: string[];
  riskSummary?: string;
}

export interface WorkflowV2TaskPacket {
  nodeId: string;
  title: string;
  role: WorkflowV2NodeRole;
  execModel: WorkflowV2ExecModel;
  executionMode: WorkflowV2ExecutionMode;
  executionModeRationale: string;
  executionModeConfidence: number;
  modelProfile: WorkflowV2ModelProfile;
  configuredAgentId?: string;
  modelId?: string;
  objective: string;
  acceptanceCriteria: WorkflowV2AcceptanceCriterion[];
  constraints: WorkflowV2ConstraintDef[];
  upstreamDigest: WorkflowV2UpstreamDigest[];
  outputFields: WorkflowV2OutputFieldDef[];
  downstreamRequirements?: WorkflowV2DownstreamRequirement[];
  budget: WorkflowV2BudgetEnvelope;
}

export interface WorkflowV2ResultPacket {
  nodeId: string;
  summary: string;
  outputs: Record<string, unknown>;
  evidence?: string[];
  risks?: string[];
  nextStepSuggestions?: string[];
}

export interface WorkflowV2PlanNode {
  nodeId: string;
  title: string;
  role: WorkflowV2NodeRole;
  execModel: WorkflowV2ExecModel;
  executionMode: WorkflowV2ExecutionMode;
  executionModeRationale: string;
  executionModeConfidence: number;
  modelProfile: WorkflowV2ModelProfile;
  configuredAgentId?: string;
  modelId?: string;
  acceptanceCriteria: WorkflowV2AcceptanceCriterion[];
  budget: WorkflowV2BudgetEnvelope;
  taskPacket: WorkflowV2TaskPacket;
  scriptGovernance?: {
    managerRisk: WorkflowV2ScriptRiskLevel;
    reviewerRisk: WorkflowV2ScriptRiskLevel;
    staticRisk: WorkflowV2ScriptRiskLevel;
    effectiveRisk: WorkflowV2ScriptRiskLevel;
    capabilities: WorkflowV2ScriptCapability[];
    capabilityDigest: string;
    reviewedRevision: number;
  };
}

export interface WorkflowV2DownstreamRequirement {
  downstreamNodeId: string;
  downstreamNodeTitle: string;
  parameterKey: string;
  parameterLabel: string;
  upstreamOutputKey: string;
  location: WorkflowV2ScriptParameterLocation;
  valueType: WorkflowV2ScriptParameterValueType;
  required: boolean;
  description?: string;
}

export interface WorkflowV2Plan {
  workflowId: string;
  objective: string;
  graphVersion: number;
  definition: WorkflowV2Definition;
  approvedBy: string;
  frozenAt: number;
  acceptanceCriteria: WorkflowV2AcceptanceCriterion[];
  roleDefaults: Record<WorkflowV2NodeRole, WorkflowV2RoleRoute>;
  nodes: WorkflowV2PlanNode[];
  budget: WorkflowV2BudgetEnvelope;
}

export interface WorkflowV2GraphRevision {
  revisionId: string;
  basedOnGraphVersion: number;
  nextGraphVersion?: number;
  reason: string;
  changesSummary: string;
  approvedBy: string;
  createdAt: number;
}

export const DEFAULT_WORKFLOW_V2_CONTEXT_BUDGET: WorkflowV2ContextBudget = {
  maxContextTokens: 4000,
  maxEvidenceItems: 8,
  maxUpstreamNodes: 4,
};

export function cloneWorkflowV2Plan<TPlan extends WorkflowV2Plan>(plan: TPlan): TPlan {
  return structuredClone(plan);
}

export function workflowV2DefaultRoleRoutes(): Record<WorkflowV2NodeRole, WorkflowV2RoleRoute> {
  return {
    orchestrator: { role: "orchestrator", modelProfile: "expert" },
    executor: { role: "executor", modelProfile: "fast" },
    reviewer: { role: "reviewer", modelProfile: "expert" },
  };
}

export function deriveWorkflowV2AcceptanceCriteria(definition: WorkflowV2Definition): WorkflowV2AcceptanceCriterion[] {
  const criteria: WorkflowV2AcceptanceCriterion[] = [];

  for (const node of definition.nodes) {
    criteria.push(...deriveWorkflowV2NodeAcceptanceCriteria(node));
  }

  if (criteria.length > 0) return criteria;
  return [
    {
      key: "workflow.objective",
      description: definition.objective,
      required: true,
    },
  ];
}

export function deriveWorkflowV2NodeAcceptanceCriteria(node: WorkflowV2Node): WorkflowV2AcceptanceCriterion[] {
  const criteria: WorkflowV2AcceptanceCriterion[] = [];

  for (const outputField of node.outputFields) {
    if (outputField.required === false) continue;
    criteria.push({
      key: `${node.id}.${outputField.key}`,
      description: `Node ${node.title} must produce output field ${outputField.key}.`,
      required: true,
    });
  }

  if (node.execModel === "llm") {
    for (const constraint of node.constraints ?? []) {
      criteria.push({
        key: `${node.id}.constraint.${constraint.key}`,
        description: constraint.description,
        required: true,
      });
    }
  }

  return criteria;
}

export function createWorkflowV2TaskPacket(input: {
  node: WorkflowV2Node;
  workflowObjective: string;
  acceptanceCriteria: WorkflowV2AcceptanceCriterion[];
  roleRoutes: Record<WorkflowV2NodeRole, WorkflowV2RoleRoute>;
  defaultContextBudget: WorkflowV2ContextBudget;
  upstreamDigest?: WorkflowV2UpstreamDigest[];
  downstreamRequirements?: WorkflowV2DownstreamRequirement[];
  costBudget?: WorkflowV2CostBudget;
}): WorkflowV2TaskPacket {
  const role = resolveWorkflowV2NodeRole(input.node);
  const modelProfile = resolveWorkflowV2NodeModelProfile(input.node, input.roleRoutes);
  const executionMode = resolveWorkflowV2ExecutionMode(input.node);
  const budget = {
    context: cloneContextBudget(input.node.execModel === "llm" ? input.node.contextBudget ?? input.defaultContextBudget : input.defaultContextBudget),
    ...(input.costBudget ? { cost: cloneCostBudget(input.costBudget) } : {}),
  };
  const nodeAcceptanceCriteria = deriveWorkflowV2NodeAcceptanceCriteria(input.node);
  const upstreamDigest = (input.upstreamDigest ?? []).slice(0, budget.context.maxUpstreamNodes ?? input.upstreamDigest?.length);
  const downstreamRequirements = input.downstreamRequirements ?? [];

  return {
    nodeId: input.node.id,
    title: input.node.title,
    role,
    execModel: input.node.execModel,
    executionMode: executionMode.mode,
    executionModeRationale: executionMode.rationale,
    executionModeConfidence: executionMode.confidence,
    modelProfile,
    ...(input.node.execModel === "llm" && input.node.configuredAgentId ? { configuredAgentId: input.node.configuredAgentId } : {}),
    ...(input.node.execModel === "llm" && input.node.modelId ? { modelId: input.node.modelId } : {}),
    objective: input.workflowObjective,
    acceptanceCriteria: nodeAcceptanceCriteria.length > 0 ? nodeAcceptanceCriteria : input.acceptanceCriteria.map(cloneAcceptanceCriterion),
    constraints: input.node.execModel === "llm" ? [...(input.node.constraints ?? [])] : [],
    upstreamDigest: upstreamDigest.map(cloneUpstreamDigest),
    outputFields: input.node.outputFields.map((field) => ({ ...field })),
    ...(downstreamRequirements.length > 0 ? { downstreamRequirements: downstreamRequirements.map((requirement) => ({ ...requirement })) } : {}),
    budget,
  };
}

export function deriveWorkflowV2DownstreamRequirements(
  definition: WorkflowV2Definition,
  nodeId: string,
): WorkflowV2DownstreamRequirement[] {
  const directDownstreamNodeIds = new Set(definition.edges
    .filter((edge) => edge.fromNodeId === nodeId)
    .map((edge) => edge.toNodeId));

  return definition.nodes.flatMap((node) => {
    if (node.execModel !== "script" || !directDownstreamNodeIds.has(node.id)) return [];
    return node.script.parameters
      .filter((parameter) => parameter.source === "upstream" && parameter.upstreamNodeId === nodeId && Boolean(parameter.upstreamOutputKey))
      .map((parameter) => ({
        downstreamNodeId: node.id,
        downstreamNodeTitle: node.title,
        parameterKey: parameter.key,
        parameterLabel: parameter.label,
        upstreamOutputKey: parameter.upstreamOutputKey!,
        location: parameter.location,
        valueType: parameter.valueType,
        required: parameter.required,
        ...(parameter.description ? { description: parameter.description } : {}),
      }));
  });
}

export function deriveWorkflowV2DirectUpstreamDigest(
  definition: WorkflowV2Definition,
  nodeId: string,
): WorkflowV2UpstreamDigest[] {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  return definition.edges
    .filter((edge) => edge.toNodeId === nodeId)
    .map((edge) => nodeById.get(edge.fromNodeId))
    .filter((node): node is WorkflowV2Node => Boolean(node))
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      summary: `Await output packet from ${node.title}.`,
      outputKeys: node.outputFields.map((field) => field.key),
    }));
}

export function resolveWorkflowV2ExecutionMode(node: WorkflowV2Node): {
  mode: WorkflowV2ExecutionMode;
  rationale: string;
  confidence: number;
} {
  if (!node.executionMode) {
    throw new Error(`Workflow V2 node ${node.id} must declare execution mode explicitly.`);
  }
  const mode = node.executionMode;
  if (mode === "script" && node.execModel !== "script") {
    throw new Error(`Workflow V2 node ${node.id} cannot use script execution mode with ${node.execModel} execution.`);
  }
  if ((mode === "one-shot" || mode === "interactive") && node.execModel !== "llm") {
    throw new Error(`Workflow V2 node ${node.id} cannot use ${mode} execution mode with ${node.execModel} execution.`);
  }
  const rationale = node.executionModeRationale?.trim()
    || (mode === "interactive"
      ? "The node requires multi-turn user clarification before completion."
      : mode === "script"
        ? "The node is deterministic and executes through the script runtime."
        : "The node has bounded inputs and can complete in one agent turn.");
  const confidence = node.executionModeConfidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Workflow V2 node ${node.id} execution mode confidence must be between 0 and 1.`);
  }
  return { mode, rationale, confidence };
}
export function resolveWorkflowV2NodeRole(node: WorkflowV2Node): WorkflowV2NodeRole {
  const role: unknown = node.role === undefined ? "executor" : node.role;
  if (!isWorkflowV2NodeRole(role)) {
    throw new Error(`Workflow V2 node ${node.id} has unsupported role ${String(role)}.`);
  }
  return role;
}

export function resolveWorkflowV2NodeModelProfile(
  node: WorkflowV2Node,
  roleRoutes: Record<WorkflowV2NodeRole, WorkflowV2RoleRoute>,
): WorkflowV2ModelProfile {
  const role = resolveWorkflowV2NodeRole(node);
  if (node.execModel === "llm" && node.modelProfile !== undefined) {
    if (!isWorkflowV2ModelProfile(node.modelProfile)) {
      throw new Error(`Workflow V2 llm node ${node.id} has unsupported model profile ${String(node.modelProfile)}.`);
    }
    return node.modelProfile;
  }
  const route = roleRoutes[role];
  if (!route) throw new Error(`Workflow V2 node ${node.id} has no model route for role ${role}.`);
  return route.modelProfile;
}

function cloneAcceptanceCriterion(criterion: WorkflowV2AcceptanceCriterion): WorkflowV2AcceptanceCriterion {
  return { ...criterion };
}

function cloneContextBudget(budget: WorkflowV2ContextBudget): WorkflowV2ContextBudget {
  return { ...budget };
}

function cloneCostBudget(budget: WorkflowV2CostBudget): WorkflowV2CostBudget {
  return { ...budget };
}

function cloneUpstreamDigest(digest: WorkflowV2UpstreamDigest): WorkflowV2UpstreamDigest {
  return {
    ...digest,
    ...(digest.outputKeys ? { outputKeys: [...digest.outputKeys] } : {}),
  };
}
