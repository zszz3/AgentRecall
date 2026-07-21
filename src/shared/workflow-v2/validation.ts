import type {
  WorkflowV2AcceptanceCriterion,
  WorkflowV2BudgetEnvelope,
  WorkflowV2CostBudget,
} from "./planning";
import type {
  WorkflowV2AuthoredDefinition,
  WorkflowV2Definition,
  WorkflowV2ModelProfile,
  WorkflowV2Node,
  WorkflowV2NodeRole,
  WorkflowV2ValidationResult,
} from "./definition";
import { workflowV2NodeHookValidationErrors } from "./hooks";
import { isWorkflowV2ExecutionLeasePolicy } from "./supervision";
import { compileWorkflowV2Definition, WorkflowV2TemplateCompileError } from "./templates";
import type { WorkflowV2TemplateRegistry } from "./templates";
import { listWorkflowV2TerminalNodeIds, normalizeWorkflowV2TerminalNode } from "./topology";

// Validation is the first hard boundary after raw shared types: if this layer
// drifts, later store/runtime migrations will persist or execute the wrong shape.
const VALID_SCRIPT_LANGUAGES = new Set(["python", "typescript", "bash"]);
const VALID_SCRIPT_RISKS = new Set(["safe", "read", "write", "dangerous"]);
const VALID_SUMMARY_FALLBACK_POLICIES = new Set(["truncate", "summarize", "ask_human"]);
const VALID_MODEL_PROFILES = new Set(["fast", "balanced", "expert"]);
const VALID_NODE_ROLES = new Set(["orchestrator", "executor", "reviewer"]);
const VALID_WORKFLOW_VALUE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "json",
  "secret",
  "file",
  "directory",
]);

export function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

export function isWorkflowV2ModelProfile(value: unknown): value is WorkflowV2ModelProfile {
  return typeof value === "string" && VALID_MODEL_PROFILES.has(value);
}

export function isWorkflowV2NodeRole(value: unknown): value is WorkflowV2NodeRole {
  return typeof value === "string" && VALID_NODE_ROLES.has(value);
}

export function workflowV2AcceptanceCriteriaValidationErrors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return ["Workflow V2 acceptance criteria must be a non-empty array."];
  }

  const errors: string[] = [];
  const keys = new Set<string>();
  value.forEach((criterion, index) => {
    if (!isRecord(criterion)) {
      errors.push(`Workflow V2 acceptance criteria item ${index} must be an object.`);
      return;
    }

    const key = typeof criterion.key === "string" ? criterion.key.trim() : "";
    if (!key) {
      errors.push(`Workflow V2 acceptance criteria item ${index} requires a non-empty key.`);
    } else if (keys.has(key)) {
      errors.push(`Workflow V2 acceptance criteria has duplicate key ${key}.`);
    } else {
      keys.add(key);
    }

    if (typeof criterion.description !== "string" || !criterion.description.trim()) {
      errors.push(`Workflow V2 acceptance criteria item ${index} requires a non-empty description.`);
    }
    if (criterion.required !== undefined && typeof criterion.required !== "boolean") {
      errors.push(
        `Workflow V2 acceptance criteria item ${index} requires required to be a boolean when provided.`,
      );
    }
  });
  return errors;
}

export function isValidWorkflowV2AcceptanceCriteria(
  value: unknown,
): value is WorkflowV2AcceptanceCriterion[] {
  return workflowV2AcceptanceCriteriaValidationErrors(value).length === 0;
}

export function isValidWorkflowV2ContextBudget(
  value: unknown,
): value is WorkflowV2BudgetEnvelope["context"] {
  if (!isRecord(value) || !isPositiveSafeInteger(value.maxContextTokens)) return false;
  if (value.maxEvidenceItems !== undefined && !isNonNegativeSafeInteger(value.maxEvidenceItems)) {
    return false;
  }
  if (value.maxUpstreamNodes !== undefined && !isNonNegativeSafeInteger(value.maxUpstreamNodes)) {
    return false;
  }
  return (
    value.summaryFallbackPolicy === undefined
    || (typeof value.summaryFallbackPolicy === "string"
      && VALID_SUMMARY_FALLBACK_POLICIES.has(value.summaryFallbackPolicy))
  );
}

export function isValidWorkflowV2CostBudget(value: unknown): value is WorkflowV2CostBudget {
  if (!isRecord(value)) return false;
  return (
    ["maxModelCalls", "maxPromptTokens", "maxCompletionTokens", "maxWallClockMs"] as const
  ).every((field) => value[field] === undefined || isNonNegativeSafeInteger(value[field]));
}

export function isValidWorkflowV2BudgetEnvelope(value: unknown): value is WorkflowV2BudgetEnvelope {
  return (
    isRecord(value)
    && isValidWorkflowV2ContextBudget(value.context)
    && (value.cost === undefined || isValidWorkflowV2CostBudget(value.cost))
  );
}

function appendNodeValidationErrors(node: WorkflowV2Node, errors: string[]): void {
  // Treat the incoming node as untrusted input so malformed payloads become
  // structured validation errors instead of throwing through the caller.
  const untrustedNode = node as unknown as { id?: unknown; execModel?: unknown };
  if (untrustedNode.execModel !== "llm" && untrustedNode.execModel !== "script") {
    errors.push(
      `Workflow V2 node ${String(untrustedNode.id)} has unsupported execution model ${String(
        untrustedNode.execModel,
      )}.`,
    );
    return;
  }

  if (!node.id.trim()) errors.push("Workflow V2 node id must not be empty.");
  if (!node.title.trim()) errors.push(`Workflow V2 node ${node.id} must have a title.`);
  if (!node.kind.trim()) errors.push(`Workflow V2 node ${node.id} must have a kind.`);
  if (node.executionMode === undefined) {
    errors.push(`Workflow V2 node ${node.id} must declare execution mode explicitly.`);
  }
  if (
    node.executionModeConfidence !== undefined
    && (typeof node.executionModeConfidence !== "number"
      || !Number.isFinite(node.executionModeConfidence)
      || node.executionModeConfidence < 0
      || node.executionModeConfidence > 1)
  ) {
    errors.push(`Workflow V2 node ${node.id} execution mode confidence must be between 0 and 1.`);
  }
  if (node.execModel === "llm" && node.executionMode === "script") {
    errors.push(`Workflow V2 llm node ${node.id} cannot use script execution mode.`);
  }
  if (node.execModel === "script" && node.executionMode !== "script") {
    errors.push(`Workflow V2 script node ${node.id} must use script execution mode.`);
  }
  if (node.role !== undefined && !isWorkflowV2NodeRole(node.role)) {
    errors.push(`Workflow V2 node ${node.id} has unsupported role ${String(node.role)}.`);
  }
  if (node.executionLease !== undefined && !isWorkflowV2ExecutionLeasePolicy(node.executionLease)) {
    errors.push(`Workflow V2 node ${node.id} has an invalid execution lease policy.`);
  }
  errors.push(
    ...workflowV2NodeHookValidationErrors(node.hooks).map(
      (error) => `Workflow V2 node ${node.id} ${error}`,
    ),
  );

  if (!Array.isArray(node.outputFields) || node.outputFields.length === 0) {
    errors.push(`Workflow V2 node ${node.id} must declare at least one output field.`);
  } else {
    const outputFieldKeys = new Set<string>();
    for (const outputField of node.outputFields) {
      if (!outputField.key.trim()) {
        errors.push(`Workflow V2 node ${node.id} has an output field with an empty key.`);
        continue;
      }
      if (outputFieldKeys.has(outputField.key)) {
        errors.push(`Workflow V2 node ${node.id} has duplicate output field key ${outputField.key}.`);
      }
      outputFieldKeys.add(outputField.key);
      if (outputField.valueType !== undefined && !VALID_WORKFLOW_VALUE_TYPES.has(outputField.valueType)) {
        errors.push(
          `Workflow V2 node ${node.id} output field ${outputField.key} has unsupported value type ${String(
            outputField.valueType,
          )}.`,
        );
      }
    }
  }

  if (node.execModel === "llm") {
    if (!node.prompt.trim()) errors.push(`Workflow V2 llm node ${node.id} must have a prompt.`);
    if (node.configuredAgentId !== undefined && !node.configuredAgentId.trim()) {
      errors.push(`Workflow V2 llm node ${node.id} configuredAgentId must not be empty.`);
    }
    if (node.modelId !== undefined && !node.modelId.trim()) {
      errors.push(`Workflow V2 llm node ${node.id} modelId must not be empty.`);
    }
    if (node.modelProfile !== undefined && !isWorkflowV2ModelProfile(node.modelProfile)) {
      errors.push(
        `Workflow V2 llm node ${node.id} has unsupported model profile ${String(node.modelProfile)}.`,
      );
    }
    if (node.maxRetry !== undefined && !isNonNegativeSafeInteger(node.maxRetry)) {
      errors.push(`Workflow V2 llm node ${node.id} must have a non-negative safe-integer maxRetry.`);
    }
    if (node.contextBudget && !isValidWorkflowV2ContextBudget(node.contextBudget)) {
      errors.push(`Workflow V2 llm node ${node.id} has an invalid context budget.`);
    }
    return;
  }

  if (node.execModel === "script") {
    if (!isRecord(node.script) || !isRecord(node.script.executable)) {
      errors.push(`Workflow V2 script node ${node.id} must declare an executable contract.`);
      return;
    }
    if (
      node.script.executable.kind === "inline"
      && !VALID_SCRIPT_LANGUAGES.has(node.script.executable.language)
    ) {
      errors.push(
        `Workflow V2 script node ${node.id} has unsupported language ${String(
          node.script.executable.language,
        )}.`,
      );
    }
    if (node.script.executable.kind === "inline" && !node.script.executable.code.trim()) {
      errors.push(`Workflow V2 script node ${node.id} must have executable code.`);
    }
    if (node.script.executable.kind === "command" && !node.script.executable.command.trim()) {
      errors.push(`Workflow V2 script node ${node.id} must have an executable command.`);
    }
    if (!Array.isArray(node.script.parameters)) {
      errors.push(`Workflow V2 script node ${node.id} must declare parameters.`);
    } else {
      for (const parameter of node.script.parameters) {
        if (!parameter.enum) continue;
        if (parameter.enum.length === 0) {
          errors.push(
            `Workflow V2 script node ${node.id} parameter ${parameter.key} must not declare an empty enum.`,
          );
        }
        if (
          parameter.valueType !== "string"
          && parameter.valueType !== "number"
          && parameter.valueType !== "boolean"
        ) {
          errors.push(
            `Workflow V2 script node ${node.id} parameter ${parameter.key} may use enum only with string, number, or boolean values.`,
          );
          continue;
        }
        if (parameter.enum.some((value) => typeof value !== parameter.valueType)) {
          errors.push(
            `Workflow V2 script node ${node.id} parameter ${parameter.key} enum values must match ${parameter.valueType}.`,
          );
        }
        if (
          new Set(parameter.enum.map((value) => `${typeof value}:${String(value)}`)).size
          !== parameter.enum.length
        ) {
          errors.push(
            `Workflow V2 script node ${node.id} parameter ${parameter.key} has duplicate enum values.`,
          );
        }
      }
    }
    if (!Array.isArray(node.script.capabilities)) {
      errors.push(`Workflow V2 script node ${node.id} must declare capabilities.`);
    }
    if (
      !VALID_SCRIPT_RISKS.has(node.script.managerRisk.level)
      || !node.script.managerRisk.rationale.trim()
    ) {
      errors.push(`Workflow V2 script node ${node.id} must declare Manager risk and rationale.`);
    }
    if (node.script.timeoutMs !== undefined && !isPositiveSafeInteger(node.script.timeoutMs)) {
      errors.push(`Workflow V2 script node ${node.id} must have a positive safe-integer timeoutMs.`);
    }
    if (node.expectedExitCode !== undefined && !isSafeInteger(node.expectedExitCode)) {
      errors.push(`Workflow V2 script node ${node.id} must have a safe-integer expectedExitCode.`);
    }
  }
}

function topologicalOrder(definition: WorkflowV2Definition, errors: string[]): string[] {
  // Validation needs a stable DAG ordering both to reject cycles and to give
  // downstream layers a canonical node order when the graph is valid.
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const edgeKeys = new Set<string>();

  for (const node of definition.nodes) {
    adjacency.set(node.id, []);
    indegree.set(node.id, 0);
  }

  for (const edge of definition.edges) {
    const edgeKey = JSON.stringify([edge.fromNodeId, edge.toNodeId]);
    if (edgeKeys.has(edgeKey)) {
      errors.push(`Workflow V2 definition has duplicate edge ${edge.fromNodeId} -> ${edge.toNodeId}.`);
      continue;
    }
    edgeKeys.add(edgeKey);
    if (!adjacency.has(edge.fromNodeId) || !adjacency.has(edge.toNodeId)) {
      errors.push(`Workflow V2 edge ${edge.fromNodeId} -> ${edge.toNodeId} references a missing node.`);
      continue;
    }
    adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
  }

  const queue = definition.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const orderedNodeIds: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    orderedNodeIds.push(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      const nextIndegree = (indegree.get(nextNodeId) ?? 0) - 1;
      indegree.set(nextNodeId, nextIndegree);
      if (nextIndegree === 0) queue.push(nextNodeId);
    }
  }

  if (orderedNodeIds.length !== definition.nodes.length) {
    errors.push("Workflow V2 definition must be acyclic.");
  }
  return orderedNodeIds;
}

function appendUpstreamScriptParameterValidationErrors(
  definition: WorkflowV2Definition,
  errors: string[],
  warnings: string[],
): void {
  // Script parameters bound to upstream outputs are the sharpest contract edge:
  // this is where graph topology, outputFields, and runtime payload types meet.
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const directEdges = new Set(definition.edges.map((edge) => JSON.stringify([edge.fromNodeId, edge.toNodeId])));
  const consumerTypeByOutput = new Map<string, string>();
  const warnedUntypedOutputs = new Set<string>();

  for (const node of definition.nodes) {
    if (node.execModel !== "script" || !isRecord(node.script) || !Array.isArray(node.script.parameters)) {
      continue;
    }
    for (const parameter of node.script.parameters) {
      if (!isRecord(parameter) || parameter.source !== "upstream") continue;
      const parameterKey = String(parameter.key);
      const upstreamNodeId = typeof parameter.upstreamNodeId === "string" ? parameter.upstreamNodeId : "";
      const upstreamOutputKey =
        typeof parameter.upstreamOutputKey === "string" ? parameter.upstreamOutputKey : "";
      if (!upstreamNodeId.trim()) {
        errors.push(
          `Workflow V2 script node ${node.id} upstream parameter ${parameterKey} must declare upstreamNodeId.`,
        );
      }
      if (!upstreamOutputKey.trim()) {
        errors.push(
          `Workflow V2 script node ${node.id} upstream parameter ${parameterKey} must declare upstreamOutputKey.`,
        );
      }
      if (!upstreamNodeId.trim() || !upstreamOutputKey.trim()) continue;

      const upstreamNode = nodesById.get(upstreamNodeId);
      if (!upstreamNode) {
        errors.push(
          `Workflow V2 script node ${node.id} upstream parameter ${parameterKey} references missing node ${upstreamNodeId}.`,
        );
        continue;
      }
      if (!directEdges.has(JSON.stringify([upstreamNodeId, node.id]))) {
        errors.push(
          `Workflow V2 script node ${node.id} upstream parameter ${parameterKey} must reference a direct upstream node, but ${upstreamNodeId} is not connected to ${node.id}.`,
        );
      }
      const outputField = Array.isArray(upstreamNode.outputFields)
        ? upstreamNode.outputFields.find((field) => field.key === upstreamOutputKey)
        : undefined;
      if (!outputField) {
        errors.push(
          `Workflow V2 script node ${node.id} upstream parameter ${parameterKey} references output ${upstreamOutputKey}, which is not declared by node ${upstreamNodeId}.`,
        );
        continue;
      }

      const outputBindingKey = JSON.stringify([upstreamNodeId, upstreamOutputKey]);
      const parameterValueType = typeof parameter.valueType === "string" ? parameter.valueType : "";
      const existingConsumerType = consumerTypeByOutput.get(outputBindingKey);
      if (existingConsumerType && existingConsumerType !== parameterValueType) {
        errors.push(
          `Workflow V2 output ${upstreamNodeId}.${upstreamOutputKey} has conflicting downstream value types ${existingConsumerType} and ${parameterValueType}.`,
        );
      } else if (parameterValueType) {
        consumerTypeByOutput.set(outputBindingKey, parameterValueType);
      }

      if (outputField.valueType === undefined) {
        if (!warnedUntypedOutputs.has(outputBindingKey)) {
          warnings.push(
            `Workflow V2 node ${upstreamNodeId} output field ${upstreamOutputKey} should declare valueType because a downstream script consumes it.`,
          );
          warnedUntypedOutputs.add(outputBindingKey);
        }
      } else if (outputField.valueType !== parameterValueType) {
        errors.push(
          `Workflow V2 node ${upstreamNodeId} output field ${upstreamOutputKey} has value type ${outputField.valueType}, but script node ${node.id} parameter ${parameterKey} requires ${parameterValueType}.`,
        );
      }
    }
  }
}

export function validateWorkflowV2Definition(
  definition: WorkflowV2Definition,
  options?: { configuredAgentIds?: Iterable<string> },
): WorkflowV2ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!definition.workflowId.trim()) errors.push("Workflow V2 definition must have a workflowId.");
  if (!isPositiveSafeInteger(definition.graphVersion)) {
    errors.push("Workflow V2 definition must have a positive safe-integer graphVersion.");
  }
  if (!definition.objective.trim()) errors.push("Workflow V2 definition must have an objective.");
  if (definition.nodes.length === 0) errors.push("Workflow V2 definition must have at least one node.");

  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) errors.push(`Workflow V2 definition has duplicate node id ${node.id}.`);
    nodeIds.add(node.id);
    appendNodeValidationErrors(node, errors);
    if (node.role === undefined) warnings.push(`Workflow V2 node ${node.id} does not declare a role.`);
  }

  const topologicalNodeIds = topologicalOrder(definition, errors);
  appendUpstreamScriptParameterValidationErrors(definition, errors, warnings);
  const terminalNodeIds = listWorkflowV2TerminalNodeIds(definition);
  if (terminalNodeIds.length !== 1) {
    // Multiple terminals are legal at authoring time only after compilation
    // passes through terminal normalization.
    errors.push(`Workflow V2 definition must have exactly one terminal node, found ${terminalNodeIds.length}.`);
  }
  if (options?.configuredAgentIds) {
    errors.push(...validateWorkflowV2ConfiguredAgentReferences(definition, options.configuredAgentIds));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    topologicalNodeIds,
  };
}

export function validateWorkflowV2ConfiguredAgentReferences(
  definition: WorkflowV2Definition,
  configuredAgentIds: Iterable<string>,
): string[] {
  const known = new Set(configuredAgentIds);
  return [
    ...new Set(
      definition.nodes
        .filter(
          (node) => node.execModel === "llm" && node.configuredAgentId && !known.has(node.configuredAgentId),
        )
        .map((node) => (node.execModel === "llm" ? node.configuredAgentId! : "")),
    ),
  ].map((configuredAgentId) => `Workflow V2 configured agent ${configuredAgentId} was not found.`);
}

export function assertWorkflowV2ConfiguredAgentReplacement(
  definitions: Iterable<WorkflowV2Definition>,
  currentAgents: Iterable<{ id: string; managed?: boolean }>,
  nextAgents: Iterable<{ id: string }>,
): void {
  const nextAgentIds = new Set([...nextAgents].map((agent) => agent.id));
  for (const agent of currentAgents) {
    if (agent.managed) nextAgentIds.add(agent.id);
  }
  const error = [...definitions].flatMap((definition) =>
    validateWorkflowV2ConfiguredAgentReferences(definition, nextAgentIds),
  )[0];
  if (error) throw new Error(`${error} Reassign the workflow node before deleting this agent.`);
}

export function compileAndValidateWorkflowV2Definition(
  definition: WorkflowV2AuthoredDefinition,
  registry: WorkflowV2TemplateRegistry,
): WorkflowV2ValidationResult & { definition?: WorkflowV2Definition } {
  try {
    // Templates expand first, then terminal normalization makes multi-branch
    // authored graphs executable under the single-terminal runtime contract.
    const compiledDefinition = normalizeWorkflowV2TerminalNode(
      compileWorkflowV2Definition(definition, registry),
    ).definition;
    const validation = validateWorkflowV2Definition(compiledDefinition);
    return {
      ...validation,
      ...(validation.valid ? { definition: compiledDefinition } : {}),
    };
  } catch (error) {
    if (error instanceof WorkflowV2TemplateCompileError) {
      return {
        valid: false,
        errors: [error.message],
        warnings: [],
        topologicalNodeIds: [],
      };
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
