import type { WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2PlanNode, WorkflowV2ResultPacket, WorkflowV2WorkerOutput } from "../../../shared/types";
import type { WorkflowRuntimeDependencies } from "../workflow-runtime-ports";
import { analyzeWorkflowV2Script } from "./workflow-v2-script-analysis";
import { decideWorkflowV2ScriptPermission } from "./workflow-v2-script-permission";

export function authorizeWorkflowV2Script(input: { node: WorkflowV2ScriptNode; planNode: WorkflowV2PlanNode; confirmed: boolean }) {
  const analysis = analyzeWorkflowV2Script(input.node.script);
  const governance = input.planNode.scriptGovernance;
  if (!governance) throw new Error(`Workflow V2 script node ${input.node.id} has no frozen governance profile.`);
  if (governance.capabilityDigest !== analysis.capabilityDigest || JSON.stringify(governance.capabilities) !== JSON.stringify(analysis.detectedCapabilities)) throw new Error(`Workflow V2 script node ${input.node.id} governance no longer matches its executable.`);
  return { analysis, governance, permission: decideWorkflowV2ScriptPermission({ managerRisk: governance.managerRisk, reviewerRisk: governance.reviewerRisk, staticRisk: governance.staticRisk, confirmed: input.confirmed }) };
}

export async function executeAuthorizedWorkflowV2Script(input: { deps: WorkflowRuntimeDependencies; node: WorkflowV2ScriptNode; workDir: string; upstreamOutputs: readonly WorkflowV2ResultPacket[]; timeoutMs: number; inputs: Record<string, unknown>; authorization: Parameters<WorkflowRuntimeDependencies["executeWorkflowV2Script"]>[0]["authorization"]; controller: AbortController }): Promise<WorkflowV2WorkerOutput> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(`Workflow V2 script node ${input.node.id} timed out after ${input.timeoutMs}ms.`);
      reject(timeoutError);
      input.controller.abort(timeoutError);
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([input.deps.executeWorkflowV2Script({ node: input.node, workDir: input.workDir, upstreamOutputs: input.upstreamOutputs, signal: input.controller.signal, timeoutMs: input.timeoutMs, inputs: Object.freeze(structuredClone(input.inputs)), authorization: input.authorization }), deadline]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
