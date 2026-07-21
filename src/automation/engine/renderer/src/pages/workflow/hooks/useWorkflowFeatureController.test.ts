import { describe, expect, test } from "vitest";
import type { WorkflowRunState } from "../../../../../shared/types";
import { selectWorkflowRunContext } from "./useWorkflowFeatureController";

function run(runId: string, status: WorkflowRunState["status"]): WorkflowRunState {
  return { runId, workflowId: "workflow", status, workflowV2Plan: {} as WorkflowRunState["workflowV2Plan"], progress: [], events: [], contextDocument: "", startedAt: 1, finishedAt: undefined, lastError: undefined };
}

describe("selectWorkflowRunContext", () => {
  test("prefers a live run and otherwise exposes only the latest failed or stopped run for revision", () => {
    expect(selectWorkflowRunContext([run("failed", "failed"), run("live", "waiting_for_user")], "workflow", "failed")?.runId).toBe("live");
    expect(selectWorkflowRunContext([run("old", "failed"), run("latest", "stopped")], "workflow", "latest")?.runId).toBe("latest");
    expect(selectWorkflowRunContext([run("old", "failed"), run("latest", "completed")], "workflow", "latest")).toBeUndefined();
  });
});
