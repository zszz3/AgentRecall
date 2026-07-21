import type { WorkflowV2ScriptParameterDef } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2ResultPacket } from "../../../shared/workflow-v2/planning";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";
import type { WorkflowRunProgressItem } from "../../../shared/workflow/run";
import type { WorkflowV2DurableNodeControlState } from "../../../shared/workflow-v2/storage";

export interface ResolveWorkflowV2ScriptInputResult {
  complete: boolean;
  values: Record<string, unknown>;
  auditValues: Record<string, unknown>;
  missing: WorkflowV2ScriptParameterDef[];
  requested: WorkflowV2ScriptParameterDef[];
}

export function workflowV2ScriptInputSignal(input: { nodeId: string; nodeTitle: string; missing: WorkflowV2ScriptParameterDef[]; requestedAt: number }): WorkflowV2SupervisionSignal {
  return new WorkflowV2SupervisionSignal({
    resolution: { action: "pause", question: `Provide inputs for ${input.nodeTitle}.`, reason: "Script node is waiting for required typed input." },
    report: { nodeId: input.nodeId, attempt: 1, phase: "input", completedItems: [], remainingItems: input.missing.map((item) => item.label), blockers: ["Required script input is missing."], evidence: [], safeToInterrupt: true, requestedAction: "need_input", reportedAt: input.requestedAt },
  });
}

export function recordWorkflowV2ScriptInputRequest(input: { nodeId: string; nodeTitle: string; requested: WorkflowV2ScriptParameterDef[]; control: Record<string, WorkflowV2DurableNodeControlState>; updateNode: (nodeId: string, patch: Partial<WorkflowRunProgressItem>, event: { type: "gate_opened"; nodeId: string; question: string }) => void }): number {
  const requestedAt = Date.now();
  input.control[input.nodeId] = { ...(input.control[input.nodeId] ?? { extensionCount: 0 }), scriptInput: { requestedParameters: input.requested, submittedValues: {}, auditValues: {}, requestedAt } };
  const labels = input.requested.map((item) => item.label).join(", ");
  input.updateNode(input.nodeId, { status: "awaiting_input", detail: "Waiting for script inputs", inputRequest: { kind: "script_parameters", parameters: structuredClone(input.requested) } }, { type: "gate_opened", nodeId: input.nodeId, question: `Provide script inputs: ${labels}` });
  return requestedAt;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function assertParameterType(parameter: WorkflowV2ScriptParameterDef, value: unknown): void {
  if (value === undefined) return;
  if (parameter.valueType === "number" && typeof value !== "number") throw new Error(`Script parameter ${parameter.key} must be a number.`);
  if (parameter.valueType === "boolean" && typeof value !== "boolean") throw new Error(`Script parameter ${parameter.key} must be a boolean.`);
  if ((parameter.valueType === "string" || parameter.valueType === "secret" || parameter.valueType === "file" || parameter.valueType === "directory") && typeof value !== "string") throw new Error(`Script parameter ${parameter.key} must be a string.`);
  if (parameter.valueType === "json" && (typeof value !== "object" || value === null)) throw new Error(`Script parameter ${parameter.key} must be JSON.`);
  if (parameter.enum && !parameter.enum.some((item) => Object.is(item, value))) throw new Error(`Script parameter ${parameter.key} must be one of: ${parameter.enum.join(", ")}.`);
}

function resolveParameter(input: {
  parameter: WorkflowV2ScriptParameterDef;
  workflowContext: unknown;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  submittedValues: Readonly<Record<string, unknown>>;
}): unknown {
  const { parameter } = input;
  if (parameter.source === "literal") return parameter.literalValue ?? parameter.defaultValue;
  if (parameter.source === "workflow") return parameter.workflowPath ? valueAtPath(input.workflowContext, parameter.workflowPath) ?? parameter.defaultValue : parameter.defaultValue;
  if (parameter.source === "upstream") {
    const packet = input.upstreamOutputs.find((item) => item.nodeId === parameter.upstreamNodeId);
    return parameter.upstreamOutputKey ? packet?.outputs[parameter.upstreamOutputKey] ?? parameter.defaultValue : parameter.defaultValue;
  }
  return input.submittedValues[parameter.key] ?? parameter.defaultValue;
}

export function resolveWorkflowV2ScriptInput(input: {
  parameters: readonly WorkflowV2ScriptParameterDef[];
  workflowContext: unknown;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  submittedValues: Readonly<Record<string, unknown>>;
}): ResolveWorkflowV2ScriptInputResult {
  const values: Record<string, unknown> = {};
  const auditValues: Record<string, unknown> = {};
  const missing: WorkflowV2ScriptParameterDef[] = [];
  const requested: WorkflowV2ScriptParameterDef[] = [];
  for (const parameter of input.parameters) {
    const value = resolveParameter({ ...input, parameter });
    if (value === undefined) {
      if (parameter.source === "user") {
        requested.push(structuredClone(parameter));
        if (parameter.required) missing.push(structuredClone(parameter));
      }
      else if (parameter.required) throw new Error(`Script parameter ${parameter.key} could not be resolved from ${parameter.source}.`);
      continue;
    }
    assertParameterType(parameter, value);
    values[parameter.key] = structuredClone(value);
    auditValues[parameter.key] = parameter.valueType === "secret" ? "[REDACTED]" : structuredClone(value);
  }
  return { complete: missing.length === 0, values, auditValues, missing, requested };
}
