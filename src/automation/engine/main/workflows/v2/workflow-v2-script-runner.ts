import type { WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type {
  WorkflowV2PlanNode,
  WorkflowV2ResultPacket,
  WorkflowV2TaskPacket,
} from "../../../shared/workflow-v2/planning";

export interface RunWorkflowV2ScriptNodeInput {
  node: WorkflowV2ScriptNode;
  planNode: WorkflowV2PlanNode;
  taskPacket: WorkflowV2TaskPacket;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  executeScript: (input: {
    node: WorkflowV2ScriptNode;
    planNode: WorkflowV2PlanNode;
    taskPacket: WorkflowV2TaskPacket;
    upstreamOutputs: readonly WorkflowV2ResultPacket[];
  }) => Promise<WorkflowV2WorkerOutput>;
}

export async function runWorkflowV2ScriptNode(input: RunWorkflowV2ScriptNodeInput): Promise<WorkflowV2WorkerOutput> {
  return input.executeScript({
    node: input.node,
    planNode: input.planNode,
    taskPacket: input.taskPacket,
    upstreamOutputs: input.upstreamOutputs,
  });
}
