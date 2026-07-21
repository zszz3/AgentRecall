import { isDeepStrictEqual } from "node:util";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import {
  createWorkflowV2TaskPacket,
  deriveWorkflowV2DownstreamRequirements,
  deriveWorkflowV2DirectUpstreamDigest,
} from "../../../shared/workflow-v2/planning";
import {
  isNonNegativeSafeInteger,
  isValidWorkflowV2AcceptanceCriteria,
  isValidWorkflowV2BudgetEnvelope,
  isWorkflowV2ModelProfile,
  validateWorkflowV2Definition,
} from "../../../shared/workflow-v2/validation";

export function workflowV2PlanValidationError(
  workflow: WorkflowDraftState,
  plan: WorkflowV2Plan,
): string | undefined {
  if (!isRecord(plan)) return "Workflow V2 frozen plan must be an object.";
  if (typeof plan.approvedBy !== "string" || !plan.approvedBy.trim()) {
    return "Workflow V2 frozen plan requires a non-empty approvedBy.";
  }
  if (!isNonNegativeSafeInteger(plan.frozenAt)) {
    return "Workflow V2 frozen plan requires a finite non-negative frozenAt timestamp.";
  }
  if (typeof plan.objective !== "string" || !plan.objective.trim()) {
    return "Workflow V2 frozen plan requires a non-empty objective.";
  }
  if (!isRecord(plan.definition) || !Array.isArray(plan.definition.nodes) || !Array.isArray(plan.definition.edges)) {
    return "Workflow V2 frozen plan definition is malformed.";
  }
  if (plan.workflowId !== workflow.workflowId) {
    return `Workflow V2 plan ${plan.workflowId} does not belong to workflow ${workflow.workflowId}.`;
  }
  if (plan.definition.workflowId !== workflow.workflowId) {
    return `Workflow V2 definition ${plan.definition.workflowId} does not belong to workflow ${workflow.workflowId}.`;
  }
  if (plan.graphVersion !== plan.definition.graphVersion) {
    return `Workflow V2 plan graph version ${plan.graphVersion} does not match definition version ${plan.definition.graphVersion}.`;
  }
  const validation = (() => {
    try {
      return validateWorkflowV2Definition(plan.definition);
    } catch {
      return undefined;
    }
  })();
  if (!validation) return "Workflow V2 frozen plan definition is malformed.";
  if (!validation.valid) return validation.errors.join(" ");
  if (!isValidWorkflowV2AcceptanceCriteria(plan.acceptanceCriteria)) {
    return "Workflow V2 frozen plan acceptance criteria are malformed.";
  }
  if (!isValidWorkflowV2BudgetEnvelope(plan.budget)) return "Workflow V2 frozen plan budget is malformed.";
  if (!isWorkflowV2RoleDefaults(plan.roleDefaults)) return "Workflow V2 frozen plan role defaults are malformed.";
  if (!Array.isArray(plan.nodes)) return "Workflow V2 frozen plan nodes are malformed.";

  const definitionNodeById = new Map(plan.definition.nodes.map((node) => [node.id, node]));
  const planNodeIds = new Set<string>();
  if (plan.nodes.length !== definitionNodeById.size) return "Workflow V2 plan nodes do not match the frozen definition.";
  for (const planNode of plan.nodes) {
    if (!isRecord(planNode) || typeof planNode.nodeId !== "string") {
      return "Workflow V2 frozen plan nodes are malformed.";
    }
    const definitionNode = definitionNodeById.get(planNode.nodeId);
    if (!definitionNode || planNodeIds.has(planNode.nodeId)) {
      return "Workflow V2 plan nodes do not match the frozen definition.";
    }
    planNodeIds.add(planNode.nodeId);
  }
  if (!isDeepStrictEqual(plan.nodes.map((node) => node.nodeId), validation.topologicalNodeIds)) {
    return "Workflow V2 plan node order does not match the frozen definition topological order.";
  }

  for (const planNode of plan.nodes) {
    const definitionNode = definitionNodeById.get(planNode.nodeId)!;
    try {
      const expectedTaskPacket = createWorkflowV2TaskPacket({
        node: definitionNode,
        workflowObjective: plan.objective,
        acceptanceCriteria: plan.acceptanceCriteria,
        roleRoutes: plan.roleDefaults,
        defaultContextBudget: plan.budget.context,
        upstreamDigest: deriveWorkflowV2DirectUpstreamDigest(plan.definition, definitionNode.id),
        downstreamRequirements: deriveWorkflowV2DownstreamRequirements(plan.definition, definitionNode.id),
        ...(plan.budget.cost ? { costBudget: plan.budget.cost } : {}),
      });
      const comparableExpectedTaskPacket = { ...expectedTaskPacket };
      if (isRecord(planNode.taskPacket) && !Object.hasOwn(planNode.taskPacket, "downstreamRequirements")) {
        delete comparableExpectedTaskPacket.downstreamRequirements;
      }
      if (
        planNode.title !== definitionNode.title
        || planNode.execModel !== definitionNode.execModel
        || planNode.role !== expectedTaskPacket.role
        || planNode.modelProfile !== expectedTaskPacket.modelProfile
        || !isDeepStrictEqual(planNode.acceptanceCriteria, expectedTaskPacket.acceptanceCriteria)
        || !isDeepStrictEqual(planNode.budget, expectedTaskPacket.budget)
        || !isDeepStrictEqual(planNode.taskPacket, comparableExpectedTaskPacket)
      ) {
        return `Workflow V2 plan node ${planNode.nodeId} does not match the frozen definition and task packet.`;
      }
    } catch {
      return `Workflow V2 plan node ${planNode.nodeId} does not match the frozen definition and task packet.`;
    }
  }
  return undefined;
}

function isWorkflowV2RoleDefaults(value: unknown): value is WorkflowV2Plan["roleDefaults"] {
  if (!isRecord(value)) return false;
  const roles = ["orchestrator", "executor", "reviewer"] as const;
  if (Object.keys(value).some((role) => !roles.includes(role as typeof roles[number]))) return false;
  return roles.every((role) => {
    const route = value[role];
    return isRecord(route) && route.role === role && isWorkflowV2ModelProfile(route.modelProfile);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
