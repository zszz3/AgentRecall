import type { WorkflowV2Definition, WorkflowV2LLMNode } from "./definition";

export const WORKFLOW_V2_SUMMARY_NODE_ID = "workflow-summary";

export interface WorkflowV2TerminalNormalizationResult {
  definition: WorkflowV2Definition;
  terminalNodeIds: string[];
  addedSummaryNodeId?: string;
}

export function listWorkflowV2TerminalNodeIds(definition: WorkflowV2Definition): string[] {
  const nodesWithOutgoingEdges = new Set(definition.edges.map((edge) => edge.fromNodeId));
  return definition.nodes
    .filter((node) => !nodesWithOutgoingEdges.has(node.id))
    .map((node) => node.id);
}

export function normalizeWorkflowV2TerminalNode(definition: WorkflowV2Definition): WorkflowV2TerminalNormalizationResult {
  // The execution/review pipeline expects one terminal node. When an authored
  // graph fans out into multiple terminal branches, we preserve the branches
  // and add a synthetic final summary node instead of mutating branch content.
  const normalizedDefinition = structuredClone(definition);
  const terminalNodeIds = listWorkflowV2TerminalNodeIds(normalizedDefinition);
  if (terminalNodeIds.length <= 1) {
    return { definition: normalizedDefinition, terminalNodeIds };
  }

  const summaryNodeId = uniqueSummaryNodeId(new Set(normalizedDefinition.nodes.map((node) => node.id)));
  normalizedDefinition.nodes.push(createSummaryNode(summaryNodeId, terminalNodeIds.length));
  normalizedDefinition.edges.push(...terminalNodeIds.map((fromNodeId) => ({
    fromNodeId,
    toNodeId: summaryNodeId,
  })));

  return {
    definition: normalizedDefinition,
    terminalNodeIds,
    addedSummaryNodeId: summaryNodeId,
  };
}

function createSummaryNode(nodeId: string, upstreamNodeCount: number): WorkflowV2LLMNode {
  return {
    id: nodeId,
    kind: "summary",
    title: "汇总结果",
    execModel: "llm",
    executionMode: "one-shot",
    role: "orchestrator",
    prompt: [
      "You are the final aggregation node for this workflow.",
      "Read every direct upstream result from the JSON context object named upstreamOutputs.",
      "Each item follows this structure: { nodeId, summary, outputs, evidence?, risks?, nextStepSuggestions? }.",
      "Preserve important facts from every upstream node, resolve overlaps without inventing information, and organize the combined result into a coherent final response.",
      "Return outputs as a JSON object with exactly one required field: answer_markdown.",
      "answer_markdown must be a complete user-facing Markdown answer, not a description of the aggregation process.",
    ].join("\n"),
    outputFields: [{
      key: "answer_markdown",
      required: true,
      description: "Complete user-facing Markdown answer synthesized from every terminal result packet.",
    }],
    contextBudget: {
      maxContextTokens: 4000,
      maxEvidenceItems: 8,
      maxUpstreamNodes: upstreamNodeCount,
      summaryFallbackPolicy: "summarize",
    },
  };
}

function uniqueSummaryNodeId(nodeIds: ReadonlySet<string>): string {
  // Keep normalization deterministic while avoiding collisions with authored ids.
  if (!nodeIds.has(WORKFLOW_V2_SUMMARY_NODE_ID)) return WORKFLOW_V2_SUMMARY_NODE_ID;
  let suffix = 2;
  while (nodeIds.has(`${WORKFLOW_V2_SUMMARY_NODE_ID}-${suffix}`)) suffix += 1;
  return `${WORKFLOW_V2_SUMMARY_NODE_ID}-${suffix}`;
}
