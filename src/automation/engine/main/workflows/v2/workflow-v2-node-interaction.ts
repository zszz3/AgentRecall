import type { WorkflowEvent, WorkflowRunProgressItem } from "../../../shared/workflow/run";
import type { WorkflowV2HumanIntervention } from "../../../shared/workflow-v2/review";
import type { WorkflowV2DurableNodeControlState } from "../../../shared/workflow-v2/storage";

export function projectWorkflowV2PausedNodeInteraction(input: {
  nodeId: string;
  interactiveAgent: boolean;
  intervention: WorkflowV2HumanIntervention;
  control?: WorkflowV2DurableNodeControlState;
}): {
  progress: Partial<WorkflowRunProgressItem>;
  event: Omit<WorkflowEvent, "at">;
} {
  const scriptInput = input.control?.scriptInput;
  if (scriptInput && scriptInput.submittedAt === undefined) {
    const labels = scriptInput.requestedParameters.map((item) => item.label).join(", ");
    return {
      progress: {
        status: "awaiting_input",
        detail: `Waiting for ${labels}`,
        inputRequest: { kind: "script_parameters", parameters: structuredClone(scriptInput.requestedParameters) },
      },
      event: { type: "gate_opened", nodeId: input.nodeId, detail: input.intervention.reason },
    };
  }
  if (input.interactiveAgent && input.intervention.progressReport?.requestedAction === "need_input") {
    const prompt = input.intervention.supervisorDecision?.action === "pause"
      ? input.intervention.supervisorDecision.question
      : input.intervention.reason;
    return {
      progress: {
        status: "awaiting_input",
        detail: input.intervention.reason,
        inputRequest: { kind: "agent_message", prompt },
        intervention: structuredClone(input.intervention),
      },
      event: { type: "gate_opened", nodeId: input.nodeId, detail: input.intervention.reason, intervention: input.intervention },
    };
  }
  return {
    progress: {
      status: "paused",
      detail: input.intervention.reason,
      intervention: structuredClone(input.intervention),
    },
    event: { type: "node_paused", nodeId: input.nodeId, detail: input.intervention.reason, intervention: input.intervention },
  };
}
