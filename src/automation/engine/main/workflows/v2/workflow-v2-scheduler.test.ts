import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import {
  listWorkflowV2RunnableNodeIds,
  transitionWorkflowV2NodeState,
} from "./workflow-v2-scheduler";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-runtime",
    graphVersion: 5,
    objective: "Execute a frozen workflow v2 graph deterministically",
    nodes: [
      {
        id: "plan",
        kind: "planner",
        title: "Plan",
        execModel: "llm",
        executionMode: "one-shot",
        role: "orchestrator",
        prompt: "Plan the work",
        outputFields: [{ key: "planDoc", required: true }],
      },
      {
        id: "implement",
        kind: "implementation",
        title: "Implement",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Implement the plan",
        outputFields: [{ key: "diff", required: true }],
        resourceLocks: ["workspace"],
      },
      {
        id: "docs",
        kind: "docs",
        title: "Docs",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Update documentation",
        outputFields: [{ key: "docsDiff", required: true }],
        resourceLocks: ["workspace"],
      },
      {
        id: "review",
        kind: "review",
        title: "Review",
        execModel: "llm",
        executionMode: "one-shot",
        role: "reviewer",
        prompt: "Review the implementation",
        outputFields: [{ key: "reviewVerdict", required: true }],
      },
    ],
    edges: [
      { fromNodeId: "plan", toNodeId: "implement" },
      { fromNodeId: "plan", toNodeId: "docs" },
      { fromNodeId: "implement", toNodeId: "review" },
      { fromNodeId: "docs", toNodeId: "review" },
    ],
  };
}

describe("workflow-v2 scheduler", () => {
  test("initializes root nodes ready and downstream nodes blocked by dependencies", () => {
    const runState = createWorkflowV2RunState({
      definition: definition(),
      maxParallelNodes: 2,
    });

    expect(runState.status).toBe("running");
    expect(runState.nodes.plan!.status).toBe("ready");
    expect(runState.nodes.implement!.status).toBe("blocked");
    expect(runState.nodes.docs!.status).toBe("blocked");
    expect(runState.nodes.review!.status).toBe("blocked");
    expect(runState.nodes.review!.blockedBy).toEqual(["implement", "docs"]);
    expect(listWorkflowV2RunnableNodeIds(runState)).toEqual(["plan"]);
  });

  test("advances by dependency readiness and respects the global concurrency ceiling", () => {
    const initial = createWorkflowV2RunState({
      definition: definition(),
      maxParallelNodes: 1,
    });
    const runningPlan = transitionWorkflowV2NodeState(initial, { nodeId: "plan", status: "running", now: 100 });

    expect(listWorkflowV2RunnableNodeIds(runningPlan)).toEqual([]);

    const completedPlan = transitionWorkflowV2NodeState(runningPlan, { nodeId: "plan", status: "completed", now: 120 });
    expect(completedPlan.nodes.implement!.status).toBe("ready");
    expect(completedPlan.nodes.docs!.status).toBe("ready");
    expect(listWorkflowV2RunnableNodeIds(completedPlan)).toEqual(["implement"]);

    const runningImplement = transitionWorkflowV2NodeState(completedPlan, { nodeId: "implement", status: "running", now: 140 });
    expect(listWorkflowV2RunnableNodeIds(runningImplement)).toEqual([]);
  });

  test("keeps lock-conflicting ready nodes out of the same runnable batch", () => {
    const unlockedState = transitionWorkflowV2NodeState(
      transitionWorkflowV2NodeState(
        createWorkflowV2RunState({
          definition: definition(),
          maxParallelNodes: 3,
        }),
        { nodeId: "plan", status: "running", now: 100 },
      ),
      { nodeId: "plan", status: "completed", now: 120 },
    );

    expect(listWorkflowV2RunnableNodeIds(unlockedState)).toEqual(["implement"]);
  });

  test("keeps a fan-in node blocked until every dependency is completed", () => {
    const initial = createWorkflowV2RunState({
      definition: definition(),
      maxParallelNodes: 3,
    });
    const completedPlan = transitionWorkflowV2NodeState(
      transitionWorkflowV2NodeState(initial, { nodeId: "plan", status: "running", now: 100 }),
      { nodeId: "plan", status: "completed", now: 120 },
    );
    const completedImplement = transitionWorkflowV2NodeState(
      transitionWorkflowV2NodeState(completedPlan, { nodeId: "implement", status: "running", now: 130 }),
      { nodeId: "implement", status: "completed", now: 150 },
    );

    expect(completedImplement.nodes.review!.status).toBe("blocked");
    expect(completedImplement.nodes.review!.blockedBy).toEqual(["docs"]);
  });

  test("treats a skipped node as a satisfied dependency", () => {
    const initial = createWorkflowV2RunState({ definition: definition(), maxParallelNodes: 2 });
    const runningPlan = transitionWorkflowV2NodeState(initial, { nodeId: "plan", status: "running", now: 100 });
    const skippedPlan = transitionWorkflowV2NodeState(runningPlan, { nodeId: "plan", status: "skipped", now: 120 });

    expect(skippedPlan.nodes.plan?.status).toBe("skipped");
    expect(skippedPlan.nodes.implement?.status).toBe("ready");
    expect(skippedPlan.nodes.docs?.status).toBe("ready");
    expect(listWorkflowV2RunnableNodeIds(skippedPlan)).toEqual(["implement"]);
  });

  test("marks the run failed and leaves downstream nodes blocked when a dependency fails", () => {
    const failedState = transitionWorkflowV2NodeState(
      transitionWorkflowV2NodeState(
        createWorkflowV2RunState({
          definition: definition(),
          maxParallelNodes: 2,
        }),
        { nodeId: "plan", status: "running", now: 100 },
      ),
      { nodeId: "plan", status: "failed", error: "Planning failed", now: 130 },
    );

    expect(failedState.status).toBe("failed");
    expect(failedState.nodes.plan!.status).toBe("failed");
    expect(failedState.nodes.implement!.status).toBe("blocked");
    expect(failedState.nodes.docs!.status).toBe("blocked");
    expect(failedState.nodes.review!.status).toBe("blocked");
    expect(listWorkflowV2RunnableNodeIds(failedState)).toEqual([]);
  });
  test("keeps descendants blocked while any predecessor is paused", () => {
    let runState = createWorkflowV2RunState({ definition: definition(), maxParallelNodes: 3 });

    runState = transitionWorkflowV2NodeState(runState, { nodeId: "plan", status: "running", now: 10 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "plan", status: "completed", now: 11 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "implement", status: "running", now: 12 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "docs", status: "running", now: 13 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "docs", status: "completed", now: 14 });
    runState = transitionWorkflowV2NodeState(runState, {
      nodeId: "implement",
      status: "paused",
      now: 15,
      intervention: {
        nodeId: "implement",
        source: "validation",
        reason: "Need user input",
        allowedActions: ["continue"],
        requestedAt: 15,
      },
    });

    expect(runState.nodes.review).toMatchObject({ status: "blocked", blockedBy: ["implement"] });
    expect(listWorkflowV2RunnableNodeIds(runState)).toEqual([]);
  });
});
