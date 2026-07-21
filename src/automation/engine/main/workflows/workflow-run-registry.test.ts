import { describe, expect, it } from "vitest";
import { WorkflowRunRegistry, type ActiveWorkflowRun } from "./workflow-run-registry";

function activeRun(runId = "run-1"): ActiveWorkflowRun {
  return {
    workflowId: "workflow-1",
    runId,
    pausedNodeIds: new Set(),
    pausedTaskIds: new Set(),
    gatedNodeIds: new Set(),
    taskIdByNodeId: new Map(),
  };
}

describe("WorkflowRunRegistry", () => {
  it("owns active run identity until the run is released", () => {
    const registry = new WorkflowRunRegistry();
    const run = activeRun();

    registry.register(run);

    expect(registry.has(run.runId)).toBe(true);
    expect(registry.get(run.runId)).toBe(run);
    registry.release(run.runId);
    expect(registry.has(run.runId)).toBe(false);
  });

  it("keeps a stop request after active resources are released", () => {
    const registry = new WorkflowRunRegistry();
    const run = activeRun();
    registry.register(run);

    expect(registry.requestStop(run.runId)).toBe(run);
    registry.release(run.runId);

    expect(registry.isStopRequested(run.runId)).toBe(true);
  });

  it("clears an obsolete stop request when the same run is registered for resumption", () => {
    const registry = new WorkflowRunRegistry();
    const run = activeRun();
    registry.requestStop(run.runId);

    registry.register(run);

    expect(registry.isStopRequested(run.runId)).toBe(false);
  });
});
