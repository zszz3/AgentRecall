import type { WorkflowV2Definition, WorkflowV2Node, WorkflowV2ReviewGate } from "./definition";

export const DEFAULT_WORKFLOW_V2_GATE_QUALITY_RETRIES = 2;
export const MAX_WORKFLOW_V2_GATE_QUALITY_RETRIES = 5;

export function workflowV2ReviewGateForNode(
  definition: WorkflowV2Definition,
  nodeId: string,
): WorkflowV2ReviewGate | undefined {
  if (definition.nodes.find((node) => node.id === nodeId)?.execModel !== "llm") return undefined;
  return definition.reviewGates?.find((gate) => gate.targetNodeId === nodeId);
}

export function migrateWorkflowV2ReviewGates(
  definition: WorkflowV2Definition,
  legacyReviewerConfiguredAgentId: string,
): WorkflowV2Definition {
  const scriptNodeIds = new Set(definition.nodes.filter((node) => node.execModel === "script").map((node) => node.id));
  const explicitGates = (definition.reviewGates ?? [])
    .filter((gate) => !scriptNodeIds.has(gate.targetNodeId))
    .map(withoutLegacyReviewGateFields);
  const gatedNodeIds = new Set(explicitGates.map((gate) => gate.targetNodeId));
  const gateIds = new Set(explicitGates.map((gate) => gate.id));
  const nodes = definition.nodes.map((node) => {
    const migratedNode = withoutLegacyReviewFields(node);
    if (node.execModel !== "llm" || !node.reviewLevel || node.reviewLevel === "none" || gatedNodeIds.has(node.id)) return migratedNode;
    const baseId = `review-${node.id}`;
    let gateId = baseId;
    for (let suffix = 2; gateIds.has(gateId); suffix += 1) gateId = `${baseId}-${suffix}`;
    gateIds.add(gateId);
    gatedNodeIds.add(node.id);
    explicitGates.push({
      id: gateId,
      targetNodeId: node.id,
      configuredAgentId: legacyReviewerConfiguredAgentId.trim(),
      reviewLevel: node.reviewLevel,
      judgeDimensions: structuredClone(node.judgeDimensions ?? []),
      maxQualityRetries: Math.min(
        MAX_WORKFLOW_V2_GATE_QUALITY_RETRIES,
        Math.max(0, node.reviewMaxRetries ?? DEFAULT_WORKFLOW_V2_GATE_QUALITY_RETRIES),
      ),
    });
    return migratedNode;
  });
  const { reviewEnabled: _legacyReviewEnabled, ...current } = structuredClone(definition);
  return { ...current, nodes, reviewGates: explicitGates };
}

function withoutLegacyReviewFields(node: WorkflowV2Node): WorkflowV2Node {
  const next = structuredClone(node);
  delete next.reviewLevel;
  delete next.reviewMaxRetries;
  delete next.judgeDimensions;
  return next;
}

function withoutLegacyReviewGateFields(gate: WorkflowV2ReviewGate): WorkflowV2ReviewGate {
  const next = structuredClone(gate) as WorkflowV2ReviewGate & { requiredTools?: unknown };
  delete next.requiredTools;
  return next;
}
