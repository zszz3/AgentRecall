import type { WorkflowV2ScriptPermissionDecision, WorkflowV2ScriptRiskLevel } from "../../../shared/workflow-v2/definition";
import { maximumWorkflowV2ScriptRisk } from "./workflow-v2-script-analysis";

export interface WorkflowV2ScriptPermissionInput {
  managerRisk: WorkflowV2ScriptRiskLevel;
  reviewerRisk: WorkflowV2ScriptRiskLevel;
  staticRisk: WorkflowV2ScriptRiskLevel;
  confirmed: boolean;
}

export interface WorkflowV2ScriptPermissionResult {
  risk: WorkflowV2ScriptRiskLevel;
  decision: WorkflowV2ScriptPermissionDecision;
}

export function decideWorkflowV2ScriptPermission(input: WorkflowV2ScriptPermissionInput): WorkflowV2ScriptPermissionResult {
  const risk = maximumWorkflowV2ScriptRisk(input.managerRisk, input.reviewerRisk, input.staticRisk);
  if (risk === "safe" || risk === "read") return { risk, decision: "auto_allow" };
  return { risk, decision: input.confirmed ? "allow_once" : "require_confirmation" };
}
