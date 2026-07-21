import type {
  WorkflowV2NodeExecutionState,
  WorkflowV2RunNodeState,
  WorkflowV2RunState,
} from "../../../shared/workflow-v2/state";
import type { WorkflowV2NodeValidationResult } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2HumanIntervention, WorkflowV2ReviewVerdict } from "../../../shared/workflow-v2/review";

export interface WorkflowV2NodeStateTransition {
  nodeId: string;
  status: Extract<
    WorkflowV2NodeExecutionState,
    "ready" | "running" | "validating" | "awaiting_review" | "paused" | "skipped" | "completed" | "failed"
  >;
  now?: number;
  error?: string;
  validation?: WorkflowV2NodeValidationResult;
  reviewVerdict?: WorkflowV2ReviewVerdict;
  intervention?: WorkflowV2HumanIntervention;
}

export function listWorkflowV2RunnableNodeIds(runState: WorkflowV2RunState): string[] {
  if (runState.status !== "running") return [];

  const runningNodes = orderedNodes(runState).filter((node) => node.status === "running");
  const availableSlots = runState.maxParallelNodes - runningNodes.length;
  if (availableSlots <= 0) return [];

  const reservedLocks = new Set(runningNodes.flatMap((node) => node.resourceLocks));
  const runnable: string[] = [];

  for (const node of orderedNodes(runState)) {
    if (node.status !== "ready") continue;
    if (node.resourceLocks.some((lock) => reservedLocks.has(lock))) continue;
    runnable.push(node.nodeId);
    for (const lock of node.resourceLocks) reservedLocks.add(lock);
    if (runnable.length >= availableSlots) break;
  }

  return runnable;
}

export function transitionWorkflowV2NodeState(
  runState: WorkflowV2RunState,
  transition: WorkflowV2NodeStateTransition,
): WorkflowV2RunState {
  const target = runState.nodes[transition.nodeId];
  if (!target) throw new Error(`Workflow V2 run node ${transition.nodeId} was not found.`);

  const nextNodes = cloneNodes(runState.nodes);
  const nextTarget = nextNodes[transition.nodeId]!;
  const now = transition.now ?? Date.now();

  if (transition.status === "ready") {
    nextTarget.status = "ready";
    delete nextTarget.finishedAt;
    if (transition.error !== undefined) nextTarget.lastError = transition.error;
    else delete nextTarget.lastError;
  } else if (transition.status === "running") {
    nextTarget.status = "running";
    nextTarget.attempt += 1;
    nextTarget.startedAt = now;
    delete nextTarget.finishedAt;
    delete nextTarget.lastError;
    delete nextTarget.validation;
    delete nextTarget.reviewVerdict;
    delete nextTarget.intervention;
  } else if (transition.status === "validating") {
    nextTarget.status = "validating";
    if (transition.validation !== undefined) nextTarget.validation = transition.validation;
    else delete nextTarget.validation;
  } else if (transition.status === "awaiting_review") {
    nextTarget.status = "awaiting_review";
    if (transition.reviewVerdict !== undefined) nextTarget.reviewVerdict = transition.reviewVerdict;
  } else if (transition.status === "paused") {
    nextTarget.status = "paused";
    nextTarget.finishedAt = now;
    if (transition.intervention !== undefined) nextTarget.intervention = transition.intervention;
    if (transition.reviewVerdict !== undefined) nextTarget.reviewVerdict = transition.reviewVerdict;
    if (transition.error !== undefined) nextTarget.lastError = transition.error;
  } else if (transition.status === "completed" || transition.status === "skipped") {
    nextTarget.status = transition.status;
    nextTarget.finishedAt = now;
    nextTarget.blockedBy = [];
    delete nextTarget.lastError;
  } else {
    nextTarget.status = "failed";
    nextTarget.finishedAt = now;
    nextTarget.lastError = transition.error ?? "Workflow V2 node failed.";
  }

  for (const nodeId of runState.nodeOrder) {
    if (nodeId === transition.nodeId) continue;
    const node = nextNodes[nodeId]!;
    if (!isWaitingNodeState(node.status)) continue;

    const blockedBy = node.dependsOn.filter((dependencyNodeId) => !isDependencySatisfied(nextNodes[dependencyNodeId]!.status));
    node.blockedBy = blockedBy;
    node.status = blockedBy.length === 0 ? "ready" : "blocked";
  }

  return {
    ...runState,
    status: deriveWorkflowV2RunStatus(nextNodes),
    nodes: nextNodes,
  };
}

function deriveWorkflowV2RunStatus(nodes: Record<string, WorkflowV2RunNodeState>): WorkflowV2RunState["status"] {
  const nodeStates = Object.values(nodes).map((node) => node.status);
  if (nodeStates.some((status) => status === "failed")) return "failed";
  if (nodeStates.some((status) => status === "paused")) return "paused";
  if (nodeStates.every(isDependencySatisfied)) return "completed";
  return "running";
}

function isWaitingNodeState(status: WorkflowV2NodeExecutionState): boolean {
  return status === "blocked" || status === "ready";
}

function isDependencySatisfied(status: WorkflowV2NodeExecutionState): boolean {
  return status === "completed" || status === "skipped";
}

function orderedNodes(runState: WorkflowV2RunState): WorkflowV2RunNodeState[] {
  return runState.nodeOrder.map((nodeId) => runState.nodes[nodeId]!).filter(Boolean);
}

function cloneNodes(nodes: Record<string, WorkflowV2RunNodeState>): Record<string, WorkflowV2RunNodeState> {
  return Object.fromEntries(
    Object.entries(nodes).map(([nodeId, node]) => [
      nodeId,
      {
        ...node,
        dependsOn: [...node.dependsOn],
        dependents: [...node.dependents],
        blockedBy: [...node.blockedBy],
        resourceLocks: [...node.resourceLocks],
        ...(node.validation ? {
          validation: {
            ...node.validation,
            reasons: [...node.validation.reasons],
            missingOutputFields: [...node.validation.missingOutputFields],
          },
        } : {}),
        ...(node.reviewVerdict ? { reviewVerdict: structuredClone(node.reviewVerdict) } : {}),
        ...(node.intervention ? { intervention: structuredClone(node.intervention) } : {}),
      } satisfies WorkflowV2RunNodeState,
    ]),
  );
}
