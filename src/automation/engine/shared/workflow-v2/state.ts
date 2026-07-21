import type { WorkflowV2Definition } from "./definition";
import type { WorkflowV2NodeValidationResult } from "./definition";
import type { WorkflowV2HumanIntervention, WorkflowV2ReviewVerdict } from "./review";

export type WorkflowV2NodeExecutionState =
  | "blocked"
  | "ready"
  | "running"
  | "validating"
  | "awaiting_review"
  | "paused"
  | "skipped"
  | "completed"
  | "failed";
export type WorkflowV2RunExecutionStatus = "running" | "paused" | "completed" | "failed";

export interface WorkflowV2RunNodeState {
  nodeId: string;
  title: string;
  status: WorkflowV2NodeExecutionState;
  dependsOn: string[];
  dependents: string[];
  blockedBy: string[];
  resourceLocks: string[];
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  validation?: WorkflowV2NodeValidationResult;
  reviewVerdict?: WorkflowV2ReviewVerdict;
  intervention?: WorkflowV2HumanIntervention;
}

export interface WorkflowV2RunState {
  workflowId: string;
  graphVersion: number;
  status: WorkflowV2RunExecutionStatus;
  maxParallelNodes: number;
  nodeOrder: string[];
  nodes: Record<string, WorkflowV2RunNodeState>;
}

export function createWorkflowV2RunState(input: {
  definition: WorkflowV2Definition;
  maxParallelNodes?: number;
}): WorkflowV2RunState {
  const requestedMaxParallelNodes = input.maxParallelNodes ?? Number.MAX_SAFE_INTEGER;
  const maxParallelNodes = Number.isFinite(requestedMaxParallelNodes)
    ? Math.max(1, Math.floor(requestedMaxParallelNodes))
    : Number.MAX_SAFE_INTEGER;
  const dependsOnByNodeId = new Map<string, string[]>();
  const dependentsByNodeId = new Map<string, string[]>();

  for (const node of input.definition.nodes) {
    dependsOnByNodeId.set(node.id, []);
    dependentsByNodeId.set(node.id, []);
  }

  for (const edge of input.definition.edges) {
    dependsOnByNodeId.get(edge.toNodeId)?.push(edge.fromNodeId);
    dependentsByNodeId.get(edge.fromNodeId)?.push(edge.toNodeId);
  }

  const nodes = Object.fromEntries(
    input.definition.nodes.map((node) => {
      const dependsOn = dependsOnByNodeId.get(node.id) ?? [];
      const blockedBy = dependsOn.slice();
      return [
        node.id,
        {
          nodeId: node.id,
          title: node.title,
          status: blockedBy.length === 0 ? "ready" : "blocked",
          dependsOn,
          dependents: dependentsByNodeId.get(node.id) ?? [],
          blockedBy,
          resourceLocks: [...(node.resourceLocks ?? [])],
          attempt: 0,
        } satisfies WorkflowV2RunNodeState,
      ];
    }),
  ) as Record<string, WorkflowV2RunNodeState>;

  return {
    workflowId: input.definition.workflowId,
    graphVersion: input.definition.graphVersion,
    status: "running",
    maxParallelNodes,
    nodeOrder: input.definition.nodes.map((node) => node.id),
    nodes,
  };
}
