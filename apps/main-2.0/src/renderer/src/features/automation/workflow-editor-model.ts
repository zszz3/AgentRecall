import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowOutputField,
} from "../../../../automation/engine/shared/workflow/model";

export type WorkflowNodeKind = WorkflowNode["kind"];

export interface WorkflowConnection {
  fromNodeId: string;
  fromOutputKey: string;
  toNodeId: string;
}

const resultOutput = (): WorkflowOutputField => ({
  key: "result",
  name: "Result",
  description: "The completed result",
  type: "text",
  required: true,
});

function nodeId(kind: WorkflowNodeKind, now: number, count: number): string {
  return `${kind}_${now}_${count}`;
}

function createNode(
  kind: WorkflowNodeKind,
  agentId: string,
  id: string,
  previous?: WorkflowNode,
): WorkflowNode {
  const base = {
    id,
    title: kind === "agent" ? "Agent task" : kind === "script" ? "Script" : kind === "review" ? "Review" : "Approval",
    goal: kind === "approval" ? "Ask a person to make the decision." : "Describe what this node should accomplish.",
    inputs: previous ? [{
      source: "node" as const,
      nodeId: previous.id,
      outputKey: previous.outputs[0]?.key ?? "result",
    }] : [],
    acceptanceCriteria: [],
  };
  if (kind === "agent") return {
    ...base,
    kind,
    agentId,
    instructions: [],
    constraints: [],
    outputs: [resultOutput()],
  };
  if (kind === "script") return {
    ...base,
    kind,
    runtime: "bash",
    source: "#!/usr/bin/env bash\nset -euo pipefail\nnode -e 'process.stdin.on(\"data\", d => console.log(JSON.stringify({result: d.toString()})))'",
    timeoutSeconds: 60,
    permissions: ["workspace_read"],
    outputs: [resultOutput()],
  };
  if (kind === "review") return {
    ...base,
    kind,
    agentId,
    instructions: ["Evaluate every criterion and explain any required revision."],
    constraints: [],
    targetNodeIds: previous ? [previous.id] : [],
    criteria: [{ key: "quality", description: "The result is correct, complete, and useful." }],
    maxRevisions: null,
    onReject: "revise",
    outputs: [
      { key: "verdict", name: "Verdict", description: "Use pass or revise", type: "text", required: true },
      {
        key: "criteriaResults",
        name: "Criteria results",
        description: "Result for each review criterion",
        type: "list",
        required: true,
      },
      { key: "feedback", name: "Feedback", description: "Specific revision feedback", type: "text", required: true },
    ],
  };
  return {
    ...base,
    kind,
    message: "Review the available inputs and choose how the Workflow should continue.",
    options: [
      { value: "approve", label: "Approve", description: "Continue the Workflow." },
      { value: "reject", label: "Reject", description: "Stop at this decision." },
    ],
    allowComment: true,
    outputs: [
      { key: "decision", name: "Decision", description: "The selected option", type: "text", required: true },
      { key: "comment", name: "Comment", description: "Optional decision context", type: "text", required: false },
    ],
  };
}

export function createWorkflowDefinition(agentId: string, now = Date.now()): WorkflowDefinition {
  return {
    id: `workflow_${now}`,
    name: "New Workflow",
    description: "Describe when and why to use this Workflow.",
    inputs: [],
    nodes: [createNode("agent", agentId, nodeId("agent", now, 1))],
    createdAt: now,
    updatedAt: now,
  };
}

export function createWorkflowCopy(source: WorkflowDefinition, now = Date.now()): WorkflowDefinition {
  const definition = structuredClone(source);
  delete definition.isTemplate;
  return {
    ...definition,
    id: `workflow_${now}`,
    name: `${source.name} 副本`,
    createdAt: now,
    updatedAt: now,
  };
}

export function addWorkflowNode(
  definition: WorkflowDefinition,
  kind: WorkflowNodeKind,
  agentId: string,
  now = Date.now(),
): WorkflowDefinition {
  const previous = definition.nodes.at(-1);
  return {
    ...structuredClone(definition),
    nodes: [...structuredClone(definition.nodes), createNode(kind, agentId, nodeId(kind, now, definition.nodes.length + 1), previous)],
    updatedAt: now,
  };
}

export function workflowConnections(definition: WorkflowDefinition): WorkflowConnection[] {
  return definition.nodes.flatMap((node) => node.inputs.flatMap((input) => input.source === "node" ? [{
    fromNodeId: input.nodeId,
    fromOutputKey: input.outputKey,
    toNodeId: node.id,
  }] : []));
}
