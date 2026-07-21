import { describe, expect, test } from "vitest";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { assembleWorkflowV2LeaderNavigation } from "./workflow-v2-leader";

function runState(status: WorkflowV2RunState["status"]): WorkflowV2RunState {
  return {
    workflowId: "workflow-v2-leader",
    graphVersion: 11,
    status,
    maxParallelNodes: 2,
    nodeOrder: ["plan", "implement"],
    nodes: {
      plan: {
        nodeId: "plan",
        title: "Plan",
        status: "completed",
        dependsOn: [],
        dependents: ["implement"],
        blockedBy: [],
        resourceLocks: [],
        attempt: 1,
        startedAt: 10,
        finishedAt: 20,
      },
      implement: {
        nodeId: "implement",
        title: "Implement",
        status: "ready",
        dependsOn: ["plan"],
        dependents: [],
        blockedBy: [],
        resourceLocks: [],
        attempt: 0,
      },
    },
  };
}

describe("workflow-v2 leader", () => {
  test("assembles navigation from runnable nodes and escalation proposals", () => {
    const workerOutputs: WorkflowV2WorkerOutput[] = [
      {
        nodeId: "implement",
        summary: "Need human review before continuing",
        outputs: {},
        proposals: [
          { kind: "escalate", reason: "Human sign-off is required for the implementation diff." },
          { kind: "continue", reason: "Proceed after approval", targetNodeIds: ["implement"] },
        ],
      },
    ];

    expect(
      assembleWorkflowV2LeaderNavigation({
        runState: runState("running"),
        runnableNodeIds: ["implement"],
        workerOutputs,
      }),
    ).toEqual(expect.objectContaining({
      nextNodeIds: ["implement"],
      priorityNodeIds: ["implement"],
      escalationHints: ["Human sign-off is required for the implementation diff."],
      planHealth: "at-risk",
    }));
  });

  test("marks the plan blocked when the run has failed", () => {
    expect(
      assembleWorkflowV2LeaderNavigation({
        runState: runState("failed"),
        runnableNodeIds: ["implement"],
        workerOutputs: [],
      }),
    ).toEqual(expect.objectContaining({
      nextNodeIds: [],
      priorityNodeIds: [],
      escalationHints: [],
      planHealth: "blocked",
    }));
  });
});
