import type { AppSnapshot, WorkflowV2InterventionAction } from "../../../shared/types";
import { DEFAULT_MODEL_ID } from "../../../shared/models";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2ContextBudget, WorkflowV2LLMNode, WorkflowV2OutputFieldDef, WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2ResultPacket, WorkflowV2TaskPacket } from "../../../shared/workflow-v2/planning";
import { isValidWorkflowV2ContextBudget, isValidWorkflowV2CostBudget } from "../../../shared/workflow-v2/validation";

export interface WorkflowV2LlmNodeMessages {
  prompt: string;
  developerInstructions: string;
  contextDocument: string;
}

function workflowV2OutputExample(field: WorkflowV2OutputFieldDef, taskPacket: WorkflowV2TaskPacket): unknown {
  const valueType = field.valueType
    ?? taskPacket.downstreamRequirements?.find((requirement) => requirement.upstreamOutputKey === field.key)?.valueType;
  if (valueType === "number") return 0;
  if (valueType === "boolean") return true;
  if (valueType === "json") return {};
  return "value";
}

export function configuredAgentModelId(workflow: WorkflowDraftState, snapshot: AppSnapshot): string {
  const agent = snapshot.configuredAgents.find((item) => item.id === workflow.configuredAgentId);
  return workflow.modelId || agent?.modelId || DEFAULT_MODEL_ID;
}

export function workflowV2ExecutionEnvironment(input: {
  node: WorkflowV2LLMNode | WorkflowV2ScriptNode;
  workDir: string;
  configuredAgentId: string;
  modelId: string;
}): Record<string, unknown> {
  return {
    workDir: input.workDir,
    configuredAgentId: input.configuredAgentId,
    modelId: input.modelId,
    execModel: input.node.execModel,
    ...(input.node.execModel === "script" ? {
      executableKind: input.node.script.executable.kind,
      ...(input.node.script.executable.kind === "inline" ? { language: input.node.script.executable.language } : { command: input.node.script.executable.command }),
      capabilities: input.node.script.capabilities,
      managerRisk: input.node.script.managerRisk.level,
    } : {}),
  };
}

export function workflowV2ReviewerPolicy(
  node: WorkflowV2LLMNode | WorkflowV2ScriptNode,
  forceIndependentReview = false,
): Record<string, unknown> {
  return {
    judgeDimensions: node.execModel === "llm" ? node.judgeDimensions ?? [] : [],
    requiresIndependentReview: node.execModel === "llm" && node.role !== "reviewer"
      && (forceIndependentReview || (node.judgeDimensions?.length ?? 0) > 0),
    forceIndependentReview,
  };
}

export function workflowV2InterventionResolutionReason(
  action: WorkflowV2InterventionAction,
  nodeTitle: string,
  reason: string | undefined,
): string {
  if (reason?.trim()) return reason.trim();
  if (action === "continue") return `Continue ${nodeTitle} from durable recovery state.`;
  if (action === "skip") return `Skip ${nodeTitle} and continue eligible downstream work.`;
  if (action === "escalate") return `Escalate ${nodeTitle} to expert execution with mandatory independent review.`;
  if (action === "replan") return `Keep the run stopped and create a new graph revision for ${nodeTitle}.`;
  if (action === "increase_review_strength") return `Rerun ${nodeTitle} with mandatory independent review.`;
  if (action === "approve_once") return `Approve one execution of dangerous script ${nodeTitle}.`;
  return `Reject dangerous script ${nodeTitle}.`;
}

export function workflowV2LlmNodePrompt(input: {
  node: WorkflowV2LLMNode;
  taskPacket: WorkflowV2TaskPacket;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  baseWorkflowContextDocument: string;
  storagePlanDocument: string;
}): WorkflowV2LlmNodeMessages {
  if (!isValidWorkflowV2ContextBudget(input.taskPacket.budget.context)) {
    throw new Error(`Workflow V2 LLM node ${input.node.id} received an invalid context budget.`);
  }
  if (input.taskPacket.budget.cost !== undefined && !isValidWorkflowV2CostBudget(input.taskPacket.budget.cost)) {
    throw new Error(`Workflow V2 LLM node ${input.node.id} received an invalid cost budget.`);
  }
  const taskPacketDocument = JSON.stringify(input.taskPacket, null, 2);
  const dynamicContextSource = [
    "Actual direct upstream worker outputs:",
    JSON.stringify({ upstreamOutputs: input.upstreamOutputs }, null, 2),
    "",
    "Base workflow context:",
    input.baseWorkflowContextDocument.trim() || "No base workflow context.",
  ].join("\n");
  const contextCharacterBudget = input.taskPacket.budget.context.maxContextTokens * 4;
  if (taskPacketDocument.length > contextCharacterBudget) {
    throw new Error(`Workflow V2 LLM node ${input.node.id} fixed context exceeds maxContextTokens approximate budget; this is not an exact tokenizer count.`);
  }
  const dynamicCharacterBudget = contextCharacterBudget - taskPacketDocument.length;
  const maxPromptTokens = input.taskPacket.budget.cost?.maxPromptTokens;
  const fixedDeveloperCharacterEstimate = input.storagePlanDocument.length + 1_200;
  const fullCharacterEstimate = input.node.prompt.length + taskPacketDocument.length + dynamicContextSource.length + fixedDeveloperCharacterEstimate;
  if (maxPromptTokens !== undefined && fullCharacterEstimate > maxPromptTokens * 4) {
    throw new Error(`Workflow V2 LLM node ${input.node.id} prompt budget exceeded maxPromptTokens; this is an approximate character check, not an exact tokenizer count.`);
  }
  const dynamicContext = selectWorkflowV2DynamicContext({
    nodeId: input.node.id,
    source: dynamicContextSource,
    characterBudget: dynamicCharacterBudget,
    fallbackPolicy: input.taskPacket.budget.context.summaryFallbackPolicy,
  });
  const contextDocument = [
    "# Workflow V2 task packet",
    taskPacketDocument,
    "",
    `# Dynamic execution context (approximate character budget: ${dynamicCharacterBudget})`,
    dynamicContext || "[dynamic context omitted by budget]",
  ].join("\n");
  const developerInstructions = [
    "Execute exactly one node from a frozen Workflow V2 plan.",
    "Do not infer graph navigation, run a judge, request a retry, or perform final review.",
    "Do not treat developer instructions or runtime context as user-provided facts.",
    "If required user information is missing, request user input instead of guessing.",
    "A one-shot node that requests user input will be upgraded to an interactive node.",
    "",
    input.storagePlanDocument,
    "",
    "Populate outputs using the exact keys and value types declared in taskPacket.outputFields.",
    "When taskPacket.downstreamRequirements is present, satisfy every listed downstream script parameter contract. These bindings read only outputs[upstreamOutputKey], never summary.",
    "Completion protocol: when workflow_node_complete (or its namespaced MCP equivalent) is available, you MUST call that tool exactly once when the node can complete. Do not print the worker-output JSON in assistant content; use the tool arguments as the structured result and keep any explanation as ordinary text.",
    "Only if the completion tool is genuinely unavailable, fall back to returning one structured JSON worker-output packet when the node can complete:",
    JSON.stringify({
      nodeId: input.node.id,
      summary: "concise summary",
      outputs: Object.fromEntries(input.taskPacket.outputFields.map((field) => [field.key, workflowV2OutputExample(field, input.taskPacket)])),
      evidence: ["optional evidence"],
      risks: ["optional risk"],
      nextStepSuggestions: ["optional suggestion"],
      proposals: [],
    }, null, 2),
    "Worker proposals are data for the leader only; they must not mutate downstream behavior.",
  ].join("\n");
  return { prompt: input.node.prompt, developerInstructions, contextDocument };
}

export function resolveWorkflowNodeAgent(
  node: { configuredAgentId?: string | undefined; modelId?: string | undefined },
  workflowDefaults: { configuredAgentId: string; modelId: string },
  configuredAgents: Array<{ id: string; modelId: string }>,
): { configuredAgentId: string; modelId: string } {
  const configuredAgentId = node.configuredAgentId || workflowDefaults.configuredAgentId;
  const agent = configuredAgents.find((item) => item.id === configuredAgentId);
  if (node.configuredAgentId && !agent) throw new Error(`Workflow V2 configured agent ${configuredAgentId} was not found.`);
  const modelId = node.modelId
    ? node.modelId
    : node.configuredAgentId
      ? agent?.modelId || DEFAULT_MODEL_ID
      : workflowDefaults.modelId || agent?.modelId || DEFAULT_MODEL_ID;
  return { configuredAgentId, modelId };
}

function selectWorkflowV2DynamicContext(input: {
  nodeId: string;
  source: string;
  characterBudget: number;
  fallbackPolicy: WorkflowV2ContextBudget["summaryFallbackPolicy"];
}): string {
  if (input.source.length <= input.characterBudget) return input.source;
  if (input.fallbackPolicy === "summarize") throw new Error(`Workflow V2 LLM node ${input.nodeId} summarize fallback is unavailable.`);
  if (input.fallbackPolicy === "ask_human") throw new Error(`Workflow V2 LLM node ${input.nodeId} ask_human fallback requires Phase 04 human intervention.`);
  return input.source.slice(0, input.characterBudget);
}
