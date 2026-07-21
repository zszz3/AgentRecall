import type { WorkflowV2ExecModel } from "../../../../shared/workflow-v2/definition";

export type WorkflowNodeSurfaceKind = "agent" | "script";

export function workflowNodeOpenTarget(execModel: WorkflowV2ExecModel): WorkflowNodeSurfaceKind {
  return execModel === "script" ? "script" : "agent";
}
