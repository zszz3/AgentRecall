import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type {
  WorkflowV2PlanNode,
  WorkflowV2ResultPacket,
  WorkflowV2TaskPacket,
} from "../../../shared/workflow-v2/planning";

export interface RunWorkflowV2LlmNodeInput {
  node: WorkflowV2LLMNode;
  planNode: WorkflowV2PlanNode;
  taskPacket: WorkflowV2TaskPacket;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  runLlmNode: (input: {
    node: WorkflowV2LLMNode;
    planNode: WorkflowV2PlanNode;
    taskPacket: WorkflowV2TaskPacket;
    upstreamOutputs: readonly WorkflowV2ResultPacket[];
  }) => Promise<WorkflowV2WorkerOutput>;
}

export async function runWorkflowV2LlmNode(input: RunWorkflowV2LlmNodeInput): Promise<WorkflowV2WorkerOutput> {
  return input.runLlmNode({
    node: input.node,
    planNode: input.planNode,
    taskPacket: input.taskPacket,
    upstreamOutputs: input.upstreamOutputs,
  });
}
