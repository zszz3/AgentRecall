import { describe, expect, it } from "vitest";
import type {
  WorkflowDraftState,
  WorkflowRunState,
} from "../../../../automation/contracts";
import { selectWorkbenchWorkflows } from "./workbench-workflows";

function workflow(workflowId: string, updatedAt: number): WorkflowDraftState {
  return {
    workflowId,
    title: workflowId,
    status: "draft",
    revision: 1,
    configuredAgentId: "agent",
    modelId: "default",
    reviewerConfiguredAgentId: "agent",
    reviewerModelId: "default",
    objective: "",
    definition: { workflowId, graphVersion: 1, objective: "", nodes: [], edges: [] },
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "",
    contextDocument: "",
    runIds: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function run(
  workflowId: string,
  status: WorkflowRunState["status"],
  startedAt: number,
): WorkflowRunState {
  return {
    runId: `${workflowId}-run`,
    workflowId,
    status,
    workflowV2Plan: {} as WorkflowRunState["workflowV2Plan"],
    progress: [],
    events: [],
    contextDocument: "",
    startedAt,
    finishedAt: undefined,
    lastError: undefined,
  };
}

describe("selectWorkbenchWorkflows", () => {
  it("prioritizes waiting and running workflows before recent inactive workflows", () => {
    const selected = selectWorkbenchWorkflows(
      [
        workflow("recent", 40),
        workflow("running", 10),
        workflow("waiting", 5),
        workflow("older", 20),
      ],
      [run("running", "running", 30), run("waiting", "waiting_for_user", 25)],
      3,
    );

    expect(selected.map((item) => [item.workflow.workflowId, item.status])).toEqual([
      ["waiting", "waiting_for_user"],
      ["running", "running"],
      ["recent", "draft"],
    ]);
  });
});
