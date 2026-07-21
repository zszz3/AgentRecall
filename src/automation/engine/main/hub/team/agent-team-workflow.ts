import type {
  AgentTeamMember,
  AgentTeamMode,
  AgentWorkflowEdge,
  AgentWorkflowNode,
  AgentWorkflowNodeStatus,
  AgentWorkflowSnapshot,
  TeamRunStatus,
  TeamRunStep,
} from "../../../shared/types";

export function cloneTeamMember(member: AgentTeamMember): AgentTeamMember {
  return {
    ...member,
    ...(member.canvasPosition ? { canvasPosition: { ...member.canvasPosition } } : {}),
  };
}

function workflowMemberNodeId(memberId: string): string {
  return `member:${memberId}`;
}

function workflowSynthesisMemberId(memberId: string): string {
  return `${memberId}:synthesis`;
}

function workflowSynthesisNodeId(memberId: string): string {
  return `synthesis:${memberId}`;
}

function workflowEdge(fromNodeId: string, toNodeId: string, label?: string): AgentWorkflowEdge {
  return {
    id: `${fromNodeId}->${toNodeId}`,
    fromNodeId,
    toNodeId,
    ...(label ? { label } : {}),
  };
}

function workflowTerminalStatus(runStatus: TeamRunStatus | undefined, terminal: "start" | "done"): AgentWorkflowNodeStatus {
  if (!runStatus) return "idle";
  if (terminal === "start") return runStatus === "queued" ? "queued" : "completed";
  if (runStatus === "completed" || runStatus === "failed" || runStatus === "stopped") return runStatus;
  return "queued";
}

function workflowJoinStatus(steps: TeamRunStep[] | undefined): AgentWorkflowNodeStatus {
  if (!steps || steps.length === 0) return "idle";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "stopped")) return "stopped";
  if (steps.every((step) => step.status === "completed")) return "completed";
  if (steps.some((step) => step.status === "running" || step.status === "completed")) return "running";
  return "queued";
}

export function buildWorkflowSnapshot(input: {
  mode: AgentTeamMode;
  members: AgentTeamMember[];
  steps?: TeamRunStep[];
  runStatus?: TeamRunStatus;
}): AgentWorkflowSnapshot {
  const stepByMemberId = new Map((input.steps ?? []).map((step) => [step.teamMemberId, step]));
  const nodes: AgentWorkflowNode[] = [
    {
      id: "start",
      kind: "start",
      label: "Start",
      status: workflowTerminalStatus(input.runStatus, "start"),
    },
  ];
  const edges: AgentWorkflowEdge[] = [];
  const agentNodes = input.members.map((member): AgentWorkflowNode => {
    const step = stepByMemberId.get(member.id);
    return {
      id: workflowMemberNodeId(member.id),
      kind: "agent",
      label: member.roleName,
      status: step?.status ?? "idle",
      teamMemberId: member.id,
      ...(step ? { stepId: step.id } : {}),
      ...(member.prompt.trim() ? { description: member.prompt.trim() } : {}),
      ...(member.canvasPosition ? { canvasPosition: { ...member.canvasPosition } } : {}),
    };
  });

  if (input.mode === "parallel") {
    nodes.push(
      ...agentNodes,
      { id: "join", kind: "join", label: "Join", status: workflowJoinStatus(input.steps) },
      {
        id: "done",
        kind: "done",
        label: "Done",
        status: workflowTerminalStatus(input.runStatus, "done"),
      },
    );
    for (const node of agentNodes) {
      edges.push(workflowEdge("start", node.id, "fan out"));
      edges.push(workflowEdge(node.id, "join", "complete"));
    }
    edges.push(workflowEdge("join", "done"));
    return {
      mode: input.mode,
      phases: [
        { id: "phase:start", title: "Start", nodeIds: ["start"] },
        { id: "phase:workers", title: "Parallel agents", nodeIds: agentNodes.map((node) => node.id) },
        { id: "phase:join", title: "Join", nodeIds: ["join"] },
        { id: "phase:done", title: "Done", nodeIds: ["done"] },
      ],
      nodes,
      edges,
    };
  }

  if (input.mode === "supervisor" && input.members.length > 0) {
    const lead = input.members[0]!;
    const leadNode = agentNodes[0]!;
    const workerNodes = agentNodes.slice(1);
    const synthesisStep = stepByMemberId.get(workflowSynthesisMemberId(lead.id));
    const synthesisNode: AgentWorkflowNode = {
      id: workflowSynthesisNodeId(lead.id),
      kind: "synthesis",
      label: `${lead.roleName} Synthesis`,
      status: synthesisStep?.status ?? "idle",
      teamMemberId: workflowSynthesisMemberId(lead.id),
      ...(synthesisStep ? { stepId: synthesisStep.id } : {}),
      description: "Synthesize worker artifacts into the final coordinated answer.",
    };
    nodes.push(
      ...agentNodes,
      synthesisNode,
      {
        id: "done",
        kind: "done",
        label: "Done",
        status: workflowTerminalStatus(input.runStatus, "done"),
      },
    );
    edges.push(workflowEdge("start", leadNode.id));
    if (workerNodes.length === 0) {
      edges.push(workflowEdge(leadNode.id, synthesisNode.id));
    } else {
      for (const node of workerNodes) {
        edges.push(workflowEdge(leadNode.id, node.id, "delegate"));
        edges.push(workflowEdge(node.id, synthesisNode.id, "artifact"));
      }
    }
    edges.push(workflowEdge(synthesisNode.id, "done"));
    return {
      mode: input.mode,
      phases: [
        { id: "phase:lead", title: "Lead", nodeIds: ["start", leadNode.id] },
        { id: "phase:workers", title: "Workers", nodeIds: workerNodes.map((node) => node.id) },
        { id: "phase:synthesis", title: "Synthesis", nodeIds: [synthesisNode.id] },
        { id: "phase:done", title: "Done", nodeIds: ["done"] },
      ],
      nodes,
      edges,
    };
  }

  nodes.push(
    ...agentNodes,
    {
      id: "done",
      kind: "done",
      label: "Done",
      status: workflowTerminalStatus(input.runStatus, "done"),
    },
  );
  let previousNodeId = "start";
  for (const node of agentNodes) {
    edges.push(workflowEdge(previousNodeId, node.id));
    previousNodeId = node.id;
  }
  edges.push(workflowEdge(previousNodeId, "done"));
  return {
    mode: input.mode,
    phases: [
      { id: "phase:start", title: "Start", nodeIds: ["start"] },
      ...agentNodes.map((node) => ({ id: `phase:${node.id}`, title: node.label, nodeIds: [node.id] })),
      { id: "phase:done", title: "Done", nodeIds: ["done"] },
    ],
    nodes,
    edges,
  };
}
