import { createHash } from "node:crypto";
import type { WorkflowV2ScriptCapability, WorkflowV2ScriptNode, WorkflowV2ScriptRiskLevel, WorkflowV2ScriptSpec } from "../../../shared/workflow-v2/definition";

export interface WorkflowV2ScriptStaticAnalysis {
  minimumRisk: WorkflowV2ScriptRiskLevel;
  detectedCapabilities: WorkflowV2ScriptCapability[];
  capabilityDigest: string;
  uncertain: boolean;
  rationale: string;
}

const riskByCapability: Record<WorkflowV2ScriptCapability, WorkflowV2ScriptRiskLevel> = {
  workspace_read: "read", network_read: "read", environment_read: "read",
  workspace_write: "write", external_write: "write", network_write: "write",
  workspace_delete: "dangerous", external_read: "dangerous", external_delete: "dangerous", process_spawn: "dangerous",
  shell_execute: "dangerous", credential_read: "dangerous", system_config_write: "dangerous",
};
const riskOrder: WorkflowV2ScriptRiskLevel[] = ["safe", "read", "write", "dangerous"];

export function maximumWorkflowV2ScriptRisk(...levels: WorkflowV2ScriptRiskLevel[]): WorkflowV2ScriptRiskLevel {
  return levels.reduce((maximum, level) => riskOrder.indexOf(level) > riskOrder.indexOf(maximum) ? level : maximum, "safe");
}

export function workflowV2ScriptCapabilityDigest(capabilities: readonly WorkflowV2ScriptCapability[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(capabilities)].sort())).digest("hex");
}

function canonicalWorkflowV2Value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalWorkflowV2Value);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalWorkflowV2Value(item)]));
  }
  return value;
}

export function workflowV2ScriptOperationDigest(input: {
  workflowId: string;
  graphVersion: number;
  runId: string;
  node: WorkflowV2ScriptNode;
  workDir: string;
  inputs: Readonly<Record<string, unknown>>;
}): string {
  return createHash("sha256").update(JSON.stringify(canonicalWorkflowV2Value({
    workflowId: input.workflowId,
    graphVersion: input.graphVersion,
    runId: input.runId,
    nodeId: input.node.id,
    executable: input.node.script.executable,
    parameters: input.node.script.parameters,
    expectedExitCode: input.node.expectedExitCode,
    workDir: input.workDir,
    inputs: input.inputs,
  }))).digest("hex");
}

export function analyzeWorkflowV2Script(script: WorkflowV2ScriptSpec): WorkflowV2ScriptStaticAnalysis {
  const declared = [...new Set(script.capabilities)].sort();
  const commandExecution = script.executable.kind === "command";
  const detectedCapabilities = commandExecution
    ? [...new Set<WorkflowV2ScriptCapability>([...declared, "process_spawn", "shell_execute"])].sort()
    : declared;
  const minimumRisk = commandExecution
    ? "dangerous"
    : maximumWorkflowV2ScriptRisk(...detectedCapabilities.map((capability) => riskByCapability[capability]));
  return {
    minimumRisk,
    detectedCapabilities,
    capabilityDigest: workflowV2ScriptCapabilityDigest(detectedCapabilities),
    uncertain: commandExecution,
    rationale: commandExecution ? "External command execution is dynamic and fails closed." : detectedCapabilities.length === 0 ? "Restricted in-process transform has no declared side effects." : "Minimum risk derived from declared semantic capabilities.",
  };
}
