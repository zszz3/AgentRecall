import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2RunState } from "../../../shared/workflow-v2/state";
import type { WorkflowV2ExecutionMode } from "../../../shared/workflow-v2/definition";

export type WorkflowV2LeaderPlanHealth = "healthy" | "at-risk" | "blocked";

export interface WorkflowV2LeaderNavigation {
  at: number;
  nextNodeIds: string[];
  priorityNodeIds: string[];
  escalationHints: string[];
  planHealth: WorkflowV2LeaderPlanHealth;
  blockedNodes: Array<{ nodeId: string; reason: string }>;
  executionModeRecommendations: Array<{ nodeId: string; mode: WorkflowV2ExecutionMode; reason: string }>;
  scriptCandidates: Array<{ nodeId: string; reason: string }>;
  risks: string[];
}

export interface AssembleWorkflowV2LeaderNavigationInput {
  runState: WorkflowV2RunState;
  runnableNodeIds: string[];
  workerOutputs: WorkflowV2WorkerOutput[];
}

export function assembleWorkflowV2LeaderNavigation(
  input: AssembleWorkflowV2LeaderNavigationInput,
): WorkflowV2LeaderNavigation {
  const escalationHints = input.workerOutputs
    .flatMap((workerOutput) => workerOutput.proposals)
    .flatMap((proposal) => (proposal.kind === "escalate" ? [proposal.reason] : []));
  const planHealth = deriveWorkflowV2LeaderPlanHealth(input.runState.status, escalationHints.length > 0);
  const nextNodeIds = planHealth === "blocked" ? [] : [...input.runnableNodeIds];

  return {
    at: Date.now(),
    nextNodeIds,
    priorityNodeIds: [...nextNodeIds],
    escalationHints,
    planHealth,
    blockedNodes: Object.values(input.runState.nodes).filter((node) => node.status === "blocked" || node.status === "paused").map((node) => ({ nodeId: node.nodeId, reason: node.lastError ?? (node.blockedBy.length ? `Waiting for ${node.blockedBy.join(", ")}` : "Paused for user action") })),
    executionModeRecommendations: [],
    scriptCandidates: input.workerOutputs.flatMap((output) => output.proposals.filter((proposal) => proposal.kind === "graph-revision" && /script/i.test(proposal.reason)).map((proposal) => ({ nodeId: output.nodeId, reason: proposal.reason }))),
    risks: input.workerOutputs.flatMap((output) => output.risks ?? []),
  };
}

function deriveWorkflowV2LeaderPlanHealth(
  runStatus: WorkflowV2RunState["status"],
  hasEscalationHints: boolean,
): WorkflowV2LeaderPlanHealth {
  if (runStatus === "failed") return "blocked";
  if (hasEscalationHints) return "at-risk";
  return "healthy";
}
