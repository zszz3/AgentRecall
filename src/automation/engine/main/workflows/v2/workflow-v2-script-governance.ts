import type { WorkflowV2ScriptRiskLevel } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import { analyzeWorkflowV2Script } from "./workflow-v2-script-analysis";
import { decideWorkflowV2ScriptPermission } from "./workflow-v2-script-permission";

export function freezeWorkflowV2ScriptGovernance(input: { plan: WorkflowV2Plan; reviewedRevision: number; reviewerRisks?: Record<string, { level: WorkflowV2ScriptRiskLevel; rationale: string }> }): WorkflowV2Plan {
  const plan = structuredClone(input.plan);
  plan.nodes = plan.nodes.map((planNode) => {
    const node = plan.definition.nodes.find((candidate) => candidate.id === planNode.nodeId);
    if (node?.execModel !== "script") return planNode;
    const analysis = analyzeWorkflowV2Script(node.script);
    const reviewerRisk = input.reviewerRisks?.[node.id] ?? { level: analysis.minimumRisk, rationale: "No optional reviewer assessment; using static analysis as the independent risk baseline." };
    const permission = decideWorkflowV2ScriptPermission({ managerRisk: node.script.managerRisk.level, reviewerRisk: reviewerRisk.level, staticRisk: analysis.minimumRisk, confirmed: false });
    return { ...planNode, scriptGovernance: { managerRisk: node.script.managerRisk.level, reviewerRisk: reviewerRisk.level, staticRisk: analysis.minimumRisk, effectiveRisk: permission.risk, capabilities: [...analysis.detectedCapabilities], capabilityDigest: analysis.capabilityDigest, reviewedRevision: input.reviewedRevision } };
  });
  return plan;
}
