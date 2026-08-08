import type { WorkflowV2Node } from "../../../shared/workflow-v2/definition";
import { cloneWorkflowV2WorkerOutput, type WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowTransactionMode } from "../../../shared/workflow-v2/transaction";
import { materializeWorkflowV2OutputArtifacts } from "./workflow-v2-output-artifacts";

export async function materializeWorkflowV2AcceptedReviewCandidate(input: {
  workflowId: string;
  runId: string;
  sourceWorkDir: string;
  baselineId: string;
  transactionMode: WorkflowTransactionMode;
  node: WorkflowV2Node;
  candidate: WorkflowV2WorkerOutput;
  prepareWorkspaceTransaction?: (input: {
    workflowId: string;
    runId: string;
    sourceDir: string;
    baselineId: string;
  }) => Promise<{ workspaceDir: string }>;
}): Promise<WorkflowV2WorkerOutput> {
  let outputWorkDir = input.sourceWorkDir;
  if (input.transactionMode === "strict_atomic") {
    if (!input.prepareWorkspaceTransaction) throw new Error("Workflow strict_atomic mode requires durable workspace isolation.");
    const preparation = await input.prepareWorkspaceTransaction({
      workflowId: input.workflowId,
      runId: input.runId,
      sourceDir: input.sourceWorkDir,
      baselineId: input.baselineId,
    });
    outputWorkDir = preparation.workspaceDir;
  }

  const acceptedOutput = cloneWorkflowV2WorkerOutput(input.candidate);
  await materializeWorkflowV2OutputArtifacts({
    workflowId: input.workflowId,
    runId: input.runId,
    workDir: outputWorkDir,
    node: input.node,
    output: acceptedOutput,
  });
  return acceptedOutput;
}
