import type { WorkflowV2Definition, WorkflowV2ModelProfile, WorkflowV2NodeRole } from "../../../shared/workflow-v2/definition";
import type {
  WorkflowV2AcceptanceCriterion,
  WorkflowV2CostBudget,
  WorkflowV2GraphRevision,
  WorkflowV2Plan,
  WorkflowV2RoleRoute,
} from "../../../shared/workflow-v2/planning";
import {
  createWorkflowV2TaskPacket,
  DEFAULT_WORKFLOW_V2_CONTEXT_BUDGET,
  deriveWorkflowV2DownstreamRequirements,
  deriveWorkflowV2DirectUpstreamDigest,
  deriveWorkflowV2AcceptanceCriteria,
  resolveWorkflowV2NodeModelProfile,
  resolveWorkflowV2ExecutionMode,
  resolveWorkflowV2NodeRole,
  workflowV2DefaultRoleRoutes,
} from "../../../shared/workflow-v2/planning";
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isValidWorkflowV2ContextBudget,
  isValidWorkflowV2CostBudget,
  isWorkflowV2ModelProfile,
  validateWorkflowV2Definition,
  workflowV2AcceptanceCriteriaValidationErrors,
} from "../../../shared/workflow-v2/validation";
import { normalizeWorkflowV2TerminalNode } from "../../../shared/workflow-v2/topology";

export class WorkflowV2PlanBuildError extends Error {
  constructor(
    message: string,
    readonly details?: {
      errors?: string[];
      warnings?: string[];
    },
  ) {
    super(message);
    this.name = "WorkflowV2PlanBuildError";
  }
}

export interface BuildWorkflowV2PlanRequest {
  definition: WorkflowV2Definition;
  objective?: string;
  acceptanceCriteria?: WorkflowV2AcceptanceCriterion[];
  contextBudget?: typeof DEFAULT_WORKFLOW_V2_CONTEXT_BUDGET;
  costBudget?: WorkflowV2CostBudget;
  roleModelProfiles?: Partial<Record<WorkflowV2NodeRole, WorkflowV2ModelProfile>>;
  approvedBy: string;
  now?: number;
}

export interface BuildWorkflowV2GraphRevisionRequest {
  basedOnGraphVersion: number;
  nextGraphVersion?: number;
  reason: string;
  changesSummary: string;
  approvedBy: string;
  now?: number;
}

export function buildWorkflowV2PlanSync(input: BuildWorkflowV2PlanRequest): WorkflowV2Plan {
  const normalizedDefinition = normalizeWorkflowV2TerminalNode(input.definition).definition;
  const validation = validateWorkflowV2Definition(normalizedDefinition);
  if (!validation.valid) {
    throw new WorkflowV2PlanBuildError("Workflow V2 definition is not plannable.", {
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  const contextBudget = input.contextBudget ?? DEFAULT_WORKFLOW_V2_CONTEXT_BUDGET;
  const inputErrors: string[] = [];
  if (!isValidWorkflowV2ContextBudget(contextBudget)) {
    inputErrors.push("Workflow V2 planner requires a valid context budget.");
  }
  if (input.costBudget !== undefined && !isValidWorkflowV2CostBudget(input.costBudget)) {
    inputErrors.push("Workflow V2 planner requires a valid cost budget.");
  }

  const approvedBy = typeof input.approvedBy === "string" ? input.approvedBy.trim() : "";
  if (!approvedBy) inputErrors.push("Workflow V2 planner requires a non-empty approvedBy.");

  const frozenAt = input.now ?? Date.now();
  if (!isNonNegativeSafeInteger(frozenAt)) {
    inputErrors.push("Workflow V2 planner requires now to be a non-negative safe integer.");
  }

  let objective = normalizedDefinition.objective.trim();
  if (input.objective !== undefined) {
    if (typeof input.objective !== "string") {
      inputErrors.push("Workflow V2 planner objective override must be a string when provided.");
    } else if (input.objective.trim()) {
      objective = input.objective.trim();
    }
  }
  if (!objective) inputErrors.push("Workflow V2 planner requires a non-empty objective.");

  let customAcceptanceCriteria: WorkflowV2AcceptanceCriterion[] | undefined;
  if (input.acceptanceCriteria !== undefined) {
    if (!Array.isArray(input.acceptanceCriteria)) {
      inputErrors.push("Workflow V2 planner acceptance criteria must be an array when provided.");
    } else {
      const acceptanceCriteriaErrors = workflowV2AcceptanceCriteriaValidationErrors(input.acceptanceCriteria);
      inputErrors.push(...acceptanceCriteriaErrors);
      if (acceptanceCriteriaErrors.length === 0) {
        customAcceptanceCriteria = input.acceptanceCriteria.map((criterion) => ({
          ...criterion,
          key: criterion.key.trim(),
          description: criterion.description.trim(),
        }));
      }
    }
  }

  if (input.roleModelProfiles !== undefined) {
    if (!isRecord(input.roleModelProfiles)) {
      inputErrors.push("Workflow V2 planner role model profiles must be an object when provided.");
    } else {
      const roles: WorkflowV2NodeRole[] = ["orchestrator", "executor", "reviewer"];
      for (const [role, modelProfile] of Object.entries(input.roleModelProfiles)) {
        if (!roles.includes(role as WorkflowV2NodeRole)) {
          inputErrors.push(`Workflow V2 planner does not support role ${role}.`);
        } else if (!isWorkflowV2ModelProfile(modelProfile)) {
          inputErrors.push(`Workflow V2 planner role ${role} requires a valid model profile.`);
        }
      }
    }
  }

  if (inputErrors.length > 0) {
    throw new WorkflowV2PlanBuildError("Workflow V2 plan input is not plannable.", { errors: inputErrors });
  }

  const frozenDefinition = structuredClone(normalizedDefinition);
  const roleDefaults = mergeWorkflowV2RoleRoutes(input.roleModelProfiles);
  const acceptanceCriteria = customAcceptanceCriteria ?? deriveWorkflowV2AcceptanceCriteria(frozenDefinition);
  const acceptanceCriteriaErrors = workflowV2AcceptanceCriteriaValidationErrors(acceptanceCriteria);
  if (acceptanceCriteriaErrors.length > 0) {
    throw new WorkflowV2PlanBuildError("Workflow V2 acceptance criteria are not plannable.", {
      errors: acceptanceCriteriaErrors,
    });
  }
  const budget = {
    context: { ...contextBudget },
    ...(input.costBudget ? { cost: { ...input.costBudget } } : {}),
  };
  const nodeById = new Map(frozenDefinition.nodes.map((node) => [node.id, node]));

  const nodes = validation.topologicalNodeIds.map((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) throw new WorkflowV2PlanBuildError(`Workflow V2 planner lost node ${nodeId} during topological planning.`);

    const upstreamDigest = deriveWorkflowV2DirectUpstreamDigest(frozenDefinition, node.id);
    const downstreamRequirements = deriveWorkflowV2DownstreamRequirements(frozenDefinition, node.id);
    const taskPacket = createWorkflowV2TaskPacket({
      node,
      workflowObjective: objective,
      acceptanceCriteria,
      roleRoutes: roleDefaults,
      defaultContextBudget: budget.context,
      upstreamDigest,
      downstreamRequirements,
      ...(budget.cost ? { costBudget: budget.cost } : {}),
    });

    const executionMode = resolveWorkflowV2ExecutionMode(node);
    return {
      nodeId: node.id,
      title: node.title,
      role: resolveWorkflowV2NodeRole(node),
      execModel: node.execModel,
      executionMode: executionMode.mode,
      executionModeRationale: executionMode.rationale,
      executionModeConfidence: executionMode.confidence,
      modelProfile: resolveWorkflowV2NodeModelProfile(node, roleDefaults),
      ...(node.execModel === "llm" && node.configuredAgentId ? { configuredAgentId: node.configuredAgentId } : {}),
      ...(node.execModel === "llm" && node.modelId ? { modelId: node.modelId } : {}),
      acceptanceCriteria: taskPacket.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      budget: {
        context: { ...taskPacket.budget.context },
        ...(taskPacket.budget.cost ? { cost: { ...taskPacket.budget.cost } } : {}),
      },
      taskPacket,
    };
  });

  return {
    workflowId: frozenDefinition.workflowId,
    objective,
    graphVersion: frozenDefinition.graphVersion,
    definition: frozenDefinition,
    approvedBy,
    frozenAt,
    acceptanceCriteria,
    roleDefaults,
    nodes,
    budget,
  };
}

export async function buildWorkflowV2Plan(input: BuildWorkflowV2PlanRequest): Promise<WorkflowV2Plan> {
  return buildWorkflowV2PlanSync(input);
}

export function buildWorkflowV2GraphRevision(input: BuildWorkflowV2GraphRevisionRequest): WorkflowV2GraphRevision {
  const errors: string[] = [];
  if (!isPositiveSafeInteger(input.basedOnGraphVersion)) {
    errors.push("Workflow V2 graph revision requires basedOnGraphVersion to be a positive safe integer.");
  }
  if (input.nextGraphVersion !== undefined) {
    if (!isPositiveSafeInteger(input.nextGraphVersion)) {
      errors.push("Workflow V2 graph revision requires nextGraphVersion to be a positive safe integer when provided.");
    } else if (isPositiveSafeInteger(input.basedOnGraphVersion) && input.nextGraphVersion <= input.basedOnGraphVersion) {
      errors.push("Workflow V2 graph revision requires nextGraphVersion to be greater than basedOnGraphVersion.");
    }
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) errors.push("Workflow V2 graph revision requires reason to be a non-empty string.");
  const changesSummary = typeof input.changesSummary === "string" ? input.changesSummary.trim() : "";
  if (!changesSummary) errors.push("Workflow V2 graph revision requires changesSummary to be a non-empty string.");
  const approvedBy = typeof input.approvedBy === "string" ? input.approvedBy.trim() : "";
  if (!approvedBy) errors.push("Workflow V2 graph revision requires approvedBy to be a non-empty string.");
  const createdAt = input.now ?? Date.now();
  if (!isNonNegativeSafeInteger(createdAt)) {
    errors.push("Workflow V2 graph revision requires now to be a non-negative safe integer when provided.");
  }
  if (errors.length > 0) {
    throw new WorkflowV2PlanBuildError("Workflow V2 graph revision input is invalid.", { errors });
  }
  return {
    revisionId: `graph-revision-${createdAt}`,
    basedOnGraphVersion: input.basedOnGraphVersion,
    ...(input.nextGraphVersion !== undefined ? { nextGraphVersion: input.nextGraphVersion } : {}),
    reason,
    changesSummary,
    approvedBy,
    createdAt,
  };
}

function mergeWorkflowV2RoleRoutes(
  overrides: Partial<Record<WorkflowV2NodeRole, WorkflowV2ModelProfile>> | undefined,
): Record<WorkflowV2NodeRole, WorkflowV2RoleRoute> {
  const routes = workflowV2DefaultRoleRoutes();
  if (!overrides) return routes;

  for (const [role, modelProfile] of Object.entries(overrides) as Array<[WorkflowV2NodeRole, WorkflowV2ModelProfile | undefined]>) {
    if (!modelProfile) continue;
    routes[role] = { role, modelProfile };
  }
  return routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
