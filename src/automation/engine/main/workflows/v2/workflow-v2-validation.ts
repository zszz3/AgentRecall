import type {
  WorkflowV2LLMNode,
  WorkflowV2Node,
  WorkflowV2NodeValidationResult,
  WorkflowV2ScriptNode,
} from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";

export interface ValidateWorkflowV2NodeOutputInput {
  node: WorkflowV2Node;
  output: WorkflowV2WorkerOutput;
  attempt: number;
}

export function validateWorkflowV2NodeOutput(
  input: ValidateWorkflowV2NodeOutputInput,
): WorkflowV2NodeValidationResult {
  if (input.output.nodeId !== input.node.id) {
    return invalidResult("fail", `Output packet belongs to ${input.output.nodeId}, not ${input.node.id}.`);
  }

  if (input.node.execModel === "llm") {
    return validateLlmNodeOutput(input.node, input.output, input.attempt);
  }
  return validateScriptNodeOutput(input.node, input.output);
}

function validateLlmNodeOutput(
  node: WorkflowV2LLMNode,
  output: WorkflowV2WorkerOutput,
  attempt: number,
): WorkflowV2NodeValidationResult {
  const failures = collectStructuralFailures(node, output);
  if (failures.reasons.length === 0) return passResult();

  const maxRetry = node.maxRetry ?? 0;
  if (attempt <= maxRetry) {
    return {
      outcome: "retry",
      ...failures,
    };
  }
  return {
    outcome: node.onExhausted === "ask_human" ? "ask_human" : "fail",
    ...failures,
  };
}

function validateScriptNodeOutput(
  node: WorkflowV2ScriptNode,
  output: WorkflowV2WorkerOutput,
): WorkflowV2NodeValidationResult {
  const failures = collectStructuralFailures(node, output);
  if (failures.reasons.length === 0) return passResult();
  return {
    outcome: node.onError === "ask_human" ? "ask_human" : "fail",
    ...failures,
  };
}

function collectStructuralFailures(
  node: WorkflowV2Node,
  output: WorkflowV2WorkerOutput,
): Pick<WorkflowV2NodeValidationResult, "reasons" | "missingOutputFields"> {
  const reasons: string[] = [];
  if (typeof output.summary !== "string" || output.summary.trim().length === 0) {
    reasons.push("Output summary is required.");
  }

  const outputs = isRecord(output.outputs) ? output.outputs : {};
  const missingOutputFields = node.outputFields
    .filter((field) => field.required !== false && !Object.hasOwn(outputs, field.key))
    .map((field) => field.key);
  if (missingOutputFields.length > 0) {
    reasons.push(`Missing required output fields: ${missingOutputFields.join(", ")}.`);
  }
  return { reasons, missingOutputFields };
}

function passResult(): WorkflowV2NodeValidationResult {
  return { outcome: "pass", reasons: [], missingOutputFields: [] };
}

function invalidResult(
  outcome: WorkflowV2NodeValidationResult["outcome"],
  reason: string,
): WorkflowV2NodeValidationResult {
  return { outcome, reasons: [reason], missingOutputFields: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
